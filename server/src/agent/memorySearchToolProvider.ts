import type { Stats } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

import { z } from 'zod';

import type { MemoryIndexService } from '../memory/index/service.js';
import type { SearchResponse } from '../memory/index/types.js';
import { loadToolDescription } from './tools/descriptionLoader.js';
import type { AuthorizedToolCall, ToolCallContext, ToolDescriptor, ToolProvider, ToolResult } from './toolRuntime.js';

const DEFAULT_MEMORY_RESULTS = 5;
const MAX_MEMORY_RESULTS = 10;
const MAX_MEMORY_LIST_ENTRIES = 200;

type MemorySearchInput = {
  query: string;
  keywords?: string;
  maxResults?: number;
};

type MemoryListInput = {
  subdir?: string;
};

export const memorySearchToolDescriptor: ToolDescriptor<MemorySearchInput> = {
  id: 'MemorySearch',
  name: 'MemorySearch',
  displayName: 'Memory Search',
  description: loadToolDescription('MemorySearch'),
  schema: z.object({
    query: z.string().min(1).describe('自然语言查询。'),
    keywords: z.string().optional().describe('可选，用于 FTS 精确匹配的关键词；默认取 query。'),
    maxResults: z.number().int().positive().max(MAX_MEMORY_RESULTS).optional(),
  }),
  risk: 'safe',
  approvalMode: 'never',
  auditCategory: 'memory.search',
  category: 'memory',
  label: '搜索记忆',
};

export const memoryListToolDescriptor: ToolDescriptor<MemoryListInput> = {
  id: 'MemoryList',
  name: 'MemoryList',
  displayName: 'Memory List',
  description: loadToolDescription('MemoryList'),
  schema: z.object({
    subdir: z.string().optional().describe('可选，memory/ 下的子目录（如 "topics"）。'),
  }),
  risk: 'safe',
  approvalMode: 'never',
  auditCategory: 'memory.list',
  category: 'memory',
  label: '列出记忆文件',
};

export class MemorySearchToolProvider implements ToolProvider {
  constructor(private readonly memoryIndexService: MemoryIndexService) {}

  list(): ToolDescriptor[] {
    return [memorySearchToolDescriptor, memoryListToolDescriptor];
  }

  async invoke(call: AuthorizedToolCall, context: ToolCallContext): Promise<ToolResult | undefined> {
    if (call.toolId === memorySearchToolDescriptor.id) {
      const input = memorySearchToolDescriptor.schema.parse(call.input) as MemorySearchInput;
      const indexer = this.memoryIndexService.getIndexer(context.workspace.root);
      await indexer.syncIfStale({
        maxWaitMs: 800,
        emptyIndexMaxWaitMs: 2_000,
        manifestCheckIntervalMs: 60_000,
      });
      const response = await indexer.search(input.query, {
        maxResults: input.maxResults ?? DEFAULT_MEMORY_RESULTS,
        keywords: input.keywords?.trim() || input.query,
      });
      return { content: formatMemorySearchResponse(response) };
    }
    if (call.toolId === memoryListToolDescriptor.id) {
      const input = memoryListToolDescriptor.schema.parse(call.input) as MemoryListInput;
      const content = await listMemoryFiles(context.workspace.root, input.subdir);
      return { content };
    }
    return undefined;
  }
}

const MAX_MEMORY_WALK_DEPTH = 8;

type MemoryEntry = { path: string; bytes: number; mtime: string };
type ListState = { entries: MemoryEntry[]; truncated: boolean; errors: string[] };

/**
 * MemoryList 实现。安全要点：
 *  - subdir 拒绝 `..` / 绝对路径；解析后再用 path.relative 做 `isInside` 校验，
 *    避免 startsWith 前缀绕过（`../memory_secret` 解析为同级且共前缀的合法路径）。
 *  - 每个候选目录/文件用 lstat 先检测符号链接，遇到 symlink 直接跳过，防止
 *    `memory/private -> /etc` 这类向外延伸的攻击向量。
 *  - errno 区分：ENOENT 走"目录不存在"，其他错误（EACCES/EPERM/EMFILE）追加
 *    `[error reading X: <code>]` 让模型知道结果是部分的，不再静默吞错。
 *  - truncated 由 walk 内部命中 cap 时显式置 true（而不是 entries.length >= MAX）
 *    避免恰好命中时假阳性。
 */
async function listMemoryFiles(workspaceRoot: string, subdir?: string): Promise<string> {
  const state: ListState = { entries: [], truncated: false, errors: [] };

  // 1. Root MEMORY.md（只有不指定 subdir 时列出）
  if (!subdir) {
    const memoryMd = join(workspaceRoot, 'MEMORY.md');
    const stRes = await safeLstat(memoryMd);
    if (stRes.ok && stRes.stat.isFile()) {
      state.entries.push({
        path: 'MEMORY.md',
        bytes: stRes.stat.size,
        mtime: formatMtime(stRes.stat.mtime),
      });
    } else if (stRes.ok && stRes.stat.isSymbolicLink()) {
      state.errors.push('MEMORY.md 是符号链接，已跳过');
    }
  }

  // 2. memory/ 目录下递归
  const memoryRoot = join(workspaceRoot, 'memory');

  // subdir 早期硬约束：拒绝绝对路径与任何包含 `..` 段的输入
  if (subdir) {
    if (isAbsolute(subdir) || subdir.split(/[/\\]/).some((s) => s === '..')) {
      return `Access denied: subdir 包含 ".." 或绝对路径`;
    }
  }
  const startDir = subdir ? join(memoryRoot, subdir) : memoryRoot;

  // 用 path.relative 做 isInside（修复 startsWith 前缀绕过漏洞）
  if (!isPathInside(memoryRoot, startDir)) {
    return `Access denied: subdir 越界（必须在 memory/ 下）`;
  }

  const startStatRes = await safeLstat(startDir);
  if (!startStatRes.ok) {
    if (startStatRes.code === 'ENOENT') {
      return state.entries.length > 0
        ? formatMemoryList(state)
        : `memory/${subdir ?? ''} 目录不存在`;
    }
    return `memory/${subdir ?? ''} 读取失败：${startStatRes.code}`;
  }
  // 不跟随符号链接进入根
  if (startStatRes.stat.isSymbolicLink() || !startStatRes.stat.isDirectory()) {
    return state.entries.length > 0
      ? formatMemoryList(state)
      : `memory/${subdir ?? ''} 不是目录（或是符号链接，已拒绝）`;
  }

  await walkMemoryDir(startDir, workspaceRoot, state, 0);

  if (state.entries.length === 0 && state.errors.length === 0) {
    return `未找到任何 memory 文件（MEMORY.md 或 memory/**.md）`;
  }
  return formatMemoryList(state);
}

