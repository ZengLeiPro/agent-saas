import type { PoolClient } from 'pg';

import { PostgresIntegrationV3ActivationStore } from './integrationV3ActivationStore.js';
import { integrationCandidateTableNames } from './integrationCandidateSchema.js';
import type { IntegrationV3RepairTables } from './integrationV3Repair.js';

export interface IntegrationV3MetricsSnapshot {
  capturedAt: string;
  unknownOperationCount: number;
  oldestUnknownOperationAgeMs: number | null;
  staleLaneCount: number;
  staleOutboxCount: number;
  oldestOutboxAgeMs: number | null;
  cleanupFailureCount: number;
  activeFailedCandidateCount?: number;
  gatewayDisabled: boolean;
  gatewayHealthy: boolean;
  gatewayReason?: string;
  activeV2Count: number;
  activeV3Count: number;
  /** Reserved until provider usage is durably attributed to a candidate. */
  costBudgetUsed: number | null;
  /** Reserved until a policy-level cost ceiling is persisted. */
  costBudgetLimit: number | null;
  workRoundBudgetUsed: number | null;
  workRoundBudgetLimit: number | null;
}

export interface IntegrationV3HealthThresholds {
  maxUnknownOperationAgeMs: number;
  maxStaleLaneCount: number;
  maxOutboxAgeMs: number;
  maxCleanupFailureCount: number;
  maxActiveFailedCandidateCount: number;
  requireGateway: boolean;
}

export type IntegrationV3HealthStatus = {
  status: 'not_applicable';
  releaseReady: true;
  reasons: [];
} | {
  status: 'ok' | 'degraded';
  releaseReady: boolean;
  reasons: string[];
  metrics: IntegrationV3MetricsSnapshot;
};

export interface IntegrationV3GatewayHealth {
  enabled: boolean;
  healthy: boolean;
  reason?: string;
}

const DEFAULT_THRESHOLDS: IntegrationV3HealthThresholds = {
  maxUnknownOperationAgeMs: 5 * 60_000,
  maxStaleLaneCount: 0,
  maxOutboxAgeMs: 15 * 60_000,
  maxCleanupFailureCount: 0,
  maxActiveFailedCandidateCount: 0,
  requireGateway: true,
};

type Queryable = Pick<PoolClient, 'query'>;

export function createIntegrationV3HealthProvider(store: {
  pool: Queryable;
  tasksTable: string;
  executionsTable: string;
  integrationLanesTable: string;
  integrationSourcesTable: string;
}, getGatewayHealth?: () => Promise<IntegrationV3GatewayHealth>): () => Promise<IntegrationV3HealthStatus> {
  const candidateTables = integrationCandidateTableNames(store.integrationSourcesTable);
  const tables: IntegrationV3RepairTables = {
    tasks: store.tasksTable, executions: store.executionsTable, lanes: store.integrationLanesTable,
    candidates: candidateTables.candidatesTable, providerOperations: candidateTables.providerOperationsTable,
    requestsOutbox: candidateTables.requestsOutboxTable,
  };
  return async () => evaluateIntegrationV3Health(await collectIntegrationV3Metrics(store.pool, tables, getGatewayHealth));
}

export function createRuntimeIntegrationV3HealthProvider(
  enabled: boolean,
  store: Parameters<typeof createIntegrationV3HealthProvider>[0] | undefined,
  getRuntimeHealth: () => Promise<IntegrationV3GatewayHealth> | undefined,
  processRole: 'all' | 'ws-only' | 'scheduler-only' | 'runtime-worker' = 'all',
): () => Promise<IntegrationV3HealthStatus> {
  if (!enabled) return async () => ({ status: 'not_applicable', releaseReady: true, reasons: [] });
  if (!store) return async () => evaluateIntegrationV3Health(unavailableMetrics('runtime_store_unavailable'));
  const tables = integrationCandidateTableNames(store.integrationSourcesTable);
  const activationStore = new PostgresIntegrationV3ActivationStore(store.pool, tables.activationHeartbeatsTable);
  return createIntegrationV3HealthProvider(store, async () => {
    if (processRole === 'ws-only') return activationStore.compatibleHealth();
    return await getRuntimeHealth()
      ?? { enabled: true, healthy: false, reason: 'worker_or_required_adapter_unavailable' };
  });
}

