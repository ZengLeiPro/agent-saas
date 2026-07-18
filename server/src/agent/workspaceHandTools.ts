import { lstat, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, extname as pathExtname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { z } from 'zod';

import type { ArtifactKind } from '../runtime/artifactStore.js';
import { loadToolDescription } from './tools/descriptionLoader.js';
import type { ToolDescriptor, ToolResult, WorkspaceRef } from './toolRuntime.js';

export const MAX_EDIT_FILE_BYTES = 1_000_000;
export const MAX_GLOB_PATHS = 5_000;
export const MAX_GLOB_DEPTH = 12;
export const MAX_GREP_FILES = 200;
export const MAX_GREP_MATCHES_PER_FILE = 200;
export const MAX_GREP_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_GREP_PATTERN_LENGTH = 256;
export const MAX_GREP_TOTAL_WALL_MS = 5_000;
export const MAX_ARTIFACT_PAYLOAD_BYTES = 16 * 1024 * 1024;

const GLOB_SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.venv',
  '.cache',
  '.next',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.turbo',
  '.parcel-cache',
  '.runtime-events',
  '.browser-profile',
  '.ky-agent',
]);

const GLOB_SKIP_FILE_PATTERNS: RegExp[] = [
  /\.env(\..+)?$/i,
  /\.(npmrc|netrc|pypirc)$/i,
  /\.(pem|key|crt|p12|pfx)$/i,
];

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico',
  '.pdf', '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z',
  '.mp3', '.mp4', '.m4a', '.mov', '.avi', '.mkv', '.webm',
  '.exe', '.bin', '.so', '.dylib', '.dll', '.class', '.jar',
  '.woff', '.woff2', '.ttf', '.otf',
]);

const EDIT_DENY_PATTERNS: RegExp[] = [
  /(^|\/)\.ky-agent\/settings\.json$/i,
  /(^|\/)\.claude\/settings\.json$/i,
  /(^|\/)\.env(\..+)?$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.ssh\//i,
  /(^|\/)\.git\//i,
];
const ARTIFACT_DENY_PATTERNS: RegExp[] = EDIT_DENY_PATTERNS;

export type EditInput = {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
};

export type GlobInput = {
  pattern: string;
  path?: string;
};

export type GrepInput = {
  pattern: string;
  path?: string;
  glob?: string;
  case_insensitive?: boolean;
  max_files?: number;
};

export type CreateArtifactInput = {
  file_path: string;
  kind?: ArtifactKind;
  mime_type?: string;
  metadata?: Record<string, unknown>;
};

export type WorkspaceArtifactPayload = {
  sourcePath: string;
  fileName: string;
  sizeBytes: number;
  dataBase64: string;
  kind?: ArtifactKind;
  mimeType?: string;
};

type PathGuard = (fullPath: string) => void;

export const editToolDescriptor: ToolDescriptor<EditInput> = {
  id: 'Edit',
  name: 'Edit',
  displayName: 'Edit',
  description: loadToolDescription('Edit'),
  schema: z.object({
    file_path: z.string().min(1).describe('Workspace-relative or absolute path inside the workspace.'),
    old_string: z.string().describe('Exact text to find.'),
    new_string: z.string().describe('Replacement text.'),
    replace_all: z.boolean().optional().describe('Replace all occurrences instead of failing on multiple matches.'),
  }),
  risk: 'workspace_write',
  approvalMode: 'web',
  auditCategory: 'filesystem.edit',
  category: 'workspace',
  label: '精确编辑文件',
};

export const globToolDescriptor: ToolDescriptor<GlobInput> = {
  id: 'Glob',
  name: 'Glob',
  displayName: 'Glob',
  description: loadToolDescription('Glob'),
  schema: z.object({
    pattern: z.string().min(1).describe('Glob pattern, e.g. "**/*.ts" or "src/**/foo*.md".'),
    path: z.string().optional().describe('Optional subdirectory to scope; defaults to workspace root.'),
  }),
  risk: 'safe',
  approvalMode: 'never',
  auditCategory: 'filesystem.glob',
  category: 'workspace',
  label: 'Glob 查找文件',
};