async function walkMemoryDir(
  dir: string,
  workspaceRoot: string,
  out: ListState,
  depth: number,
): Promise<void> {
  if (out.entries.length >= MAX_MEMORY_LIST_ENTRIES) {
    out.truncated = true;
    return;
  }
  if (depth > MAX_MEMORY_WALK_DEPTH) {
    out.errors.push(`[depth-cap at ${relative(workspaceRoot, dir)}]`);
    return;
  }
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = errnoCode(err);
    if (code !== 'ENOENT') {
      out.errors.push(`[error reading ${relative(workspaceRoot, dir)}: ${code}]`);
    }
    return;
  }
  for (const dirent of dirents) {
    if (out.entries.length >= MAX_MEMORY_LIST_ENTRIES) {
      out.truncated = true;
      return;
    }
    // 显式拒绝符号链接，无论指向何处（防止 memory/private -> /etc 这类）
    if (dirent.isSymbolicLink()) continue;
    const full = join(dir, dirent.name);
    if (dirent.isDirectory()) {
      await walkMemoryDir(full, workspaceRoot, out, depth + 1);
    } else if (dirent.isFile() && dirent.name.endsWith('.md')) {
      const stRes = await safeLstat(full);
      if (!stRes.ok) {
        if (stRes.code !== 'ENOENT') {
          out.errors.push(`[error stat ${relative(workspaceRoot, full)}: ${stRes.code}]`);
        }
        continue;
      }
      // lstat 已经过滤了 symlink，到这里 isFile 一定是真实文件
      if (stRes.stat.isSymbolicLink()) continue;
      out.entries.push({
        path: relative(workspaceRoot, full),
        bytes: stRes.stat.size,
        mtime: formatMtime(stRes.stat.mtime),
      });
    }
  }
}

type LstatResult =
  | { ok: true; stat: Stats }
  | { ok: false; code: string };

async function safeLstat(path: string): Promise<LstatResult> {
  try {
    return { ok: true, stat: (await lstat(path)) as Stats };
  } catch (err) {
    return { ok: false, code: errnoCode(err) };
  }
}

function errnoCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err && typeof (err as { code?: unknown }).code === 'string') {
    return (err as { code: string }).code;
  }
  return 'UNKNOWN';
}

/** 用 `path.relative` 实现 isInside，避免 startsWith 前缀绕过漏洞。 */
function isPathInside(baseDir: string, candidate: string): boolean {
  const rel = relative(baseDir, candidate);
  // rel === '' → candidate 等同 baseDir 本身（允许）
  // rel.startsWith('..') → 在 baseDir 外
  // isAbsolute(rel) → 跨盘符（Windows），算外部
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** 输出小时级精度，避免毫秒精度泄漏作息节律。 */
function formatMtime(d: Date): string {
  return d.toISOString().slice(0, 13) + 'Z'; // YYYY-MM-DDTHHZ
}

function formatMemoryList(state: ListState): string {
  const sorted = state.entries.slice().sort((a, b) => (a.path < b.path ? -1 : 1));
  const lines = sorted.map((e) => `${e.path}\t${e.bytes}B\t${e.mtime}`);
  const parts: string[] = [
    `共 ${sorted.length} 个记忆文件（路径\\t字节\\t小时级 mtime）：`,
    lines.join('\n'),
  ];
  if (state.truncated) {
    parts.push(`...[truncated at ${MAX_MEMORY_LIST_ENTRIES} entries]`);
  }
  if (state.errors.length > 0) {
    parts.push('\n[partial-result 警告：以下目录读取受限]\n' + state.errors.join('\n'));
  }
  // realpath import 保留供未来扩展（如校验 memory/ 自身是否被替换为 symlink）
  void realpath;
  return parts.join('\n');
}

export function hasMemorySearchTool(memoryIndexService?: MemoryIndexService | null): boolean {
  return !!memoryIndexService;
}

function formatMemorySearchResponse(response: SearchResponse): string {
  if (response.results.length === 0) {
    return [
      '未找到匹配的记忆内容。',
      `候选数: ${response.meta.totalCandidates}; 过滤数: ${response.meta.filteredOut}; 最高过滤分: ${response.meta.bestFilteredScore.toFixed(3)}`,
    ].join('\n');
  }

  const formatted = response.results.map((result, index) => {
    const location = `${result.path}#L${result.startLine}-L${result.endLine}`;
    return [
      `[${index + 1}] ${location} (score: ${result.score.toFixed(3)})`,
      result.snippet,
    ].join('\n');
  });

  formatted.push(
    `meta: candidates=${response.meta.totalCandidates}, filtered=${response.meta.filteredOut}, bestFiltered=${response.meta.bestFilteredScore.toFixed(3)}`,
  );
  return formatted.join('\n\n---\n\n');
}
