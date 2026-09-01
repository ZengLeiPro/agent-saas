import { setTimeout as delay } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { AGENT_LEGACY_TRANSCRIPTS_ROOT, isValidSessionId } from './projectKey.js';
import {
  AGENT_TARGET_BINDING_VERSION,
  parseAgentTarget,
  sameAgentTarget,
  type AgentTarget,
  type AgentTargetIdentitySnapshot,
  type SandboxProfile,
} from '@agent/shared';
import type { AgentProfileSessionBinding } from '../agentProfiles/types.js';
import {
  atomicWriteTrustedFile,
  openTrustedFile,
  readTrustedFile,
  relativeToTrustedRoot,
  removeTrustedPath,
  writeTrustedFile,
  writeTrustedFileIfAbsent,
} from '../../security/trustedFile.js';

export interface SessionMeta extends Partial<AgentProfileSessionBinding> {
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
  /** ACS sandbox resource tier. Legacy records without this field use coding. */
  sandboxProfile?: SandboxProfile;
  /**
   * 公司级专职 Agent 绑定（2026-07 唯恩批次）。会话创建时由 dispatch/channel 写入；
   * 缺省 = 个人 Agent 会话（存量行为零变化）。PG meta_json 自动投影。
   */
  orgAgentId?: string;
  /** M20-06 canonical target identity. Absence is N-1 and must not imply personal. */
  agentTarget?: AgentTarget;
  agentTargetBindingVersion?: number;
  /** M30-03 immutable session identity label plus versioned availability projection. */
  agentTargetSnapshot?: AgentTargetIdentitySnapshot;
  /** 当前 in-flight run 的组织 Agent 安全快照；新消息更新，approval/interaction resume 固定复用。 */
  orgAgentSnapshot?: unknown;
  /** 软删除时间戳（ISO 8601），存在即表示已删除 */
  deletedAt?: string;
  /** 执行删除操作的用户名 */
  deletedBy?: string;
  /** 累积等效 API 成本（美元），每次 query 结束时累加 */
  totalCostUsd?: number;
  /** cron 触发时的任务名称，用于前端显示 */
  cronJobName?: string;
  /**
   * cron 系统任务标识（2026-07-14 记忆轮询批次）。'memory_poll' = 每日记忆轮询
   * 会话：对非 admin 隐藏（与 cronJobName 名称后缀兼容判断并存，本字段是真源）。
   */
  cronSystemKind?: 'memory_poll';
  /**
   * 会话种类（2026-07-06 子 agent 工具）。'subagent' = 父 run 经 Agent 工具派生的
   * hidden session：会话列表 API 过滤不展示，但 transcript / runtime events 完整
   * 保留，平台 admin Run Trace 可按 parentRunId 关联查看。
   */
  kind?: 'subagent';
  /** 组织 Agent 调度链角色；缺省表示普通直接执行会话。 */
  executionRole?: 'dispatcher' | 'worker';
  /**
   * 记忆写入策略版本（2026-07-29 记忆写入职责剥离批次）。'v2' = 该会话主 Agent
   * 只读记忆、后台服务唯一写入；首次落库固定后不变。缺省 = v1。
   */
  memoryPolicyVersion?: 'v1' | 'v2';
  /** 平台内部来源；memory_consolidation 会话保留审计数据但不对用户展示。 */
  sessionSource?: 'taskboard_execution' | 'memory_consolidation';
  memoryAutomationEligible?: boolean;
}

export function getMetaPath(transcriptPath: string): string {
  const dir = dirname(transcriptPath);
  const sessionId = basename(transcriptPath, '.jsonl');
  return join(dir, `${sessionId}.meta.json`);
}

function trustedMetaLocation(
  filePath: string,
  trustedRoot = AGENT_LEGACY_TRANSCRIPTS_ROOT,
): { root: string; relativePath: string } {
  return { root: trustedRoot, relativePath: relativeToTrustedRoot(trustedRoot, filePath) };
}

