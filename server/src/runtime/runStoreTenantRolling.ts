import type pg from 'pg';
import { RunCreateConflictError, type RunRecord } from './runStoreTypes.js';

interface TenantRollingTables { // auxiliary authority during expand/contract
  runsTable: string;
  messageSubmissionsTable: string;
  steeringSessionsTable: string;
}

type Client = pg.PoolClient;

export async function lockRawTenantKey(
  client: Client,
  namespace: string,
  key: string,
): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [namespace, key]);
}

export async function readSameTenantSubmissionRun(
  client: Client,
  tables: TenantRollingTables,
  tenantId: string,
  userScope: string,
  clientMessageId: string,
): Promise<RunRecord> {
  const authority = await client.query<{ run_id: string; owner_tenant_id: string | null }>(`
    SELECT submission.run_id,COALESCE(submission.tenant_id,owner_run.tenant_id) owner_tenant_id
    FROM ${tables.messageSubmissionsTable} submission
    LEFT JOIN ${tables.runsTable} owner_run
      ON owner_run.run_id=submission.run_id AND owner_run.session_id=submission.session_id
    WHERE (submission.tenant_id=$1 AND submission.tenant_user_scope=$2
           AND submission.tenant_client_message_id=$3)
       OR (submission.user_scope=$2 AND submission.client_message_id=$3)
    ORDER BY CASE WHEN COALESCE(submission.tenant_id,owner_run.tenant_id)=$1 THEN 0 ELSE 1 END
    LIMIT 1
  `, [tenantId, userScope, clientMessageId]);
  const owner = authority.rows[0];
  if (!owner || owner.owner_tenant_id !== tenantId) {
    throw new RunCreateConflictError(
      'Cross-tenant shared authority is closed until durable legacy-writer drain evidence is contracted',
    );
  }
  const run = await client.query<{ row_json: RunRecord }>(`
    SELECT row_to_json(${tables.runsTable}.*) row_json FROM ${tables.runsTable}
    WHERE tenant_id=$1 AND run_id=$2
  `, [tenantId, owner.run_id]);
  if (!run.rows[0]) throw new Error('Message submission exists without same-tenant run');
  return run.rows[0].row_json;
}

export async function upsertSteeringStopAuthority(
  client: Client,
  tables: TenantRollingTables,
  tenantId: string,
  sessionId: string,
  stoppedAt: string,
): Promise<void> {
  await lockRawTenantKey(client, `${tables.steeringSessionsTable}:raw-key`, sessionId);
  await client.query(`INSERT INTO ${tables.steeringSessionsTable}
    (tenant_id,session_id,stopped_at,tenant_session_id) VALUES ($1,$2,$3::timestamptz,$2)
    ON CONFLICT DO NOTHING`, [tenantId, sessionId, stoppedAt]);
  let updated = await updateSteeringStop(client, tables, tenantId, sessionId, stoppedAt);
  if (updated > 0) return;
  // A nullable legacy row derives its tenant only from one unambiguous session identity.
  const authority = await client.query<{ owner_tenant_id: string | null }>(`
    SELECT COALESCE(stop.tenant_id,identity.tenant_id) owner_tenant_id
    FROM ${tables.steeringSessionsTable} stop
    LEFT JOIN LATERAL (
      SELECT MIN(run.tenant_id) tenant_id FROM ${tables.runsTable} run
      WHERE run.session_id=$1 HAVING COUNT(DISTINCT run.tenant_id)=1
    ) identity ON true
    WHERE stop.session_id=$1 LIMIT 1
  `, [sessionId]);
  if (!authority.rows[0] || authority.rows[0].owner_tenant_id !== tenantId) {
    throw new RunCreateConflictError(
      'Cross-tenant steering authority is closed until durable legacy-writer drain evidence is contracted',
    );
  }
  await client.query(`UPDATE ${tables.steeringSessionsTable}
    SET tenant_id=$1,tenant_session_id=$2 WHERE session_id=$2 AND tenant_id IS NULL`,
  [tenantId, sessionId]);
  updated = await updateSteeringStop(client, tables, tenantId, sessionId, stoppedAt);
  if (updated === 0) throw new Error('Steering stop authority disappeared');
}

async function updateSteeringStop(
  client: Client,
  tables: TenantRollingTables,
  tenantId: string,
  sessionId: string,
  stoppedAt: string,
): Promise<number> {
  const result = await client.query(`UPDATE ${tables.steeringSessionsTable}
    SET stopped_at=GREATEST(stopped_at,$3::timestamptz)
    WHERE tenant_id=$1 AND tenant_session_id=$2`, [tenantId, sessionId, stoppedAt]);
  return result.rowCount ?? 0;
}
