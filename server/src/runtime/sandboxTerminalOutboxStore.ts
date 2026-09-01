import type { SandboxWorkloadDescriptor } from '@agent/shared';
import type { PgPool } from './runStoreTypes.js';

export interface TerminalLifecycleCandidate {
  runId: string;
  sessionId: string;
  tenantId?: string;
  workspaceId: string;
  sandboxScopeId: string;
  targetHandId?: string;
  status: 'completed' | 'failed' | 'cancelled' | 'orphaned';
  statusReason?: string;
  terminalAt: string;
  workload: SandboxWorkloadDescriptor;
}

export interface TerminalDeferredState {
  attempts: number;
  nextAttemptAt: string;
  lastError: string;
}

export class SandboxTerminalOutboxStore {
  constructor(
    private readonly pool: PgPool,
    private readonly runsTable: string,
    private readonly now: () => Date,
  ) {}

  async listCandidates(limit = 100): Promise<TerminalLifecycleCandidate[]> {
    const result = await this.pool.query<Record<string, unknown>>(`
      WITH terminal AS (
        SELECT run_id, session_id, tenant_id, workspace_id, sandbox_scope_id, status,
               status_reason, completed_at, failed_at, cancelled_at, updated_at, metadata,
               COALESCE(
                 metadata->>'sandboxLifecycleTerminalAt', completed_at::text,
                 failed_at::text, cancelled_at::text, updated_at::text
               )::timestamptz AS terminal_at
        FROM ${this.runsTable}
        WHERE status IN ('completed','failed','cancelled','orphaned')
          AND metadata->>'sandboxWorkloadTopLevel' = 'true'
          AND metadata->'sandboxWorkloadDescriptor'->>'kind' IN ('taskboard','cron','memory')
          AND workspace_id IS NOT NULL AND sandbox_scope_id IS NOT NULL
      ), latest AS (
        SELECT terminal.*,
               ROW_NUMBER() OVER (
                 PARTITION BY tenant_id, workspace_id, sandbox_scope_id
                 ORDER BY terminal_at DESC, run_id DESC
               ) AS scope_rank
        FROM terminal
      )
      SELECT run_id, session_id, tenant_id, workspace_id, sandbox_scope_id, status,
             status_reason, completed_at, failed_at, cancelled_at, updated_at, metadata
      FROM latest
      WHERE scope_rank = 1
        AND COALESCE(metadata->'sandboxLifecycleOutbox'->>'state', 'pending') <> 'delivered'
        AND (
          COALESCE(metadata->'sandboxLifecycleOutbox'->>'state', 'pending') <> 'deferred'
          OR COALESCE(
            NULLIF(metadata->'sandboxLifecycleOutbox'->>'nextAttemptAt', '')::timestamptz,
            '-infinity'::timestamptz
          ) <= $2::timestamptz
        )
      ORDER BY terminal_at ASC, run_id ASC
      LIMIT $1
    `, [limit, this.now().toISOString()]);
    return result.rows.flatMap(candidateFromRow);
  }

  async pinTargetHand(runId: string, targetHandId: string): Promise<string | undefined> {
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

  async markDelivered(runId: string, deliveredAt: string): Promise<void> {
    await this.pool.query(`
      UPDATE ${this.runsTable}
      SET metadata = metadata || jsonb_build_object('sandboxLifecycleOutbox',
        jsonb_build_object('state','delivered','deliveredAt',$2::text)), updated_at=NOW()
      WHERE run_id=$1
    `, [runId, deliveredAt]);
  }

  async defer(
    runId: string,
    error: unknown,
    deferredAt = this.now().toISOString(),
  ): Promise<TerminalDeferredState | undefined> {
    const lastError = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
    const result = await this.pool.query<{ outbox: Record<string, unknown> }>(`
      UPDATE ${this.runsTable}
      SET metadata = jsonb_set(metadata, '{sandboxLifecycleOutbox}',
        COALESCE(metadata->'sandboxLifecycleOutbox', '{}'::jsonb) || jsonb_build_object(
          'state', 'deferred',
          'attempts', COALESCE((metadata->'sandboxLifecycleOutbox'->>'attempts')::int, 0) + 1,
          'nextAttemptAt', (
            $2::timestamptz
            + LEAST(
                300::double precision,
                power(2::double precision, LEAST(COALESCE((metadata->'sandboxLifecycleOutbox'->>'attempts')::int, 0), 8))
              ) * interval '1 second'
          )::text,
          'lastError', $3::text,
          'deferredAt', $2::text
        ), true), updated_at=NOW()
      WHERE run_id=$1
        AND COALESCE(metadata->'sandboxLifecycleOutbox'->>'state', 'pending') <> 'delivered'
      RETURNING metadata->'sandboxLifecycleOutbox' AS outbox
    `, [runId, deferredAt, lastError]);
    const outbox = asRecord(result.rows[0]?.outbox);
    const attempts = typeof outbox.attempts === 'number' ? outbox.attempts : Number(outbox.attempts);
    const nextAttemptAt = stringValue(outbox.nextAttemptAt);
    if (!Number.isFinite(attempts) || !nextAttemptAt) return undefined;
    return { attempts, nextAttemptAt, lastError: stringValue(outbox.lastError) ?? lastError };
  }
}

function candidateFromRow(row: Record<string, unknown>): TerminalLifecycleCandidate[] {
  const metadata = asRecord(row.metadata);
  const workload = parseWorkload(metadata.sandboxWorkloadDescriptor);
  const status = row.status;
  if (!workload || workload.kind === 'interactive'
    || !['completed', 'failed', 'cancelled', 'orphaned'].includes(String(status))) return [];
  const targetHandId = stringValue(asRecord(metadata.sandboxLifecycleOutbox).targetHandId);
  return [{
    runId: String(row.run_id), sessionId: String(row.session_id),
    ...(typeof row.tenant_id === 'string' ? { tenantId: row.tenant_id } : {}),
    workspaceId: String(row.workspace_id), sandboxScopeId: String(row.sandbox_scope_id),
    status: status as TerminalLifecycleCandidate['status'],
    ...(typeof row.status_reason === 'string' ? { statusReason: row.status_reason } : {}),
    terminalAt: stringValue(metadata.sandboxLifecycleTerminalAt)
      ?? String(row.completed_at ?? row.failed_at ?? row.cancelled_at ?? row.updated_at),
    ...(targetHandId ? { targetHandId } : {}), workload,
  }];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
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
