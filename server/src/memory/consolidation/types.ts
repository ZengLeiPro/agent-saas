/**
 * L2 会话级记忆审查。
 *
 * 触发正确性来自 PG durable global cursor；每个会话按
 * (processed_session_sequence, target_session_sequence] 记录幂等范围。隐藏 Run
 * 从父会话完整 Context Projection 重放，并直接维护真实 Markdown。
 */

/** throttled 仅用于兼容旧版本遗留状态；新引擎启动时会恢复为 pending。 */
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
  lastBoundaryGlobalSequence: number;
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

/** 旧状态保留给存量 ledger 兼容；新实现只写 started/applied/retryable_failed/permanent_failed。 */
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
  normalizedFingerprint: string | null;
  subjectText: string | null;
  scope: TombstoneScope;
  source: 'explicit_user_forget' | 'explicit_user_correction' | 'admin_repair';
  reason: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface MemoryConsolidationScannerStatus {
  capturedAt: string;
  consumerName: string;
  cursor: number;
  cursorUpdatedAt: string | null;
  latestBoundarySequence: number;
  latestBoundaryAt: string | null;
  sequenceLag: number;
  oldestPendingBoundarySequence: number | null;
  oldestPendingBoundaryAt: string | null;
  oldestPendingAgeMs: number | null;
  skips24hByReason: Record<string, number>;
  latestSkipAt: string | null;
}

export interface MemoryConsolidationResolvedConfig {
  enabled: boolean;
  debounceMinutes: number;
  scanIntervalMs: number;
  scanBatchSize: number;
  workerConcurrency: number;
  leaseSeconds: number;
  timeoutSeconds: number;
  maxRetries: number;
  maxTurns: number;
  includeInterrupted: boolean;
  promptVersion: number;
}

export function withMemoryConsolidationLeaseBuffer(
  config: MemoryConsolidationResolvedConfig,
): MemoryConsolidationResolvedConfig {
  return { ...config, leaseSeconds: Math.max(config.leaseSeconds, config.timeoutSeconds + 300) };
}

export const MEMORY_CONSOLIDATION_DEFAULTS: MemoryConsolidationResolvedConfig = {
  enabled: false,
  debounceMinutes: 30,
  scanIntervalMs: 10_000,
  scanBatchSize: 500,
  workerConcurrency: 2,
  // lease 必须覆盖一小时 Run 上限，并留出提交与终态落库缓冲，避免过期后重复领取。
  leaseSeconds: 3_900,
  timeoutSeconds: 3_600,
  maxRetries: 5,
  maxTurns: 1_000,
  includeInterrupted: true,
  promptVersion: 2,
};

/** 重试退避序列（分钟）：5m、15m、1h、6h、24h。 */
export const CONSOLIDATION_RETRY_BACKOFF_MINUTES = [5, 15, 60, 360, 1440] as const;
