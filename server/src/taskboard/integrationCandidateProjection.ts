import pg from 'pg';

import type { TaskBoardIntegrationCandidateDetails, TaskBoardTask } from '../../../shared/src/types/taskboard.js';
import {
  rowToIntegrationCandidate,
  rowToIntegrationCandidateRevision,
  rowToIntegrationCandidateSourceSnapshot,
} from './integrationCandidateMapper.js';
import { integrationCandidateTableNames } from './integrationCandidateSchema.js';
import {
  TaskboardNotFoundError,
  TaskboardValidationError,
  type TaskboardIdentity,
} from './types.js';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

export interface IntegrationCandidateProjectionHost {
  pool: PgPool;
  integrationSourcesTable: string;
  getTask(identity: TaskboardIdentity, taskId: string): Promise<TaskBoardTask>;
}

export interface IntegrationCandidateProjectionOptions {
  /** Default false: only the current revision is returned. */
  includeHistory?: boolean;
  page?: number;
  pageSize?: number;
}

export async function loadIntegrationCandidateProjection(
  store: IntegrationCandidateProjectionHost,
  identity: TaskboardIdentity,
  integrationTaskId: string,
  options: IntegrationCandidateProjectionOptions = {},
) {
  const task = await store.getTask(identity, integrationTaskId);
  if (task.kind !== 'integration' || task.workflowVersion !== 3) {
    throw new TaskboardValidationError(
      'Task is not a Workflow v3 integration',
      'TASKBOARD_CANDIDATE_WORKFLOW_VERSION_REQUIRED',
    );
  }
  const tables = integrationCandidateTableNames(store.integrationSourcesTable);
  const candidateResult = await store.pool.query(
    `SELECT * FROM ${tables.candidatesTable} WHERE integration_task_id=$1`,
    [integrationTaskId],
  );
  const row = candidateResult.rows[0];
  if (!row) throw new TaskboardNotFoundError('Integration candidate not found');

  const includeHistory = options.includeHistory === true;
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(options.pageSize ?? 20)));
  const revisionResult = includeHistory
    ? await store.pool.query(
      `SELECT * FROM ${tables.revisionsTable} WHERE candidate_id=$1
        ORDER BY revision DESC LIMIT $2 OFFSET $3`,
      [row.id, pageSize, (page - 1) * pageSize],
    )
    : await store.pool.query(
      `SELECT * FROM ${tables.revisionsTable} WHERE candidate_id=$1 AND revision=$2`,
      [row.id, Number(row.current_revision)],
    );
  const revisionNumbers = revisionResult.rows.map((revision) => Number(revision.revision));
  const [countResult, snapshots, operations, cleanupResult] = await Promise.all([
    includeHistory
      ? store.pool.query(`SELECT count(*)::int AS total FROM ${tables.revisionsTable} WHERE candidate_id=$1`, [row.id])
      : Promise.resolve({ rows: [{ total: revisionNumbers.length }] }),
    revisionNumbers.length
      ? store.pool.query(
        `SELECT * FROM ${tables.sourceSnapshotsTable}
          WHERE candidate_id=$1 AND revision=ANY($2::int[]) ORDER BY revision DESC,source_order`,
        [row.id, revisionNumbers],
      )
      : Promise.resolve({ rows: [] }),
    revisionNumbers.length
      ? store.pool.query(
        `SELECT * FROM ${tables.providerOperationsTable}
          WHERE candidate_id=$1 AND candidate_revision=ANY($2::int[]) ORDER BY created_at DESC`,
        [row.id, revisionNumbers],
      )
      : Promise.resolve({ rows: [] }),
    store.pool.query(
      `SELECT status,last_error,receipt,updated_at FROM ${tables.requestsOutboxTable}
        WHERE candidate_id=$1 AND kind='cleanup' AND candidate_revision=$2
        ORDER BY created_at DESC LIMIT 1`,
      [row.id, Number(row.current_revision)],
    ),
  ]);
  const total = Number(countResult.rows[0]?.total ?? 0);
  const cleanup = cleanupProjection(cleanupResult.rows[0]);
  return {
    candidate: rowToIntegrationCandidate(row),
    revisions: revisionResult.rows.map(rowToIntegrationCandidateRevision),
    sourceSnapshots: snapshots.rows.map(rowToIntegrationCandidateSourceSnapshot),
    operations: operations.rows.map((operation) => ({
      id: String(operation.id), operationKey: String(operation.operation_key), kind: String(operation.kind),
      state: String(operation.state), attemptCount: Number(operation.attempt_count),
      ...(operation.error ? { error: String(operation.error) } : {}),
      ...(operation.receipt ? {
        receipt: typeof operation.receipt === 'string' ? JSON.parse(operation.receipt) : operation.receipt,
      } : {}),
      updatedAt: operation.updated_at instanceof Date
        ? operation.updated_at.toISOString()
        : String(operation.updated_at),
    })),
    worker: {
      status: String(row.worker_status ?? 'idle'),
      checkpoint: typeof row.worker_checkpoint === 'string'
        ? JSON.parse(row.worker_checkpoint)
        : row.worker_checkpoint ?? {},
      ...(row.worker_error ? { error: String(row.worker_error) } : {}),
    },
    ...(cleanup ? { cleanup } : {}),
    history: { includeHistory, page, pageSize, total, hasMore: includeHistory && page * pageSize < total },
    lastRefreshedAt: new Date().toISOString(),
  };
}

function cleanupProjection(row: Record<string, unknown> | undefined) {
  if (!row) return undefined;
  const status = String(row.status);
  const reason = row.last_error ? String(row.last_error) : undefined;
  const receipt = row.receipt
    ? (typeof row.receipt === 'string' ? JSON.parse(row.receipt) : row.receipt) as NonNullable<TaskBoardIntegrationCandidateDetails['cleanup']>['receipt']
    : undefined;
  const actions = Array.isArray(receipt?.actions) ? receipt.actions as Array<Record<string, unknown>> : [];
  const allSkipped = actions.length > 0 && actions.every((action) => action.status === 'skipped');
  const legacySkipped = !receipt && Boolean(reason && /skipped-by-policy|disabled/i.test(reason));
  const outcome: 'pending' | 'completed' | 'failed' | 'skipped' = status === 'failed' || receipt?.outcome === 'failed'
    ? 'failed'
    : status === 'completed' && (allSkipped || legacySkipped) ? 'skipped'
      : status === 'completed' && receipt?.outcome === 'succeeded' ? 'completed' : 'pending';
  return {
    outcome,
    requestStatus: status,
    ...(reason ? { reason } : {}),
    ...(receipt ? { receipt } : {}),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}
