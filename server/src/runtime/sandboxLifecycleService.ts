import { randomUUID } from 'node:crypto';
import type { SandboxWorkloadDescriptor } from '@agent/shared';
import type { PlatformEvent } from './types.js';
import type { HandStore } from './handStore.js';
import type { RunStore } from './runStore.js';
import type { PgPool } from './runStoreTypes.js';
import { hasSandboxScopeActivity } from './runStoreSessionActivity.js';
import { lockSandboxCleanupKeys } from './sandboxRunAdmissionFence.js';
import type { SessionCatalog } from './sessionCatalog.js';
import { deriveSandboxScopeId, deriveWorkspaceMountSubPath, type TenantRemoteHandDispatchConfig } from './rawRuntimeRunDispatch.js';
import { runtimeRunController } from './runController.js';
import { controlPlaneFetch } from './controlPlaneFetch.js';
import { selectTenantRemoteHandsForRegistration, type TenantRemoteHandAuthTokenResolver } from './tenantRemoteHandResolver.js';

export interface SandboxLifecycleIdentity {
  workspaceId: string;
  sessionId: string;
  sandboxScopeId: string;
}

interface SandboxDeletionGenerationUpdate extends SandboxLifecycleIdentity {
  deletionGeneration: string;
  previousDeletionGeneration?: string;
}

interface SandboxScopeDeletion extends SandboxLifecycleIdentity {
  deletionGeneration: string;
}

interface LifecycleCandidate extends SandboxLifecycleIdentity {
  runId: string;
  tenantId?: string;
  targetHandId?: string;
  status: 'completed' | 'failed' | 'cancelled' | 'orphaned';
  statusReason?: string;
  terminalAt: string;
  workload: SandboxWorkloadDescriptor;
}

interface CleanupCandidate extends SandboxLifecycleIdentity {
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

interface ActiveScopeRun {
  runId: string;
  sessionId: string;
  tenantId?: string;
  userId?: string;
}

interface LegacyCleanupCandidate extends SandboxLifecycleIdentity {
  runId: string;
  tenantId?: string;
  userId?: string;
  username?: string;
}

export interface SandboxLifecycleLogger {
  info(message: string): void;
  warn(message: string): void;
}

export class PgSandboxLifecycleStore {
  constructor(
    private readonly pool: PgPool,
    private readonly runsTable: string,
    private readonly steeringInputsTable: string,
  ) {}

  async listTerminalCandidates(limit = 100): Promise<LifecycleCandidate[]> {
    const result = await this.pool.query<Record<string, unknown>>(`
      SELECT run_id, session_id, tenant_id, workspace_id, sandbox_scope_id, status,
             status_reason, completed_at, failed_at, cancelled_at, updated_at, metadata
      FROM ${this.runsTable}
      WHERE status IN ('completed','failed','cancelled','orphaned')
        AND metadata->>'sandboxWorkloadTopLevel' = 'true'
        AND metadata->'sandboxWorkloadDescriptor'->>'kind' IN ('taskboard','cron','memory')
        AND COALESCE(metadata->'sandboxLifecycleOutbox'->>'state', 'pending') <> 'delivered'
        AND workspace_id IS NOT NULL AND sandbox_scope_id IS NOT NULL
      ORDER BY COALESCE(
        metadata->>'sandboxLifecycleTerminalAt',
        completed_at::text,
        failed_at::text,
        cancelled_at::text,
        updated_at::text
      )::timestamptz ASC
      LIMIT $1
    `, [limit]);
    return result.rows.flatMap((row) => {
      const metadata = asRecord(row.metadata);
      const workload = parseWorkload(metadata.sandboxWorkloadDescriptor);
      const status = row.status;
      if (!workload || workload.kind === 'interactive'
        || !['completed', 'failed', 'cancelled', 'orphaned'].includes(String(status))) return [];
      return [{
        runId: String(row.run_id), sessionId: String(row.session_id),
        ...(typeof row.tenant_id === 'string' ? { tenantId: row.tenant_id } : {}),
        workspaceId: String(row.workspace_id), sandboxScopeId: String(row.sandbox_scope_id),
        status: status as LifecycleCandidate['status'],
        ...(typeof row.status_reason === 'string' ? { statusReason: row.status_reason } : {}),
        terminalAt: stringValue(metadata.sandboxLifecycleTerminalAt)
          ?? String(row.completed_at ?? row.failed_at ?? row.cancelled_at ?? row.updated_at),
        ...(stringValue(asRecord(metadata.sandboxLifecycleOutbox).targetHandId) ? {
          targetHandId: stringValue(asRecord(metadata.sandboxLifecycleOutbox).targetHandId),
        } : {}),
        workload,
      }];
    });
  }

