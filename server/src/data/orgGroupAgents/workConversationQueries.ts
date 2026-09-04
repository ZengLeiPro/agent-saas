import type pg from 'pg';

import type { OrgAgentWorkConversation } from './types.js';
import { mapWorkConversation } from './storeMappers.js';

export async function getStoredWorkConversation(
  pool: pg.Pool,
  table: string,
  tenantId: string,
  workConversationId: string,
): Promise<OrgAgentWorkConversation | null> {
  const result = await pool.query(
    `SELECT * FROM ${table} WHERE tenant_id=$1 AND work_conversation_id=$2`,
    [tenantId, workConversationId],
  );
  return result.rows[0] ? mapWorkConversation(result.rows[0] as Record<string, unknown>) : null;
}

export async function listStoredWorkConversations(
  pool: pg.Pool,
  table: string,
  tenantId: string,
  bindingId: string,
  limit: number,
): Promise<OrgAgentWorkConversation[]> {
  const result = await pool.query(
    `SELECT * FROM ${table} WHERE tenant_id=$1 AND binding_id=$2
    ORDER BY updated_at DESC,work_conversation_id DESC LIMIT $3`,
    [tenantId, bindingId, limit],
  );
  return result.rows.map((row) => mapWorkConversation(row as Record<string, unknown>));
}
