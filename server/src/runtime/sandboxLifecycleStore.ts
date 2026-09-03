import { randomUUID } from 'node:crypto';
import { currentTerminalAt, SandboxTerminalOutboxStore, type TerminalDeferredState, type TerminalLifecycleCandidate } from './sandboxTerminalOutboxStore.js';
import type { PgPool } from './runStoreTypes.js';
import { hasSandboxScopeActivity } from './runStoreSessionActivity.js';
import { lockSandboxCleanupKeys } from './sandboxRunAdmissionFence.js';
import { LEGACY_TENANT_ID } from '../data/tenants/types.js';
import type { SandboxLifecycleIdentity } from './sandboxLifecycleService.js';

export interface CleanupCandidate extends SandboxLifecycleIdentity {
  runId: string;
  tenantId?: string;
  userId?: string;
  username?: string;
  targetHandId: string;
  deletionGeneration: string;
  previousDeletionGeneration?: string;
  claimId?: string;
  claimGeneration?: number;
}

interface ActiveScopeRun { runId: string; sessionId: string; tenantId?: string; userId?: string }
interface LegacyCleanupCandidate extends SandboxLifecycleIdentity { runId: string; tenantId?: string; userId?: string; username?: string }

export class PgSandboxLifecycleStore {
  private readonly terminalOutbox: SandboxTerminalOutboxStore;

  constructor(
    private readonly pool: PgPool,
    private readonly runsTable: string,
    private readonly steeringInputsTable: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.terminalOutbox = new SandboxTerminalOutboxStore(pool, runsTable, now);
  }

  listTerminalCandidates(limit = 100): Promise<TerminalLifecycleCandidate[]> {
    return this.terminalOutbox.listCandidates(limit);
  }

  isTerminalCandidateCurrent(runId: string): Promise<boolean> {
    return this.terminalOutbox.isCurrentCandidate(runId);
  }

  hasActivity(candidate: Pick<TerminalLifecycleCandidate, 'sandboxScopeId' | 'sessionId' | 'tenantId'>): Promise<boolean> {
    return hasSandboxScopeActivity({ pool: this.pool, runsTable: this.runsTable, steeringInputsTable: this.steeringInputsTable }, {
      sandboxScopeId: candidate.sandboxScopeId,
      topLevelSessionId: candidate.sessionId,
      ...(candidate.tenantId ? { tenantId: candidate.tenantId } : {}),
    });
  }

  async runWhileTerminalCandidateCurrent(
    candidate: TerminalLifecycleCandidate,
    operation: (terminalAt: string) => Promise<void>,
  ): Promise<'committed' | 'active' | 'superseded'> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockSandboxCleanupKeys(client, candidate.sessionId, candidate.sandboxScopeId);
      const activity = await hasSandboxScopeActivity({
        pool: client as unknown as PgPool,
        runsTable: this.runsTable,
        steeringInputsTable: this.steeringInputsTable,
      }, {
        sandboxScopeId: candidate.sandboxScopeId,
        topLevelSessionId: candidate.sessionId,
        ...(candidate.tenantId ? { tenantId: candidate.tenantId } : {}),
      });
      if (activity) {
        await client.query('COMMIT');
        return 'active';
      }
      const effectiveTerminalAt = await currentTerminalAt(
        client as unknown as Pick<PgPool, 'query'>, this.runsTable, candidate.runId,
      );
      if (!effectiveTerminalAt) {
        await client.query('COMMIT');
        return 'superseded';
      }
      await operation(effectiveTerminalAt);
      await client.query(`
        UPDATE ${this.runsTable}
        SET metadata = metadata || jsonb_build_object('sandboxLifecycleOutbox',
          jsonb_build_object('state','delivered','deliveredAt',$2::text)), updated_at=NOW()
        WHERE run_id=$1
          AND COALESCE(metadata->'sandboxLifecycleOutbox'->>'state', 'pending') <> 'delivered'
      `, [candidate.runId, this.now().toISOString()]);
      await client.query('COMMIT');
      return 'committed';
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  pinTerminalTargetHand(runId: string, targetHandId: string): Promise<string | undefined> {
    return this.terminalOutbox.pinTargetHand(runId, targetHandId);
  }

