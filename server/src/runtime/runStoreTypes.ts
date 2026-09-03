import pg from 'pg';
import type { ExecutionTargetKind } from '../agent/toolRuntime.js';
import type { PlatformEvent, PlatformEventInput } from './types.js';
import type { LivenessReapResult, RunHeartbeatSource, RunLiveness } from './runLiveness.js';

const { Pool } = pg;
export type PgPool = InstanceType<typeof Pool>;
export type MessageDeliveryMode = 'queue' | 'steer';

export type RunStatus =
  | 'pending'
  | 'running'
  | 'waiting_approval'
  | 'waiting_user'
  | 'waiting_hand'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'orphaned';

export interface RunRecord {
  runId: string;
  sessionId: string;
  userId?: string;
  /** 认证提交者的幂等域；管理员代操作时可与 userId（会话 owner）不同。 */
  submitterUserId?: string;
  tenantId?: string;
  status: RunStatus;
  statusReason?: string;
  model?: string;
  channel?: string;
  requestedAt: string;
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
  failedAt?: string;
  cancelledAt?: string;
  workerId?: string;
  leaseExpiresAt?: string;
  /** M40-02 server-authoritative liveness；legacy rows without a version project as unknown. */
  liveness?: RunLiveness;
  idempotencyKey?: string;
  executionTarget?: ExecutionTargetKind;
  workspaceId?: string;
  sandboxScopeId?: string;
  metadata: Record<string, unknown>;
  // ── Responses API session state（RFC v1 P0.4） ──
  /** 本 run 结束时最后一个 store=true 的 response.id（用于跨 run 接力 reasoning chain）。 */
  lastResponseId?: string;
  /** 上述 response 的服务端过期时间（72h TTL）。 */
  lastResponseExpireAt?: string;
  /** Responses API 返回的 response.model 实际别名值（用于审计/告警）。 */
  actualModelSeen?: string;
  /**
   * 产生 lastResponseId 时发给上游的 model 值（RunContext.model）。
   * 跨 run 接力的身份键：新 run 模型与它不一致时禁止接力——response id 是后端私有状态，
   * 拿 A 后端的 id 发给 B 后端必报 PreviousResponseNotFound（2026-07-02 切模型事故）。
   */
  lastResponseModel?: string;
  /** Agent Profile config digest that produced lastResponseId. */
  lastResponseProfileDigest?: string;
  /** 本 run 内累计 input_tokens（嵌套接力会爆涨，监控用）。 */
  cumulativeInputTokens?: number;
}

export interface UpsertRunInput {
  runId: string;
  sessionId: string;
  userId?: string;
  /** 认证提交者的幂等域；与管理员代操作时的 session/run owner 分离。 */
  submitterUserId?: string;
  /**
   * Tenant 归属（多组织改造 PR 3）。旧 PG 列回填 LEGACY_TENANT_ID；新写入缺省走平台根；PR 4
   * dispatch 层会从 ChannelContext.user.tenantId 显式透传。
   */
  tenantId?: string;
  model?: string;
  channel?: string;
  idempotencyKey?: string;
  executionTarget?: ExecutionTargetKind;
  workspaceId?: string;
  sandboxScopeId?: string;
  metadata?: Record<string, unknown>;
}

export class RunCreateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunCreateConflictError';
  }
}

export interface EnqueueBackgroundTaskLimits {
  /** 单个父 run 同时处于 pending/running 的后台任务上限。 */
  perParentActive: number;
  /** 单租户同时处于 pending/running 的后台任务排队保险丝。 */
  perTenantActive: number;
}

export interface ListBackgroundTasksOptions {
  userId?: string;
  tenantId?: string;
  limit?: number;
}

export class BackgroundTaskLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackgroundTaskLimitError';
  }
}

/**
 * Responses API session state patch（RFC v1 P0.4 / P1.6）
 * lastResponseExpireAt 传 ISO timestamp 或 epoch ms；cumulativeInputTokensDelta 是增量。
 */
