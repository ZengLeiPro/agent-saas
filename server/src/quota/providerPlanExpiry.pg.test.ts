import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgProviderQuotaSnapshotStore } from './providerQuotaSnapshotStore.js';

const connectionString = process.env.TEST_DATABASE_URL?.trim();
const describePg = connectionString ? describe : describe.skip;

describePg('套餐到期持久化与审计', () => {
  const prefix = `quota_expiry_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let pool: pg.Pool;
  let store: PgProviderQuotaSnapshotStore;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 3000 });
    store = new PgProviderQuotaSnapshotStore(pool, { tablePrefix: prefix });
    await store.init();
    await store.init();
  });
  afterAll(async () => {
    if (!pool) return;
    try {
      await pool.query(`DROP TABLE IF EXISTS ${store.planExpiryTable}, ${store.table}`);
    } finally {
      await pool.end();
    }
  });
  it('发布回读 SQL 能验证新增表结构', async () => {
    const catalog = JSON.parse(readFileSync(new URL('../../../config/release-migration-postconditions.json', import.meta.url), 'utf8'));
    const entry = catalog.entries.find((item: { path: string }) => item.path === 'server/src/quota/providerQuotaSnapshotStore.ts');
    const check = entry.checks[0];
    expect((await pool.query(check.sql, [prefix])).rows).toEqual([{ ok: true }]);
  });

  it('跨实例读取，清除回退且快照清理不删除编辑历史', async () => {
    const key = 'codex-email:shared@example.com';
    await store.setPlanExpiry(key, '2026-10-01T23:59:00+08:00', 'admin-1');
    await store.setPlanExpiry('volcengine:g', '2027-01-01T00:00:00Z', 'admin-2');
    const another = new PgProviderQuotaSnapshotStore(pool, { tablePrefix: prefix });
    expect((await another.planExpiryOverrides([key])).get(key)).toBe('2026-10-01T15:59:00.000Z');
    expect((await another.planExpiryOverrides(['codex-email:other@example.com'])).size).toBe(0);
    await another.setPlanExpiry(key, null, 'admin-3');
    await another.setPlanNote(key, '续费前确认额度', 'admin-4');
    expect((await store.planNotes([key])).get(key)).toBe('续费前确认额度');
    await another.setPlanNote(key, null, 'admin-5');
    expect((await store.planNotes([key])).get(key)).toBeNull();
    await store.prune(30);
    expect((await store.planExpiryOverrides([key])).get(key)).toBeNull();
    expect((await store.planExpiryOverrides(['volcengine:g'])).get('volcengine:g')).toBe(
      '2027-01-01T00:00:00.000Z',
    );
    const result = await pool.query(
      `SELECT end_time, updated_by, updated_at FROM ${store.planExpiryTable} WHERE identity_key=$1 ORDER BY id`,
      [key],
    );
    expect(result.rows.map((row) => row.updated_by)).toEqual(['admin-1', 'admin-3']);
    expect(result.rows[1].end_time).toBeNull();
    expect(result.rows[0].updated_at).toBeInstanceOf(Date);
  });
});