  hasActivity(candidate: Pick<LifecycleCandidate, 'sandboxScopeId' | 'sessionId' | 'tenantId'>): Promise<boolean> {
    return hasSandboxScopeActivity({ pool: this.pool, runsTable: this.runsTable, steeringInputsTable: this.steeringInputsTable }, {
      sandboxScopeId: candidate.sandboxScopeId,
      topLevelSessionId: candidate.sessionId,
      ...(candidate.tenantId ? { tenantId: candidate.tenantId } : {}),
    });
  }

  async pinTerminalTargetHand(runId: string, targetHandId: string): Promise<string | undefined> {
    const result = await this.pool.query<{ target_hand_id: string }>(`
      UPDATE ${this.runsTable}
      SET metadata = jsonb_set(metadata, '{sandboxLifecycleOutbox}',
        COALESCE(metadata->'sandboxLifecycleOutbox', '{}'::jsonb)
          || jsonb_build_object('state','pending','targetHandId',$2::text,'pinnedAt',NOW()::text)),
          updated_at=NOW()
      WHERE run_id=$1
        AND COALESCE(metadata->'sandboxLifecycleOutbox'->>'state','pending') <> 'delivered'
        AND NULLIF(metadata->'sandboxLifecycleOutbox'->>'targetHandId','') IS NULL
      RETURNING metadata->'sandboxLifecycleOutbox'->>'targetHandId' AS target_hand_id
    `, [runId, targetHandId]);
    if (result.rows[0]?.target_hand_id) return result.rows[0].target_hand_id;
    const existing = await this.pool.query<{ target_hand_id: string }>(`
      SELECT metadata->'sandboxLifecycleOutbox'->>'targetHandId' AS target_hand_id
      FROM ${this.runsTable} WHERE run_id=$1
    `, [runId]);
    return stringValue(existing.rows[0]?.target_hand_id);
  }

