import { getTranscriptPath, findTranscriptOrMetaPathBySessionId } from '../data/transcripts/store.js';
import {
  readSessionMeta,
  transformSessionMeta,
  writeSessionMetaIfAbsent,
  updateSessionMeta,
  backfillSessionIdentity,
  type SessionIdentityBackfill,
  type SessionMeta,
} from '../data/transcripts/meta.js';
import type { ExecutionTargetKind } from '../agent/toolRuntime.js';
import type { AgentProfileSessionBinding } from '../data/agentProfiles/types.js';
import {
  orgAgentRuntimePolicySchema,
  parseOrgAgentRuntimePolicy,
  type OrgAgentRuntimePolicy,
} from '../data/orgAgents/runtimePolicy.js';
import type { OrgAgentRecord } from '../data/orgAgents/types.js';

export type RuntimeSessionStatus = 'running' | 'idle' | 'waiting_approval' | 'finished' | 'error';
export type MemoryPolicyVersion = 'v1' | 'v2';
export type RuntimeSessionSource = 'taskboard_execution';

export interface OrgAgentSessionSnapshot {
  name: string;
  instructions: string;
  allowedSkills: string[];
  allowedKnowledge: string[];
  runtime: OrgAgentRuntimePolicy;
}

export function createOrgAgentSessionSnapshot(
  agent: Pick<OrgAgentRecord, 'name' | 'instructions' | 'allowedSkills' | 'allowedKnowledge' | 'runtime'>,
): OrgAgentSessionSnapshot {
  return {
    name: agent.name,
    instructions: agent.instructions,
    allowedSkills: [...agent.allowedSkills],
    allowedKnowledge: [...(agent.allowedKnowledge ?? [])],
    runtime: parseOrgAgentRuntimePolicy(agent.runtime),
  };
}

function parseOrgAgentSessionSnapshot(value: unknown): OrgAgentSessionSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.name !== 'string' || typeof record.instructions !== 'string') return undefined;
  if (!Array.isArray(record.allowedSkills) || !record.allowedSkills.every(item => typeof item === 'string')) return undefined;
  if (!Array.isArray(record.allowedKnowledge) || !record.allowedKnowledge.every(item => typeof item === 'string')) return undefined;
  const runtime = orgAgentRuntimePolicySchema.safeParse(record.runtime);
  if (!runtime.success) return undefined;
  return {
    name: record.name,
    instructions: record.instructions,
    allowedSkills: [...record.allowedSkills],
    allowedKnowledge: [...record.allowedKnowledge],
    runtime: parseOrgAgentRuntimePolicy(runtime.data),
  };
}

export interface RuntimeSessionRecord extends Partial<AgentProfileSessionBinding> {
  sessionId: string;
  userId: string;
  username: string;
  userRole?: 'admin' | 'user';
  tenantId?: string;
  channel: string;
  cwd: string;
  transcriptPath: string;
  modelRef?: string;
  executionTarget?: ExecutionTargetKind;
  workspaceId?: string;
  status?: RuntimeSessionStatus;
  /**
   * 会话种类（2026-07-06 子 agent 工具）。'subagent' = Agent 工具派生的 hidden
   * session：不进会话列表，Run Trace 可见。与 SessionMeta.kind 一一对应。
   */
  kind?: 'subagent';
  /** 组织 Agent 调度链角色；缺省表示普通直接执行会话。 */
  executionRole?: 'dispatcher' | 'worker';
  /** 公司级专职 Agent 绑定（2026-07 唯恩批次）。缺省 = 个人 Agent 会话。 */
  orgAgentId?: string;
  /** 当前 in-flight run 的组织 Agent 安全快照；resume 必须复用，不能读取更宽的新配置。 */
  orgAgentSnapshot?: OrgAgentSessionSnapshot;
  /**
   * 记忆写入策略版本（2026-07-29 记忆写入职责剥离批次）。'v2' = 主 Agent 只读
   * 记忆、后台服务唯一写入。会话首次落库固定，之后不随租户开关变化
   * （prompt prefix 稳定性要求）。缺省 = v1（历史行为）。
   */
  memoryPolicyVersion?: MemoryPolicyVersion;
  /** 稳定会话来源；不能依赖 sessionId 命名约定判断。 */
  sessionSource?: RuntimeSessionSource;
  /** 是否允许后台自动记忆；false 永久 fail-closed。 */
  memoryAutomationEligible?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SessionCatalog {
  upsert(record: RuntimeSessionRecord): Promise<void>;
  backfillIdentity?(
    sessionId: string,
    identity: SessionIdentityBackfill,
  ): Promise<RuntimeSessionRecord | null>;
  ensure(record: RuntimeSessionRecord): Promise<void>;
  get(sessionId: string): Promise<RuntimeSessionRecord | null>;
  markStatus(sessionId: string, status: RuntimeSessionStatus): Promise<void>;
  findTranscriptPath(sessionId: string): Promise<string | null>;
}

export interface FileSessionCatalogOptions {
  agentCwd: string;
}

/**
 * File-backed catalog that keeps the current transcript/meta layout while
 * exposing the minimal lookup contract needed by wake(sessionId).
 */
export class FileSessionCatalog implements SessionCatalog {
  constructor(private readonly options: FileSessionCatalogOptions) {}

