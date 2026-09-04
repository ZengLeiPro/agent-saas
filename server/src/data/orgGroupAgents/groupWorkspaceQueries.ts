import type pg from 'pg';

import type { OrgAgentGroupWorkspaceData } from './types.js';
import { mapMemory, mapWorkAttempt, mapWorkConversation, mapWorkOrder } from './storeMappers.js';

export async function loadStoredGroupWorkspace(input: {
  pool: pg.Pool;
  tenantId: string;
  bindingIds: string[];
  limitPerBinding: number;
  tables: { conversations: string; workOrders: string; attempts: string; memories: string };
}): Promise<OrgAgentGroupWorkspaceData> {
  if (input.bindingIds.length === 0)
    return { conversations: [], workOrders: [], attempts: [], memories: [] };
  const params: unknown[] = [input.tenantId, input.bindingIds, input.limitPerBinding];
  const [conversations, workOrders, attempts, memories] = await Promise.all([
    input.pool.query(
      `SELECT * FROM (SELECT row_data.*,
        ROW_NUMBER() OVER (PARTITION BY binding_id ORDER BY updated_at DESC,work_conversation_id DESC) AS workspace_rank
        FROM ${input.tables.conversations} row_data WHERE tenant_id=$1 AND binding_id=ANY($2::text[])) ranked
      WHERE workspace_rank<=$3 ORDER BY binding_id,workspace_rank`,
      params,
    ),
    input.pool.query(
      `SELECT * FROM (SELECT row_data.*,
        ROW_NUMBER() OVER (PARTITION BY binding_id ORDER BY updated_at DESC,work_order_id DESC) AS workspace_rank
        FROM ${input.tables.workOrders} row_data WHERE tenant_id=$1 AND binding_id=ANY($2::text[])) ranked
      WHERE workspace_rank<=$3 ORDER BY binding_id,workspace_rank`,
      params,
    ),
    input.pool.query(
      `WITH ranked_work AS (SELECT row_data.*,
        ROW_NUMBER() OVER (PARTITION BY binding_id ORDER BY updated_at DESC,work_order_id DESC) AS workspace_rank
        FROM ${input.tables.workOrders} row_data WHERE tenant_id=$1 AND binding_id=ANY($2::text[])),
      selected_work AS (SELECT work_order_id FROM ranked_work WHERE workspace_rank<=$3)
      SELECT attempt.* FROM ${input.tables.attempts} attempt
      JOIN selected_work selected ON selected.work_order_id=attempt.work_order_id
      WHERE attempt.tenant_id=$1 ORDER BY attempt.work_order_id,attempt.attempt_no`,
      params,
    ),
    input.pool.query(
      `SELECT * FROM (SELECT row_data.*,
        ROW_NUMBER() OVER (PARTITION BY binding_id ORDER BY updated_at DESC,memory_id DESC) AS workspace_rank
        FROM ${input.tables.memories} row_data WHERE tenant_id=$1 AND binding_id=ANY($2::text[])) ranked
      WHERE workspace_rank<=$3 ORDER BY binding_id,workspace_rank`,
      params,
    ),
  ]);
  return {
    conversations: conversations.rows.map((row) =>
      mapWorkConversation(row as Record<string, unknown>),
    ),
    workOrders: workOrders.rows.map((row) => mapWorkOrder(row as Record<string, unknown>)),
    attempts: attempts.rows.map((row) => mapWorkAttempt(row as Record<string, unknown>)),
    memories: memories.rows.map((row) => mapMemory(row as Record<string, unknown>)),
  };
}

export async function listStoredWorkAttempts(
  pool: pg.Pool,
  table: string,
  tenantId: string,
  workOrderId: string,
) {
  const result = await pool.query(
    `SELECT * FROM ${table} WHERE tenant_id=$1 AND work_order_id=$2 ORDER BY attempt_no ASC`,
    [tenantId, workOrderId],
  );
  return result.rows.map((row) => mapWorkAttempt(row as Record<string, unknown>));
}