export async function readSessionMeta(
  transcriptPath: string,
  trustedRoot = AGENT_LEGACY_TRANSCRIPTS_ROOT,
): Promise<SessionMeta | null> {
  try {
    const location = trustedMetaLocation(getMetaPath(transcriptPath), trustedRoot);
    const raw = await readTrustedFile(location.root, location.relativePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 原子写入：write-to-temp → rename（POSIX 同文件系统下 rename 是原子操作） */
async function atomicWriteJson(filePath: string, data: object): Promise<void> {
  const location = trustedMetaLocation(filePath);
  await atomicWriteTrustedFile(location.root, location.relativePath, JSON.stringify(data, null, 2), {
    createParents: true,
    tempSuffix: `tmp.${randomBytes(4).toString('hex')}`,
  });
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

const META_LOCK_STALE_MS = 120_000;
const META_LOCK_TIMEOUT_MS = 10_000;

async function acquireCrossProcessMetaLock(metaPath: string): Promise<() => Promise<void>> {
  const lockPath = `${metaPath}.lock`;
  const location = trustedMetaLocation(lockPath);
  const deadline = Date.now() + META_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await writeTrustedFile(location.root, location.relativePath, `${process.pid} ${Date.now()}\n`, {
        createParents: true,
        exclusive: true,
      });
      return async () => {
        await removeTrustedPath(location.root, location.relativePath).catch(() => undefined);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const lockStat = await openTrustedFile(location.root, location.relativePath).catch(() => null);
      if (lockStat && Date.now() - lockStat.stats.mtimeMs > META_LOCK_STALE_MS) {
        await lockStat.handle.close();
        await removeTrustedPath(location.root, location.relativePath).catch(() => undefined);
        continue;
      }
      await lockStat?.handle.close().catch(() => undefined);
      if (Date.now() >= deadline) throw new Error(`session meta lock timeout: ${metaPath}`);
      await delay(10 + Math.floor(Math.random() * 20));
    }
  }
}

async function withMetaLock<T>(metaPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = metaLocks.get(metaPath) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>(resolve => { release = resolve; });
  metaLocks.set(metaPath, next);
  let releaseCrossProcess: (() => Promise<void>) | undefined;
  try {
    await prev;
    releaseCrossProcess = await acquireCrossProcessMetaLock(metaPath);
    return await fn();
  } finally {
    await releaseCrossProcess?.();
    release();
    if (metaLocks.get(metaPath) === next) metaLocks.delete(metaPath);
  }
}

export async function writeSessionMeta(transcriptPath: string, meta: SessionMeta): Promise<void> {
  const metaPath = getMetaPath(transcriptPath);
  await withMetaLock(metaPath, () => persistSessionMeta(transcriptPath, meta));
}

export type SessionAgentTargetResolution =
  | { status: 'bound'; target: AgentTarget; needsMigration: boolean }
  | { status: 'unproven' };

/**
 * 读取 session 的 Agent target。N-1 只允许 meta.orgAgentId 证明组织 target；
 * 缺少该证据时绝不把历史会话猜成 personal。
 */
export function resolveSessionAgentTarget(
  meta: SessionMeta | null,
  expectedTenantId?: string,
): SessionAgentTargetResolution {
  if (!meta) return { status: 'unproven' };
  const canonical = parseAgentTarget(meta.agentTarget);
  if (canonical) {
    if (expectedTenantId && canonical.tenantId !== expectedTenantId) return { status: 'unproven' };
    if (meta.tenantId && canonical.tenantId !== meta.tenantId) return { status: 'unproven' };
    if (canonical.kind === 'org-agent' && meta.orgAgentId && canonical.orgAgentId !== meta.orgAgentId) {
      return { status: 'unproven' };
    }
    return {
      status: 'bound',
      target: canonical,
      needsMigration: meta.agentTargetBindingVersion !== AGENT_TARGET_BINDING_VERSION,
    };
  }
  const tenantId = meta.tenantId ?? expectedTenantId;
  if (meta.orgAgentId && tenantId && (!expectedTenantId || tenantId === expectedTenantId)) {
    return {
      status: 'bound',
      target: { kind: 'org-agent', tenantId, orgAgentId: meta.orgAgentId },
      needsMigration: true,
    };
  }
  return { status: 'unproven' };
}

/**
 * 跨进程原子绑定/迁移 target。tenant 与已绑定会话都只能确认同一 target，绝不允许后续请求改绑。
 */
export async function ensureSessionAgentTargetBinding(
  transcriptPath: string,
  target: AgentTarget,
  snapshot?: AgentTargetIdentitySnapshot,
): Promise<SessionMeta> {
  return transformSessionMeta(transcriptPath, existing => {
    if (!existing) throw new Error('SESSION_AGENT_TARGET_META_MISSING');
    const resolved = resolveSessionAgentTarget(existing, target.tenantId);
    if (resolved.status === 'bound' && !sameAgentTarget(resolved.target, target)) {
      throw new Error('SESSION_AGENT_TARGET_MISMATCH');
    }
    if (resolved.status === 'unproven' && existing.agentTarget !== undefined) {
      throw new Error('SESSION_AGENT_TARGET_INVALID');
    }
    if (existing.tenantId && existing.tenantId !== target.tenantId) {
      throw new Error('SESSION_AGENT_TARGET_MISMATCH');
    }
    if (existing.orgAgentId && (target.kind !== 'org-agent' || existing.orgAgentId !== target.orgAgentId)) {
      throw new Error('SESSION_AGENT_TARGET_MISMATCH');
    }
    return {
      ...existing,
      agentTarget: target,
      agentTargetBindingVersion: AGENT_TARGET_BINDING_VERSION,
      agentTargetSnapshot: existing.agentTargetSnapshot ?? snapshot ?? {
        name: target.kind === 'personal' ? '个人 Agent' : '企业专家',
        status: 'available',
        version: 1,
      },
      ...(target.kind === 'org-agent' ? { orgAgentId: target.orgAgentId } : {}),
    };
  });
}

/** 跨进程串行的 read-modify-write；用于必须基于最新 meta 保持单调不变量的 upsert。 */
export async function transformSessionMeta(
  transcriptPath: string,
  transform: (existing: SessionMeta | null) => SessionMeta,
): Promise<SessionMeta> {
  const metaPath = getMetaPath(transcriptPath);
  return withMetaLock(metaPath, async () => {
    const next = transform(await readSessionMeta(transcriptPath));
    await persistSessionMeta(transcriptPath, next);
    return next;
  });
}

/** 跨进程原子首写：完整临时文件通过 hard link 发布，已存在时绝不覆盖。 */
export async function writeSessionMetaIfAbsent(
  transcriptPath: string,
  meta: SessionMeta,
): Promise<boolean> {
  const metaPath = getMetaPath(transcriptPath);
  return withMetaLock(metaPath, async () => {
    const location = trustedMetaLocation(metaPath);
    const created = await writeTrustedFileIfAbsent(
      location.root,
      location.relativePath,
      JSON.stringify(meta, null, 2),
      { createParents: true, tempSuffix: `create.${randomBytes(4).toString('hex')}` },
    );
    if (created) notifySessionMetaPersisted(transcriptPath, meta);
    return created;
  });
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

export interface SessionIdentityBackfill {
  userId?: string;
  tenantId?: string;
  orgAgentId?: string;
  updatedAt: string;
}

export async function backfillSessionIdentity(
  transcriptPath: string,
  identity: SessionIdentityBackfill,
): Promise<SessionMeta | null> {
  const metaPath = getMetaPath(transcriptPath);
  return withMetaLock(metaPath, async () => {
    const meta = await readSessionMeta(transcriptPath);
    if (!meta) return null;
    assertSessionIdentityCompatible('userId', meta.userId, identity.userId);
    assertSessionIdentityCompatible('tenantId', meta.tenantId, identity.tenantId);
    assertSessionIdentityCompatible('orgAgentId', meta.orgAgentId, identity.orgAgentId);
    const updated: SessionMeta = {
      ...meta,
      userId: meta.userId || identity.userId || '',
      ...(!meta.tenantId && identity.tenantId ? { tenantId: identity.tenantId } : {}),
      ...(!meta.orgAgentId && identity.orgAgentId ? { orgAgentId: identity.orgAgentId } : {}),
    };
    const changed = updated.userId !== meta.userId
      || updated.tenantId !== meta.tenantId
      || updated.orgAgentId !== meta.orgAgentId;
    if (!changed) return meta;
    updated.updatedAt = identity.updatedAt;
    await persistSessionMeta(transcriptPath, updated);
    return updated;
  });
}

function assertSessionIdentityCompatible(
  field: string,
  existing: string | undefined,
  durable: string | undefined,
): void {
  if (existing && durable && existing !== durable) {
    throw new Error(`WAKE_SESSION_IDENTITY_CONFLICT:${field}`);
  }
}

export async function updateSessionMeta(
  transcriptPath: string,
  patch: Partial<Pick<SessionMeta,
    | 'customTitle'
    | 'generatedTitle'
    | 'deletedAt'
    | 'deletedBy'
    | 'cronJobName'
    | 'cronSystemKind'
    | 'runtimeStatus'
    | 'updatedAt'
    | 'cwd'
    | 'executionTarget'
    | 'workspaceId'
    | 'transcriptPath'
    | 'userRole'
    | 'profileId'
    | 'profileKey'
    | 'profileVersionId'
    | 'profileVersionNumber'
    | 'profileConfigDigest'
    | 'profileBindingKey'
    | 'profileResolution'
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
