import type { PoolClient } from 'pg';
import { LEGACY_TENANT_ID } from '../data/tenants/types.js';
import type { SandboxCleanupClaimGuard } from './runStoreTypes.js';

export async function lockSandboxCleanupKeys(
  client: PoolClient, sessionId: string, sandboxScopeId: string,
): Promise<void> {
  await client.query(`
    SELECT pg_advisory_xact_lock(hashtextextended(lock_key, 0))
    FROM (SELECT DISTINCT unnest($1::text[]) AS lock_key ORDER BY lock_key) ordered
  `, [[sessionId, sandboxScopeId]]);
}

export async function acquireSandboxCleanupClaimGuard(
  client: PoolClient, runsTable: string, guard: SandboxCleanupClaimGuard,
): Promise<boolean> {
  await lockSandboxCleanupKeys(client, guard.sessionId, guard.sandboxScopeId);
  const result = await client.query<{ current: boolean }>(`
    SELECT EXISTS(SELECT 1 FROM ${runsTable} WHERE run_id=$1
      AND metadata->'sandboxCleanupOutbox'->>'state'='cancelling'
      AND metadata->'sandboxCleanupOutbox'->>'claimId'=$2
      AND (metadata->'sandboxCleanupOutbox'->>'claimGeneration')::int=$3) AS current
  `, [guard.cleanupRunId, guard.claimId, guard.claimGeneration]);
  return result.rows[0]?.current === true;
}

const ACTIVE_RUN_STATUSES = "'pending','running','waiting_approval','waiting_user','waiting_hand'";
const ACTIVE_CLEANUP_STATES = "'prepared','cancelling','pending','claimed','delivered'";

/**
 * 在 runs 表安装 admission trigger：Run 插入或转入 active 状态与 Sandbox cleanup 共享
 * top-level session + sandbox scope advisory locks，禁止 cleanup durable 后再接纳同 scope Run，并重开已投递的 terminal carrier。
 */
export function sandboxRunAdmissionFenceSql(runsTable: string): string[] {
  const base = `${runsTable}_sandbox_admission`.replace(/[^a-zA-Z0-9_]/gu, '_');
  const functionName = `${base}_fn`.slice(0, 63);
  const triggerName = `${base}_trigger`.slice(0, 63);
  return [
    `CREATE OR REPLACE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scope_session TEXT;
BEGIN
  IF NEW.status NOT IN (${ACTIVE_RUN_STATUSES}) THEN RETURN NEW; END IF;
  scope_session := COALESCE(NULLIF(NEW.metadata->>'topLevelSessionId',''), NEW.session_id);
  PERFORM pg_advisory_xact_lock(hashtextextended(lock_key, 0))
  FROM (
    SELECT DISTINCT unnest(ARRAY[scope_session, NEW.sandbox_scope_id]) AS lock_key
    ORDER BY lock_key
  ) ordered
  WHERE lock_key IS NOT NULL;
  IF EXISTS (
    SELECT 1 FROM ${runsTable} AS cleanup
    WHERE cleanup.run_id<>NEW.run_id
      AND cleanup.metadata->'sandboxCleanupOutbox'->>'state' IN (${ACTIVE_CLEANUP_STATES})
      AND (cleanup.metadata->'sandboxCleanupOutbox'->>'sessionId'=scope_session
        OR (NEW.sandbox_scope_id IS NOT NULL
          AND cleanup.metadata->'sandboxCleanupOutbox'->>'sandboxScopeId'=NEW.sandbox_scope_id))
      AND COALESCE(cleanup.tenant_id, '${LEGACY_TENANT_ID}')=COALESCE(NEW.tenant_id, '${LEGACY_TENANT_ID}')
  ) THEN
    RAISE EXCEPTION 'Sandbox cleanup is active for session %', scope_session USING ERRCODE='55000';
  END IF;
  -- 若上一轮终态已投递，新活动会清除 ACS 终态，因此重新打开顶层 outbox，
  -- 让最后一个非顶层 Run 完成后仍有 durable terminal carrier。
  UPDATE ${runsTable} AS terminal
  SET metadata=jsonb_set(terminal.metadata, '{sandboxLifecycleOutbox}',
    COALESCE(terminal.metadata->'sandboxLifecycleOutbox','{}'::jsonb)
      || jsonb_build_object('state','pending','reopenedAt',clock_timestamp()::text)),
    updated_at=clock_timestamp()
  WHERE terminal.run_id=(
    SELECT candidate.run_id FROM ${runsTable} AS candidate
    WHERE candidate.run_id<>NEW.run_id
      AND candidate.workspace_id=NEW.workspace_id
      AND candidate.sandbox_scope_id=NEW.sandbox_scope_id
      AND COALESCE(candidate.tenant_id, '${LEGACY_TENANT_ID}')=COALESCE(NEW.tenant_id, '${LEGACY_TENANT_ID}')
      AND candidate.status IN ('completed','failed','cancelled','orphaned')
      AND candidate.metadata->>'sandboxWorkloadTopLevel'='true'
      AND candidate.metadata->'sandboxWorkloadDescriptor'->>'kind' IN ('taskboard','cron','memory')
    ORDER BY COALESCE(candidate.metadata->>'sandboxLifecycleTerminalAt', candidate.updated_at::text)::timestamptz DESC,
      candidate.run_id DESC LIMIT 1
  ) AND terminal.metadata->'sandboxLifecycleOutbox'->>'state'='delivered';
  RETURN NEW;
END
$$`,
    `DROP TRIGGER IF EXISTS ${triggerName} ON ${runsTable}`,
    `CREATE TRIGGER ${triggerName}
      BEFORE INSERT OR UPDATE OF status, session_id, tenant_id, sandbox_scope_id, metadata ON ${runsTable}
      FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
  ];
}