function unavailableMetrics(reason: string): IntegrationV3MetricsSnapshot {
  return {
    capturedAt: new Date().toISOString(), unknownOperationCount: 0, oldestUnknownOperationAgeMs: null,
    staleLaneCount: 0, staleOutboxCount: 0, oldestOutboxAgeMs: null, cleanupFailureCount: 0,
    gatewayDisabled: false, gatewayHealthy: false, gatewayReason: reason, activeV2Count: 0, activeV3Count: 0,
    costBudgetUsed: null, costBudgetLimit: null, workRoundBudgetUsed: null, workRoundBudgetLimit: null,
  };
}

export async function collectIntegrationV3Metrics(
  db: Queryable,
  tables: IntegrationV3RepairTables,
  getGatewayHealth: () => Promise<IntegrationV3GatewayHealth> = async () => ({ enabled: false, healthy: false, reason: 'not_configured' }),
): Promise<IntegrationV3MetricsSnapshot> {
  const [result, gateway] = await Promise.all([
    db.query(
      `SELECT
         (SELECT count(*)::int FROM ${tables.providerOperations} WHERE state IN ('executing','unknown')) AS unknown_count,
         (SELECT EXTRACT(EPOCH FROM (clock_timestamp()-min(updated_at)))*1000
            FROM ${tables.providerOperations} WHERE state IN ('executing','unknown')) AS unknown_age_ms,
         (SELECT count(*)::int
            FROM ${tables.lanes} l JOIN ${tables.tasks} t ON t.id=l.active_integration_task_id
            LEFT JOIN ${tables.candidates} c ON c.integration_task_id=t.id
           WHERE t.workflow_version=3 AND (t.status IN ('done','canceled') OR c.id IS NULL
             OR c.state IN ('merged','canceled') OR c.lane_epoch<>l.epoch)) AS stale_lane_count,
         (SELECT count(*)::int FROM ${tables.requestsOutbox}
           WHERE status IN ('pending','processing') AND updated_at < now()-interval '15 minutes') AS stale_outbox_count,
         (SELECT EXTRACT(EPOCH FROM (clock_timestamp()-min(created_at)))*1000
            FROM ${tables.requestsOutbox} WHERE status IN ('pending','processing')) AS outbox_age_ms,
         (SELECT count(*)::int FROM ${tables.requestsOutbox}
           WHERE kind='cleanup' AND status='failed') AS cleanup_failure_count,
         (SELECT count(*)::int FROM ${tables.candidates}
           WHERE worker_status='failed' AND state NOT IN ('merged','canceled')) AS active_failed_candidate_count,
         (SELECT count(*)::int FROM ${tables.tasks}
           WHERE kind='integration' AND workflow_version=2 AND status NOT IN ('done','canceled')) AS active_v2_count,
         (SELECT count(*)::int FROM ${tables.candidates}
           WHERE state NOT IN ('merged','canceled')) AS active_v3_count`,
    ),
    getGatewayHealth(),
  ]);
  const row = result.rows[0] ?? {};
  return {
    capturedAt: new Date().toISOString(),
    unknownOperationCount: integer(row.unknown_count),
    oldestUnknownOperationAgeMs: nullableNumber(row.unknown_age_ms),
    staleLaneCount: integer(row.stale_lane_count),
    staleOutboxCount: integer(row.stale_outbox_count),
    oldestOutboxAgeMs: nullableNumber(row.outbox_age_ms),
    cleanupFailureCount: integer(row.cleanup_failure_count),
    activeFailedCandidateCount: integer(row.active_failed_candidate_count),
    gatewayDisabled: gateway.enabled !== true,
    gatewayHealthy: gateway.enabled === true && gateway.healthy === true,
    ...(gateway.reason ? { gatewayReason: gateway.reason } : {}),
    activeV2Count: integer(row.active_v2_count),
    activeV3Count: integer(row.active_v3_count),
    costBudgetUsed: null,
    costBudgetLimit: null,
    workRoundBudgetUsed: null,
    workRoundBudgetLimit: null,
  };
}

