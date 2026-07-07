import pg from 'pg';

const { Pool } = pg;

type PgPool = InstanceType<typeof Pool>;

export interface AlertStateRecord {
  alertKey: string;
  severity: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastNotifiedAt: string | null;
  notifyCount: number;
}

export interface PgAlertStateStoreOptions {
  pool?: PgPool;
  connectionString?: string;
  tablePrefix?: string;
}

export class PgAlertStateStore {
  readonly pool: PgPool;
  readonly alertStateTable: string;
  private readonly ownsPool: boolean;

  constructor(options: PgAlertStateStoreOptions) {
    if (!options.pool && !options.connectionString) {
      throw new Error('PgAlertStateStore requires either pool or connectionString');
    }
    const prefix = sanitizeIdentifier(options.tablePrefix ?? 'runtime');
    this.alertStateTable = `${prefix}_alert_state`;
    this.pool = options.pool ?? new Pool({ connectionString: options.connectionString! });
    this.ownsPool = !options.pool;
  }

  async init(): Promise<void> {
    const lockKey = `${this.alertStateTable}:init`;
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.alertStateTable} (
          alert_key TEXT PRIMARY KEY,
          severity TEXT NOT NULL,
          first_seen_at TIMESTAMPTZ NOT NULL,
          last_seen_at TIMESTAMPTZ NOT NULL,
          last_notified_at TIMESTAMPTZ,
          notify_count INTEGER NOT NULL DEFAULT 0
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ${this.alertStateTable}_last_seen_idx
        ON ${this.alertStateTable} (last_seen_at)
      `);
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => undefined);
      client.release();
    }
  }

  async get(alertKey: string): Promise<AlertStateRecord | null> {
    const result = await this.pool.query<AlertStateRow>(
      `SELECT alert_key, severity, first_seen_at, last_seen_at, last_notified_at, notify_count
       FROM ${this.alertStateTable}
       WHERE alert_key = $1`,
      [alertKey],
    );
    return result.rows[0] ? mapAlertStateRow(result.rows[0]) : null;
  }

  async touch(alertKey: string, severity: string, seenAt = new Date()): Promise<AlertStateRecord> {
    const result = await this.pool.query<AlertStateRow>(
      `INSERT INTO ${this.alertStateTable}
         (alert_key, severity, first_seen_at, last_seen_at, last_notified_at, notify_count)
       VALUES ($1, $2, $3, $3, NULL, 0)
       ON CONFLICT (alert_key) DO UPDATE SET
         severity = EXCLUDED.severity,
         last_seen_at = EXCLUDED.last_seen_at
       RETURNING alert_key, severity, first_seen_at, last_seen_at, last_notified_at, notify_count`,
      [alertKey, severity, seenAt],
    );
    return mapAlertStateRow(result.rows[0]!);
  }

  async markNotified(alertKey: string, notifiedAt = new Date()): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.alertStateTable}
       SET last_notified_at = $2, notify_count = notify_count + 1
       WHERE alert_key = $1`,
      [alertKey, notifiedAt],
    );
  }

  async cleanupGone(activeKeys: string[], olderThanMs: number, now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - olderThanMs);
    const result = activeKeys.length > 0
      ? await this.pool.query(
          `DELETE FROM ${this.alertStateTable}
           WHERE NOT (alert_key = ANY($1::text[]))
             AND last_seen_at < $2`,
          [activeKeys, cutoff],
        )
      : await this.pool.query(
          `DELETE FROM ${this.alertStateTable}
           WHERE last_seen_at < $1`,
          [cutoff],
        );
    return result.rowCount ?? 0;
  }

  async summary(): Promise<{ configured: boolean; lastNotifiedAt: string | null; notifyCount: number }> {
    const result = await this.pool.query<{ last_notified_at: Date | string | null; notify_count: string }>(
      `SELECT max(last_notified_at) AS last_notified_at, COALESCE(sum(notify_count),0)::text AS notify_count
       FROM ${this.alertStateTable}`,
    );
    const row = result.rows[0];
    return {
      configured: true,
      lastNotifiedAt: row?.last_notified_at ? toIso(row.last_notified_at) : null,
      notifyCount: Number(row?.notify_count ?? 0),
    };
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}

interface AlertStateRow {
  alert_key: string;
  severity: string;
  first_seen_at: Date | string;
  last_seen_at: Date | string;
  last_notified_at: Date | string | null;
  notify_count: number;
}

function mapAlertStateRow(row: AlertStateRow): AlertStateRecord {
  return {
    alertKey: row.alert_key,
    severity: row.severity,
    firstSeenAt: toIso(row.first_seen_at),
    lastSeenAt: toIso(row.last_seen_at),
    lastNotifiedAt: row.last_notified_at ? toIso(row.last_notified_at) : null,
    notifyCount: Number(row.notify_count),
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function sanitizeIdentifier(input: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(input)) {
    throw new Error(`Invalid SQL identifier prefix: ${input}`);
  }
  return input;
}
