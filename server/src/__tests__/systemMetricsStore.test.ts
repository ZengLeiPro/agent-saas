import { describe, expect, it } from 'vitest';

import {
  PgSystemMetricsStore,
  type UpsertWorkspaceUsageInput,
} from '../runtime/systemMetricsStore.js';

interface RecordedQuery {
  text: string;
  values: unknown[];
}

function createFakePool() {
  const queries: RecordedQuery[] = [];
  const client = {
    async query(text: string, values: unknown[] = []) {
      queries.push({ text, values });
      if (text.includes('pg_try_advisory_xact_lock')) {
        return { rows: [{ locked: true }], rowCount: 1 };
      }
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

describe('PgSystemMetricsStore', () => {
  // Retention 状态与容量都复用本 Store；测试确保不会靠进程内内存维持关键时间点。
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

  it('creates an index for bounded retention status authority reads', async () => {
    const pool = createFakePool();
    const store = new PgSystemMetricsStore({ pool: pool as never });

    await store.init();

    const index = pool.queries.find((query) => query.text.includes('_retention_status_id_idx'));
    expect(index?.text).toContain(`ON ${store.systemMetricsTable} (id DESC)`);
    expect(index?.text).toContain("WHERE metric = 'runtime_event_retention' AND label = 'status'");
  });

  it('updates one indexed status row and keeps lastSuccessAt monotonic without JSON history sorting', async () => {
    const pool = createFakePool();
    (pool as any).connect = async () => ({
      async query(text: string, values: unknown[] = []) {
        pool.queries.push({ text, values });
        if (text.includes('pg_try_advisory_xact_lock')) {
          return { rows: [{ locked: true }], rowCount: 1 };
        }
        if (text.includes('SELECT id, metric, label')
          && text.includes("WHERE metric = 'runtime_event_retention' AND label = 'status'")) {
          return {
            rows: [{
              id: 1,
              metric: 'runtime_event_retention',
              label: 'status',
              value_num: 10,
              detail_json: { lastSuccessAt: '2026-08-29T12:00:00.000Z' },
              sampled_at: '2026-08-29T12:00:00.000Z',
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 1 };
      },
      release() {},
    });
    const store = new PgSystemMetricsStore({ pool: pool as never });

    await store.recordRuntimeEventRetentionStatus({
      schemaVersion: 1,
      state: 'failed',
      mode: 'execute',
      sweepIntervalMinutes: 10,
      lastStartedAt: '2026-08-29T13:00:00.000Z',
      lastCompletedAt: '2026-08-29T13:00:01.000Z',
      lastSuccessAt: '2026-08-29T11:00:00.000Z',
      durationMs: 1000,
      errorCategory: 'execution_failed',
      nextScheduledAt: null,
      watermarks: { legal: '10', billing: null, effectiveDeleteThrough: null },
      maxGlobalSequence: null,
      categories: {},
    });

    const authorityRead = pool.queries.find((query) => query.text.includes('FOR UPDATE'));
    const update = pool.queries.find((query) => query.text.includes(`UPDATE ${store.systemMetricsTable}`));
    const compact = pool.queries.find((query) => query.text.includes(`DELETE FROM ${store.systemMetricsTable}`));
    expect(authorityRead?.text).toContain('ORDER BY id DESC');
    expect(authorityRead?.text).not.toContain("detail_json->>'lastSuccessAt'");
    expect(JSON.parse(String(update?.values[1]))).toMatchObject({
      state: 'failed',
      lastSuccessAt: '2026-08-29T12:00:00.000Z',
      errorCategory: 'execution_failed',
    });
    expect(update?.text).toContain('sampled_at = clock_timestamp()');
    expect(compact?.text).toContain("label = 'status' AND id <> $1");
    expect(store.isRuntimeEventRetentionStatusAvailable()).toBe(true);
    expect(pool.queries.some((query) => query.text.includes('pg_try_advisory_xact_lock'))).toBe(true);
  });

  it('marks status unavailable without writes when the retention authority lock is unavailable', async () => {
    const pool = createFakePool();
    (pool as any).connect = async () => ({
      async query(text: string, values: unknown[] = []) {
        pool.queries.push({ text, values });
        if (text.includes('pg_try_advisory_xact_lock')) {
          return { rows: [{ locked: false }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release() {},
    });
    const store = new PgSystemMetricsStore({ pool: pool as never });

    await expect(store.recordRuntimeEventRetentionStatus({
      schemaVersion: 1,
      state: 'scheduled',
      mode: 'execute',
      sweepIntervalMinutes: 10,
      lastStartedAt: null,
      lastCompletedAt: null,
      lastSuccessAt: null,
      durationMs: null,
      errorCategory: null,
      nextScheduledAt: '2026-08-29T13:10:00.000Z',
      watermarks: { legal: '10', billing: null, effectiveDeleteThrough: null },
      maxGlobalSequence: null,
      categories: {},
    })).rejects.toThrow('status lock unavailable');
    expect(store.isRuntimeEventRetentionStatusAvailable()).toBe(false);
    expect(pool.queries.some((query) => query.text === 'ROLLBACK')).toBe(true);
    expect(pool.queries.some((query) => /INSERT INTO|UPDATE/.test(query.text))).toBe(false);
  });

  it('marks status persistence unavailable when connection acquisition fails and recovers after a successful retry', async () => {
    const pool = createFakePool();
    const connect = pool.connect.bind(pool);
    let databaseAvailable = false;
    (pool as any).connect = async () => {
      if (!databaseAvailable) throw new Error('db down');
      return connect();
    };
    const store = new PgSystemMetricsStore({ pool: pool as never });
    const snapshot = {
      schemaVersion: 1 as const,
      state: 'scheduled' as const,
      mode: 'execute' as const,
      sweepIntervalMinutes: 10,
      lastStartedAt: null,
      lastCompletedAt: null,
      lastSuccessAt: null,
      durationMs: null,
      errorCategory: null,
      nextScheduledAt: '2026-08-29T13:10:00.000Z',
      watermarks: { legal: '10', billing: null, effectiveDeleteThrough: null },
      maxGlobalSequence: null,
      categories: {},
    };

    await expect(store.recordRuntimeEventRetentionStatus(snapshot)).rejects.toThrow('db down');
    expect(store.isRuntimeEventRetentionStatusAvailable()).toBe(false);
    expect(pool.queries).toEqual([]);

    databaseAvailable = true;
    await expect(store.recordRuntimeEventRetentionStatus(snapshot)).resolves.toBeUndefined();
    expect(store.isRuntimeEventRetentionStatusAvailable()).toBe(true);
    expect(pool.queries.some((query) => query.text.includes('pg_try_advisory_xact_lock'))).toBe(true);
  });

  it('preserves the latest retention status while pruning ordinary expired series', async () => {
    const pool = createFakePool();
    const store = new PgSystemMetricsStore({ pool: pool as never });

    await store.pruneSystemMetrics(90);

    const query = pool.queries.find((item) => item.text.includes(`DELETE FROM ${store.systemMetricsTable}`));
    expect(query?.text).toContain("expired.metric = 'runtime_event_retention'");
    expect(query?.text).toContain('SELECT latest.id');
    expect(query?.text).toContain('ORDER BY latest.id DESC');
    expect(query?.values).toEqual([90]);
  });

  it('reads a metric series with index-leading metric and label predicates', async () => {
    const pool = createFakePool();
    const store = new PgSystemMetricsStore({ pool: pool as never });

    await store.listMetricSeries('pg_table_size', 'runtime_events', 720);

    const query = pool.queries.at(-1)!;
    expect(query.text).toContain('WHERE metric = $1 AND label = $2');
    expect(query.text).toContain("sampled_at >= now() - ($3::int * interval '1 hour')");
    expect(query.text).toContain('ORDER BY sampled_at DESC, id DESC');
    expect(query.values).toEqual(['pg_table_size', 'runtime_events', 720]);
  });

  it('samples separate table/index/total bytes for each PG table', async () => {
    const pool = createFakePool();
    (pool as any).query = async (text: string, values: unknown[] = []) => {
      pool.queries.push({ text, values });
      return {
        rows: [{ table_name: 'runtime_events', table_bytes: '10', index_bytes: '4', total_bytes: '14' }],
        rowCount: 1,
      };
    };
    const store = new PgSystemMetricsStore({ pool: pool as never });

    await expect(store.queryPgRuntimeTableSizes('Runtime')).resolves.toEqual([{
      table: 'runtime_events', tableBytes: 10, indexBytes: 4, totalBytes: 14,
    }]);
    expect(pool.queries.at(-1)?.text).toContain('pg_table_size');
    expect(pool.queries.at(-1)?.text).toContain('pg_indexes_size');
    expect(pool.queries.at(-1)?.text).toContain('pg_total_relation_size');
    expect(pool.queries.at(-1)?.values).toEqual(['runtime_%']);
  });
});
