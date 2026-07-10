import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { isValidSessionId } from './projectKey.js';

export interface SessionMeta {
  userId: string;
  username: string;
  userRole?: 'admin' | 'user';
  /**
   * Tenant 归属（多组织改造 PR 5 起）。session 创建时由 dispatch 写入 user.tenantId；
   * 旧 session 缺失时按 owner 的 userStore.findById(userId).tenantId 解析。
   */
  tenantId?: string;
  channel: string;
  createdAt: string;
  /** raw runtime wake(sessionId) 需要的工作目录；历史会话可能缺失。 */
  cwd?: string;
  /** raw runtime 当前执行后端，用于 approval resume 时避免目标漂移。 */
  executionTarget?: string;
  /** Managed Agents hand workspace id；当前通常等于 sessionId。 */
  workspaceId?: string;
  /** legacy transcript JSONL 路径；只作过渡期定位用。 */
  transcriptPath?: string;
  /** raw runtime 状态，供 SessionCatalog 读取；非 raw 通道可忽略。 */
  runtimeStatus?: string;
  /** meta 最近一次由 runtime 更新的时间。 */
  updatedAt?: string;
  customTitle?: string;
  generatedTitle?: string;
  model?: string;
  /**
   * 公司级专职 Agent 绑定（2026-07 唯恩批次）。会话创建时由 dispatch/channel 写入；
   * 缺省 = 个人 Agent 会话（存量行为零变化）。PG meta_json 自动投影。
   */
  orgAgentId?: string;
  /** 软删除时间戳（ISO 8601），存在即表示已删除 */
  deletedAt?: string;
  /** 执行删除操作的用户名 */
  deletedBy?: string;
  /** 累积等效 API 成本（美元），每次 query 结束时累加 */
  totalCostUsd?: number;
  /** cron 触发时的任务名称，用于前端显示 */
  cronJobName?: string;
  /**
   * 会话种类（2026-07-06 子 agent 工具）。'subagent' = 父 run 经 Agent 工具派生的
   * hidden session：会话列表 API 过滤不展示，但 transcript / runtime events 完整
   * 保留，平台 admin Run Trace 可按 parentRunId 关联查看。
   */
  kind?: 'subagent';
}

export function getMetaPath(transcriptPath: string): string {
  const dir = dirname(transcriptPath);
  const sessionId = basename(transcriptPath, '.jsonl');
  return join(dir, `${sessionId}.meta.json`);
}

