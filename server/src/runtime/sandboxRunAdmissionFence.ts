import type { PoolClient } from 'pg';
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
const ACTIVE_CLEANUP_STATES = "'prepared','cancelling','pending','claimed'";

/**
 * 在 runs 表安装 admission trigger：Run 插入或转入 active 状态与 Sandbox cleanup 共享
 * top-level session + sandbox scope advisory locks，禁止 cleanup active 后再插入/恢复同 scope Run。
 */
export function sandboxRunAdmissionFenceSql(runsTable: string): string[] {
  const base = `${runsTable}_sandbox_admission`.replace(/[^a-zA-Z0-9_]/gu, '_');
  const functionName = `${base}_fn`.slice(0, 63);
  const triggerName = `${base}_trigger`.slice(0, 63);
  return [
    `CREATE OR REPLACE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scope_session TEXT; old_scope_session TEXT;
BEGIN
  IF NEW.status NOT IN (${ACTIVE_RUN_STATUSES}) THEN RETURN NEW; END IF;
  scope_session := COALESCE(NULLIF(NEW.metadata->>'topLevelSessionId',''), NEW.session_id);
  IF TG_OP='UPDATE' THEN
    old_scope_session := COALESCE(NULLIF(OLD.metadata->>'topLevelSessionId',''), OLD.session_id);
    IF NEW.status IS NOT DISTINCT FROM OLD.status
      AND scope_session IS NOT DISTINCT FROM old_scope_session
      AND NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id
      AND NEW.sandbox_scope_id IS NOT DISTINCT FROM OLD.sandbox_scope_id THEN RETURN NEW; END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(lock_key, 0))
  FROM (
    SELECT DISTINCT unnest(ARRAY[scope_session, NEW.sandbox_scope_id]) AS lock_key
    ORDER BY lock_key
  ) ordered
  WHERE lock_key IS NOT NULL;
  IF EXISTS (
    SELECT 1 FROM ${runsTable} AS cleanup
    WHERE cleanup.metadata->'sandboxCleanupOutbox'->>'state' IN (${ACTIVE_CLEANUP_STATES})
      AND (cleanup.metadata->'sandboxCleanupOutbox'->>'sessionId'=scope_session
        OR (NEW.sandbox_scope_id IS NOT NULL
          AND cleanup.metadata->'sandboxCleanupOutbox'->>'sandboxScopeId'=NEW.sandbox_scope_id))
      AND (NEW.tenant_id IS NULL OR cleanup.tenant_id=NEW.tenant_id)
  ) THEN
    RAISE EXCEPTION 'Sandbox cleanup is active for session %', scope_session USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END
$$`,
    `DROP TRIGGER IF EXISTS ${triggerName} ON ${runsTable}`,
    `CREATE TRIGGER ${triggerName}
      BEFORE INSERT OR UPDATE OF status, session_id, tenant_id, sandbox_scope_id, metadata ON ${runsTable}
      FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
  ];
}
