import type { PoolClient } from 'pg';

import type { TaskBoardTask } from '../../../shared/src/types/taskboard.js';
import { integrationAgentTableNames } from './integrationAgentSchema.js';
import { integrationCandidateTableNames } from './integrationCandidateSchema.js';
import type { TaskboardV2StoreOptions } from './v2Store.js';
import { TaskboardValidationError } from './types.js';

/**
 * One-way compatibility bridge for integrations created by the retired v3
 * candidate runtime. Candidate/revision rows are historical input only; every
 * caller continues exclusively through the durable Agent rendezvous afterwards.
 */
export async function ensureLegacyIntegrationAgentRendezvous(
  options: Pick<TaskboardV2StoreOptions, 'integrationSourcesTable' | 'tasksTable'>,
  client: Pick<PoolClient, 'query'>,
  task: TaskBoardTask,
): Promise<boolean> {
  if (task.kind !== 'integration' || task.workflowVersion !== 3) return false;
  const { agentsTable } = integrationAgentTableNames(options.integrationSourcesTable);
  const existing = await client.query(
    `SELECT 1 FROM ${agentsTable} WHERE integration_task_id=$1 FOR UPDATE`, [task.id],
  );
  if (existing.rows[0]) {
    await migrateLegacyIntegrationSourceHeads(options, client, task.id);
    return true;
  }

  const legacy = integrationCandidateTableNames(options.integrationSourcesTable);
  const candidate = await client.query(
    `SELECT c.repository_id,c.branch,c.provider_pull_request_id,c.state,
            c.approved_review_execution_id,r.head_oid
       FROM ${legacy.candidatesTable} c
       LEFT JOIN ${legacy.revisionsTable} r ON r.candidate_id=c.id AND r.revision=c.current_revision
      WHERE c.integration_task_id=$1
      FOR UPDATE OF c`, [task.id],
  );
  const row = candidate.rows[0];
  if (!row) return false;
  const sources = await client.query(
    `SELECT id FROM ${options.integrationSourcesTable}
      WHERE integration_task_id=$1 ORDER BY source_order,id`, [task.id],
  );
  const legacyState = String(row.state);
  const approved = legacyState === 'approved' && row.head_oid && row.approved_review_execution_id;
  const status = legacyState === 'merged' ? 'merged'
    : legacyState === 'canceled' ? 'canceled'
      : approved ? 'ready_to_merge'
        : legacyState === 'in_review' ? 'reviewing' : 'active';
  await client.query(
    `INSERT INTO ${agentsTable}
       (integration_task_id,delivery_source_ids,repository_id,integration_branch,provider_pull_request_id,
        status,review_head_oid,verdict,review_execution_id)
     VALUES ($1,$2::jsonb,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (integration_task_id) DO NOTHING`,
    [task.id, JSON.stringify(sources.rows.map((source) => String(source.id))), String(row.repository_id),
      String(row.branch), row.provider_pull_request_id ? String(row.provider_pull_request_id) : null,
      status, approved ? String(row.head_oid) : null, approved ? 'approved' : null,
      approved ? String(row.approved_review_execution_id) : null],
  );
  await migrateLegacyIntegrationSourceHeads(options, client, task.id);
  return true;
}

/** Copies only the immutable, reviewed head recorded by the retired Candidate source snapshot. */
export async function migrateLegacyIntegrationSourceHeads(
  options: Pick<TaskboardV2StoreOptions, 'integrationSourcesTable' | 'tasksTable'>,
  client: Pick<PoolClient, 'query'>,
  taskId: string,
): Promise<void> {
  const legacy = integrationCandidateTableNames(options.integrationSourcesTable);
  const exists = await client.query(`SELECT to_regclass($1) AS snapshots_table`, [legacy.sourceSnapshotsTable]);
  if (!exists.rows[0]?.snapshots_table) return;
  await client.query(
    `UPDATE ${options.integrationSourcesTable} s
        SET frozen_head_oid=snapshot.frozen_head_oid,updated_at=now()
       FROM ${legacy.candidatesTable} candidate
       JOIN ${legacy.sourceSnapshotsTable} snapshot
         ON snapshot.candidate_id=candidate.id AND snapshot.revision=candidate.current_revision
      WHERE candidate.integration_task_id=$1 AND snapshot.integration_source_id=s.id
        AND s.integration_task_id=$1 AND s.frozen_head_oid IS NULL`,
    [taskId],
  );
}

export async function requireIntegrationAgentRendezvous(
  options: Pick<TaskboardV2StoreOptions, 'integrationSourcesTable' | 'tasksTable'>,
  client: Pick<PoolClient, 'query'>,
  task: TaskBoardTask,
): Promise<void> {
  if (!await ensureLegacyIntegrationAgentRendezvous(options, client, task)) {
    throw new TaskboardValidationError(
      'Integration task has no Agent rendezvous record',
      'TASKBOARD_INTEGRATION_AGENT_REQUIRED',
    );
  }
}
