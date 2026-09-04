import type pg from 'pg';

interface MemoryStatusChangeInput {
  tenantId: string;
  memoryId: string;
  expectedVersion: number;
  status: 'revoked' | 'deleted';
}

interface MemoryPromotionInput {
  tenantId: string;
  sourceMemoryId: string;
  memoryId: string;
  promotedBy: string;
  reason: string;
  policyRevision: number;
}

export async function promoteStoredMemory(
  pool: pg.Pool,
  memoriesTable: string,
  input: MemoryPromotionInput,
): Promise<Record<string, unknown>> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const source = await client.query(
      `SELECT memory_id FROM ${memoriesTable}
      WHERE tenant_id=$1 AND memory_id=$2 AND status='active'
        AND memory_scope IN ('conversation','task_checkpoint') FOR UPDATE`,
      [input.tenantId, input.sourceMemoryId],
    );
    if (!source.rows[0]) throw new Error('ORG_AGENT_MEMORY_NOT_PROMOTABLE');
    const result = await client.query(
      `INSERT INTO ${memoriesTable} (
      memory_id,tenant_id,agent_id,memory_scope,status,content_json,provenance_json,promoted_by,
      promotion_reason,policy_revision,version,created_at,updated_at
    ) SELECT $1,tenant_id,agent_id,'agent','active',content_json,
      provenance_json || jsonb_build_object('sourceMemoryId',memory_id),$4,$5,$6,1,NOW(),NOW()
      FROM ${memoriesTable} WHERE tenant_id=$2 AND memory_id=$3 RETURNING *`,
      [
        input.memoryId,
        input.tenantId,
        input.sourceMemoryId,
        input.promotedBy,
        input.reason.slice(0, 1000),
        input.policyRevision,
      ],
    );
    await client.query('COMMIT');
    return result.rows[0] as Record<string, unknown>;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function changeStoredMemoryStatus(
  pool: pg.Pool,
  memoriesTable: string,
  input: MemoryStatusChangeInput,
): Promise<Record<string, unknown>> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const source = await client.query(
      `SELECT memory_scope,agent_id FROM ${memoriesTable}
      WHERE tenant_id=$1 AND memory_id=$2 AND version=$3 AND status='active' FOR UPDATE`,
      [input.tenantId, input.memoryId, input.expectedVersion],
    );
    if (!source.rows[0]) throw new Error('ORG_AGENT_MEMORY_VERSION_CONFLICT');
    const result = await client.query(
      `UPDATE ${memoriesTable}
      SET status=$4,version=version+1,revoked_at=CASE WHEN $4='revoked' THEN NOW() ELSE revoked_at END,
          deleted_at=CASE WHEN $4='deleted' THEN NOW() ELSE deleted_at END,updated_at=NOW()
      WHERE tenant_id=$1 AND memory_id=$2 AND version=$3 AND status='active' RETURNING *`,
      [input.tenantId, input.memoryId, input.expectedVersion, input.status],
    );
    if (
      source.rows[0].memory_scope === 'conversation' ||
      source.rows[0].memory_scope === 'task_checkpoint'
    ) {
      await client.query(
        `UPDATE ${memoriesTable}
        SET status=$3,version=version+1,
            revoked_at=CASE WHEN $3='revoked' THEN NOW() ELSE revoked_at END,
            deleted_at=CASE WHEN $3='deleted' THEN NOW() ELSE deleted_at END,updated_at=NOW()
        WHERE tenant_id=$1 AND agent_id=$4 AND memory_scope='agent' AND status='active'
          AND provenance_json->>'sourceMemoryId'=$2`,
        [input.tenantId, input.memoryId, input.status, source.rows[0].agent_id],
      );
    }
    await client.query('COMMIT');
    return result.rows[0] as Record<string, unknown>;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