  async markTerminalDelivered(runId: string, deliveredAt: string): Promise<void> {
    await this.pool.query(`
      UPDATE ${this.runsTable}
      SET metadata = metadata || jsonb_build_object('sandboxLifecycleOutbox',
        jsonb_build_object('state','delivered','deliveredAt',$2::text)), updated_at=NOW()
      WHERE run_id=$1
    `, [runId, deliveredAt]);
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
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await lockSandboxCleanupKeys(client, candidate.sessionId, candidate.sandboxScopeId);
      const result = await client.query<Record<string, unknown>>(`
      WITH active AS (
        SELECT run_id FROM ${this.runsTable}
        WHERE session_id=$1 AND ($2::text IS NULL OR tenant_id=$2)
          AND metadata->'sandboxCleanupOutbox'->>'state' IN ('prepared','cancelling','pending','claimed')
          AND NULLIF(metadata->'sandboxCleanupOutbox'->>'targetHandId','') IS NOT NULL
          AND NULLIF(metadata->'sandboxCleanupOutbox'->>'deletionGeneration','') IS NOT NULL
        ORDER BY updated_at DESC LIMIT 1
      ), legacy AS (
        SELECT run_id FROM ${this.runsTable}
        WHERE session_id=$1 AND ($2::text IS NULL OR tenant_id=$2)
          AND ($6::text IS NULL OR run_id=$6)
          AND (metadata->'sandboxCleanupOutbox'->>'state'='pending'
            OR (metadata->'sandboxCleanupOutbox'->>'state'='claimed'
              AND metadata->'sandboxCleanupOutbox'->>'claimedAt' < $5::text))
          AND (NULLIF(metadata->'sandboxCleanupOutbox'->>'targetHandId','') IS NULL
            OR NULLIF(metadata->'sandboxCleanupOutbox'->>'deletionGeneration','') IS NULL)
        ORDER BY updated_at DESC LIMIT 1
      ), target AS (
        SELECT run_id FROM legacy
        UNION ALL
        SELECT fallback.run_id FROM (
          SELECT run_id FROM ${this.runsTable}
          WHERE session_id=$1 AND ($2::text IS NULL OR tenant_id=$2)
          ORDER BY (metadata->>'sandboxWorkloadTopLevel' = 'true') DESC, updated_at DESC LIMIT 1
        ) AS fallback WHERE $6::text IS NULL AND NOT EXISTS (SELECT 1 FROM legacy)
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
      ), existing AS (
        SELECT run.run_id, run.tenant_id, run.user_id, run.metadata->>'username' AS username,
               run.metadata->'sandboxCleanupOutbox' AS cleanup
        FROM ${this.runsTable} AS run JOIN active ON run.run_id=active.run_id
      )
      SELECT * FROM updated UNION ALL SELECT * FROM existing LIMIT 1
      `, [candidate.sessionId, candidate.tenantId ?? null, payload, candidate.deletionGeneration,
        new Date(Date.now() - 60_000).toISOString(), candidate.legacyRunId ?? null]);
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

  // preparation/delivery 的任一 durable 状态均可由 restore 取消，历史 cycle 不得回退 generation fence。
  async cancelCleanup(sessionId: string, tenantId: string | undefined, deletionGeneration: string): Promise<CleanupCandidate[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<Record<string, unknown>>(`
      WITH cleanup_identity AS (
        SELECT DISTINCT run.metadata->'sandboxCleanupOutbox'->>'sandboxScopeId' AS sandbox_scope_id
        FROM ${this.runsTable} AS run
        WHERE run.session_id=$1 AND ($2::text IS NULL OR run.tenant_id=$2)
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
          AND session_id=$1 AND ($2::text IS NULL OR tenant_id=$2)
          AND run.metadata->'sandboxCleanupOutbox'->>'state' IN ('prepared','cancelling','pending','claimed')
        RETURNING run.run_id, run.tenant_id, run.user_id, run.metadata->>'username' AS username,
                  run.metadata->'sandboxCleanupOutbox' AS cleanup
      ), existing AS (
        SELECT run.run_id, run.tenant_id, run.user_id, run.metadata->>'username' AS username,
               run.metadata->'sandboxCleanupOutbox' AS cleanup
        FROM ${this.runsTable} AS run
        WHERE run.session_id=$1 AND ($2::text IS NULL OR run.tenant_id=$2)
          AND run.metadata->'sandboxCleanupOutbox'->>'state'='cancelled'
          AND NOT EXISTS (SELECT 1 FROM updated)
        ORDER BY run.updated_at DESC LIMIT 1
      )
      SELECT * FROM updated UNION ALL SELECT * FROM existing
      `, [sessionId, tenantId ?? null, new Date().toISOString(), deletionGeneration]);
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
            AND (cleanup_run.tenant_id IS NULL OR active.tenant_id=cleanup_run.tenant_id)
            AND active.status IN ('pending','running','waiting_approval','waiting_user','waiting_hand')
        )
      RETURNING cleanup_run.run_id, cleanup_run.tenant_id, cleanup_run.user_id,
                cleanup_run.metadata->>'username' AS username,
                cleanup_run.metadata->'sandboxCleanupOutbox' AS cleanup
    `, [runId, claimId, claimGeneration]);
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
    const result = await this.pool.query(`
      UPDATE ${this.runsTable}
      SET metadata = jsonb_set(metadata, '{sandboxCleanupOutbox}',
        metadata->'sandboxCleanupOutbox' || jsonb_build_object(
          'state','cancelled','cancelledAt',NOW()::text,'cancelReason','intent_without_tombstone'
        )), updated_at=NOW()
      WHERE run_id=$1 AND metadata->'sandboxCleanupOutbox'->>'state'='prepared'
        AND COALESCE(metadata->'sandboxCleanupOutbox'->>'queuedAt','') < $2::text
    `, [runId, staleBefore]);
    return (result.rowCount ?? 0) > 0;
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
        AND ($3::text IS NULL OR tenant_id=$3)
        AND status IN ('pending','running','waiting_approval','waiting_user','waiting_hand')
      ORDER BY requested_at ASC
    `, [identity.sandboxScopeId, identity.sessionId, tenantId ?? null]);
    return result.rows.map((row) => ({
      runId: String(row.run_id), sessionId: String(row.session_id),
      ...(typeof row.tenant_id === 'string' ? { tenantId: row.tenant_id } : {}),
      ...(typeof row.user_id === 'string' ? { userId: row.user_id } : {}),
    }));
  }
}

