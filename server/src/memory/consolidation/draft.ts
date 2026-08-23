import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readlink,
  realpath,
  rename,
  rm,
  type FileHandle,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';

import type {
  AuthorizedToolCall,
  ToolCallContext,
  ToolResult,
} from '../../agent/toolRuntime.js';

const MAX_READ_BYTES = 128 * 1024;
const MAX_READ_LINES = 2_000;
const MAX_DRAFT_FILE_BYTES = 1024 * 1024;
const MAX_DRAFT_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_DRAFT_FILES = 256;

type DraftContent = string | null;

interface MemoryDraft {
  rootPath: string;
  rootHandle: FileHandle;
  rootDev: number;
  rootIno: number;
  baseline: Map<string, DraftContent>;
  staged: Map<string, DraftContent>;
  queue: Promise<void>;
  closing: boolean;
  closePromise?: Promise<void>;
}

export class MemoryConsolidationDraftConflictError extends Error {
  constructor(readonly relativePath: string) {
    super(`记忆文件在审查期间已变化，拒绝覆盖：${relativePath}`);
    this.name = 'MemoryConsolidationDraftConflictError';
  }
}

const drafts = new Map<string, MemoryDraft>();
const draftCreations = new Map<string, { rootPath: string; promise: Promise<MemoryDraft> }>();
const draftClosures = new Map<string, Promise<void>>();

export interface MemoryCommitJournal {
  version: 1;
  entries: Array<{ relativePath: string; baseline: DraftContent; staged: string }>;
}

function isMemoryRelativePath(path: string): boolean {
  if (path.includes('\\')) return false;
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return false;
  return path === 'MEMORY.md'
    || (segments.length > 1 && segments[0] === 'memory' && path.endsWith('.md'));
}