export interface ResponseSessionStatePatch {
  lastResponseId?: string | null;
  lastResponseExpireAt?: string | null;
  actualModelSeen?: string | null;
  /** 产生 lastResponseId 的上游 model 值（接力身份键，见 RunRecord.lastResponseModel）。 */
  lastResponseModel?: string | null;
  lastResponseProfileDigest?: string | null;
  cumulativeInputTokensDelta?: number;
}

/**
 * RFC v1 跨 run 接力查询结果。仅返回 reasoning chain 必需字段。
 */
export interface LatestResponseSessionState {
  runId: string;
  lastResponseId: string;
  lastResponseExpireAt?: string;
  actualModelSeen?: string;
  /** 产生 lastResponseId 的上游 model 值；缺失（存量数据）视为身份未知，调用方不得接力。 */
  lastResponseModel?: string;
  lastResponseProfileDigest?: string;
  cumulativeInputTokens?: number;
}

export interface ActiveRunCounts {
  pending: number;
  running: number;
  waitingApproval: number;
  waitingUser: number;
  waitingHand: number;
  blocking: number;
  total: number;
}

/** 一条等待注入目标 AgentLoop 的 durable 用户消息。sourceRun 保留为故障回退 run。 */
export interface SteeringInputRecord {
  inputId: string;
  sourceRunId: string;
  targetRunId: string;
  sessionId: string;
  /**
   * pending=排队中；reserved=目标 run 已取得所有权、尚未交给模型；
   * applied=已进入目标 run 的模型上下文；released=source run 已回退为独立 run；
   * cancelled=用户撤回。reserved 起不可撤回、也不得自动 fallback。
   */
  state: 'pending' | 'reserved' | 'applied' | 'released' | 'cancelled';
  acceptedAt: string;
  reservedAt?: string;
  appliedAt?: string;
  sourceRun: RunRecord;
}

/** 撤回排队插话的结果。 */
export interface CancelSteeringResult {
  ok: boolean;
  /** too_late=已被目标 run 消费或 source 已非 pending；not_found=无此排队插话。 */
  reason?: 'too_late' | 'not_found';
  sessionId?: string;
  clientMsgId?: string;
}

export interface SteeringApplyInput {
  sourceRunId: string;
  clientMsgId?: string;
  /** /compact 等控制输入没有 user_message 事件，但仍与 applied 状态同事务结算。 */
  event?: PlatformEventInput;
}

export interface SteeringApplyResult {
  appliedSourceRunIds: string[];
  events: PlatformEvent[];
}

export interface RunLeaseAdmission {
  foreground: boolean;
  foregroundReservedRuns: number;
  /** 子 run 继承正在运行的父槽；同一父同时只允许一个，由 SubagentLimiter 保证。 */
  inheritFromRunId?: string;
}

export interface SandboxCleanupClaimGuard {
  cleanupRunId: string;
  sessionId: string;
  sandboxScopeId: string;
  claimId: string;
  claimGeneration: number;
}