export const grepToolDescriptor: ToolDescriptor<GrepInput> = {
  id: 'Grep',
  name: 'Grep',
  displayName: 'Grep',
  description: loadToolDescription('Grep'),
  schema: z.object({
    pattern: z.string().min(1).max(MAX_GREP_PATTERN_LENGTH).describe('JavaScript regex.'),
    path: z.string().optional().describe('Subdirectory to scope to; defaults to workspace root.'),
    glob: z.string().optional().describe('Restrict to files matching this glob pattern.'),
    case_insensitive: z.boolean().optional().describe('Case-insensitive search.'),
    max_files: z.number().int().positive().max(MAX_GREP_FILES).optional(),
  }),
  risk: 'safe',
  approvalMode: 'never',
  auditCategory: 'filesystem.grep',
  category: 'workspace',
  label: '正则搜索文件',
};

export const artifactCreateToolDescriptor: ToolDescriptor<CreateArtifactInput> = {
  id: 'CreateArtifact',
  name: 'CreateArtifact',
  displayName: 'Create Artifact',
  description: loadToolDescription('CreateArtifact'),
  schema: z.object({
    file_path: z.string().min(1).describe('Workspace-relative or absolute path inside the workspace.'),
    kind: z.enum(['file', 'screenshot', 'patch', 'log', 'blob']).optional(),
    mime_type: z.string().optional().describe('Optional MIME type, e.g. text/plain or image/png.'),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  risk: 'safe',
  approvalMode: 'never',
  auditCategory: 'artifact.create',
  category: 'workspace',
  label: '创建 Artifact',
};

export async function runWorkspaceEdit(
  input: EditInput,
  workspace: WorkspaceRef,
  guard?: PathGuard,
): Promise<ToolResult> {
  const fullPath = resolveInsideWorkspace(workspace.root, input.file_path);
  guard?.(fullPath);
  const relPath = relativeWorkspacePath(workspace.root, fullPath);
  assertNotDenied(relPath, EDIT_DENY_PATTERNS, (path) =>
    `Edit: path "${path}" is in the deny list (sensitive config / credentials). Ask the admin via console if a change is genuinely required.`);

  let st;
  try {
    st = await stat(fullPath);
  } catch (err) {
    throw new Error(`Edit: cannot stat ${relPath} (${err instanceof Error ? err.message : String(err)})`);
  }
  if (st.size > MAX_EDIT_FILE_BYTES) {
    throw new Error(`Edit: file too large (${st.size}B > ${MAX_EDIT_FILE_BYTES}B); use Write to rewrite.`);
  }
  let content: string;
  try {
    content = await readFile(fullPath, 'utf-8');
  } catch (err) {
    throw new Error(`Edit: cannot read ${relPath} (${err instanceof Error ? err.message : String(err)})`);
  }
  if (input.old_string === input.new_string) {
    throw new Error('Edit: old_string equals new_string; no-op.');
  }
  if (input.old_string === '') {
    throw new Error('Edit: empty old_string not allowed; use Write for new files.');
  }

  const parts = content.split(input.old_string);
  const occurrences = parts.length - 1;
  if (occurrences === 0) {
    throw new Error('Edit: old_string not found.');
  }
  if (!input.replace_all && occurrences > 1) {
    throw new Error(`Edit: old_string matched ${occurrences} times; supply more surrounding context or set replace_all=true.`);
  }
  const updated = parts.join(input.new_string);
  const replacements = input.replace_all ? occurrences : 1;

  await writeFile(fullPath, updated, 'utf-8');
  return {
    content: `Edited ${relPath} (${replacements} replacement${replacements === 1 ? '' : 's'}, ${updated.length} bytes).`,
  };
}

export async function runWorkspaceGlob(
  input: GlobInput,
  workspace: WorkspaceRef,
  guard?: PathGuard,
): Promise<ToolResult> {
  const baseDir = input.path
    ? resolveInsideWorkspace(workspace.root, input.path)
    : workspace.root;
  guard?.(baseDir);
  const regex = globToRegExp(input.pattern);

  const all = await walkWorkspace(baseDir, workspace.root, guard);
  const matched = all
    .filter((entry) => regex.test(normalizeForMatch(entry.path)))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (matched.length === 0) {
    return { content: `（无匹配项；扫描 ${all.length} 文件）` };
  }
  const lines = matched.slice(0, MAX_GLOB_PATHS).map((m) => m.path);
  const suffix = matched.length >= MAX_GLOB_PATHS ? `\n...[truncated at ${MAX_GLOB_PATHS} paths]` : '';
  return { content: lines.join('\n') + suffix };
}

export async function runWorkspaceGrep(
  input: GrepInput,
  workspace: WorkspaceRef,
  guard?: PathGuard,
): Promise<ToolResult> {
  const baseDir = input.path
    ? resolveInsideWorkspace(workspace.root, input.path)
    : workspace.root;
  guard?.(baseDir);
  const flags = input.case_insensitive ? 'gi' : 'g';
  let regex: RegExp;
  try {
    regex = new RegExp(input.pattern, flags);
  } catch (err) {
    throw new Error(`Grep: bad regex (${err instanceof Error ? err.message : String(err)})`);
  }
  const globRegex = input.glob ? globToRegExp(input.glob) : null;
  const all = await walkWorkspace(baseDir, workspace.root, guard, {
    maxPaths: MAX_GREP_FILES * 4,
    maxDepth: MAX_GLOB_DEPTH,
  });
  const candidates = globRegex
    ? all.filter((entry) => globRegex.test(normalizeForMatch(entry.path)))
    : all;
  const limit = input.max_files ?? MAX_GREP_FILES;
  const files = candidates.slice(0, limit);

  const matches: string[] = [];
  let totalMatches = 0;
  let timeBudgetHit = false;
  let binarySkipped = 0;
  let oversizeSkipped = 0;
  const deadline = Date.now() + MAX_GREP_TOTAL_WALL_MS;

  for (const f of files) {
    if (Date.now() > deadline) {
      timeBudgetHit = true;
      break;
    }
    const ext = pathExtname(f.path);
    if (BINARY_EXT.has(ext.toLowerCase())) {
      binarySkipped++;
      continue;
    }
    const filePath = join(workspace.root, f.path);
    guard?.(filePath);
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      continue;
    }
    if (fileStat.size > MAX_GREP_FILE_BYTES) {
      oversizeSkipped++;
      continue;
    }
    let body: string;
    try {
      body = await readFile(filePath, 'utf-8');
    } catch {
      continue;
    }
    if (body.indexOf('\0') >= 0) {
      binarySkipped++;
      continue;
    }
    const lines = body.split('\n');
    let fileMatchCount = 0;
    for (let lineNo = 0; lineNo < lines.length; lineNo++) {
      if (fileMatchCount >= MAX_GREP_MATCHES_PER_FILE) break;
      if (Date.now() > deadline) {
        timeBudgetHit = true;
        break;
      }
      regex.lastIndex = 0;
      if (regex.test(lines[lineNo])) {
        matches.push(`${f.path}:${lineNo + 1}:${lines[lineNo]}`);
        fileMatchCount++;
        totalMatches++;
      }
    }
    if (timeBudgetHit) break;
  }

  const summaryParts: string[] = [
    `[matched ${totalMatches} line(s) across ${files.length} file(s); cap=${limit}`,
  ];
  if (binarySkipped) summaryParts.push(`binarySkipped=${binarySkipped}`);
  if (oversizeSkipped) summaryParts.push(`oversizeSkipped=${oversizeSkipped}`);
  if (timeBudgetHit) summaryParts.push(`time-budget-hit (${MAX_GREP_TOTAL_WALL_MS}ms)`);
  summaryParts.push(']');
  const summary = summaryParts.join('; ');

  if (matches.length === 0) {
    return { content: `（无匹配） ${summary}` };
  }
  return { content: matches.join('\n') + '\n\n' + summary };
}

export async function createWorkspaceArtifactPayload(
  input: CreateArtifactInput,
  workspace: WorkspaceRef,
  guard?: PathGuard,
): Promise<WorkspaceArtifactPayload> {
  const fullPath = resolveInsideWorkspace(workspace.root, input.file_path);
  guard?.(fullPath);
  const relPath = relativeWorkspacePath(workspace.root, fullPath);
  assertNotDenied(relPath, ARTIFACT_DENY_PATTERNS, (path) => `CreateArtifact: refused sensitive path ${path}`);
  const lst = await lstat(fullPath);
  if (lst.isSymbolicLink()) {
    throw new Error(`CreateArtifact: refused symlink ${relPath}`);
  }
  const st = await stat(fullPath);
  if (!st.isFile()) {
    throw new Error('CreateArtifact: source must be a file');
  }
  if (st.size > MAX_ARTIFACT_PAYLOAD_BYTES) {
    throw new Error(`CreateArtifact: file too large (${st.size}B > ${MAX_ARTIFACT_PAYLOAD_BYTES}B)`);
  }
  const data = await readFile(fullPath);
  return {
    sourcePath: normalizePath(relPath),
    fileName: basename(fullPath),
    sizeBytes: data.byteLength,
    dataBase64: data.toString('base64'),
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.mime_type ? { mimeType: input.mime_type } : {}),
  };
}

