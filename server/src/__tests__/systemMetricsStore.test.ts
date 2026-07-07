import { describe, expect, it } from 'vitest';

import { PgSystemMetricsStore, type UpsertWorkspaceUsageInput } from '../runtime/systemMetricsStore.js';

interface RecordedQuery {
  text: string;
  values: unknown[];
}

function createFakePool() {
  const queries: RecordedQuery[] = [];
  const client = {
    async query(text: string, values: unknown[] = []) {
      queries.push({ text, values });
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const pool = {
    queries,
    async connect() {
      return client;
    },
    async query(text: string, values: unknown[] = []) {
      queries.push({ text, values });
      if (text.includes('count(*)::text AS count')) {
        return { rows: [{ count: '7' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    async end() {},
  };
  return pool;
}

function record(path: string, bytes: number): UpsertWorkspaceUsageInput {
  return {
    path,
    tenantId: path.split('/')[0] ?? '',
    userId: path.split('/')[1] ?? null,
    status: 'active',
    bytes,
    fileCount: null,
    scannedAt: new Date('2026-07-07T00:00:00.000Z'),
  };
}

describe('PgSystemMetricsStore.upsertWorkspaceUsage', () => {
  it('deletes rows missing from a full (non-partial) round', async () => {
    const pool = createFakePool();
    const store = new PgSystemMetricsStore({ pool: pool as never });

    await store.upsertWorkspaceUsage([record('kaiyan/u1', 10)], new Date(), { durationMs: 5 }, { partial: false });

    const deletes = pool.queries.filter((query) => query.text.includes(`DELETE FROM ${store.workspaceUsageTable}`));
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.text).toContain('WHERE NOT (path = ANY($1::text[]))');
    expect(deletes[0]!.values).toEqual([['kaiyan/u1']]);
  });

  it('FIX-1 regression: partial rounds only upsert and never delete missing paths', async () => {
    const pool = createFakePool();
    const store = new PgSystemMetricsStore({ pool: pool as never });

    await store.upsertWorkspaceUsage([record('kaiyan/u1', 10)], new Date(), { durationMs: 5, partial: true }, { partial: true });

    const deletes = pool.queries.filter((query) => query.text.includes(`DELETE FROM ${store.workspaceUsageTable}`));
    expect(deletes).toHaveLength(0);
    const upserts = pool.queries.filter((query) => query.text.includes(`INSERT INTO ${store.workspaceUsageTable}`));
    expect(upserts).toHaveLength(1);
  });

  it('FIX-4 regression: -1 bytes survive to the insert values and totals exclude them', async () => {
    const pool = createFakePool();
    const store = new PgSystemMetricsStore({ pool: pool as never });

    await store.upsertWorkspaceUsage(
      [record('kaiyan/u1', -1), record('kaiyan/u2', 10.9), record('kaiyan/u3', -5)],
      new Date('2026-07-07T00:00:00.000Z'),
    );

    const upserts = pool.queries.filter((query) => query.text.includes(`INSERT INTO ${store.workspaceUsageTable}`));
    expect(upserts.map((query) => query.values[4])).toEqual([-1, 10, -1]);

    const scanMetric = pool.queries.find((query) => query.text.includes(`INSERT INTO ${store.systemMetricsTable}`));
    expect(scanMetric?.values[0]).toBe(10);
  });

  it('counts workspace usage rows', async () => {
    const pool = createFakePool();
    const store = new PgSystemMetricsStore({ pool: pool as never });

    await expect(store.countWorkspaceUsage()).resolves.toBe(7);
  });
});
