import type pg from 'pg';
import type { ProviderQuotaHistoryPoint, ProviderQuotaSnapshot } from '@agent/shared';

type PgPool = pg.Pool;

function sanitizeIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error(`Invalid PG table prefix: ${value}`);
  return value;
}

/**
 * 套餐额度快照：只追加。最新一条 = 看板当前值，历史用于趋势与「上次采集失败原因」。
 * 采集器单例靠 PG advisory lock，蓝绿两色 Worker 并存期间不会双采。
 */
export class PgProviderQuotaSnapshotStore {
  readonly table: string;

  constructor(
    private readonly pool: PgPool,
    options: { tablePrefix?: string } = {},
  ) {
    this.table = `${sanitizeIdentifier(options.tablePrefix ?? 'runtime')}_provider_quota_snapshots`;
  }

  async init(): Promise<void> {
    const lockKey = `${this.table}:init`;
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.table} (
          id BIGSERIAL PRIMARY KEY,
          account_key TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          collected_at TIMESTAMPTZ NOT NULL,
          ok BOOLEAN NOT NULL,
          snapshot JSONB NOT NULL
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS ${this.table}_account_time_idx ON ${this.table} (account_key, collected_at DESC)`,
      );
    } finally {
      await client
        .query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey])
        .catch(() => undefined);
      client.release();
    }
  }

  async append(snapshots: readonly ProviderQuotaSnapshot[]): Promise<void> {
    for (const snapshot of snapshots) {
      await this.pool.query(
        `INSERT INTO ${this.table} (account_key, source_kind, collected_at, ok, snapshot)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          snapshot.accountKey,
          snapshot.sourceKind,
          snapshot.collectedAt,
          snapshot.ok,
          JSON.stringify(snapshot),
        ],
      );
    }
  }

  /** 每个账号最新一条（含失败快照，前端据此显示错误）。 */
  async latest(): Promise<ProviderQuotaSnapshot[]> {
    const result = await this.pool.query<{ snapshot: ProviderQuotaSnapshot }>(
      `SELECT DISTINCT ON (account_key) snapshot
       FROM ${this.table}
       ORDER BY account_key, collected_at DESC`,
    );
    return result.rows.map((row) => row.snapshot);
  }

  /** 每个账号最近一次成功快照；账号刚失败时看板仍能显示上一次真实用量。 */
  async latestSuccessful(): Promise<ProviderQuotaSnapshot[]> {
    const result = await this.pool.query<{ snapshot: ProviderQuotaSnapshot }>(
      `SELECT DISTINCT ON (account_key) snapshot
       FROM ${this.table}
       WHERE ok = TRUE
       ORDER BY account_key, collected_at DESC`,
    );
    return result.rows.map((row) => row.snapshot);
  }

  async history(hours: number, limit = 5_000): Promise<ProviderQuotaHistoryPoint[]> {
    const safeHours = Math.min(Math.max(Math.floor(hours), 1), 24 * 30);
    const result = await this.pool.query<{
      account_key: string;
      collected_at: Date | string;
      ok: boolean;
      windows: Array<{ id?: unknown; usedPercent?: unknown }> | null;
    }>(
      `SELECT account_key, collected_at, ok, snapshot->'windows' AS windows
       FROM ${this.table}
       WHERE collected_at >= NOW() - ($1::int * INTERVAL '1 hour')
       ORDER BY collected_at ASC
       LIMIT $2`,
      [safeHours, Math.max(1, Math.floor(limit))],
    );
    return result.rows.map((row) => ({
      accountKey: row.account_key,
      collectedAt:
        row.collected_at instanceof Date
          ? row.collected_at.toISOString()
          : String(row.collected_at),
      ok: row.ok,
      windows: (Array.isArray(row.windows) ? row.windows : [])
        .filter((window) => typeof window.id === 'string' && typeof window.usedPercent === 'number')
        .map((window) => ({ id: window.id as string, usedPercent: window.usedPercent as number })),
    }));
  }

  async prune(retentionDays: number): Promise<number> {
    const days = Math.max(1, Math.floor(retentionDays));
    const result = await this.pool.query(
      `DELETE FROM ${this.table} WHERE collected_at < NOW() - ($1::int * INTERVAL '1 day')`,
      [days],
    );
    return result.rowCount ?? 0;
  }

  /** 进程级采集单例锁；拿不到返回 null，拿到后由调用方在采集结束时 release。 */
  async tryAcquireCollectorLock(): Promise<(() => Promise<void>) | null> {
    const lockKey = `${this.table}:collector`;
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',
        [lockKey],
      );
      if (result.rows[0]?.acquired !== true) {
        client.release();
        return null;
      }
    } catch (error) {
      client.release();
      throw error;
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await client
        .query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey])
        .catch(() => undefined);
      client.release();
    };
  }
}
