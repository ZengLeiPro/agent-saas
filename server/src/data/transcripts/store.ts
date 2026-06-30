/**
 * 会话存储操作模块
 *
 * 提供会话列表、定位、删除等操作。
 */
import * as fs from "node:fs/promises";
import { Dirent } from "node:fs";
import * as path from "node:path";
import {
  AGENT_LEGACY_TRANSCRIPTS_ROOT,
  assertAllowedTranscriptPath,
  deriveProjectKey,
  getAnonymousAgentTranscriptDir,
  getAgentTranscriptDir,
  hasTranscriptOwnerRef,
  isValidSessionId,
  type TranscriptOwnerRef,
} from "./projectKey.js";

export interface SessionListItem {
  sessionId: string;
  /** Logical source bucket. New layout uses tenantId/userId; legacy layout keeps cwd-derived projectKey. */
  projectKey: string;
  updatedAtMs: number;
  createdAtMs?: number;
  title?: string;
  preview?: string;
  source?: { type: string; label: string };
  /** Internal absolute path used by server-side readers; must not be exposed in API responses. */
  transcriptPath?: string;
}

/**
 * 获取 transcript 文件路径。
 *
 * 新会话在调用方提供 tenantId + userId 时写入 Agent SaaS canonical layout：
 *   ~/.agent-saas/legacy-transcripts/<tenantId>/<userId>/<sessionId>.jsonl
 *
 * 缺少 owner 的旧调用方写入 Agent SaaS ownerless dev/test layout：
 *   ~/.agent-saas/legacy-transcripts/__anonymous/<cwd-projectKey>/<sessionId>.jsonl
 */
export function getTranscriptPath(
  cwd: string,
  sessionId: string,
  owner?: TranscriptOwnerRef,
): string {
  if (hasTranscriptOwnerRef(owner)) {
    return path.join(getAgentTranscriptDir(owner), `${sessionId}.jsonl`);
  }
  return path.join(getAnonymousAgentTranscriptDir(cwd), `${sessionId}.jsonl`);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listTranscriptFilesRecursive(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...await listTranscriptFilesRecursive(full));
    } else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
      const sessionId = ent.name.replace(/\.jsonl$/, '');
      if (isValidSessionId(sessionId)) out.push(full);
    }
  }
  return out;
}

async function listMetaFilesRecursive(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...await listMetaFilesRecursive(full));
    } else if (ent.isFile() && ent.name.endsWith('.meta.json')) {
      const sessionId = ent.name.replace(/\.meta\.json$/, '');
      if (isValidSessionId(sessionId)) out.push(full);
    }
  }
  return out;
}

/**
 * 通过 sessionId 查找 transcript 路径（全局扫描）。
 * 仅扫描新 Agent SaaS layout；旧 cwd-derived transcript root 不再作为在线会话读路径。
 */
export async function findTranscriptPathBySessionId(
  sessionId: string
): Promise<string | null> {
  if (!isValidSessionId(sessionId)) return null;

  const files = await listTranscriptFilesRecursive(AGENT_LEGACY_TRANSCRIPTS_ROOT);
  const match = files.find((file) => path.basename(file) === `${sessionId}.jsonl`);
  if (match) return match;
  return null;
}

/**
 * 通过 sessionId 查找会话路径。
 *
 * 优先返回真实 .jsonl transcript；当 enqueue-only 会话刚创建、legacy
 * transcript 还没被 projection 写出时，fallback 到 .meta.json 对应的虚拟
 * transcript 路径，供 readSessionMeta / runtime event store 定位使用。
 */
export async function findTranscriptOrMetaPathBySessionId(
  sessionId: string
): Promise<string | null> {
  return (await findTranscriptPathBySessionId(sessionId))
    ?? (await findMetaPathBySessionId(sessionId));
}

/**
 * 读取文件首行（最多 1KB），用于快速类型判定
 * 返回 null 表示读取失败或首行为空
 */
async function readFirstLine(fullPath: string): Promise<string | null> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(fullPath, 'r');
    const buf = Buffer.alloc(1024);
    const { bytesRead } = await handle.read(buf, 0, 1024, 0);
    if (bytesRead === 0) return null;
    const text = buf.slice(0, bytesRead).toString('utf-8');
    const nl = text.indexOf('\n');
    return nl === -1 ? text : text.slice(0, nl);
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => { /* noop */ });
  }
}

