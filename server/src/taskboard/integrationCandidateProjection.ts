import pg from 'pg';

import type { TaskBoardTask } from '../../../shared/src/types/taskboard.js';
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

export async function loadIntegrationCandidateProjection(
  store: IntegrationCandidateProjectionHost,
  identity: TaskboardIdentity,
  integrationTaskId: string,
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
  const [revisions, snapshots, operations] = await Promise.all([
    store.pool.query(`SELECT * FROM ${tables.revisionsTable} WHERE candidate_id=$1 ORDER BY revision`, [row.id]),
    store.pool.query(`SELECT * FROM ${tables.sourceSnapshotsTable} WHERE candidate_id=$1 ORDER BY revision,source_order`, [row.id]),
    store.pool.query(`SELECT * FROM ${tables.providerOperationsTable} WHERE candidate_id=$1 ORDER BY created_at`, [row.id]),
  ]);
  return {
    candidate: rowToIntegrationCandidate(row),
    revisions: revisions.rows.map(rowToIntegrationCandidateRevision),
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
    lastRefreshedAt: new Date().toISOString(),
  };
}
