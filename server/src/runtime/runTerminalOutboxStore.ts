import { PgRunStore, type RunRecord, type RunStore } from './runStore.js';

export interface ClaimedTerminalEventOutboxRun extends RunRecord {
  tenantId: string;
}

export interface TerminalEventOutboxRunStore extends RunStore {
  listPendingTerminalEventOutboxes(now: Date, staleBefore: Date, limit?: number): Promise<RunRecord[]>;
  claimTerminalEventOutbox(
    runId: string,
    deliveryId: string,
    claimToken: string,
    now: Date,
    staleBefore: Date,
  ): Promise<ClaimedTerminalEventOutboxRun | null>;
  finishTerminalEventOutbox(
    runId: string,
    deliveryId: string,
    claimToken: string,
    outbox: Record<string, unknown>,
  ): Promise<RunRecord | null>;
}

/** PgRunStore with durable, cross-process terminal event outbox claims. */
export class PgTerminalEventOutboxRunStore extends PgRunStore implements TerminalEventOutboxRunStore {
  override async init(): Promise<void> {
    await super.init();
    const client = await this.pool.connect();
    const lockKey = `${this.runsTable}:terminal-outbox-index`;
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
      await client.query(`CREATE INDEX IF NOT EXISTS ${this.runsTable}_terminal_outbox_idx ON ${this.runsTable} ((metadata->'terminalEventOutbox'->>'state'), updated_at) WHERE metadata ? 'terminalEventOutbox' AND metadata->'terminalEventOutbox'->>'state' <> 'delivered'`);
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => undefined);
      client.release();
    }
  }

  async listPendingTerminalEventOutboxes(now: Date, staleBefore: Date, limit = 50): Promise<RunRecord[]> {
    const boundedLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    const result = await this.pool.query<{ row_json: RunRecord }>(`
      SELECT row_to_json(run.*) AS row_json
      FROM ${this.runsTable} run
      WHERE status = metadata->'terminalEventOutbox'->>'terminalStatus'
        AND (
          (metadata->'terminalEventOutbox'->>'state' IN ('pending', 'failed')
            AND metadata->'terminalEventOutbox'->>'tenantResolutionError' IS NULL
            AND (
            metadata->'terminalEventOutbox'->>'nextAttemptAt' IS NULL
            OR (metadata->'terminalEventOutbox'->>'nextAttemptAt')::timestamptz <= $1
          ))
          OR (metadata->'terminalEventOutbox'->>'state' = 'delivering' AND (
            metadata->'terminalEventOutbox'->>'claimedAt' IS NULL
            OR (metadata->'terminalEventOutbox'->>'claimedAt')::timestamptz < $2
          ))
        )
      ORDER BY COALESCE(
        (metadata->'terminalEventOutbox'->>'nextAttemptAt')::timestamptz,
        (metadata->'terminalEventOutbox'->>'claimedAt')::timestamptz,
        updated_at
      ), run_id
      LIMIT $3
    `, [now.toISOString(), staleBefore.toISOString(), boundedLimit]);
    return result.rows.map((row) => normalizeOutboxRunRecord(row.row_json));
  }

  async claimTerminalEventOutbox(
    runId: string,
    deliveryId: string,
    claimToken: string,
    now: Date,
    staleBefore: Date,
  ): Promise<ClaimedTerminalEventOutboxRun | null> {
    const patch = JSON.stringify({
      state: 'delivering', claimToken, claimedAt: now.toISOString(),
      updatedAt: now.toISOString(), nextAttemptAt: null,
    });
    const result = await this.pool.query<{ row_json: RunRecord }>(`
      UPDATE ${this.runsTable}
      SET metadata = jsonb_set(
            metadata,
            '{terminalEventOutbox}',
            metadata->'terminalEventOutbox' || $3::jsonb || jsonb_build_object('tenantId', BTRIM(tenant_id)),
            true
          ),
          updated_at = $4
      WHERE run_id = $1
        AND metadata->'terminalEventOutbox'->>'deliveryId' = $2
        AND status = metadata->'terminalEventOutbox'->>'terminalStatus'
        AND NULLIF(BTRIM(tenant_id), '') IS NOT NULL
        AND (
          NULLIF(BTRIM(metadata->'terminalEventOutbox'->>'tenantId'), '') IS NULL
          OR BTRIM(metadata->'terminalEventOutbox'->>'tenantId') = BTRIM(tenant_id)
        )
        AND (
          (metadata->'terminalEventOutbox'->>'state' IN ('pending', 'failed')
            AND metadata->'terminalEventOutbox'->>'tenantResolutionError' IS NULL
            AND (
            metadata->'terminalEventOutbox'->>'nextAttemptAt' IS NULL
            OR (metadata->'terminalEventOutbox'->>'nextAttemptAt')::timestamptz <= $4
          ))
          OR (metadata->'terminalEventOutbox'->>'state' = 'delivering' AND (
            metadata->'terminalEventOutbox'->>'claimedAt' IS NULL
            OR (metadata->'terminalEventOutbox'->>'claimedAt')::timestamptz < $5
          ))
        )
      RETURNING row_to_json(${this.runsTable}.*) AS row_json
    `, [runId, deliveryId, patch, now.toISOString(), staleBefore.toISOString()]);
    if (result.rows[0]) {
      return normalizeOutboxRunRecord(result.rows[0].row_json) as ClaimedTerminalEventOutboxRun;
    }
    await this.failUnresolvableTerminalEventOutbox(runId, deliveryId, now);
    return null;
  }

  private async failUnresolvableTerminalEventOutbox(
    runId: string,
    deliveryId: string,
    now: Date,
  ): Promise<void> {
    const timestamp = now.toISOString();
    await this.pool.query(`
      UPDATE ${this.runsTable}
      SET metadata = jsonb_set(
            metadata,
            '{terminalEventOutbox}',
            (
              metadata->'terminalEventOutbox'
              - 'claimToken'
              - 'claimedAt'
              - 'nextAttemptAt'
            ) || jsonb_build_object(
              'state', 'failed',
              'updatedAt', $3::text,
              'lastError', CASE
                WHEN NULLIF(BTRIM(tenant_id), '') IS NULL
                  THEN 'terminal outbox tenant resolution failed: authoritative runtime run/session tenant is missing'
                ELSE 'terminal outbox tenant resolution failed: durable tenant does not match authoritative runtime run tenant'
              END,
              'tenantResolutionError', CASE
                WHEN NULLIF(BTRIM(tenant_id), '') IS NULL
                  THEN 'terminal outbox tenant resolution failed: authoritative runtime run/session tenant is missing'
                ELSE 'terminal outbox tenant resolution failed: durable tenant does not match authoritative runtime run tenant'
              END
            ),
            true
          ),
          updated_at = $3::timestamptz
      WHERE run_id = $1
        AND metadata->'terminalEventOutbox'->>'deliveryId' = $2
        AND metadata->'terminalEventOutbox'->>'state' <> 'delivered'
        AND (
          NULLIF(BTRIM(tenant_id), '') IS NULL
          OR (
            NULLIF(BTRIM(metadata->'terminalEventOutbox'->>'tenantId'), '') IS NOT NULL
            AND BTRIM(metadata->'terminalEventOutbox'->>'tenantId') <> BTRIM(tenant_id)
          )
        )
    `, [runId, deliveryId, timestamp]);
  }

  async finishTerminalEventOutbox(
    runId: string,
    deliveryId: string,
    claimToken: string,
    outbox: Record<string, unknown>,
  ): Promise<RunRecord | null> {
    const now = new Date().toISOString();
    const result = await this.pool.query<{ row_json: RunRecord }>(`
      UPDATE ${this.runsTable}
      SET metadata = jsonb_set(metadata, '{terminalEventOutbox}', $4::jsonb, true), updated_at = $5
      WHERE run_id = $1
        AND metadata->'terminalEventOutbox'->>'deliveryId' = $2
        AND metadata->'terminalEventOutbox'->>'state' = 'delivering'
        AND metadata->'terminalEventOutbox'->>'claimToken' = $3
      RETURNING row_to_json(${this.runsTable}.*) AS row_json
    `, [runId, deliveryId, claimToken, JSON.stringify(outbox), now]);
    return result.rows[0] ? normalizeOutboxRunRecord(result.rows[0].row_json) : null;
  }
}

function normalizeOutboxRunRecord(raw: RunRecord): RunRecord {
  const value = raw as RunRecord & {
    run_id?: string;
    session_id?: string;
    tenant_id?: string;
    requested_at?: string;
    updated_at?: string;
  };
  const tenantId = (value.tenantId ?? value.tenant_id)?.trim();
  return {
    ...value,
    runId: value.runId ?? value.run_id!,
    sessionId: value.sessionId ?? value.session_id!,
    tenantId: tenantId || undefined,
    requestedAt: value.requestedAt ?? value.requested_at!,
    updatedAt: value.updatedAt ?? value.updated_at!,
    metadata: value.metadata ?? {},
  };
}