/**
 * 判断 transcript 是否是 title-generator 的副产物（幽灵文件）
 */
async function isAiTitleOnlyTranscript(fullPath: string): Promise<boolean> {
  const firstLine = await readFirstLine(fullPath);
  if (!firstLine) return false;
  return firstLine.includes('"type":"ai-title"');
}

async function listSessionsInDir(
  dir: string,
  projectKey: string,
): Promise<SessionListItem[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates: { sessionId: string; fullPath: string }[] = [];
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith(".jsonl")) continue;
    const sessionId = ent.name.replace(/\.jsonl$/, "");
    if (!isValidSessionId(sessionId)) continue;
    candidates.push({ sessionId, fullPath: path.join(dir, ent.name) });
  }

  const statResults = await Promise.all(
    candidates.map(async ({ sessionId, fullPath }) => {
      const stat = await fs.stat(fullPath);
      if (stat.size === 0) return null;
      if (stat.size < 4096) {
        const isGhost = await isAiTitleOnlyTranscript(fullPath);
        if (isGhost) return null;
      }
      return { sessionId, projectKey, updatedAtMs: stat.mtimeMs, transcriptPath: fullPath } as SessionListItem;
    })
  );
  return statResults.filter((s): s is SessionListItem => s !== null);
}

/**
 * 扫描指定 ownerless projectKey 下的所有 dev/test 会话。
 */
export async function listSessionsByProjectKey(
  projectKey: string,
  options?: { limit?: number; before?: number }
): Promise<{ items: SessionListItem[]; hasMore: boolean }> {
  let sessions = await listSessionsInDir(
    path.join(AGENT_LEGACY_TRANSCRIPTS_ROOT, "__anonymous", projectKey),
    `__anonymous/${projectKey}`,
  );
  sessions.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  if (options?.before) sessions = sessions.filter(s => s.updatedAtMs < options.before!);
  const limit = options?.limit ?? 200;
  return { items: sessions.slice(0, limit), hasMore: sessions.length > limit };
}

/**
 * 扫描指定 cwd/owner 对应的所有会话。
 * 仅扫描新 Agent SaaS layout；旧 cwd-derived projectKey 不再作为在线会话 fallback。
 */
export async function listSessions(
  cwd: string,
  options?: { limit?: number; before?: number; owner?: TranscriptOwnerRef }
): Promise<{ items: SessionListItem[]; hasMore: boolean }> {
  let sessions = hasTranscriptOwnerRef(options?.owner)
    ? await listSessionsInDir(
      getAgentTranscriptDir(options.owner),
      `${options.owner.tenantId}/${options.owner.userId}`,
    )
    : await listSessionsInDir(
      getAnonymousAgentTranscriptDir(cwd),
      `__anonymous/${deriveProjectKey(cwd)}`,
    );

  sessions = sessions.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  if (options?.before) sessions = sessions.filter(s => s.updatedAtMs < options.before!);
  const limit = options?.limit ?? 200;
  return { items: sessions.slice(0, limit), hasMore: sessions.length > limit };
}

/**
 * 删除会话及其相关文件
 */
export async function deleteSession(
  sessionId: string,
  options?: { deleteSidecarDir?: boolean }
): Promise<{ deleted: boolean; transcriptPath?: string; sidecarPath?: string }> {
  if (!isValidSessionId(sessionId)) throw new Error("Invalid sessionId format");

  const transcriptPath = await findTranscriptPathBySessionId(sessionId);
  if (!transcriptPath) return { deleted: false };

  assertAllowedTranscriptPath(transcriptPath);
  await fs.unlink(transcriptPath);

  const metaPath = transcriptPath.replace(/\.jsonl$/, '.meta.json');
  try { await fs.unlink(metaPath); } catch { /* meta may not exist */ }

  let sidecarPath: string | undefined;
  if (options?.deleteSidecarDir) {
    sidecarPath = path.join(path.dirname(transcriptPath), sessionId);
    try { await fs.rm(sidecarPath, { recursive: true, force: true }); } catch { /* noop */ }
  }

  return { deleted: true, transcriptPath, sidecarPath };
}

/** 检查会话是否存在 */
export async function sessionExists(
  cwd: string,
  sessionId: string,
  owner?: TranscriptOwnerRef,
): Promise<boolean> {
  const transcriptPath = getTranscriptPath(cwd, sessionId, owner);
  const exists = await pathExists(transcriptPath);
  if (exists) return true;
  return false;
}