  markTerminalDelivered(runId: string, deliveredAt: string): Promise<void> {
    return this.terminalOutbox.markDelivered(runId, deliveredAt);
  }

  deferTerminalCandidate(runId: string, error: unknown, deferredAt?: string): Promise<TerminalDeferredState | undefined> {
    return this.terminalOutbox.defer(runId, error, deferredAt);
  }

  async enqueueCleanup(
    candidate: Omit<CleanupCandidate, 'runId' | 'claimId' | 'claimGeneration' | 'previousDeletionGeneration'> & { legacyRunId?: string },
    options: { prepared?: boolean } = {},
  ): Promise<CleanupCandidate | undefined> {
    const payload = JSON.stringify({
      state: options.prepared ? 'prepared' : 'pending', workspaceId: candidate.workspaceId, sessionId: candidate.sessionId,
      sandboxScopeId: candidate.sandboxScopeId, tenantId: candidate.tenantId,
      userId: candidate.userId, username: candidate.username, targetHandId: candidate.targetHandId,
      queuedAt: new Date().toISOString(),
    });
    const carrierRunId = `sandbox-cleanup-${randomUUID()}`;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockSandboxCleanupKeys(client, candidate.sessionId, candidate.sandboxScopeId);
      const result = await client.query<Record<string, unknown>>(`
      WITH active AS (
        SELECT run_id, metadata->'sandboxCleanupOutbox'->>'state' AS state
        FROM ${this.runsTable}
        WHERE session_id=$1 AND COALESCE(tenant_id, $13::text)=COALESCE($2::text, $13::text)
          AND metadata->'sandboxCleanupOutbox'->>'state' IN ('prepared','cancelling','pending','claimed')
          AND NULLIF(metadata->'sandboxCleanupOutbox'->>'targetHandId','') IS NOT NULL
          AND NULLIF(metadata->'sandboxCleanupOutbox'->>'deletionGeneration','') IS NOT NULL
        ORDER BY updated_at DESC LIMIT 1
      ), legacy AS (
        SELECT run_id FROM ${this.runsTable}
        WHERE session_id=$1 AND COALESCE(tenant_id, $13::text)=COALESCE($2::text, $13::text)
          AND ($6::text IS NULL OR run_id=$6)
          AND (metadata->'sandboxCleanupOutbox'->>'state'='pending'
            OR (metadata->'sandboxCleanupOutbox'->>'state'='claimed'
              AND metadata->'sandboxCleanupOutbox'->>'claimedAt' < $5::text))
          AND (NULLIF(metadata->'sandboxCleanupOutbox'->>'targetHandId','') IS NULL
            OR NULLIF(metadata->'sandboxCleanupOutbox'->>'deletionGeneration','') IS NULL)
        ORDER BY updated_at DESC LIMIT 1
      ), prior AS (
        SELECT NULLIF(metadata->'sandboxCleanupOutbox'->>'deletionGeneration','') AS deletion_generation
        FROM ${this.runsTable}
        WHERE session_id=$1 AND COALESCE(tenant_id, $13::text)=COALESCE($2::text, $13::text)
          AND NULLIF(metadata->'sandboxCleanupOutbox'->>'deletionGeneration','') IS NOT NULL
        ORDER BY updated_at DESC LIMIT 1
      ), takeover AS (
        UPDATE ${this.runsTable} AS run
        SET metadata = jsonb_set(run.metadata, '{sandboxCleanupOutbox}',
          $3::jsonb || jsonb_build_object(
            'previousDeletionGeneration', NULLIF(run.metadata->'sandboxCleanupOutbox'->>'previousDeletionGeneration',''),
            'deletionGeneration', $4::text
          )), updated_at=NOW()
        FROM active
        WHERE $7::boolean AND active.state='prepared' AND run.run_id=active.run_id
        RETURNING run.run_id, run.tenant_id, run.user_id, run.metadata->>'username' AS username,
                  run.metadata->'sandboxCleanupOutbox' AS cleanup
      ), target AS (
        SELECT run_id FROM legacy
      ), updated AS (
        UPDATE ${this.runsTable} AS run
        SET metadata = jsonb_set(run.metadata, '{sandboxCleanupOutbox}',
          $3::jsonb || jsonb_build_object(
            'previousDeletionGeneration', NULLIF(run.metadata->'sandboxCleanupOutbox'->>'deletionGeneration',''),
            'deletionGeneration', $4::text
          )), updated_at=NOW()
        FROM target
        WHERE run.run_id=target.run_id AND NOT EXISTS (SELECT 1 FROM active)
          AND (COALESCE(run.metadata->'sandboxCleanupOutbox'->>'state','') NOT IN ('prepared','cancelling','pending','claimed')
            OR EXISTS (SELECT 1 FROM legacy WHERE legacy.run_id=run.run_id))
        RETURNING run.run_id, run.tenant_id, run.user_id, run.metadata->>'username' AS username,
                  run.metadata->'sandboxCleanupOutbox' AS cleanup
      ), carrier AS (
        INSERT INTO ${this.runsTable} (
          run_id, session_id, tenant_id, user_id, status, status_reason, channel, requested_at, updated_at,
          cancelled_at, workspace_id, sandbox_scope_id, metadata
        )
        SELECT $8::text, $1::text, COALESCE($2::text, $13::text), $9::text, 'cancelled', 'sandbox cleanup carrier', 'system', NOW(), NOW(),
               NOW(), $10::text, $11::text,
               jsonb_build_object(
                 'sandboxCleanupCarrier', true,
                 'username', $12::text,
                 'sandboxCleanupOutbox', $3::jsonb || jsonb_build_object(
                   'previousDeletionGeneration', (SELECT deletion_generation FROM prior),
                   'deletionGeneration', $4::text
                 )
               )
        WHERE $6::text IS NULL
          AND NOT EXISTS (SELECT 1 FROM active)
          AND NOT EXISTS (SELECT 1 FROM target)
        RETURNING run_id, tenant_id, user_id, metadata->>'username' AS username,
                  metadata->'sandboxCleanupOutbox' AS cleanup
      ), existing AS (
        SELECT run.run_id, run.tenant_id, run.user_id, run.metadata->>'username' AS username,
               run.metadata->'sandboxCleanupOutbox' AS cleanup
        FROM ${this.runsTable} AS run JOIN active ON run.run_id=active.run_id
        WHERE NOT EXISTS (SELECT 1 FROM takeover)
      )
      SELECT * FROM updated
      UNION ALL SELECT * FROM takeover
      UNION ALL SELECT * FROM carrier
      UNION ALL SELECT * FROM existing
      LIMIT 1
      `, [candidate.sessionId, candidate.tenantId ?? null, payload, candidate.deletionGeneration,
        new Date(Date.now() - 60_000).toISOString(), candidate.legacyRunId ?? null, options.prepared === true,
        carrierRunId, candidate.userId ?? null, candidate.workspaceId, candidate.sandboxScopeId,
        candidate.username ?? null, LEGACY_TENANT_ID]);
      await client.query('COMMIT');
      const row = result.rows[0];
      return row ? cleanupCandidateFromRow(row, asRecord(row.cleanup)) : undefined;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  // preparation/delivery（含 delivered/cancelled）的任一 durable 状态均由显式 restore 推进 generation fence。
  async cancelCleanup(sessionId: string, tenantId: string | undefined, deletionGeneration: string): Promise<CleanupCandidate[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<Record<string, unknown>>(`
      WITH cleanup_identity AS (
        SELECT DISTINCT run.metadata->'sandboxCleanupOutbox'->>'sandboxScopeId' AS sandbox_scope_id
        FROM ${this.runsTable} AS run
        WHERE COALESCE(run.metadata->'sandboxCleanupOutbox'->>'sessionId', run.session_id)=$1
          AND COALESCE(run.tenant_id, $5::text)=COALESCE($2::text, $5::text)
      ), lock_keys AS (
        SELECT $1::text AS lock_key
        UNION SELECT sandbox_scope_id FROM cleanup_identity
      ), locked AS (
        SELECT pg_advisory_xact_lock(hashtextextended(lock_key, 0))
        FROM (SELECT lock_key FROM lock_keys WHERE lock_key IS NOT NULL ORDER BY lock_key) ordered
      ), updated AS (
        UPDATE ${this.runsTable} AS run
        SET metadata = jsonb_set(run.metadata, '{sandboxCleanupOutbox}',
          run.metadata->'sandboxCleanupOutbox' || jsonb_build_object(
            'state','cancelled', 'cancelledAt',$3::text,
            'previousDeletionGeneration', run.metadata->'sandboxCleanupOutbox'->>'deletionGeneration',
            'deletionGeneration',$4::text, 'claimId',NULL
          )), updated_at=NOW()
        WHERE (SELECT COUNT(*) FROM locked) > 0
          AND COALESCE(run.metadata->'sandboxCleanupOutbox'->>'sessionId', run.session_id)=$1
          AND COALESCE(run.tenant_id, $5::text)=COALESCE($2::text, $5::text)
          AND run.metadata->'sandboxCleanupOutbox'->>'state' IN ('prepared','cancelling','pending','claimed','delivered','cancelled')
        RETURNING run.run_id, run.tenant_id, run.user_id, run.metadata->>'username' AS username,
                  run.metadata->'sandboxCleanupOutbox' AS cleanup
      ), existing AS (
        SELECT run.run_id, run.tenant_id, run.user_id, run.metadata->>'username' AS username,
               run.metadata->'sandboxCleanupOutbox' AS cleanup
        FROM ${this.runsTable} AS run
        WHERE COALESCE(run.metadata->'sandboxCleanupOutbox'->>'sessionId', run.session_id)=$1
          AND COALESCE(run.tenant_id, $5::text)=COALESCE($2::text, $5::text)
          AND run.metadata->'sandboxCleanupOutbox'->>'state'='cancelled'
          AND NOT EXISTS (SELECT 1 FROM updated)
        ORDER BY run.updated_at DESC LIMIT 1
      )
      SELECT * FROM updated UNION ALL SELECT * FROM existing
      `, [sessionId, tenantId ?? null, new Date().toISOString(), deletionGeneration, LEGACY_TENANT_ID]);
      await client.query('COMMIT');
      return result.rows.flatMap((row) => {
        const cleanup = asRecord(row.cleanup);
        if (!cleanupCandidateIsComplete(cleanup)) return [];
        return [cleanupCandidateFromRow(row, cleanup)];
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listPreparedCleanupCandidates(limit = 100): Promise<CleanupCandidate[]> {
    const result = await this.pool.query<Record<string, unknown>>(`
      SELECT run_id, tenant_id, user_id, metadata->>'username' AS username,
             metadata->'sandboxCleanupOutbox' AS cleanup
      FROM ${this.runsTable}
      WHERE metadata->'sandboxCleanupOutbox'->>'state' IN ('prepared','cancelling')
      ORDER BY updated_at ASC LIMIT $1
    `, [limit]);
    return result.rows.flatMap((row) => {
      const cleanup = asRecord(row.cleanup);
      return cleanupCandidateIsComplete(cleanup) ? [cleanupCandidateFromRow(row, cleanup)] : [];
    });
  }

  async claimPreparedCleanup(runId: string, claimId: string): Promise<CleanupCandidate | undefined> {
    const claimedAt = new Date().toISOString();
    const staleBefore = new Date(Date.now() - 60_000).toISOString();
    const result = await this.pool.query<Record<string, unknown>>(`
      WITH cleanup_identity AS (
        SELECT metadata->'sandboxCleanupOutbox'->>'sessionId' AS session_id,
               metadata->'sandboxCleanupOutbox'->>'sandboxScopeId' AS sandbox_scope_id
        FROM ${this.runsTable} WHERE run_id=$1
      ), lock_keys AS (
        SELECT session_id AS lock_key FROM cleanup_identity
        UNION SELECT sandbox_scope_id FROM cleanup_identity
      ), locked AS (
        SELECT pg_advisory_xact_lock(hashtextextended(lock_key, 0))
        FROM (SELECT lock_key FROM lock_keys WHERE lock_key IS NOT NULL ORDER BY lock_key) ordered
      )
      UPDATE ${this.runsTable}
      SET metadata = jsonb_set(metadata, '{sandboxCleanupOutbox}',
        metadata->'sandboxCleanupOutbox' || jsonb_build_object(
          'state','cancelling','claimId',$2::text,'claimedAt',$3::text,
          'claimGeneration',COALESCE((metadata->'sandboxCleanupOutbox'->>'claimGeneration')::int,0)+1
        )), updated_at=NOW()
      WHERE run_id=$1 AND (SELECT COUNT(*) FROM locked) > 0
        AND (metadata->'sandboxCleanupOutbox'->>'state'='prepared'
        OR (metadata->'sandboxCleanupOutbox'->>'state'='cancelling'
          AND (metadata->'sandboxCleanupOutbox'->>'claimedAt' IS NULL
            OR metadata->'sandboxCleanupOutbox'->>'claimedAt' < $4::text)))
      RETURNING run_id, tenant_id, user_id, metadata->>'username' AS username,
                metadata->'sandboxCleanupOutbox' AS cleanup
    `, [runId, claimId, claimedAt, staleBefore]);
    const row = result.rows[0];
    return row ? cleanupCandidateFromRow(row, asRecord(row.cleanup)) : undefined;
  }

  async isPreparedCleanupClaimCurrent(runId: string, claimId: string, claimGeneration: number): Promise<boolean> {
    const result = await this.pool.query<{ current: boolean }>(`
      SELECT EXISTS(SELECT 1 FROM ${this.runsTable} WHERE run_id=$1
        AND metadata->'sandboxCleanupOutbox'->>'state'='cancelling'
        AND metadata->'sandboxCleanupOutbox'->>'claimId'=$2
        AND (metadata->'sandboxCleanupOutbox'->>'claimGeneration')::int=$3) AS current
    `, [runId, claimId, claimGeneration]);
    return result.rows[0]?.current === true;
  }

  async completePreparedCleanup(runId: string, claimId: string, claimGeneration: number): Promise<CleanupCandidate | undefined> {
    const result = await this.pool.query<Record<string, unknown>>(`
      WITH cleanup_identity AS (
        SELECT metadata->'sandboxCleanupOutbox'->>'sessionId' AS session_id,
               metadata->'sandboxCleanupOutbox'->>'sandboxScopeId' AS sandbox_scope_id
        FROM ${this.runsTable} WHERE run_id=$1
      ), lock_keys AS (
        SELECT session_id AS lock_key FROM cleanup_identity
        UNION SELECT sandbox_scope_id FROM cleanup_identity
      ), locked AS (
        SELECT pg_advisory_xact_lock(hashtextextended(lock_key, 0))
        FROM (SELECT lock_key FROM lock_keys WHERE lock_key IS NOT NULL ORDER BY lock_key) ordered
      )
      UPDATE ${this.runsTable} AS cleanup_run
      SET metadata = jsonb_set(cleanup_run.metadata, '{sandboxCleanupOutbox}',
        cleanup_run.metadata->'sandboxCleanupOutbox' || jsonb_build_object(
          'state','pending','cancelledScopeAt',NOW()::text,'claimId',NULL,'claimedAt',NULL
        )), updated_at=NOW()
      WHERE cleanup_run.run_id=$1
        AND cleanup_run.metadata->'sandboxCleanupOutbox'->>'state'='cancelling'
        AND cleanup_run.metadata->'sandboxCleanupOutbox'->>'claimId'=$2
        AND (cleanup_run.metadata->'sandboxCleanupOutbox'->>'claimGeneration')::int=$3
        AND (SELECT COUNT(*) FROM locked) > 0
        AND NOT EXISTS (
          SELECT 1 FROM ${this.runsTable} AS active
          WHERE (
            active.sandbox_scope_id=cleanup_run.metadata->'sandboxCleanupOutbox'->>'sandboxScopeId'
            OR active.session_id=cleanup_run.metadata->'sandboxCleanupOutbox'->>'sessionId'
            OR active.metadata->>'topLevelSessionId'=cleanup_run.metadata->'sandboxCleanupOutbox'->>'sessionId'
          )
            AND COALESCE(active.tenant_id, $4::text)=COALESCE(cleanup_run.tenant_id, $4::text)
            AND active.status IN ('pending','running','waiting_approval','waiting_user','waiting_hand')
        )
      RETURNING cleanup_run.run_id, cleanup_run.tenant_id, cleanup_run.user_id,
                cleanup_run.metadata->>'username' AS username,
                cleanup_run.metadata->'sandboxCleanupOutbox' AS cleanup
    `, [runId, claimId, claimGeneration, LEGACY_TENANT_ID]);
    const row = result.rows[0];
    return row ? cleanupCandidateFromRow(row, asRecord(row.cleanup)) : undefined;
  }

  async releasePreparedCleanupClaim(runId: string, claimId: string, claimGeneration: number): Promise<void> {
    await this.pool.query(`
      UPDATE ${this.runsTable}
      SET metadata = jsonb_set(metadata, '{sandboxCleanupOutbox}',
        metadata->'sandboxCleanupOutbox' || jsonb_build_object('claimId',NULL,'claimedAt',NULL)), updated_at=NOW()
      WHERE run_id=$1 AND metadata->'sandboxCleanupOutbox'->>'state'='cancelling'
        AND metadata->'sandboxCleanupOutbox'->>'claimId'=$2
        AND (metadata->'sandboxCleanupOutbox'->>'claimGeneration')::int=$3
    `, [runId, claimId, claimGeneration]);
  }

  async expireUncommittedPreparedCleanup(runId: string): Promise<boolean> {
    const staleBefore = new Date(Date.now() - 60_000).toISOString();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const identity = await client.query<{ session_id: string; sandbox_scope_id: string }>(`
        SELECT metadata->'sandboxCleanupOutbox'->>'sessionId' AS session_id,
               metadata->'sandboxCleanupOutbox'->>'sandboxScopeId' AS sandbox_scope_id
        FROM ${this.runsTable} WHERE run_id=$1
      `, [runId]);
      const current = identity.rows[0];
      if (!current?.session_id) {
        await client.query('COMMIT');
        return false;
      }
      await lockSandboxCleanupKeys(client, current.session_id, current.sandbox_scope_id);
      const result = await client.query(`
        UPDATE ${this.runsTable}
        SET metadata = jsonb_set(metadata, '{sandboxCleanupOutbox}',
          metadata->'sandboxCleanupOutbox' || jsonb_build_object(
            'state','cancelled','cancelledAt',NOW()::text,'cancelReason','intent_without_tombstone'
          )), updated_at=NOW()
        WHERE run_id=$1 AND metadata->'sandboxCleanupOutbox'->>'state'='prepared'
          AND COALESCE(metadata->'sandboxCleanupOutbox'->>'queuedAt','') < $2::text
      `, [runId, staleBefore]);
      await client.query('COMMIT');
      return (result.rowCount ?? 0) > 0;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  // 只有 cancellation 完成后的完整 outbox 可投递；legacy record 先升级再 claim。
  async listCleanupCandidates(limit = 100): Promise<CleanupCandidate[]> {
    const staleBefore = new Date(Date.now() - 60_000).toISOString();
    const result = await this.pool.query<Record<string, unknown>>(`
      SELECT run_id, tenant_id, user_id, metadata->>'username' AS username,
             metadata->'sandboxCleanupOutbox' AS cleanup
      FROM ${this.runsTable}
      WHERE metadata->'sandboxCleanupOutbox'->>'state' = 'pending'
         OR (metadata->'sandboxCleanupOutbox'->>'state' = 'claimed'
             AND metadata->'sandboxCleanupOutbox'->>'claimedAt' < $2::text)
      ORDER BY updated_at ASC LIMIT $1
    `, [limit, staleBefore]);
    return result.rows.flatMap((row) => {
      const cleanup = asRecord(row.cleanup);
      if (!cleanupCandidateIsComplete(cleanup)) return [];
      return [cleanupCandidateFromRow(row, cleanup)];
    });
  }

  async listLegacyCleanupCandidates(limit = 100): Promise<LegacyCleanupCandidate[]> {
    // 只升级超时 claim 或 pending legacy，prepared intent 必须先由 tombstone 激活。
    const staleBefore = new Date(Date.now() - 60_000).toISOString();
    const result = await this.pool.query<Record<string, unknown>>(`
      SELECT run_id, tenant_id, user_id, metadata->>'username' AS username,
             metadata->'sandboxCleanupOutbox' AS cleanup
      FROM ${this.runsTable}
      WHERE (metadata->'sandboxCleanupOutbox'->>'state'='pending'
          OR (metadata->'sandboxCleanupOutbox'->>'state'='claimed'
            AND metadata->'sandboxCleanupOutbox'->>'claimedAt' < $2::text))
        AND (NULLIF(metadata->'sandboxCleanupOutbox'->>'targetHandId','') IS NULL
          OR NULLIF(metadata->'sandboxCleanupOutbox'->>'deletionGeneration','') IS NULL)
      ORDER BY updated_at ASC LIMIT $1
    `, [limit, staleBefore]);
    return result.rows.flatMap((row) => {
      const cleanup = asRecord(row.cleanup);
      const workspaceId = stringValue(cleanup.workspaceId);
      const sessionId = stringValue(cleanup.sessionId);
      const sandboxScopeId = stringValue(cleanup.sandboxScopeId);
      if (!workspaceId || !sessionId || !sandboxScopeId) return [];
      const tenantId = stringValue(cleanup.tenantId) ?? stringValue(row.tenant_id);
      const userId = stringValue(cleanup.userId) ?? stringValue(row.user_id);
      const username = stringValue(cleanup.username) ?? stringValue(row.username);
      return [{
        runId: String(row.run_id), workspaceId, sessionId, sandboxScopeId,
        ...(tenantId ? { tenantId } : {}), ...(userId ? { userId } : {}), ...(username ? { username } : {}),
      }];
    });
  }

  async claimCleanup(runId: string, claimId: string): Promise<CleanupCandidate | undefined> {
    const claimedAt = new Date().toISOString();
    const staleBefore = new Date(Date.now() - 60_000).toISOString();
    const result = await this.pool.query<Record<string, unknown>>(`
      UPDATE ${this.runsTable}
      SET metadata = jsonb_set(metadata, '{sandboxCleanupOutbox}',
        metadata->'sandboxCleanupOutbox' || jsonb_build_object('state','claimed','claimId',$2::text,'claimedAt',$3::text)), updated_at=NOW()
      WHERE run_id=$1 AND (metadata->'sandboxCleanupOutbox'->>'state'='pending'
        OR (metadata->'sandboxCleanupOutbox'->>'state'='claimed'
          AND metadata->'sandboxCleanupOutbox'->>'claimedAt' < $4::text))
      RETURNING run_id, tenant_id, user_id, metadata->>'username' AS username,
                metadata->'sandboxCleanupOutbox' AS cleanup
    `, [runId, claimId, claimedAt, staleBefore]);
    const row = result.rows[0];
    return row ? cleanupCandidateFromRow(row, asRecord(row.cleanup)) : undefined;
  }

  async isCleanupClaimCurrent(runId: string, claimId: string): Promise<boolean> {
    const result = await this.pool.query<{ current: boolean }>(`
      SELECT EXISTS(SELECT 1 FROM ${this.runsTable} WHERE run_id=$1
        AND metadata->'sandboxCleanupOutbox'->>'state'='claimed'
        AND metadata->'sandboxCleanupOutbox'->>'claimId'=$2) AS current
    `, [runId, claimId]);
    return result.rows[0]?.current === true;
  }

  async releaseCleanupClaim(runId: string, claimId: string): Promise<void> {
    await this.pool.query(`
      UPDATE ${this.runsTable}
      SET metadata = jsonb_set(metadata, '{sandboxCleanupOutbox}',
        metadata->'sandboxCleanupOutbox' || jsonb_build_object('state','pending','claimId',NULL,'retryAt',$3::text)), updated_at=NOW()
      WHERE run_id=$1 AND metadata->'sandboxCleanupOutbox'->>'state'='claimed'
        AND metadata->'sandboxCleanupOutbox'->>'claimId'=$2
    `, [runId, claimId, new Date().toISOString()]);
  }

  async markCleanupDelivered(runId: string, claimId: string, deliveredAt: string): Promise<void> {
    await this.pool.query(`
      UPDATE ${this.runsTable}
      SET metadata = jsonb_set(metadata, '{sandboxCleanupOutbox}',
        metadata->'sandboxCleanupOutbox' || jsonb_build_object('state','delivered','deliveredAt',$3::text)), updated_at=NOW()
      WHERE run_id=$1 AND metadata->'sandboxCleanupOutbox'->>'state'='claimed'
        AND metadata->'sandboxCleanupOutbox'->>'claimId'=$2
    `, [runId, claimId, deliveredAt]);
  }

  async listActiveScopeRuns(identity: SandboxLifecycleIdentity, tenantId?: string): Promise<ActiveScopeRun[]> {
    const result = await this.pool.query<Record<string, unknown>>(`
      SELECT run_id, session_id, tenant_id, user_id
      FROM ${this.runsTable}
      WHERE ($1::text = sandbox_scope_id OR session_id=$2 OR metadata->>'topLevelSessionId'=$2)
        AND COALESCE(tenant_id, $4::text)=COALESCE($3::text, $4::text)
        AND status IN ('pending','running','waiting_approval','waiting_user','waiting_hand')
      ORDER BY requested_at ASC
    `, [identity.sandboxScopeId, identity.sessionId, tenantId ?? null, LEGACY_TENANT_ID]);
    return result.rows.map((row) => ({
      runId: String(row.run_id), sessionId: String(row.session_id),
      ...(typeof row.tenant_id === 'string' ? { tenantId: row.tenant_id } : {}),
      ...(typeof row.user_id === 'string' ? { userId: row.user_id } : {}),
    }));
  }
}


function cleanupCandidateIsComplete(cleanup: Record<string, unknown>): boolean {
  return Boolean(
    stringValue(cleanup.workspaceId)
    && stringValue(cleanup.sessionId)
    && stringValue(cleanup.sandboxScopeId)
    && stringValue(cleanup.targetHandId)
    && stringValue(cleanup.deletionGeneration),
  );
}

function cleanupCandidateFromRow(row: Record<string, unknown>, cleanup: Record<string, unknown>): CleanupCandidate {
  const tenantId = stringValue(cleanup.tenantId) ?? stringValue(row.tenant_id);
  const userId = stringValue(cleanup.userId) ?? stringValue(row.user_id);
  const username = stringValue(cleanup.username) ?? stringValue(row.username);
  const claimId = stringValue(cleanup.claimId);
  const previousDeletionGeneration = stringValue(cleanup.previousDeletionGeneration);
  const claimGeneration = typeof cleanup.claimGeneration === 'number' ? cleanup.claimGeneration : undefined;
  return {
    runId: String(row.run_id), workspaceId: stringValue(cleanup.workspaceId)!,
    sessionId: stringValue(cleanup.sessionId)!, sandboxScopeId: stringValue(cleanup.sandboxScopeId)!,
    targetHandId: stringValue(cleanup.targetHandId)!, deletionGeneration: stringValue(cleanup.deletionGeneration)!,
    ...(previousDeletionGeneration ? { previousDeletionGeneration } : {}),
    ...(tenantId ? { tenantId } : {}), ...(userId ? { userId } : {}),
    ...(username ? { username } : {}), ...(claimId ? { claimId } : {}),
    ...(claimGeneration !== undefined ? { claimGeneration } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
