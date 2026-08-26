import type { Pool, PoolClient } from 'pg';

import type { MemoryConsolidationScannerStatus } from './types.js';

interface ScannerStatusTables {
  events: string;
  consumers: string;
  skips: string;
}

export async function initMemoryConsolidationScannerTables(
  client: PoolClient,
  tables: Pick<ScannerStatusTables, 'consumers' | 'skips'>,
): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${tables.consumers} (
      consumer_name TEXT PRIMARY KEY,
      last_global_sequence BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${tables.skips} (
      consumer_name TEXT NOT NULL,
      global_sequence BIGINT NOT NULL,
      tenant_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_timestamp TIMESTAMPTZ,
      reason TEXT NOT NULL,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      skipped_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (consumer_name, global_sequence)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS ${tables.skips}_tenant_idx
    ON ${tables.skips} (tenant_id, skipped_at DESC)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS ${tables.skips}_consumer_time_idx
    ON ${tables.skips} (consumer_name, skipped_at DESC) INCLUDE (reason)
  `);
}

export async function readMemoryConsolidationScannerStatus(input: {
  pool: Pool;
  tables: ScannerStatusTables;
  consumerName: string;
}): Promise<MemoryConsolidationScannerStatus> {
  const { pool, tables, consumerName } = input;
  const cursorResult = await pool.query<{ last_global_sequence: string; updated_at: Date }>(
    `SELECT last_global_sequence, updated_at
     FROM ${tables.consumers}
     WHERE consumer_name = $1`,
    [consumerName],
  );
  const cursor = Number(cursorResult.rows[0]?.last_global_sequence ?? 0);
  const boundaryTypes = ['run_started', 'run_finished'];
  const [latestResult, oldestResult, skipResult] = await Promise.all([
    pool.query<{ global_sequence: string; timestamp: Date }>(
      `SELECT global_sequence, timestamp
       FROM ${tables.events}
       WHERE event_type = ANY($1::text[])
       ORDER BY global_sequence DESC
       LIMIT 1`,
      [boundaryTypes],
    ),
    pool.query<{ global_sequence: string; timestamp: Date }>(
      `SELECT global_sequence, timestamp
       FROM ${tables.events}
       WHERE global_sequence > $1
         AND event_type = ANY($2::text[])
       ORDER BY global_sequence ASC
       LIMIT 1`,
      [cursor, boundaryTypes],
    ),
    pool.query<{ reason: string; count: string; latest_skip_at: Date }>(
      `SELECT reason, COUNT(*)::text AS count, MAX(skipped_at) AS latest_skip_at
       FROM ${tables.skips}
       WHERE consumer_name = $1
         AND skipped_at >= NOW() - INTERVAL '24 hours'
       GROUP BY reason
       ORDER BY reason`,
      [consumerName],
    ),
  ]);
  const latest = latestResult.rows[0];
  const oldest = oldestResult.rows[0];
  const latestBoundarySequence = Number(latest?.global_sequence ?? cursor);
  const oldestPendingBoundaryAt = oldest?.timestamp?.toISOString() ?? null;
  const latestSkipAt = skipResult.rows.reduce<Date | null>(
    (seen, row) => (!seen || row.latest_skip_at > seen ? row.latest_skip_at : seen),
    null,
  );

  return {
    capturedAt: new Date().toISOString(),
    consumerName,
    cursor,
    cursorUpdatedAt: cursorResult.rows[0]?.updated_at?.toISOString() ?? null,
    latestBoundarySequence,
    latestBoundaryAt: latest?.timestamp?.toISOString() ?? null,
    sequenceLag: Math.max(0, latestBoundarySequence - cursor),
    oldestPendingBoundarySequence: oldest ? Number(oldest.global_sequence) : null,
    oldestPendingBoundaryAt,
    oldestPendingAgeMs: oldestPendingBoundaryAt
      ? Math.max(0, Date.now() - Date.parse(oldestPendingBoundaryAt))
      : null,
    skips24hByReason: Object.fromEntries(
      skipResult.rows.map((row) => [row.reason, Number(row.count)]),
    ),
    latestSkipAt: latestSkipAt?.toISOString() ?? null,
  };
}