export function evaluateIntegrationV3Health(
  metrics: IntegrationV3MetricsSnapshot,
  thresholds: Partial<IntegrationV3HealthThresholds> = {},
): IntegrationV3HealthStatus {
  const limits = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const reasons: string[] = [];
  if (metrics.oldestUnknownOperationAgeMs !== null
    && metrics.oldestUnknownOperationAgeMs > limits.maxUnknownOperationAgeMs) reasons.push('unknown_operation_too_old');
  if (metrics.staleLaneCount > limits.maxStaleLaneCount) reasons.push('stale_integration_lane');
  if (metrics.oldestOutboxAgeMs !== null && metrics.oldestOutboxAgeMs > limits.maxOutboxAgeMs) reasons.push('stale_request_outbox');
  if (metrics.cleanupFailureCount > limits.maxCleanupFailureCount) reasons.push('cleanup_failure');
  if ((metrics.activeFailedCandidateCount ?? 0) > limits.maxActiveFailedCandidateCount) reasons.push('active_failed_candidate');
  if (limits.requireGateway && metrics.gatewayDisabled) reasons.push('gateway_disabled');
  else if (limits.requireGateway && !metrics.gatewayHealthy) reasons.push('gateway_unhealthy');
  return { status: reasons.length === 0 ? 'ok' : 'degraded', releaseReady: reasons.length === 0, reasons, metrics };
}

/** Global false wins; a repository override can only disable, never bypass the global switch. */
export class IntegrationV3KillSwitch {
  private globalEnabled: boolean;
  private readonly disabledRepositories = new Set<string>();

  constructor(input: { globalEnabled?: boolean; disabledRepositories?: Iterable<string> } = {}) {
    this.globalEnabled = input.globalEnabled === true;
    for (const repositoryId of input.disabledRepositories ?? []) this.disabledRepositories.add(repositoryId);
  }

  setGlobalEnabled(enabled: boolean): void { this.globalEnabled = enabled; }
  setRepositoryEnabled(repositoryId: string, enabled: boolean): void {
    if (enabled) this.disabledRepositories.delete(repositoryId);
    else this.disabledRepositories.add(repositoryId);
  }
  check(repositoryId: string): { enabled: boolean; scope?: 'global' | 'repository' } {
    if (!this.globalEnabled) return { enabled: false, scope: 'global' };
    if (this.disabledRepositories.has(repositoryId)) return { enabled: false, scope: 'repository' };
    return { enabled: true };
  }
  assertEnabled(repositoryId: string): void {
    const result = this.check(repositoryId);
    if (!result.enabled) throw new IntegrationV3KillSwitchError(result.scope!);
  }
}

export class IntegrationV3KillSwitchError extends Error {
  readonly code = 'TASKBOARD_INTEGRATION_V3_KILLED';
  constructor(public readonly scope: 'global' | 'repository') {
    super(`Integration workflow v3 is disabled by the ${scope} kill switch`);
    this.name = 'IntegrationV3KillSwitchError';
  }
}

export async function assertIntegrationV3DestructiveActionAllowed(
  db: Queryable,
  tables: IntegrationV3RepairTables,
  input: { taskId?: string; boardId?: string },
): Promise<void> {
  if (!input.taskId && !input.boardId) throw new Error('taskId or boardId is required');
  const result = await db.query(
    `SELECT c.id,c.integration_task_id,c.state,
            EXISTS (SELECT 1 FROM ${tables.providerOperations} o
              WHERE o.candidate_id=c.id AND o.state IN ('prepared','executing','unknown')) AS provider_work,
            EXISTS (SELECT 1 FROM ${tables.requestsOutbox} q
              WHERE q.candidate_id=c.id AND q.status IN ('pending','processing')) AS outbox_work
       FROM ${tables.candidates} c
       JOIN ${tables.tasks} t ON t.id=c.integration_task_id
      WHERE ($1::text IS NOT NULL AND t.id=$1)
         OR ($2::text IS NOT NULL AND t.board_id=$2)`,
    [input.taskId ?? null, input.boardId ?? null],
  );
  const blocked = result.rows.find((row) => !INTEGRATION_V3_TERMINAL_STATES.has(String(row.state))
    || row.provider_work === true || row.outbox_work === true);
  if (blocked) throw new IntegrationV3DestructiveActionError(String(blocked.integration_task_id), String(blocked.state));
}

export class IntegrationV3DestructiveActionError extends Error {
  readonly code = 'TASKBOARD_INTEGRATION_V3_ACTIVE';
  constructor(public readonly taskId: string, public readonly candidateState: string) {
    super('Workflow v3 candidate/provider/outbox state must be terminal before archive or delete');
    this.name = 'IntegrationV3DestructiveActionError';
  }
}

const INTEGRATION_V3_TERMINAL_STATES = new Set(['merged', 'canceled']);
function integer(value: unknown): number { return Math.max(0, Math.floor(Number(value) || 0)); }
function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : null;
}