async function assertNoSymlinkBelow(root: string, target: string): Promise<void> {
  let cursor = target;
  while (cursor !== root) {
    try {
      if ((await lstat(cursor)).isSymbolicLink()) {
        throw new Error(`记忆审查工具约束：拒绝符号链接路径 ${relative(root, cursor)}。`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

async function resolveThroughExistingAncestors(target: string): Promise<string> {
  let cursor = target;
  const suffix: string[] = [];
  while (true) {
    try {
      return resolve(await realpath(cursor), ...suffix);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      try {
        const entry = await lstat(cursor);
        if (entry.isSymbolicLink()) {
          const linkTarget = await readlink(cursor);
          const resolvedLink = isAbsolute(linkTarget)
            ? resolve(linkTarget)
            : resolve(dirname(cursor), linkTarget);
          return resolveThroughExistingAncestors(resolve(resolvedLink, ...suffix));
        }
      } catch (linkError) {
        const linkCode = (linkError as NodeJS.ErrnoException).code;
        if (linkCode !== 'ENOENT' && linkCode !== 'ENOTDIR') throw linkError;
      }
      const parent = dirname(cursor);
      if (parent === cursor) return resolve(target);
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

export async function resolveMemoryMarkdownPath(
  workspaceRoot: string,
  rawPath: string,
): Promise<{ relativePath: string; fullPath: string }> {
  const root = resolve(workspaceRoot);
  const target = isAbsolute(rawPath) ? resolve(rawPath) : resolve(join(root, rawPath));
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`记忆审查工具约束：目标越界 workspace（${rawPath}）。`);
  }
  const normalized = rel.split('\\').join('/');
  if (!isMemoryRelativePath(normalized)) {
    throw new Error(`记忆审查工具约束：只允许访问 MEMORY.md 或 memory/**/*.md，拒绝 ${normalized}。`);
  }
  await assertNoSymlinkBelow(root, target);
  const [canonicalRoot, canonicalTarget] = await Promise.all([
    resolveThroughExistingAncestors(root),
    resolveThroughExistingAncestors(target),
  ]);
  const canonicalRel = relative(canonicalRoot, canonicalTarget).split('\\').join('/');
  if (canonicalRel.startsWith('..') || isAbsolute(canonicalRel) || !isMemoryRelativePath(canonicalRel)) {
    throw new Error(`记忆审查工具约束：${rawPath} 经符号链接越出记忆 Markdown 边界。`);
  }
  return { relativePath: normalized, fullPath: target };
}

async function openFixedRoot(rootInput: string): Promise<{
  rootPath: string; rootHandle: FileHandle; rootDev: number; rootIno: number;
}> {
  const rootPath = resolve(rootInput);
  const before = await lstat(rootPath);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error('记忆审查工具约束：workspace root 必须是真实目录。');
  }
  const rootHandle = await open(
    rootPath,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    const opened = await rootHandle.stat();
    if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('记忆审查工具约束：workspace root 在固定目录句柄时发生变化。');
    }
    return { rootPath, rootHandle, rootDev: opened.dev, rootIno: opened.ino };
  } catch (error) {
    await rootHandle.close().catch(() => undefined);
    throw error;
  }
}

async function assertRootCurrent(draft: MemoryDraft): Promise<void> {
  const current = await lstat(draft.rootPath);
  if (!current.isDirectory() || current.isSymbolicLink()
    || current.dev !== draft.rootDev || current.ino !== draft.rootIno) {
    throw new Error('记忆审查工具约束：workspace root 在草稿期间发生变化。');
  }
}

async function draftFor(context: ToolCallContext): Promise<MemoryDraft> {
  if (!context.sessionId) throw new Error('记忆审查草稿缺少 sessionId。');
  const rootPath = resolve(context.workspace.root);
  if (draftClosures.has(context.sessionId)) throw new Error('记忆审查草稿正在关闭。');
  const existing = drafts.get(context.sessionId);
  if (existing) {
    if (existing.rootPath !== rootPath) throw new Error('记忆审查草稿 workspace 在同一会话内发生变化。');
    if (existing.closing) throw new Error('记忆审查草稿正在关闭。');
    return existing;
  }
  const pending = draftCreations.get(context.sessionId);
  if (pending) {
    if (pending.rootPath !== rootPath) throw new Error('记忆审查草稿 workspace 在同一会话内发生变化。');
    return pending.promise;
  }
  const creation = (async () => {
    const root = await openFixedRoot(rootPath);
    const created: MemoryDraft = {
      ...root,
      baseline: new Map(),
      staged: new Map(),
      queue: Promise.resolve(),
      closing: false,
    };
    drafts.set(context.sessionId!, created);
    return created;
  })();
  draftCreations.set(context.sessionId, { rootPath, promise: creation });
  try {
    return await creation;
  } finally {
    draftCreations.delete(context.sessionId);
  }
}

async function withDraft<T>(draft: MemoryDraft, action: () => Promise<T>): Promise<T> {
  if (draft.closing) throw new Error('记忆审查草稿正在关闭。');
  const previous = draft.queue;
  let release!: () => void;
  draft.queue = new Promise<void>((resolveQueue) => { release = resolveQueue; });
  await previous;
  try {
    if (draft.closing) throw new Error('记忆审查草稿正在关闭。');
    return await action();
  } finally {
    release();
  }
}

async function readCurrent(rootHandle: FileHandle, relativePath: string): Promise<DraftContent> {
  let directoryHandle: FileHandle | undefined;
  let fileHandle: FileHandle | undefined;
  try {
    directoryHandle = await openSafeParentDirectory(rootHandle, relativePath, false);
    const target = join(`/proc/self/fd/${directoryHandle.fd}`, basename(relativePath));
    try {
      fileHandle = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ELOOP') {
        throw new Error(`记忆审查工具约束：拒绝符号链接文件 ${relativePath}。`);
      }
      throw error;
    }
    const entry = await fileHandle.stat();
    if (!entry.isFile()) throw new Error(`Read: path is not a file (${relativePath})`);
    if (entry.size > MAX_DRAFT_FILE_BYTES) {
      throw new Error(`记忆审查草稿拒绝超过 ${MAX_DRAFT_FILE_BYTES} 字节的文件：${relativePath}`);
    }
    return await fileHandle.readFile('utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  } finally {
    await fileHandle?.close().catch(() => undefined);
    await directoryHandle?.close().catch(() => undefined);
  }
}

function stagedBytes(draft: MemoryDraft, replacingPath?: string, replacingContent?: DraftContent): number {
  let total = 0;
  for (const [path, content] of draft.staged) {
    const effective = path === replacingPath ? replacingContent : content;
    if (effective !== null && effective !== undefined) total += Buffer.byteLength(effective);
  }
  if (replacingPath && !draft.staged.has(replacingPath) && replacingContent !== null && replacingContent !== undefined) {
    total += Buffer.byteLength(replacingContent);
  }
  return total;
}

function assertBaselineCapacity(
  draft: MemoryDraft,
  relativePath: string,
  content: DraftContent,
): void {
  let total = content === null ? 0 : Buffer.byteLength(content);
  for (const [path, baseline] of draft.baseline) {
    if (path !== relativePath && baseline !== null) total += Buffer.byteLength(baseline);
  }
  if (total > MAX_DRAFT_TOTAL_BYTES) {
    throw new Error(`记忆审查草稿 baseline 总大小超过上限 ${MAX_DRAFT_TOTAL_BYTES} 字节。`);
  }
}

function assertDraftCapacity(draft: MemoryDraft, relativePath: string, content: DraftContent): void {
  if (!draft.staged.has(relativePath) && draft.staged.size >= MAX_DRAFT_FILES) {
    throw new Error(`记忆审查草稿文件数超过上限 ${MAX_DRAFT_FILES}。`);
  }
  if (content !== null && Buffer.byteLength(content) > MAX_DRAFT_FILE_BYTES) {
    throw new Error(`记忆审查草稿单文件超过上限 ${MAX_DRAFT_FILE_BYTES} 字节：${relativePath}`);
  }
  if (stagedBytes(draft, relativePath, content) > MAX_DRAFT_TOTAL_BYTES) {
    throw new Error(`记忆审查草稿总大小超过上限 ${MAX_DRAFT_TOTAL_BYTES} 字节。`);
  }
}

async function ensureLoaded(draft: MemoryDraft, relativePath: string): Promise<DraftContent> {
  if (draft.staged.has(relativePath)) return draft.staged.get(relativePath) ?? null;
  const content = await readCurrent(draft.rootHandle, relativePath);
  assertBaselineCapacity(draft, relativePath, content);
  assertDraftCapacity(draft, relativePath, content);
  draft.baseline.set(relativePath, content);
  draft.staged.set(relativePath, content);
  return content;
}

function formatRead(content: string, relativePath: string, input: Record<string, unknown>): ToolResult {
  const offset = typeof input.offset === 'number' ? Math.max(1, Math.trunc(input.offset)) : undefined;
  const limit = typeof input.limit === 'number'
    ? Math.min(MAX_READ_LINES, Math.max(1, Math.trunc(input.limit)))
    : undefined;
  if (offset !== undefined || limit !== undefined) {
    const lines = content.split('\n');
    const start = (offset ?? 1) - 1;
    const selected = lines.slice(start, start + (limit ?? MAX_READ_LINES)).join('\n');
    return {
      content: selected,
      metadata: { path: relativePath, fileBytes: Buffer.byteLength(content), linesRead: selected ? selected.split('\n').length : 0, ranged: true },
    };
  }
  const bytes = Buffer.byteLength(content);
  if (bytes <= MAX_READ_BYTES) {
    return {
      content,
      metadata: { path: relativePath, fileBytes: bytes, linesRead: content ? content.split('\n').length : 0 },
    };
  }
  const prefix = Buffer.from(content).subarray(0, MAX_READ_BYTES).toString('utf8');
  return {
    content: `${prefix}\n...[truncated: file ${relativePath} is ${bytes} bytes; showing first ${MAX_READ_BYTES} bytes. Use Read with {"path":"${relativePath}","offset":1,"limit":${MAX_READ_LINES}} to continue by line chunks.]`,
    metadata: { path: relativePath, fileBytes: bytes, truncated: true, shownBytes: MAX_READ_BYTES },
  };
}

/**
 * L2 隐藏审查的文件调用只作用于进程内草稿。真实 Markdown 在 Run 成功后，
 * 由 engine 持短时用户锁并完成冲突校验后提交。
 */
export async function invokeMemoryConsolidationDraftTool(
  call: AuthorizedToolCall,
  context: ToolCallContext,
  relativePath: string,
): Promise<ToolResult> {
  if (context.signal?.aborted) throw new Error(String(context.signal.reason ?? 'run aborted'));
  const draft = await draftFor(context);
  return withDraft(draft, async () => {
    await assertRootCurrent(draft);
    const input = (call.input ?? {}) as Record<string, unknown>;
    const current = await ensureLoaded(draft, relativePath);
    if (call.toolId === 'Read') {
      if (current === null) throw new Error(`Read: cannot read ${relativePath} (file not found)`);
      return formatRead(current, relativePath, input);
    }
    if (call.toolId === 'Write') {
      if (typeof input.content !== 'string') throw new Error('Write: content must be a string.');
      assertDraftCapacity(draft, relativePath, input.content);
      draft.staged.set(relativePath, input.content);
      return {
        content: `staged ${relativePath} (${input.content.length} chars)`,
        metadata: { path: relativePath, bytesWritten: input.content.length, staged: true },
      };
    }
    if (call.toolId === 'Edit') {
      if (current === null) throw new Error(`Edit: cannot read ${relativePath} (file not found)`);
      const oldString = input.old_string;
      const newString = input.new_string;
      if (typeof oldString !== 'string' || typeof newString !== 'string') {
        throw new Error('Edit: old_string and new_string must be strings.');
      }
      if (!oldString) throw new Error('Edit: empty old_string not allowed; use Write for new files.');
      if (oldString === newString) throw new Error('Edit: old_string equals new_string; no-op.');
      const occurrences = current.split(oldString).length - 1;
      if (occurrences === 0) throw new Error('Edit: old_string not found.');
      if (input.replace_all !== true && occurrences > 1) {
        throw new Error(`Edit: old_string matched ${occurrences} times; supply more surrounding context or set replace_all=true.`);
      }
      const updated = current.split(oldString).join(newString);
      assertDraftCapacity(draft, relativePath, updated);
      draft.staged.set(relativePath, updated);
      const replacements = input.replace_all === true ? occurrences : 1;
      return {
        content: `Staged ${relativePath} (${replacements} replacement${replacements === 1 ? '' : 's'}, ${updated.length} bytes).`,
        metadata: {
          path: relativePath,
          replacements,
          occurrences,
          bytesBefore: current.length,
          bytesAfter: updated.length,
          staged: true,
        },
      };
    }
    throw new Error(`记忆审查草稿不支持工具 ${call.toolId}。`);
  });
}

function digest(content: DraftContent): string {
  return createHash('sha256').update(content === null ? '\u0000missing' : content).digest('hex');
}

async function openSafeParentDirectory(
  rootHandle: FileHandle,
  relativePath: string,
  create: boolean,
): Promise<FileHandle> {
  if (!isMemoryRelativePath(relativePath)) {
    throw new Error(`记忆审查工具约束：提交路径越界 ${relativePath}。`);
  }
  const parentRel = dirname(relativePath);
  let current = await open(
    `/proc/self/fd/${rootHandle.fd}`,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY,
  );
  try {
    for (const segment of parentRel === '.' ? [] : parentRel.split('/')) {
      const child = join(`/proc/self/fd/${current.fd}`, segment);
      if (create) {
        await mkdir(child, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        });
      }
      let next: FileHandle;
      try {
        next = await open(child, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ELOOP' || code === 'ENOTDIR') {
          throw new Error(`记忆审查工具约束：拒绝符号链接目录 ${segment}。`);
        }
        throw error;
      }
      await current.close();
      current = next;
    }
    return current;
  } catch (error) {
    await current.close().catch(() => undefined);
    throw error;
  }
}

async function safeRemove(rootHandle: FileHandle, relativePath: string): Promise<void> {
  let directoryHandle: FileHandle | undefined;
  try {
    directoryHandle = await openSafeParentDirectory(rootHandle, relativePath, false);
    const target = join(`/proc/self/fd/${directoryHandle.fd}`, basename(relativePath));
    const entry = await lstat(target);
    if (entry.isSymbolicLink()) {
      throw new Error(`记忆审查工具约束：拒绝符号链接文件 ${relativePath}。`);
    }
    await rm(target);
    await directoryHandle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  } finally {
    await directoryHandle?.close().catch(() => undefined);
  }
}

async function atomicWrite(rootHandle: FileHandle, relativePath: string, content: string): Promise<void> {
  const directoryHandle = await openSafeParentDirectory(rootHandle, relativePath, true);
  const descriptorRoot = `/proc/self/fd/${directoryHandle.fd}`;
  const target = join(descriptorRoot, basename(relativePath));
  const temporary = join(descriptorRoot, `.${basename(relativePath)}.consolidation-${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    const existingMode = await lstat(target).then((entry) => {
      if (entry.isSymbolicLink()) throw new Error(`记忆审查工具约束：拒绝符号链接文件 ${relativePath}。`);
      if (!entry.isFile()) throw new Error(`记忆审查工具约束：目标不是文件 ${relativePath}。`);
      return entry.mode & 0o777;
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return 0o600;
      throw error;
    });
    handle = await open(temporary, 'wx', existingMode);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    await directoryHandle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    await directoryHandle.close().catch(() => undefined);
  }
}

function validateCommitJournal(raw: unknown): MemoryCommitJournal {
  const parsed = raw as Partial<MemoryCommitJournal> | null;
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)
    || parsed.entries.length > MAX_DRAFT_FILES) {
    throw new Error('无效的记忆提交恢复记录。');
  }
  let stagedTotalBytes = 0;
  let baselineTotalBytes = 0;
  const paths = new Set<string>();
  for (const entry of parsed.entries) {
    if (typeof entry?.relativePath !== 'string' || !isMemoryRelativePath(entry.relativePath)
      || paths.has(entry.relativePath)
      || (entry.baseline !== null && typeof entry.baseline !== 'string')
      || typeof entry.staged !== 'string') {
      throw new Error('无效的记忆提交恢复记录条目。');
    }
    paths.add(entry.relativePath);
    const stagedBytes = Buffer.byteLength(entry.staged);
    const baselineBytes = entry.baseline === null ? 0 : Buffer.byteLength(entry.baseline);
    if (stagedBytes > MAX_DRAFT_FILE_BYTES || baselineBytes > MAX_DRAFT_FILE_BYTES) {
      throw new Error('记忆提交恢复记录单文件内容超过上限。');
    }
    stagedTotalBytes += stagedBytes;
    baselineTotalBytes += baselineBytes;
    if (stagedTotalBytes > MAX_DRAFT_TOTAL_BYTES || baselineTotalBytes > MAX_DRAFT_TOTAL_BYTES) {
      throw new Error('记忆提交恢复记录内容超过上限。');
    }
  }
  return parsed as MemoryCommitJournal;
}

export async function recoverMemoryConsolidationPreparedCommit(
  rootInput: string,
  rawJournal: unknown,
): Promise<number> {
  const root = await openFixedRoot(rootInput);
  try {
    const journal = validateCommitJournal(rawJournal);
    const pending: Array<{ relativePath: string; staged: string }> = [];
    for (const entry of journal.entries) {
      const current = await readCurrent(root.rootHandle, entry.relativePath);
      if (digest(current) === digest(entry.staged)) continue;
      if (digest(current) !== digest(entry.baseline)) {
        throw new MemoryConsolidationDraftConflictError(entry.relativePath);
      }
      pending.push({ relativePath: entry.relativePath, staged: entry.staged });
    }
    for (const entry of pending) {
      await atomicWrite(root.rootHandle, entry.relativePath, entry.staged);
    }
    return pending.length;
  } finally {
    await root.rootHandle.close().catch(() => undefined);
  }
}

export async function rollbackMemoryConsolidationPreparedCommit(
  rootInput: string,
  rawJournal: unknown,
): Promise<number> {
  const root = await openFixedRoot(rootInput);
  try {
    const journal = validateCommitJournal(rawJournal);
    const pending: Array<{ relativePath: string; baseline: DraftContent }> = [];
    for (const entry of journal.entries) {
      const current = await readCurrent(root.rootHandle, entry.relativePath);
      if (digest(current) === digest(entry.staged)) {
        pending.push({ relativePath: entry.relativePath, baseline: entry.baseline });
      }
    }
    for (const entry of pending) {
      if (entry.baseline === null) await safeRemove(root.rootHandle, entry.relativePath);
      else await atomicWrite(root.rootHandle, entry.relativePath, entry.baseline);
    }
    return pending.length;
  } finally {
    await root.rootHandle.close().catch(() => undefined);
  }
}

async function draftBySession(sessionId: string): Promise<MemoryDraft | undefined> {
  const draft = drafts.get(sessionId);
  if (draft) return draft;
  return draftCreations.get(sessionId)?.promise;
}

export async function inspectMemoryConsolidationDraft(
  sessionId: string,
): Promise<{ changedFiles: string[]; commitJournal: MemoryCommitJournal }> {
  const draft = await draftBySession(sessionId);
  if (!draft) return { changedFiles: [], commitJournal: { version: 1, entries: [] } };
  return withDraft(draft, async () => {
    await assertRootCurrent(draft);
    const changed = [...draft.staged.entries()].filter(([path, content]) => (
      digest(content) !== digest(draft.baseline.get(path) ?? null)
    ));
    const commitJournal: MemoryCommitJournal = {
      version: 1,
      entries: changed.flatMap(([relativePath, staged]) => staged === null ? [] : [{
        relativePath,
        baseline: draft.baseline.get(relativePath) ?? null,
        staged,
      }]),
    };
    validateCommitJournal(commitJournal);
    return { changedFiles: changed.map(([path]) => path), commitJournal };
  });
}

export async function commitMemoryConsolidationDraft(
  sessionId: string,
): Promise<{ changedFiles: string[] }> {
  const draft = await draftBySession(sessionId);
  if (!draft) return { changedFiles: [] };
  return withDraft(draft, async () => {
    await assertRootCurrent(draft);
    const changed = [...draft.staged.entries()].filter(([path, content]) => (
      digest(content) !== digest(draft.baseline.get(path) ?? null)
    ));
    for (const [relativePath] of changed) {
      const current = await readCurrent(draft.rootHandle, relativePath);
      if (digest(current) !== digest(draft.baseline.get(relativePath) ?? null)) {
        throw new MemoryConsolidationDraftConflictError(relativePath);
      }
    }
    const committed: Array<{ relativePath: string; baseline: DraftContent }> = [];
    try {
      for (const [relativePath, content] of changed) {
        if (content === null) continue;
        await atomicWrite(draft.rootHandle, relativePath, content);
        committed.push({ relativePath, baseline: draft.baseline.get(relativePath) ?? null });
      }
    } catch (error) {
      for (const entry of committed.reverse()) {
        try {
          if (entry.baseline === null) await safeRemove(draft.rootHandle, entry.relativePath);
          else await atomicWrite(draft.rootHandle, entry.relativePath, entry.baseline);
        } catch {
          // durable prepared journal 会在下一次 claim 时按 baseline/staged 状态补齐。
        }
      }
      throw error;
    }
    drafts.delete(sessionId);
    void trackDraftClosure(sessionId, draft).catch(() => undefined);
    return { changedFiles: changed.map(([path]) => path) };
  });
}

function disposeDraft(draft: MemoryDraft): Promise<void> {
  if (!draft.closing) {
    draft.closing = true;
    const drained = draft.queue;
    draft.closePromise = drained.then(() => draft.rootHandle.close());
  }
  return draft.closePromise ?? Promise.resolve();
}

function trackDraftClosure(sessionId: string, draft: MemoryDraft): Promise<void> {
  const existing = draftClosures.get(sessionId);
  if (existing) return existing;
  const closing = disposeDraft(draft).finally(() => {
    if (draftClosures.get(sessionId) === closing) draftClosures.delete(sessionId);
  });
  draftClosures.set(sessionId, closing);
  return closing;
}

export async function discardMemoryConsolidationDraft(
  sessionId: string | undefined,
): Promise<void> {
  if (!sessionId) return;
  const closing: Promise<void>[] = [];
  const tracked = draftClosures.get(sessionId);
  if (tracked) closing.push(tracked);
  const draft = drafts.get(sessionId);
  drafts.delete(sessionId);
  if (draft) closing.push(trackDraftClosure(sessionId, draft));
  const pending = draftCreations.get(sessionId);
  if (pending) {
    closing.push(pending.promise.then((created) => {
      if (drafts.get(sessionId) === created) drafts.delete(sessionId);
      return trackDraftClosure(sessionId, created);
    }));
  }
  await Promise.all(closing);
}
