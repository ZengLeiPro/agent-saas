import type { PoolClient } from 'pg';

import type { TaskBoardExecutionIntegrationAgent } from '../../../shared/src/types/taskboard.js';
import { integrationAgentTableNames } from './integrationAgentSchema.js';

/** Minimal execution projection; the Agent record is the only live integration protocol state. */
export async function loadExecutionIntegrationAgent(
  client: Pick<PoolClient, 'query'>,
  integrationSourcesTable: string,
  taskId: string,
): Promise<TaskBoardExecutionIntegrationAgent | undefined> {
  const { agentsTable } = integrationAgentTableNames(integrationSourcesTable);
  const result = await client.query(
    `SELECT integration_task_id,delivery_source_ids,repository_id,durable_session_id,status,updated_at
       FROM ${agentsTable} WHERE integration_task_id=$1`, [taskId],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  const sourceIds = Array.isArray(row.delivery_source_ids) ? row.delivery_source_ids : [];
  return {
    integrationTaskId: String(row.integration_task_id),
    deliverySourceIds: sourceIds.map(String),
    repositoryId: String(row.repository_id),
    status: normalizeStatus(row.status),
    ...(row.durable_session_id ? { durableSessionId: String(row.durable_session_id) } : {}),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

function normalizeStatus(value: unknown): TaskBoardExecutionIntegrationAgent['status'] {
  const status = String(value);
  if (status === 'merged' || status === 'canceled') return status;
  return 'active';
}