  async upsert(record: RuntimeSessionRecord): Promise<void> {
    await transformSessionMeta(record.transcriptPath, existing => this.toMeta(record, existing));
  }

  async backfillIdentity(
    sessionId: string,
    identity: SessionIdentityBackfill,
  ): Promise<RuntimeSessionRecord | null> {
    const transcriptPath = await this.findTranscriptPath(sessionId);
    if (!transcriptPath) return null;
    const meta = await backfillSessionIdentity(transcriptPath, identity);
    return meta ? this.toRecord(sessionId, transcriptPath, meta) : null;
  }

  async ensure(record: RuntimeSessionRecord): Promise<void> {
    await writeSessionMetaIfAbsent(record.transcriptPath, this.toMeta(record, null));
  }

  async get(sessionId: string): Promise<RuntimeSessionRecord | null> {
    const transcriptPath = await this.findTranscriptPath(sessionId);
    if (!transcriptPath) return null;
    const meta = await readSessionMeta(transcriptPath);
    if (!meta) return null;
    return this.toRecord(sessionId, transcriptPath, meta);
  }

  async markStatus(sessionId: string, status: RuntimeSessionStatus): Promise<void> {
    const transcriptPath = await this.findTranscriptPath(sessionId);
    if (!transcriptPath) return;
    await updateSessionMeta(transcriptPath, {
      runtimeStatus: status,
      updatedAt: new Date().toISOString(),
    });
  }

  async findTranscriptPath(sessionId: string): Promise<string | null> {
    return findTranscriptOrMetaPathBySessionId(sessionId);
  }