/**
 * 通过 sessionId 查找 meta 文件路径（全局扫描）。
 * 返回虚拟 transcript 路径（.jsonl），与 readSessionMeta / getMetaPath 兼容。
 */
export async function findMetaPathBySessionId(
  sessionId: string
): Promise<string | null> {
  if (!isValidSessionId(sessionId)) return null;
  const metaFileName = `${sessionId}.meta.json`;
  const files = await listMetaFilesRecursive(AGENT_LEGACY_TRANSCRIPTS_ROOT);
  const match = files.find((file) => path.basename(file) === metaFileName);
  if (match) return match.replace(/\.meta\.json$/, '.jsonl');
  return null;
}

/** 删除孤儿会话的 meta 文件和 sidecar 目录 */
export async function deleteSessionMetaOnly(
  sessionId: string,
  options?: { deleteSidecarDir?: boolean }
): Promise<{ deleted: boolean }> {
  if (!isValidSessionId(sessionId)) throw new Error("Invalid sessionId format");

  const metaPath = await findMetaPathBySessionId(sessionId);
  if (!metaPath) return { deleted: false };

  const actualMetaPath = metaPath.replace(/\.jsonl$/, '.meta.json');
  assertAllowedTranscriptPath(actualMetaPath);

  try { await fs.unlink(actualMetaPath); } catch { return { deleted: false }; }

  if (options?.deleteSidecarDir) {
    const sidecarPath = path.join(path.dirname(actualMetaPath), sessionId);
    try { await fs.rm(sidecarPath, { recursive: true, force: true }); } catch { /* noop */ }
  }
  return { deleted: true };
}

export interface DeletedSessionMetaItem {
  sessionId: string;
  projectKey: string;
  metaPath: string;
  hasTranscript: boolean;
  updatedAtMs: number;
}

async function listSessionMetasInDir(
  dir: string,
  projectKey: string,
): Promise<DeletedSessionMetaItem[]> {
  let entries: string[];
  try { entries = await fs.readdir(dir); } catch { return []; }

  const candidates: { sessionId: string; metaFullPath: string }[] = [];
  for (const name of entries) {
    if (!name.endsWith('.meta.json')) continue;
    const sessionId = name.replace(/\.meta\.json$/, '');
    if (!isValidSessionId(sessionId)) continue;
    candidates.push({ sessionId, metaFullPath: path.join(dir, name) });
  }

  const results = await Promise.all(candidates.map(async ({ sessionId, metaFullPath }) => {
    try {
      const stat = await fs.stat(metaFullPath);
      const jsonlPath = path.join(dir, `${sessionId}.jsonl`);
      let hasTranscript = false;
      try {
        const jsonlStat = await fs.stat(jsonlPath);
        hasTranscript = jsonlStat.size > 0;
      } catch { /* no .jsonl */ }
      return { sessionId, projectKey, metaPath: jsonlPath, hasTranscript, updatedAtMs: stat.mtimeMs };
    } catch {
      return null;
    }
  }));
  return results.filter((r): r is DeletedSessionMetaItem => r !== null);
}

/** 扫描指定 ownerless projectKey 目录下所有 .meta.json 文件。 */
export async function listSessionMetasByProjectKey(
  projectKey: string,
): Promise<DeletedSessionMetaItem[]> {
  return listSessionMetasInDir(
    path.join(AGENT_LEGACY_TRANSCRIPTS_ROOT, "__anonymous", projectKey),
    `__anonymous/${projectKey}`,
  );
}

/** 扫描当前用户 Agent SaaS layout 下所有 .meta.json 文件（回收站专用）。 */
export async function listSessionMetas(
  cwd: string,
  owner?: TranscriptOwnerRef,
): Promise<DeletedSessionMetaItem[]> {
  const legacyProjectKey = deriveProjectKey(cwd);
  const batches: DeletedSessionMetaItem[][] = hasTranscriptOwnerRef(owner)
    ? [await listSessionMetasInDir(
      getAgentTranscriptDir(owner),
      `${owner.tenantId}/${owner.userId}`,
    )]
    : [await listSessionMetasByProjectKey(legacyProjectKey)];
  const byId = new Map<string, DeletedSessionMetaItem>();
  for (const item of batches.flat()) {
    const existing = byId.get(item.sessionId);
    if (!existing || item.updatedAtMs > existing.updatedAtMs) byId.set(item.sessionId, item);
  }
  return [...byId.values()];
}
