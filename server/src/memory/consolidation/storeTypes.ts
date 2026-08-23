import type {
  ConsolidationRunRecord,
  ConsolidationRunStatus,
  ConsolidationState,
} from './types.js';

export interface PgConsolidationStoreOptions {
  connectionString: string;
  tablePrefix?: string;
  logger?: { info?: (msg: string, meta?: unknown) => void; warn?: (msg: string, meta?: unknown) => void };
}

export interface MemoryConsolidationCommitFence {
  finalizeApplied(input: {
    idempotencyKey: string; toSequence: number; debounceMinutes: number; now: string;
    modelActual?: string; usageJson: unknown;
  }): Promise<void>;
  retireJournalAndRequeue(input: {
    idempotencyKey: string; now: string; usageJson: unknown; errorCode: string; errorMessage: string;
  }): Promise<void>;
  release(): Promise<void>;
}

export interface MemoryConsolidationCommitFenceResult {
  fence: MemoryConsolidationCommitFence | null;
  boundaryChanged: boolean;
}

export interface MemoryConsolidationCommitLock {
  acquireFence(input: {
    tenantId: string; sessionId: string; leaseOwner: string; now: string;
    fromSequence: number; toSequence: number; boundarySequence: number;
  }): Promise<MemoryConsolidationCommitFenceResult>;
  release(): Promise<void>;
}

export interface RunUpdateInput {
  idempotencyKey: string; status?: ConsolidationRunStatus; modelActual?: string; usageJson?: unknown;
  errorCode?: string; errorMessage?: string; incrementRetry?: boolean; applied?: boolean; finished?: boolean;
}

export interface StateRow {
  tenant_id: string; user_id: string; workspace_id: string; session_id: string;
  processed_session_sequence: string; target_session_sequence: string; last_boundary_global_sequence: string;
  first_pending_at: Date | null; due_at: Date | null; last_activity_at: Date | null;
  active_run_ids: unknown; status: string; attempts: number; next_attempt_at: Date | null;
  lease_owner: string | null; lease_expires_at: Date | null; prompt_version: number | null;
}

export function mapState(row: StateRow): ConsolidationState {
  return {
    tenantId: row.tenant_id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    processedSessionSequence: Number(row.processed_session_sequence),
    targetSessionSequence: Number(row.target_session_sequence),
    lastBoundaryGlobalSequence: Number(row.last_boundary_global_sequence),
    firstPendingAt: row.first_pending_at?.toISOString() ?? null,
    dueAt: row.due_at?.toISOString() ?? null,
    lastActivityAt: row.last_activity_at?.toISOString() ?? null,
    activeRunIds: Array.isArray(row.active_run_ids) ? (row.active_run_ids as string[]) : [],
    status: row.status as ConsolidationState['status'],
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at?.toISOString() ?? null,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null,
    promptVersion: row.prompt_version,
  };
}

export function mapRun(row: Record<string, unknown>): ConsolidationRunRecord {
  return {
    id: String(row.id),
    idempotencyKey: String(row.idempotency_key),
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    workspaceId: String(row.workspace_id),
    sessionId: String(row.session_id),
    fromSessionSequence: Number(row.from_session_sequence),
    toSessionSequence: Number(row.to_session_sequence),
    status: String(row.status) as ConsolidationRunStatus,
    modelRequested: (row.model_requested as string | null) ?? null,
    modelActual: (row.model_actual as string | null) ?? null,
    promptVersion: Number(row.prompt_version),
    usageJson: row.usage_json,
    retryCount: Number(row.retry_count ?? 0),
    errorCode: (row.error_code as string | null) ?? null,
    errorMessage: (row.error_message as string | null) ?? null,
  };
}
