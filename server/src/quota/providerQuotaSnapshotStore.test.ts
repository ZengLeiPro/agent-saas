import type pg from 'pg';
import type { ProviderQuotaSnapshot } from '@agent/shared';
import { describe, expect, it } from 'vitest';

import { PgProviderQuotaSnapshotStore } from './providerQuotaSnapshotStore.js';

class FakePool {
  queries: Array<{ sql: string; params: unknown[] }> = [];
  rows: ProviderQuotaSnapshot[] = [];
  lockAcquired = true;
  released = 0;
  unlocked = 0;

  async connect(): Promise<pg.PoolClient> {
    return {
      query: async (sql: string, params: unknown[] = []) => {
        this.queries.push({ sql, params });
        if (sql.includes('pg_try_advisory_lock'))
          return { rows: [{ acquired: this.lockAcquired }] };
        if (sql.includes('pg_advisory_unlock')) this.unlocked += 1;
        return { rows: [] };
      },
      release: () => {
        this.released += 1;
      },
    } as unknown as pg.PoolClient;
  }

  async query(sql: string, params: unknown[] = []) {
    this.queries.push({ sql, params });
    if (sql.includes('INSERT INTO')) {
      this.rows.push(JSON.parse(String(params[4])) as ProviderQuotaSnapshot);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('DISTINCT ON')) {
      const byKey = new Map<string, ProviderQuotaSnapshot>();
      for (const row of this.rows) {
        if (sql.includes('WHERE ok = TRUE') && !row.ok) continue;
        const existing = byKey.get(row.accountKey);
        if (!existing || existing.collectedAt < row.collectedAt) byKey.set(row.accountKey, row);
      }
      return { rows: [...byKey.values()].map((snapshot) => ({ snapshot })), rowCount: byKey.size };
    }
    if (sql.includes("snapshot->'windows'")) {
      return {
        rows: this.rows.map((row) => ({
          account_key: row.accountKey,
          collected_at: new Date(row.collectedAt),
          ok: row.ok,
          windows: row.windows,
        })),
        rowCount: this.rows.length,
      };
    }
    if (sql.includes('DELETE FROM')) return { rows: [], rowCount: 3 };
    return { rows: [], rowCount: 0 };
  }
}

function snapshot(overrides: Partial<ProviderQuotaSnapshot>): ProviderQuotaSnapshot {
  return {
    sourceKind: 'volcengine_ark_plan',
    accountKey: 'volcengine:ark',
    accountLabel: '火山',
    groupId: 'ark',
    windows: [{ id: 'weekly', label: '近一周', usedPercent: 21.7 }],
    limitReached: false,
    ok: true,
    collectedAt: '2026-09-05T06:00:00.000Z',
    ...overrides,
  };
}

describe('PgProviderQuotaSnapshotStore', () => {
  it('表名跟随 tablePrefix，init 建表建索引并释放连接', async () => {
    const pool = new FakePool();
    const store = new PgProviderQuotaSnapshotStore(pool as unknown as pg.Pool, {
      tablePrefix: 'agent_runtime',
    });
    expect(store.table).toBe('agent_runtime_provider_quota_snapshots');
    await store.init();
    expect(
      pool.queries.some((q) =>
        q.sql.includes('CREATE TABLE IF NOT EXISTS agent_runtime_provider_quota_snapshots'),
      ),
    ).toBe(true);
    expect(
      pool.queries.some((q) =>
        q.sql.includes(
          'CREATE INDEX IF NOT EXISTS agent_runtime_provider_quota_snapshots_account_time_idx',
        ),
      ),
    ).toBe(true);
    expect(pool.released).toBe(1);
    expect(
      () =>
        new PgProviderQuotaSnapshotStore(pool as unknown as pg.Pool, { tablePrefix: 'bad-prefix' }),
    ).toThrow(/Invalid PG table prefix/u);
  });

  it('append 逐条写 JSONB，latest/latestSuccessful 按账号取最新', async () => {
    const pool = new FakePool();
    const store = new PgProviderQuotaSnapshotStore(pool as unknown as pg.Pool);
    await store.append([
      snapshot({ collectedAt: '2026-09-05T06:00:00.000Z' }),
      snapshot({ collectedAt: '2026-09-05T06:05:00.000Z', ok: false, error: 'boom', windows: [] }),
      snapshot({ accountKey: 'codex:a', sourceKind: 'codex_subscription', accountLabel: 'a@x' }),
    ]);
    const insert = pool.queries.find((q) => q.sql.includes('INSERT INTO'))!;
    expect(insert.params.slice(0, 4)).toEqual([
      'volcengine:ark',
      'volcengine_ark_plan',
      '2026-09-05T06:00:00.000Z',
      true,
    ]);
    const latest = await store.latest();
    expect(latest.find((s) => s.accountKey === 'volcengine:ark')?.ok).toBe(false);
    const latestOk = await store.latestSuccessful();
    expect(latestOk.find((s) => s.accountKey === 'volcengine:ark')?.collectedAt).toBe(
      '2026-09-05T06:00:00.000Z',
    );
  });

  it('history 把 windows 收敛为 id/usedPercent 并把 hours 夹在 1~720', async () => {
    const pool = new FakePool();
    const store = new PgProviderQuotaSnapshotStore(pool as unknown as pg.Pool);
    await store.append([snapshot({})]);
    const points = await store.history(10_000);
    expect(points).toEqual([
      {
        accountKey: 'volcengine:ark',
        collectedAt: '2026-09-05T06:00:00.000Z',
        ok: true,
        windows: [{ id: 'weekly', usedPercent: 21.7 }],
      },
    ]);
    expect(pool.queries.at(-1)?.params[0]).toBe(720);
    expect(await store.prune(30)).toBe(3);
  });

  it('collector lock：拿到后 release 会 unlock 并归还连接；拿不到直接归还', async () => {
    const pool = new FakePool();
    const store = new PgProviderQuotaSnapshotStore(pool as unknown as pg.Pool);
    const release = await store.tryAcquireCollectorLock();
    expect(release).toBeTypeOf('function');
    await release!();
    await release!();
    expect(pool.unlocked).toBe(1);
    expect(pool.released).toBe(1);
    pool.lockAcquired = false;
    expect(await store.tryAcquireCollectorLock()).toBeNull();
    expect(pool.released).toBe(2);
  });
});