export async function readSessionMeta(transcriptPath: string): Promise<SessionMeta | null> {
  try {
    const raw = await readFile(getMetaPath(transcriptPath), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 原子写入：write-to-temp → rename（POSIX 同文件系统下 rename 是原子操作） */
async function atomicWriteJson(filePath: string, data: object): Promise<void> {
  // 确保目录存在（SDK 的 system/init 事件可能在 CLI 创建 transcript 目录之前就 emit，
  // 此时目录尚不存在，writeFile 会抛出 ENOENT）
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = filePath + '.tmp.' + randomBytes(4).toString('hex');
  await writeFile(tmpPath, JSON.stringify(data, null, 2));
  await rename(tmpPath, filePath);
}

/** Per-file 进程级互斥锁，序列化同一文件的 read-modify-write 操作 */
const metaLocks = new Map<string, Promise<unknown>>();
const projectionOperations = new Set<Promise<void>>();
const projectionTails = new Map<string, Promise<void>>();

export interface SessionMetaProjectionSink {
  upsert(transcriptPath: string, meta: SessionMeta): Promise<void> | void;
  delete(sessionId: string): Promise<void> | void;
}

export interface SessionMetaProjectionStats {
  failures: number;
  lastError?: string;
  pending: number;
}

let projectionSink: SessionMetaProjectionSink | undefined;
let projectionFailures = 0;
let lastProjectionError: string | undefined;

export function setSessionMetaProjectionSink(sink: SessionMetaProjectionSink | undefined): void {
  projectionSink = sink;
}

export function getSessionMetaProjectionStats(): SessionMetaProjectionStats {
  return {
    failures: projectionFailures,
    ...(lastProjectionError ? { lastError: lastProjectionError } : {}),
    pending: projectionOperations.size,
  };
}

export async function flushSessionMetaProjectionForTests(): Promise<void> {
  await Promise.all([...projectionOperations]);
}

async function withMetaLock<T>(metaPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = metaLocks.get(metaPath) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>(resolve => { release = resolve; });
  metaLocks.set(metaPath, next);
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (metaLocks.get(metaPath) === next) metaLocks.delete(metaPath);
  }
}

export async function writeSessionMeta(transcriptPath: string, meta: SessionMeta): Promise<void> {
  const metaPath = getMetaPath(transcriptPath);
  await withMetaLock(metaPath, () => persistSessionMeta(transcriptPath, meta));
}

/**
 * 原子累加会话成本：读取当前值 + delta → 写回。
 * 在 onResult callback 中调用。
 */
export async function addSessionCost(
  transcriptPath: string,
  costUsd: number,
): Promise<void> {
  if (!costUsd || costUsd <= 0) return;
  const metaPath = getMetaPath(transcriptPath);
  await withMetaLock(metaPath, async () => {
    const meta = await readSessionMeta(transcriptPath);
    if (!meta) return;
    meta.totalCostUsd = (meta.totalCostUsd ?? 0) + costUsd;
    await persistSessionMeta(transcriptPath, meta);
  });
}

export async function updateSessionMeta(
  transcriptPath: string,
  patch: Partial<Pick<SessionMeta,
    | 'customTitle'
    | 'generatedTitle'
    | 'deletedAt'
    | 'deletedBy'
    | 'cronJobName'
    | 'runtimeStatus'
    | 'updatedAt'
    | 'cwd'
    | 'executionTarget'
    | 'workspaceId'
    | 'transcriptPath'
    | 'userRole'
  >>,
): Promise<SessionMeta | null> {
  const metaPath = getMetaPath(transcriptPath);
  return withMetaLock(metaPath, async () => {
    const meta = await readSessionMeta(transcriptPath);
    if (!meta) return null;
    const updated = { ...meta, ...patch };
    // 如果 customTitle 被设为空字符串，删除该字段（回退到自动标题）
    if (!updated.customTitle) delete updated.customTitle;
    // 清除 deletedAt/deletedBy（用于恢复）
    if (!updated.deletedAt) { delete updated.deletedAt; delete updated.deletedBy; }
    await persistSessionMeta(transcriptPath, updated);
    return updated;
  });
}

export function notifySessionMetaDeleted(sessionId: string): void {
  const sink = projectionSink;
  if (!sink || !isValidSessionId(sessionId)) return;
  scheduleProjection(sessionId, () => sink.delete(sessionId));
}

async function persistSessionMeta(transcriptPath: string, meta: SessionMeta): Promise<void> {
  const metaPath = getMetaPath(transcriptPath);
  await atomicWriteJson(metaPath, meta);
  notifySessionMetaPersisted(transcriptPath, meta);
}

function notifySessionMetaPersisted(transcriptPath: string, meta: SessionMeta): void {
  const sink = projectionSink;
  if (!sink) return;
  const sessionId = sessionIdFromTranscriptPath(transcriptPath);
  if (!sessionId || !isValidSessionId(sessionId)) return;
  scheduleProjection(sessionId, () => sink.upsert(transcriptPath, meta));
}

function scheduleProjection(sessionId: string, op: () => Promise<void> | void): void {
  const prev = projectionTails.get(sessionId) ?? Promise.resolve();
  const promise = prev
    .then(op)
    .catch((err) => {
      projectionFailures++;
      lastProjectionError = err instanceof Error ? err.message : String(err);
      console.warn(`[session-meta-projection] ${lastProjectionError}`);
    })
    .finally(() => {
      projectionOperations.delete(promise);
      if (projectionTails.get(sessionId) === promise) projectionTails.delete(sessionId);
    });
  projectionTails.set(sessionId, promise);
  projectionOperations.add(promise);
}

function sessionIdFromTranscriptPath(transcriptPath: string): string | null {
  const name = basename(transcriptPath);
  if (name.endsWith('.meta.json')) return name.slice(0, -'.meta.json'.length);
  if (name.endsWith('.jsonl')) return name.slice(0, -'.jsonl'.length);
  return null;
}
