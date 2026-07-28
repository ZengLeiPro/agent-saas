/**
 * L2 会话级记忆整合（memory consolidation，2026-07-29 记忆写入职责剥离批次）。
 *
 * 设计权威源：assets/20260728 GPT 5.6 Pro 报告（经独立验收）。核心不变量：
 *   - 触发正确性来自 PG durable global cursor 扫描；LISTEN/NOTIFY 只作低延迟唤醒
 *     （subscribeAppended 对首见会话不回放历史，不能当队列——pgEventStore.ts 注释）。
 *   - 每个会话按 (processed_session_sequence, target_session_sequence] 处理增量；
 *     processed 游标只在 applied/noop 后推进。
 *   - idempotencyKey = sha256(tenant|session|from|to)，唯一约束防蓝绿双跑双写。
 *   - 「忘记」以 tombstone（逻辑删除）落 PG：L2/L3 提交候选前必须查 tombstone，
 *     防止从 append-only 历史复活已忘内容。
 */

export type ConsolidationStateStatus =
  | 'idle'
  | 'pending'
  | 'running'
  | 'retry_wait'
  | 'blocked'
  | 'throttled';

export interface ConsolidationState {
  tenantId: string;
  userId: string;
  workspaceId: string;
  sessionId: string;
  processedSessionSequence: number;
  targetSessionSequence: number;
  firstPendingAt: string | null;
  dueAt: string | null;
  lastActivityAt: string | null;
  activeRunIds: string[];
  status: ConsolidationStateStatus;
  attempts: number;
  nextAttemptAt: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  promptVersion: number | null;
}

export type ConsolidationRunStatus =
  | 'started'
  | 'prepared'
  | 'applied'
  | 'noop'
  | 'rejected'
  | 'retryable_failed'
  | 'permanent_failed'
  | 'tombstone_blocked';

export interface ConsolidationRunRecord {
  id: string;
  idempotencyKey: string;
  tenantId: string;
  userId: string;
  workspaceId: string;
  sessionId: string;
  fromSessionSequence: number;
  toSessionSequence: number;
  status: ConsolidationRunStatus;
  modelRequested: string | null;
  modelActual: string | null;
  promptVersion: number;
  inputHash: string | null;
  baseMemoryHash: string | null;
  plannedPostimageHash: string | null;
  proposalJson: unknown;
  usageJson: unknown;
  retryCount: number;
  errorCode: string | null;
  errorMessage: string | null;
}

export type TombstoneScope = 'item' | 'subject' | 'all_memory';

export interface MemoryTombstone {
  id: string;
  tenantId: string;
  userId: string;
  workspaceId: string;
  memoryKey: string | null;
  /** 归一化指纹：小写、去空白/标点的关键词串，用于同义粗匹配。 */
  normalizedFingerprint: string | null;
  /** subject 原文（用户表达的「要忘记的对象」），语义匹配走 MemorySearch。 */
  subjectText: string | null;
  scope: TombstoneScope;
  source: 'explicit_user_forget' | 'explicit_user_correction' | 'admin_repair';
  reason: string | null;
  createdAt: string;
  revokedAt: string | null;
}

/** MemoryCommit 工具的候选操作（模型可见 schema 的一部分）。 */
export type CandidateAttribution = 'user_statement' | 'agent_inference' | 'external_source';

export interface MemoryCandidateOperation {
  target: 'daily';
  action: 'upsert' | 'supersede' | 'noop';
  memoryKey: string;
  supersedesMemoryKey?: string;
  text: string;
  attribution: CandidateAttribution;
  evidence: Array<{
    eventId: string;
    sessionSequence: number;
    sourceQuote: string;
  }>;
  observedAt?: string;
}

/** worker 在启动 L2 隐藏 run 前登记、MemoryCommit 执行时读取的服务端上下文。 */
export interface ConsolidationExecutionContext {
  tenantId: string;
  userId: string;
  username: string;
  workspaceId: string;
  /** 被整合的正式会话 */
  sourceSessionId: string;
  fromSessionSequence: number;
  toSessionSequence: number;
  idempotencyKey: string;
  consolidationRunId: string;
  /** 允许作为证据的 eventId → { sequence, role, text } 白名单（服务端投影时生成）。 */
  evidenceIndex: Map<string, { sessionSequence: number; role: 'user' | 'assistant' | 'tool'; text: string }>;
  /** 本次提交结果（worker 回读）。 */
  commitResult?: {
    status: 'applied' | 'noop' | 'rejected' | 'tombstone_blocked';
    appliedCount: number;
    rejectedCount: number;
    postimageHash?: string;
  };
}

export interface MemoryConsolidationResolvedConfig {
  enabled: boolean;
  debounceMinutes: number;
  maxDeferralMinutes: number;
  contextAnchorRuns: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCandidates: number;
  maxConsolidationsPerUserPerDay: number;
  maxInputTokensPerUserPerDay: number;
  scanIntervalMs: number;
  scanBatchSize: number;
  workerConcurrency: number;
  leaseSeconds: number;
  timeoutSeconds: number;
  maxRetries: number;
  maxTurns: number;
  includeInterrupted: boolean;
  includeError: boolean;
  model?: string;
  reasoningEffort?: string;
  promptVersion: number;
}

export const MEMORY_CONSOLIDATION_DEFAULTS: MemoryConsolidationResolvedConfig = {
  enabled: false,
  debounceMinutes: 10,
  maxDeferralMinutes: 60,
  contextAnchorRuns: 2,
  maxInputTokens: 12_000,
  maxOutputTokens: 1_200,
  maxCandidates: 20,
  maxConsolidationsPerUserPerDay: 12,
  maxInputTokensPerUserPerDay: 100_000,
  scanIntervalMs: 10_000,
  scanBatchSize: 500,
  workerConcurrency: 2,
  leaseSeconds: 900,
  timeoutSeconds: 600,
  maxRetries: 5,
  maxTurns: 8,
  includeInterrupted: true,
  includeError: false,
  promptVersion: 1,
};

/** 重试退避序列（分钟）：5m、15m、1h、6h、24h。 */
export const CONSOLIDATION_RETRY_BACKOFF_MINUTES = [5, 15, 60, 360, 1440] as const;