  private toMeta(record: RuntimeSessionRecord, existing: SessionMeta | null): SessionMeta {
    const taskboardExecution = existing?.sessionSource === 'taskboard_execution'
      || record.sessionSource === 'taskboard_execution';
    // 会话 pin 一经落库不得被任意 dispatch 改写；TaskBoard 是唯一显式迁移例外，
    // 必须升级为 v2 只读且自动记忆资格只能单调收紧为 false。
    const memoryPolicyVersion = taskboardExecution
      ? 'v2' as const
      : existing?.memoryPolicyVersion ?? record.memoryPolicyVersion;
    const memoryAutomationEligible = taskboardExecution
      ? false
      : existing?.memoryAutomationEligible === false || record.memoryAutomationEligible === false
        ? false
        : existing?.memoryAutomationEligible ?? record.memoryAutomationEligible;
    return {
      ...(existing ?? {}),
      userId: record.userId,
      username: record.username,
      userRole: record.userRole,
      ...(record.tenantId ? { tenantId: record.tenantId } : {}),
      channel: record.channel,
      createdAt: existing?.createdAt ?? record.createdAt,
      cwd: record.cwd,
      transcriptPath: record.transcriptPath,
      workspaceId: record.workspaceId,
      runtimeStatus: record.status,
      updatedAt: record.updatedAt,
      ...(record.modelRef ? { model: record.modelRef } : {}),
      ...(record.executionTarget ? { executionTarget: record.executionTarget } : {}),
      ...(record.kind ? { kind: record.kind } : {}),
      executionRole: record.executionRole,
      // orgAgentId 缺省时保留 existing 值（resume 路径 record 可能不带），不清除既有绑定
      ...(record.orgAgentId ? { orgAgentId: record.orgAgentId } : {}),
      ...(record.orgAgentSnapshot ? { orgAgentSnapshot: record.orgAgentSnapshot } : {}),
      ...(memoryPolicyVersion ? { memoryPolicyVersion } : {}),
      ...(record.sessionSource ? { sessionSource: record.sessionSource } : {}),
      ...(memoryAutomationEligible !== undefined ? { memoryAutomationEligible } : {}),
      ...(record.profileId ? { profileId: record.profileId } : {}),
      ...(record.profileKey ? { profileKey: record.profileKey } : {}),
      ...(record.profileVersionId ? { profileVersionId: record.profileVersionId } : {}),
      ...(record.profileVersionNumber ? { profileVersionNumber: record.profileVersionNumber } : {}),
      ...(record.profileConfigDigest ? { profileConfigDigest: record.profileConfigDigest } : {}),
      ...(record.profileBindingKey ? { profileBindingKey: record.profileBindingKey } : {}),
      ...(record.profileResolution ? { profileResolution: record.profileResolution } : {}),
    } as SessionMeta;
  }