export interface RunStore {
  init?(): Promise<void>;
  upsertPending(input: UpsertRunInput): Promise<RunRecord>;
  /** 仅首次创建；runId 已存在时原样返回，绝不把等待态恢复为 pending。 */
  createPending?(input: UpsertRunInput): Promise<{ record: RunRecord; created: boolean }>;
  /** 按 clientMessageId 永久幂等地接收用户消息；queue 默认串行，steer 才允许注入当前 run。 */
  enqueueUserMessage?(input: UpsertRunInput, deliveryMode: MessageDeliveryMode): Promise<RunRecord>;
  /** 兼容旧调用：等价于 enqueueUserMessage(input, 'steer')。 */
  enqueueSteeringAware?(input: UpsertRunInput): Promise<RunRecord>;
  /** 当前会话尚未开始执行的普通/插话消息，按服务端接受顺序返回。 */
  listPendingUserMessagesBySession?(sessionId: string): Promise<RunRecord[]>;
  /** M20-02：会话内所有 durable V1 用户提交，供统一 queue/runtime snapshot 投影。 */
  listUserMessagesBySession?(sessionId: string): Promise<RunRecord[]>;
  listPendingSteeringInputs?(targetRunId: string): Promise<SteeringInputRecord[]>;
  /** 在写入 durable user_message、构造模型上下文前原子取得输入所有权。 */
  reserveSteeringInputs?(targetRunId: string, sourceRunIds: string[]): Promise<string[]>;
  /** 仅把已 reserved 且 durable user_message 已写入的输入标记为已进入模型上下文。 */
  markSteeringInputsApplied?(targetRunId: string, sourceRunIds: string[]): Promise<string[]>;
  /** PG 路径：durable user_message append 与 applied/source terminal 同事务提交。 */
  applySteeringInputsAtomically?(
    targetRunId: string,
    inputs: SteeringApplyInput[],
    tenantId: string,
  ): Promise<SteeringApplyResult>;
  /** 仅当没有待注入消息时封口；false 表示调用方应先消费刚到达的消息。 */
  trySealSteeringInputWindow?(targetRunId: string): Promise<boolean>;
  /**
   * source run 在目标终止后回退为独立 run 执行时，回收它自己的 pending/reserved
   * steering 行，并清 metadata 中的 steeringState/steeringTargetRunId——否则它永远不能
   * 再成为 steering 目标，且幂等
   * 兜底会对早已终态的目标继续谎报 queued。
   */
  releasePendingSteeringForSourceRun?(sourceRunId: string): Promise<void>;
  /** 用户撤回一条仍在排队的插话：source run 标 cancelled + 行标 cancelled。 */
  cancelPendingSteeringSourceRun?(sourceRunId: string, reason?: string): Promise<CancelSteeringResult>;
  /** 撤回尚未取得执行权的普通 queue 或 steer 消息。 */
  cancelPendingUserMessage?(runId: string, reason?: string): Promise<CancelSteeringResult>;
  /** stop-all 专用：同 session 的 pending/reserved 输入在 steering advisory lock 内原子取消。 */
  cancelSteeringBeforeDispatchBySession?(
    sessionId: string,
    reason: string,
    targetRunId?: string,
  ): Promise<SteeringInputRecord[]>;
  /** stop 专用：steering/target 取消与 run_cancel_requested 同事务提交。 */
  cancelSteeringBeforeDispatchBySessionWithEvent?(
    sessionId: string,
    reason: string,
    targetRunId: string | undefined,
    event: PlatformEventInput,
    tenantId: string,
    cleanupGuard?: SandboxCleanupClaimGuard,
  ): Promise<{ cancelled: SteeringInputRecord[]; targetCancelled: boolean; event?: PlatformEvent; eventCreated: boolean }>;
  /** 会话内仍可由用户单条撤回的 pending 插话（供 detail API 恢复队列区）。 */
  listPendingSteeringBySession?(sessionId: string): Promise<SteeringInputRecord[]>;
  markStatus(runId: string, status: RunStatus, reason?: string, metadataPatch?: Record<string, unknown>): Promise<RunRecord | null>;
  /** 仅 pending + schedulerState=staged 时原子切到 ready；未命中返回当前记录。 */
  activateStagedRun?(runId: string): Promise<RunRecord | null>;
  /** 仅 legacy pending Taskboard Run（无 schedulerState）原子切到 staged；未命中返回当前记录。 */
  stagePendingRun?(runId: string): Promise<RunRecord | null>;
  /** poison dispatch 收口：仅取消 pending Taskboard Run；未命中返回当前记录。 */
  cancelPendingTaskboardRun?(runId: string, reason: string): Promise<RunRecord | null>;
  /**
   * 交互恢复专用的 staged 生命周期。它与 Taskboard 的 schedulerState=staged 隔离，
   * 所有 activate/rollback 均须以 metadata 中的 interaction claim 作 CAS 所有权校验。
   */
  claimPersistedInteractionResume?(
    runId: string,
    expectedStatuses: readonly RunStatus[],
    reason: string,
    metadataPatch: Record<string, unknown>,
  ): Promise<RunRecord | null>;
  /** 列出等待 durable interaction_resolved 协调激活的 staged claim。 */
  listStagedPersistedInteractionResumes?(limit?: number): Promise<RunRecord[]>;
  activatePersistedInteractionResume?(
    runId: string,
    claim: Record<string, unknown>,
    metadataPatch?: Record<string, unknown>,
  ): Promise<RunRecord | null>;
  rollbackPersistedInteractionResume?(
    runId: string,
    claim: Record<string, unknown>,
    waitingStatus: Extract<RunStatus, 'waiting_user' | 'waiting_approval'>,
    reason?: string,
  ): Promise<RunRecord | null>;
  /** CAS 状态迁移；仅当前状态命中 expectedStatuses 时更新，未命中返回 null。 */
  markStatusIfCurrent?(
    runId: string,
    expectedStatuses: readonly RunStatus[],
    status: RunStatus,
    reason?: string,
    metadataPatch?: Record<string, unknown>,
  ): Promise<RunRecord | null>;
  patchMetadata?(runId: string, metadataPatch: Record<string, unknown>): Promise<RunRecord | null>;
  get(runId: string): Promise<RunRecord | null>;
  findByIdempotencyKey(userId: string | undefined, idempotencyKey: string): Promise<RunRecord | null>;
  getActiveBySession?(sessionId: string): Promise<RunRecord | null>;
  cancelActiveByUser?(userId: string, reason: string): Promise<number>;
  cancelActiveByTenant?(tenantId: string, reason: string): Promise<number>;
  listActiveByUser?(userId: string): Promise<RunRecord[]>;
  /**
   * 账户批准档位变化时，单条 SQL 原子重写该用户全部活跃 run 的 approvalPolicy。
   * 返回被更新的 runId；TASK-256 安全降档收敛使用，避免逐 run 更新产生部分成功。
   */
  updateApprovalPolicyForActiveByUser?(
    userId: string,
    approvalPolicy: Record<string, unknown> | null,
  ): Promise<string[]>;
  getActiveCounts?(): Promise<ActiveRunCounts>;
  listBySession?(sessionId: string, options?: { limit?: number; beforeUpdatedAt?: string }): Promise<RunRecord[]>;
  listRecoverable(now?: Date): Promise<RunRecord[]>;
  /**
   * 原子校验后台任务配额并入队。PG 实现用事务级 advisory lock 串行化配额读取与写入；
   * file backend 不实现，Agent(mode=background) 会 fail-closed。
   */
  enqueueBackgroundTask?(input: UpsertRunInput, limits: EnqueueBackgroundTaskLimits): Promise<RunRecord>;
  listBackgroundTasks?(parentSessionId: string, options?: ListBackgroundTasksOptions): Promise<RunRecord[]>;
  /** Taskboard 关联 Session 中仍在运行或尚未完成唤醒投递的工作。 */
  hasTaskboardSessionActivity?(sessionIds: string[], tenantId?: string): Promise<boolean>;
  findBackgroundTasksByIdentifier?(
    parentSessionId: string,
    identifier: string,
    options?: Pick<ListBackgroundTasksOptions, 'userId' | 'tenantId'>,
  ): Promise<RunRecord[]>;
  /** 终态且完成通知仍待投递（或 delivering 超时）的后台任务。 */
  listPendingBackgroundTaskWakes?(staleBefore: Date, limit?: number): Promise<RunRecord[]>;
  listStagedOrgAgentBackgroundTasks?(staleBefore: Date, limit?: number): Promise<RunRecord[]>;
  /** CAS 抢占一条完成通知；返回 null 表示已被其他 brain 抢走。 */
  claimBackgroundTaskWake?(runId: string, claimToken: string, staleBefore: Date): Promise<RunRecord | null>;
  /** CAS 完成通知投递，claimToken 不匹配时拒绝覆盖。 */
  finishBackgroundTaskWake?(
    runId: string,
    claimToken: string,
    state: 'pending' | 'queued' | 'discarded',
    metadataPatch?: Record<string, unknown>,
  ): Promise<RunRecord | null>;
  listStaleWaitingApproval?(cutoff: Date, limit?: number): Promise<RunRecord[]>;
  cancelStaleWaitingApproval?(runId: string, cutoff: Date, reason: string, metadataPatch?: Record<string, unknown>): Promise<RunRecord | null>;
  acquireLease?(
    runId: string,
    workerId: string,
    leaseMs: number,
    now?: Date,
    maxConcurrentRuns?: number,
    admission?: RunLeaseAdmission,
  ): Promise<RunRecord | null>;
  renewLease?(
    runId: string,
    workerId: string,
    leaseMs: number,
    now?: Date,
    source?: RunHeartbeatSource,
  ): Promise<RunRecord | null>;
  /** Immediate activity pulse used by stream/tool/subagent execution paths (server-owned). */
  heartbeatRun?(
    runId: string,
    workerId: string,
    leaseMs: number,
    source: RunHeartbeatSource,
    now?: Date,
  ): Promise<RunRecord | null>;
  /** Explicit disconnect signal; CAS-fenced by owner and terminal-sticky. */
  markLivenessStale?(
    runId: string,
    workerId: string,
    reasonCode: string,
    now?: Date,
  ): Promise<RunRecord | null>;
  /** Two-phase lease-expiry reaper. A run must be durably stale before it can become orphaned. */
  reapExpiredLiveness?(now: Date, staleGraceMs: number, limit?: number): Promise<LivenessReapResult>;
  /** Explicit, idempotent recovery; never automatically replays an uncertain external tool. */
  retryOrphanedUserMessage?(
    submitterUserId: string | undefined,
    clientMsgId: string,
    now?: Date,
  ): Promise<RunRecord | null>;
  cancelUserMessageByClientMsgId?(
    submitterUserId: string | undefined,
    clientMsgId: string,
    reason?: string,
    now?: Date,
  ): Promise<RunRecord | null>;
  releaseLease?(runId: string, workerId: string, finalStatus?: RunStatus, reason?: string): Promise<RunRecord | null>;
  /**
   * RFC v1 P0.4：增量更新 Responses API session state。
   * 用 COALESCE 让 null 显式清空，undefined 保留原值；delta 累加到 cumulative_input_tokens。
   */
  updateResponseSessionState?(runId: string, patch: ResponseSessionStatePatch): Promise<RunRecord | null>;
  /**
   * RFC v1 P0.4：按 sessionId 查最近有 last_response_id 的 run（用于新 run 启动时接力上一 run）。
   * 过滤掉已过期的（last_response_expire_at < now）。
   */
  findLatestResponseSessionStateBySession?(sessionId: string, now?: Date): Promise<LatestResponseSessionState | null>;
  /**
   * /compact 真实现（2026-07-03）：清空整个 session 的 Responses API 接力状态。
   * 压缩后若仍接力旧 response chain，远端保存的全量历史会绕过本地投影，压缩等于没做——
   * 且 findLatestResponseSessionStateBySession 只找「有 last_response_id 的 run」，
   * compact run 自身无 responseId 并不能自然阻断，必须显式按 session 清空。
   * 不更新 updated_at（避免把老 run 顶到观测排序顶部）。返回受影响行数。
   */
  clearResponseSessionStateBySession?(sessionId: string): Promise<number>;
}

export interface PgRunStoreOptions {
  pool?: PgPool;
  connectionString?: string;
  tablePrefix?: string;
}