export function workspaceArtifactPreparedContent(payload: WorkspaceArtifactPayload): string {
  return JSON.stringify({
    sourcePath: payload.sourcePath,
    fileName: payload.fileName,
    sizeBytes: payload.sizeBytes,
  }, null, 2);
}

function globToRegExp(pattern: string): RegExp {
  const segs = pattern.split('/');
  const re: string[] = [];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '**') {
      if (i === 0) {
        re.push('(?:.*/)?');
      } else if (i === segs.length - 1) {
        re[re.length - 1] = re[re.length - 1].replace(/\/$/, '(?:/.*)?');
      } else {
        re.push('(?:.*/)?');
      }
      continue;
    }
    re.push(segmentToRegex(seg));
    if (i < segs.length - 1) re[re.length - 1] += '/';
  }
  return new RegExp('^' + re.join('') + '$');
}

function segmentToRegex(seg: string): string {
  let i = 0;
  let out = '';
  while (i < seg.length) {
    const ch = seg[i];
    if (ch === '*') {
      out += '[^/]*';
      i++;
    } else if (ch === '?') {
      out += '[^/]';
      i++;
    } else if (ch === '[') {
      const close = seg.indexOf(']', i + 1);
      if (close === -1) {
        out += '\\[';
        i++;
      } else {
        let body = seg.slice(i + 1, close);
        if (body.startsWith('!')) body = '^' + body.slice(1);
        body = body.replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
        out += '[' + body + ']';
        i = close + 1;
      }
    } else if ('.+()|^$\\{}'.includes(ch)) {
      out += '\\' + ch;
      i++;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

async function walkWorkspace(
  baseDir: string,
  cwd: string,
  guard?: PathGuard,
  opts: { maxPaths: number; maxDepth: number } = { maxPaths: MAX_GLOB_PATHS, maxDepth: MAX_GLOB_DEPTH },
): Promise<{ path: string; mtimeMs: number }[]> {
  const results: { path: string; mtimeMs: number }[] = [];

  const walk = async (current: string, depth: number): Promise<void> => {
    if (results.length >= opts.maxPaths || depth > opts.maxDepth) return;
    guard?.(current);
    let dirents;
    try {
      dirents = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (results.length >= opts.maxPaths) break;
      if (GLOB_SKIP_DIRS.has(dirent.name)) continue;
      if (dirent.isSymbolicLink()) continue;
      const full = join(current, dirent.name);
      guard?.(full);
      if (dirent.isDirectory()) {
        await walk(full, depth + 1);
      } else if (dirent.isFile()) {
        if (GLOB_SKIP_FILE_PATTERNS.some((re) => re.test(dirent.name))) continue;
        try {
          const st = await lstat(full);
          if (st.isSymbolicLink()) continue;
          results.push({ path: relative(cwd, full), mtimeMs: st.mtimeMs });
        } catch {
          // ignore
        }
      }
    }
  };
  await walk(baseDir, 0);
  return results;
}

function resolveInsideWorkspace(cwd: string, inputPath: string): string {
  const fullPath = isAbsolute(inputPath) ? resolve(inputPath) : resolve(cwd, inputPath);
  const rel = relative(cwd, fullPath);
  if (rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))) {
    return fullPath;
  }
  throw new Error(`Access denied: path outside workspace (${inputPath})`);
}

function relativeWorkspacePath(cwd: string, fullPath: string): string {
  return relative(cwd, fullPath) || '.';
}

function normalizeForMatch(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

function normalizePath(p: string): string {
  return p.split(sep).join('/');
}

function assertNotDenied(relPath: string, patterns: RegExp[], message: (path: string) => string): void {
  const normalized = normalizePath(relPath);
  for (const re of patterns) {
    if (re.test('/' + normalized)) {
      throw new Error(message(relPath));
    }
  }
}

// Tiny exported marker for tests that need a stable payload shape without parsing transcript content.
export const WORKSPACE_ARTIFACT_PAYLOAD_METADATA_KEY = 'artifactPayload';