  private toRecord(sessionId: string, transcriptPath: string, meta: SessionMeta): RuntimeSessionRecord {
    const now = new Date().toISOString();
    const orgAgentSnapshot = parseOrgAgentSessionSnapshot(meta.orgAgentSnapshot);
    return {
      sessionId,
      userId: meta.userId,
      username: meta.username,
      ...(isUserRole(meta.userRole) ? { userRole: meta.userRole } : {}),
      ...(meta.tenantId ? { tenantId: meta.tenantId } : {}),
      channel: meta.channel,
      cwd: meta.cwd ?? this.options.agentCwd,
      transcriptPath,
      ...(meta.model ? { modelRef: meta.model } : {}),
      ...(isExecutionTargetKind(meta.executionTarget) ? { executionTarget: meta.executionTarget } : {}),
      ...(meta.workspaceId ? { workspaceId: meta.workspaceId } : {}),
      ...(isRuntimeSessionStatus(meta.runtimeStatus) ? { status: meta.runtimeStatus } : {}),
      ...(meta.kind === 'subagent' ? { kind: 'subagent' as const } : {}),
      ...(meta.executionRole === 'dispatcher' || meta.executionRole === 'worker'
        ? { executionRole: meta.executionRole }
        : {}),
      ...(meta.orgAgentId ? { orgAgentId: meta.orgAgentId } : {}),
      ...(orgAgentSnapshot ? { orgAgentSnapshot } : {}),
      ...(meta.memoryPolicyVersion === 'v1' || meta.memoryPolicyVersion === 'v2'
        ? { memoryPolicyVersion: meta.memoryPolicyVersion }
        : {}),
      ...(meta.sessionSource === 'taskboard_execution' ? { sessionSource: meta.sessionSource } : {}),
      ...(typeof meta.memoryAutomationEligible === 'boolean'
        ? { memoryAutomationEligible: meta.memoryAutomationEligible }
        : {}),
      ...(meta.profileId ? { profileId: meta.profileId } : {}),
      ...(meta.profileKey ? { profileKey: meta.profileKey } : {}),
      ...(meta.profileVersionId ? { profileVersionId: meta.profileVersionId } : {}),
      ...(meta.profileVersionNumber ? { profileVersionNumber: meta.profileVersionNumber } : {}),
      ...(meta.profileConfigDigest ? { profileConfigDigest: meta.profileConfigDigest } : {}),
      ...(meta.profileBindingKey ? { profileBindingKey: meta.profileBindingKey } : {}),
      ...(meta.profileResolution ? { profileResolution: meta.profileResolution } : {}),
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt ?? meta.createdAt ?? now,
    };
  }
}

export function createRuntimeSessionRecord(args: {
  sessionId: string;
  userId?: string;
  username?: string;
  userRole?: 'admin' | 'user';
  tenantId?: string;
  channel: string;
  cwd: string;
  modelRef?: string;
  executionTarget?: ExecutionTargetKind;
  workspaceId?: string;
  status?: RuntimeSessionStatus;
  kind?: 'subagent';
  executionRole?: 'dispatcher' | 'worker';
  orgAgentId?: string;
  orgAgentSnapshot?: OrgAgentSessionSnapshot;
  memoryPolicyVersion?: MemoryPolicyVersion;
  sessionSource?: RuntimeSessionSource;
  memoryAutomationEligible?: boolean;
  profileBinding?: AgentProfileSessionBinding;
}): RuntimeSessionRecord {
  const now = new Date().toISOString();
  return {
    sessionId: args.sessionId,
    userId: args.userId ?? '',
    username: args.username ?? '',
    ...(args.userRole ? { userRole: args.userRole } : {}),
    ...(args.tenantId ? { tenantId: args.tenantId } : {}),
    channel: args.channel,
    cwd: args.cwd,
    transcriptPath: getTranscriptPath(args.cwd, args.sessionId, { userId: args.userId, tenantId: args.tenantId }),
    ...(args.modelRef ? { modelRef: args.modelRef } : {}),
    ...(args.executionTarget ? { executionTarget: args.executionTarget } : {}),
    workspaceId: args.workspaceId ?? args.sessionId,
    status: args.status ?? 'running',
    ...(args.kind ? { kind: args.kind } : {}),
    ...(args.executionRole ? { executionRole: args.executionRole } : {}),
    ...(args.orgAgentId ? { orgAgentId: args.orgAgentId } : {}),
    ...(args.orgAgentSnapshot ? { orgAgentSnapshot: args.orgAgentSnapshot } : {}),
    ...(args.memoryPolicyVersion ? { memoryPolicyVersion: args.memoryPolicyVersion } : {}),
    ...(args.sessionSource ? { sessionSource: args.sessionSource } : {}),
    ...(args.memoryAutomationEligible !== undefined ? { memoryAutomationEligible: args.memoryAutomationEligible } : {}),
    ...(args.profileBinding ?? {}),
    createdAt: now,
    updatedAt: now,
  };
}

function isExecutionTargetKind(value: unknown): value is ExecutionTargetKind {
  return value === 'server-local'
    || value === 'server-container'
    || value === 'server-remote'
    || value === 'client';
}

function isUserRole(value: unknown): value is 'admin' | 'user' {
  return value === 'admin' || value === 'user';
}

function isRuntimeSessionStatus(value: unknown): value is RuntimeSessionStatus {
  return value === 'running'
    || value === 'idle'
    || value === 'waiting_approval'
    || value === 'finished'
    || value === 'error';
}

/** 新普通用户会话仅计算一次 policy；历史缺 pin 的会话始终按 v1。 */
export function resolveSessionMemoryPolicy(input: {
  existing?: Pick<RuntimeSessionRecord, 'memoryPolicyVersion' | 'sessionSource' | 'memoryAutomationEligible'> | null;
  delegationEnabled: boolean;
  channel: string;
  toolProfile?: string;
  orgAgentId?: string;
  sessionSource?: RuntimeSessionSource;
  memoryAutomationEligible?: boolean;
}): MemoryPolicyVersion {
  const sessionSource = input.existing?.sessionSource ?? input.sessionSource;
  // access policy 与自动记忆资格解耦；TaskBoard 只是同时选择 v2 只读和 no-automation。
  if (sessionSource === 'taskboard_execution') return 'v2';
  // existing 优先级高于本次 dispatch 形态：续聊/profile/resume 均不得改写既有 pin。
  if (input.existing) return input.existing.memoryPolicyVersion === 'v2' ? 'v2' : 'v1';
  if (input.toolProfile || input.orgAgentId || (input.channel !== 'web' && input.channel !== 'dingtalk')) return 'v1';
  return input.delegationEnabled ? 'v2' : 'v1';
}