export class AcsSandboxLifecycleClient {
  constructor(private readonly options: {
    baseUrl: string;
    authToken: string;
    fetchImpl?: typeof fetch;
    requestTimeoutMs?: number;
  }) {}

  async notifyTerminal(input: SandboxLifecycleIdentity & {
    terminalState: 'completed' | 'failed' | 'cancelled' | 'timed-out';
    terminalAt: string;
    outcome?: unknown;
  }): Promise<void> {
    await this.request('/sandboxes/lifecycle', 'POST', input, undefined, false);
  }

  async advanceDeletionGeneration(input: SandboxDeletionGenerationUpdate, signal?: AbortSignal): Promise<void> {
    await this.request('/sandboxes/deletion-generation', 'POST', input, signal, true);
  }

  async deleteScope(input: SandboxScopeDeletion, signal?: AbortSignal): Promise<void> {
    await this.request('/sandboxes/scope', 'DELETE', input, signal, true);
  }

  private async request(
    path: string,
    method: 'POST' | 'DELETE',
    body: unknown,
    externalSignal: AbortSignal | undefined,
    allowMissing: boolean,
  ): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.requestTimeoutMs ?? 5_000);
    timer.unref?.();
    try {
      const baseUrl = this.options.baseUrl.replace(/\/$/, '');
      const response = await controlPlaneFetch(baseUrl, this.options.fetchImpl)(`${baseUrl}${path}`, {
        method, headers: { 'content-type': 'application/json', authorization: `Bearer ${this.options.authToken}` },
        body: JSON.stringify(body), signal: externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal,
      });
      if (response.ok) return;
      const text = await response.text().catch(() => '');
      if (allowMissing && response.status === 404 && /Sandbox .*not found|lifecycle identity not found/i.test(text)) return;
      throw new Error(`ACS ${method} ${path} HTTP ${response.status}: ${text.slice(0, 300) || 'no body'}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

export class SandboxLifecycleService {
  private timer?: NodeJS.Timeout;
  private scanPromise: Promise<void> | undefined;
  private readonly cleanupInFlight = new Map<string, {
    sessionId: string;
    controller: AbortController;
    promise: Promise<void>;
  }>();

  constructor(private readonly options: {
    agentCwd: string;
    store: PgSandboxLifecycleStore;
    runStore: Pick<RunStore, 'cancelSteeringBeforeDispatchBySessionWithEvent'>;
    sessionCatalog: Pick<SessionCatalog, 'get'>;
    handStore?: Pick<HandStore, 'get' | 'listBySession'>;
    tenantRemoteHands: () => TenantRemoteHandDispatchConfig[] | undefined;
    tenantRemoteHandResolver: TenantRemoteHandAuthTokenResolver;
    logger?: SandboxLifecycleLogger;
    fetchImpl?: typeof fetch;
    scanIntervalMs?: number;
  }) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.wake(), this.options.scanIntervalMs ?? 15_000);
    this.timer.unref?.();
    this.wake();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  observeRuntimeEvent(event: PlatformEvent): void {
    if (event.type === 'run_finished' || event.type === 'background_task_finished') this.wake();
  }

  wake(): void {
    if (this.scanPromise) return;
    this.scanPromise = this.scan().catch((error) => {
      this.options.logger?.warn(`sandbox_lifecycle_scan_failed error=${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => { this.scanPromise = undefined; });
  }

  async cancelSessionDeletion(sessionId: string): Promise<void> {
    const record = await this.options.sessionCatalog.get(sessionId);
    const deletionGeneration = newDeletionGeneration();
    const cancelled = await this.options.store.cancelCleanup(sessionId, record?.tenantId, deletionGeneration);
    const inFlight = [...this.cleanupInFlight.values()].filter((delivery) => delivery.sessionId === sessionId);
    for (const delivery of inFlight) {
      delivery.controller.abort(new Error('sandbox cleanup cancelled by session restore'));
    }
    for (const cleanup of cancelled) {
      const target = await this.resolveClient(cleanup.sessionId, cleanup.tenantId, undefined, cleanup);
      if (!target) throw new Error(`Sandbox cleanup target hand unavailable: ${cleanup.targetHandId}`);
      await target.client.advanceDeletionGeneration(cleanup);
    }
    if (cancelled.length === 0) {
      const target = await this.resolveSessionTarget(sessionId);
      if (target) await target.client.advanceDeletionGeneration({ ...target.identity, deletionGeneration });
    }
    await Promise.all(inFlight.map((delivery) => delivery.promise.catch(() => undefined)));
  }

  async prepareSessionDeletionIntent(sessionId: string): Promise<'skipped' | 'queued'> {
    const resolved = await this.resolveSessionTarget(sessionId);
    if (!resolved) return 'skipped';
    const { identity, tenantId, userId, username, targetHandId } = resolved;
    const enqueued = await this.options.store.enqueueCleanup({
      ...identity, targetHandId, deletionGeneration: newDeletionGeneration(),
      ...(tenantId ? { tenantId } : {}), ...(userId ? { userId } : {}), ...(username ? { username } : {}),
    }, { prepared: true }); // prepared 不可投递，先避免 tombstone 前产生外部删除。
    if (!enqueued) throw new Error(`Sandbox cleanup intent 无法持久化: ${sessionId}`);
    return 'queued';
  }

  async commitPreparedSessionDeletion(sessionId: string): Promise<'skipped' | 'deleted' | 'queued'> {
    let prepared = (await this.options.store.listPreparedCleanupCandidates()).filter((item) => item.sessionId === sessionId);
    let pending = (await this.options.store.listCleanupCandidates()).filter((item) => item.sessionId === sessionId);
    const intent = prepared.length > 0 || pending.length > 0
      ? 'queued' as const
      : await this.prepareSessionDeletionIntent(sessionId);
    if (prepared.length === 0 && pending.length === 0 && intent !== 'skipped') {
      prepared = (await this.options.store.listPreparedCleanupCandidates()).filter((item) => item.sessionId === sessionId);
    }
    for (const candidate of prepared) await this.processPreparedCleanup(candidate);
    pending = (await this.options.store.listCleanupCandidates()).filter((item) => item.sessionId === sessionId);
    for (const candidate of pending) {
      try {
        if (await this.deliverCleanupCandidate(candidate)) return 'deleted';
      } catch (error) {
        this.warnCandidate('sandbox_cleanup_queued', candidate.runId, error);
        this.wake();
      }
    }
    return intent === 'skipped' && prepared.length === 0 && pending.length === 0 ? 'skipped' : 'queued';
  }

  async prepareSessionDeletion(sessionId: string): Promise<'skipped' | 'deleted' | 'queued'> {
    return this.commitPreparedSessionDeletion(sessionId);
  }

  private async listScannerCandidates<T>(event: string, list: () => Promise<T[]>): Promise<T[]> {
    try {
      return await list();
    } catch (error) {
      this.warnCandidate(event, 'scanner', error);
      return [];
    }
  }

  private async scan(): Promise<void> {
    const preparedCandidates = await this.listScannerCandidates(
      'sandbox_cleanup_prepare_list_failed', async () => (await this.options.store.listPreparedCleanupCandidates?.()) ?? [],
    );
    for (const prepared of preparedCandidates) {
      try {
        await this.processPreparedCleanup(prepared);
      } catch (error) {
        this.warnCandidate('sandbox_cleanup_prepare_failed', prepared.runId, error);
      }
    }
    const legacyCandidates = await this.listScannerCandidates(
      'sandbox_cleanup_legacy_list_failed', async () => (await this.options.store.listLegacyCleanupCandidates?.()) ?? [],
    );
    for (const legacy of legacyCandidates) {
      try {
        const resolved = await this.resolveSessionTarget(legacy.sessionId);
        if (!resolved) continue;
        const { runId: legacyRunId, ...legacyIdentity } = legacy;
        await this.options.store.enqueueCleanup({
          ...legacyIdentity, legacyRunId,
          targetHandId: resolved.targetHandId, deletionGeneration: newDeletionGeneration(),
        });
      } catch (error) {
        this.warnCandidate('sandbox_cleanup_legacy_failed', legacy.runId, error);
      }
    }
    const pendingCandidates = await this.listScannerCandidates(
      'sandbox_cleanup_retry_list_failed', () => this.options.store.listCleanupCandidates(),
    );
    for (const pending of pendingCandidates) {
      try {
        await this.deliverCleanupCandidate(pending);
      } catch (error) {
        this.warnCandidate('sandbox_cleanup_retry_failed', pending.runId, error);
      }
    }
    const terminalCandidates = await this.listScannerCandidates(
      'sandbox_terminal_list_failed', () => this.options.store.listTerminalCandidates(),
    );
    for (const candidate of terminalCandidates) {
      try {
        if (await this.options.store.hasActivity(candidate)) continue;
        let targetHandId = candidate.targetHandId;
        if (!targetHandId) {
          const original = await this.resolveSessionTarget(candidate.sessionId);
          if (!original) continue;
          targetHandId = await this.options.store.pinTerminalTargetHand(candidate.runId, original.targetHandId);
        }
        if (!targetHandId) continue;
        const target = await this.resolveClient(candidate.sessionId, candidate.tenantId, undefined, { targetHandId });
        if (!target) continue;
        const timedOut = candidate.status === 'failed' && /timed?\s*out|timeout/i.test(candidate.statusReason ?? '');
        await target.client.notifyTerminal({
          workspaceId: candidate.workspaceId, sessionId: candidate.sessionId,
          sandboxScopeId: candidate.sandboxScopeId,
          terminalState: timedOut ? 'timed-out' : candidate.status === 'orphaned' ? 'failed' : candidate.status,
          terminalAt: candidate.terminalAt,
          outcome: { runId: candidate.runId, status: candidate.status, ...(candidate.statusReason ? { reason: candidate.statusReason } : {}) },
        });
        await this.options.store.markTerminalDelivered(candidate.runId, new Date().toISOString());
      } catch (error) {
        this.warnCandidate('sandbox_terminal_notify_failed', candidate.runId, error);
      }
    }
  }

  private async processPreparedCleanup(prepared: CleanupCandidate): Promise<void> {
    const record = await this.options.sessionCatalog.get(prepared.sessionId);
    if (!record?.deletedAt) {
      await this.options.store.expireUncommittedPreparedCleanup(prepared.runId);
      return;
    }
    const claimId = randomUUID();
    const claimed = await this.options.store.claimPreparedCleanup(prepared.runId, claimId);
    if (!claimed?.claimGeneration) return;
    const generation = claimed.claimGeneration;
    const ownsClaim = () => this.options.store.isPreparedCleanupClaimCurrent(claimed.runId, claimId, generation);
    try {
      const confirmed = await this.options.sessionCatalog.get(claimed.sessionId);
      if (!confirmed?.deletedAt || !await ownsClaim()) {
        await this.options.store.releasePreparedCleanupClaim(claimed.runId, claimId, generation);
        return;
      }
      if (!await this.cancelScope(claimed, claimed.tenantId, ownsClaim)) {
        await this.options.store.releasePreparedCleanupClaim(claimed.runId, claimId, generation);
        return;
      }
      const completed = await this.options.store.completePreparedCleanup(claimed.runId, claimId, generation);
      if (!completed) {
        await this.options.store.releasePreparedCleanupClaim(claimed.runId, claimId, generation);
        this.wake();
      }
    } catch (error) {
      await this.options.store.releasePreparedCleanupClaim(claimed.runId, claimId, generation);
      throw error;
    }
  }

  private async deliverCleanupCandidate(pending: CleanupCandidate): Promise<boolean> {
    const claimId = randomUUID();
    const cleanup = await this.options.store.claimCleanup(pending.runId, claimId);
    if (!cleanup) return false;
    try {
      const target = await this.resolveClient(cleanup.sessionId, cleanup.tenantId, undefined, cleanup);
      if (!target) return false;
      return await this.deliverClaimedCleanup(cleanup, target.client);
    } finally {
      await this.options.store.releaseCleanupClaim(cleanup.runId, claimId);
    }
  }

  private warnCandidate(event: string, runId: string, error: unknown): void {
    this.options.logger?.warn(`${event} run=${runId} error=${error instanceof Error ? error.message : String(error)}`);
  }

  // Delivery claim checks bracket every external transition; durable CAS remains final authority.
  private async deliverClaimedCleanup(cleanup: CleanupCandidate, client: AcsSandboxLifecycleClient): Promise<boolean> {
    const claimId = cleanup.claimId;
    if (!claimId || !await this.options.store.isCleanupClaimCurrent(cleanup.runId, claimId)) return false;
    const controller = new AbortController();
    const promise = (async () => {
      if (!await this.options.store.isCleanupClaimCurrent(cleanup.runId, claimId)) return;
      await client.advanceDeletionGeneration(cleanup, controller.signal);
      if (!await this.options.store.isCleanupClaimCurrent(cleanup.runId, claimId)) return;
      await client.deleteScope(cleanup, controller.signal);
      if (!await this.options.store.isCleanupClaimCurrent(cleanup.runId, claimId)) return;
      await this.options.store.markCleanupDelivered(cleanup.runId, claimId, new Date().toISOString());
    })();
    this.cleanupInFlight.set(claimId, { sessionId: cleanup.sessionId, controller, promise });
    try {
      await promise;
      return !controller.signal.aborted;
    } finally {
      if (this.cleanupInFlight.get(claimId)?.promise === promise) this.cleanupInFlight.delete(claimId);
    }
  }

  private async cancelScope(
    identity: CleanupCandidate, tenantId?: string,
    ownsClaim: () => Promise<boolean> = async () => true,
  ): Promise<boolean> {
    const cancel = this.options.runStore.cancelSteeringBeforeDispatchBySessionWithEvent;
    while (await ownsClaim()) {
      const active = await this.options.store.listActiveScopeRuns(identity, tenantId);
      if (active.length === 0) return ownsClaim();
      if (!cancel) throw new Error('Runtime scope cancellation is unavailable');
      for (const run of active) {
        if (!run.tenantId) throw new Error(`Runtime Run tenant 缺失，拒绝删除 scope：${run.runId}`);
        const reason = `session_deleted:${identity.sessionId}`;
        await cancel.call(this.options.runStore, run.sessionId, reason, run.runId, {
          type: 'run_cancel_requested', sessionId: run.sessionId, runId: run.runId,
          ...(run.userId ? { userId: run.userId } : {}), reason,
        }, run.tenantId, {
          cleanupRunId: identity.runId, sessionId: identity.sessionId,
          sandboxScopeId: identity.sandboxScopeId,
          claimId: identity.claimId!, claimGeneration: identity.claimGeneration!,
        });
        if (!await ownsClaim()) return false;
        runtimeRunController.abort(run.runId, reason);
      }
    }
    return false;
  }

  private async resolveSessionTarget(sessionId: string): Promise<{
    identity: SandboxLifecycleIdentity;
    tenantId?: string;
    userId?: string;
    username?: string;
    targetHandId: string;
    client: AcsSandboxLifecycleClient;
  } | undefined> {
    const record = await this.options.sessionCatalog.get(sessionId);
    if (!record || record.kind === 'subagent') return undefined;
    // server-remote.providerId 是本地 hand 类型，准确远端路由只认 metadata 或实际注册 hand。
    const hand = await this.options.handStore?.get(`${sessionId}:server-remote`);
    const pinnedTargetHandId = stringValue(hand?.metadata?.tenantRemoteHandId);
    const registeredHands = pinnedTargetHandId ? [] : await this.options.handStore?.listBySession(sessionId).catch(() => []);
    const registeredTargetHandId = pinnedTargetHandId ?? registeredHands
      ?.map((registered) => stringValue(registered.metadata?.tenantRemoteHandId) ?? stringValue(registered.providerId))
      .find((id) => id === 'agent-saas-acs')
      ?? registeredHands
        ?.map((registered) => stringValue(registered.metadata?.tenantRemoteHandId) ?? stringValue(registered.providerId))
        .find((id) => id && /acs/i.test(id));
    const target = await this.resolveClient(
      sessionId,
      record.tenantId,
      record,
      registeredTargetHandId ? { targetHandId: registeredTargetHandId } : undefined,
    );
    if (!target) return undefined;
    const workspaceId = record.workspaceId ?? sessionId;
    const recipe = asRecord(asRecord(hand?.metadata).recipe);
    const mountSubPath = stringValue(recipe.mountSubPath)
      ?? deriveWorkspaceMountSubPath({ agentCwd: this.options.agentCwd, cwd: record.cwd });
    const sandboxScopeId = stringValue(recipe.sandboxScopeId)
      ?? deriveSandboxScopeId({ workspaceId, mountSubPath, topLevelSessionId: sessionId });
    return {
      identity: { workspaceId, sessionId, sandboxScopeId },
      ...(record.tenantId ? { tenantId: record.tenantId } : {}),
      ...(record.userId ? { userId: record.userId } : {}),
      ...(record.username ? { username: record.username } : {}),
      targetHandId: target.targetHandId,
      client: target.client,
    };
  }

  private async resolveClient(
    sessionId: string,
    tenantId?: string,
    knownRecord?: Awaited<ReturnType<SessionCatalog['get']>>,
    routing?: { userId?: string; username?: string; targetHandId?: string },
  ): Promise<{ client: AcsSandboxLifecycleClient; targetHandId: string } | undefined> {
    const record = knownRecord ?? await this.options.sessionCatalog.get(sessionId);
    const configured = this.options.tenantRemoteHands() ?? [];
    const entry = routing?.targetHandId
      ? configured.find((hand) => hand.id === routing.targetHandId)
      : (() => {
          const selector = {
            userId: record?.userId ?? routing?.userId,
            username: record?.username ?? routing?.username,
            userTenantId: tenantId ?? record?.tenantId,
          };
          const candidates = selectTenantRemoteHandsForRegistration(configured, selector);
          return candidates.find((hand) => hand.id === 'agent-saas-acs')
            ?? candidates.find((hand) => /acs/i.test(hand.id));
        })();
    if (!entry) return undefined;
    const resolved = await this.options.tenantRemoteHandResolver.resolveForRegister(entry);
    return {
      targetHandId: entry.id,
      client: new AcsSandboxLifecycleClient({
        baseUrl: resolved.baseUrl, authToken: resolved.authToken, fetchImpl: this.options.fetchImpl,
      }),
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
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

function newDeletionGeneration(nowMs = Date.now()): string {
  return `${Math.trunc(nowMs)}-${randomUUID()}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseWorkload(value: unknown): SandboxWorkloadDescriptor | undefined {
  const raw = asRecord(value);
  if (raw.kind === 'interactive' || raw.kind === 'cron' || raw.kind === 'memory') return { kind: raw.kind };
  if (raw.kind !== 'taskboard') return undefined;
  return {
    kind: 'taskboard',
    ...(typeof raw.taskKind === 'string' ? { taskKind: raw.taskKind as Extract<SandboxWorkloadDescriptor, { kind: 'taskboard' }>['taskKind'] } : {}),
    ...(typeof raw.purpose === 'string' ? { purpose: raw.purpose as Extract<SandboxWorkloadDescriptor, { kind: 'taskboard' }>['purpose'] } : {}),
  };
}
