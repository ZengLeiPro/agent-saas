import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

import {
  RuntimeEventRetention,
  type RuntimeEventRetentionStatusSnapshot,
} from '../runtime/runtimeEventRetention.js';
import { PgSystemMetricsStore } from '../runtime/systemMetricsStore.js';

const { Pool } = pg;
const testPgUrl = process.env.TEST_DATABASE_URL?.trim();
const describePg = testPgUrl ? describe : describe.skip;

describePg('RuntimeEventRetention 状态与 authority PostgreSQL 集成', () => {

  const prefix = `retention_status_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const eventsTable = `${prefix}_events`;
  const toolInvocationsTable = `${prefix}_tool_invocations`;
  const billingProjectionStateTable = `${prefix}_billing_projection_state`;
  let pool: InstanceType<typeof Pool>;
  let metricsStore: PgSystemMetricsStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: testPgUrl!, connectionTimeoutMillis: 5_000, max: 4 });
    await pool.query(`
      CREATE TABLE ${eventsTable} (
        global_sequence BIGSERIAL PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        run_id TEXT,
        event_type TEXT NOT NULL,
        event_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE ${toolInvocationsTable} (
        tenant_id TEXT NOT NULL,
        invocation_id TEXT NOT NULL,
        status TEXT NOT NULL,
        completed_at TIMESTAMPTZ,
        PRIMARY KEY (tenant_id, invocation_id)
      );
      CREATE TABLE ${billingProjectionStateTable} (
        key TEXT PRIMARY KEY,
        last_global_sequence BIGINT NOT NULL
      );
      INSERT INTO ${billingProjectionStateTable} (key, last_global_sequence) VALUES ('runtime_events', 0);
    `);
    metricsStore = new PgSystemMetricsStore({ pool, tablePrefix: prefix });
    await metricsStore.init();
  }, 30_000);

  afterAll(async () => {
    if (!pool) return;
    try {
      await pool.query(`
        DROP TABLE IF EXISTS ${metricsStore.workspaceUsageTable} CASCADE;
        DROP TABLE IF EXISTS ${metricsStore.systemMetricsTable} CASCADE;
        DROP TABLE IF EXISTS ${billingProjectionStateTable} CASCADE;
        DROP TABLE IF EXISTS ${toolInvocationsTable} CASCADE;
        DROP TABLE IF EXISTS ${eventsTable} CASCADE;
      `);
    } finally {
      await pool.end();
    }
  });

  it('持久化首次 dry-run、execute、门禁阻断、部分失败、恢复和重复运行', async () => {
    expect(await metricsStore.getLatestMetric('runtime_event_retention', 'status')).toBeNull();

    const dryRun = createRetention(pool);
    await dryRun.runOnce();
    const dryRunSuccessAt = (await latestDetail()).lastSuccessAt;
    expect((await latestDetail()).state).toBe('dry_run_succeeded');

    const restartedExecute = createRetention(pool, {
      enabled: true,
      executionMode: 'execute',
      legalDeleteThroughGlobalSequence: '100',
      authorizationRef: 'CHG-test',
      sweepIntervalMinutes: 30,
    });
    await restartedExecute.start();
    expect(await latestDetail()).toMatchObject({
      state: 'scheduled',
      mode: 'execute',
      sweepIntervalMinutes: 30,
      lastSuccessAt: dryRunSuccessAt,
      nextScheduledAt: expect.any(String),
    });
    await restartedExecute.runOnce();
    await restartedExecute.runOnce();
    const executeSuccessAt = (await latestDetail()).lastSuccessAt;
    expect((await latestDetail()).state).toBe('execute_succeeded');
    restartedExecute.stop();

    const restartedDryRun = createRetention(pool, {
      enabled: true,
      sweepIntervalMinutes: 5,
    });
    await restartedDryRun.start();
    expect(await latestDetail()).toMatchObject({
      state: 'scheduled',
      mode: 'dry-run',
      sweepIntervalMinutes: 5,
      lastSuccessAt: executeSuccessAt,
      nextScheduledAt: expect.any(String),
    });
    restartedDryRun.stop();

    const blocked = createRetention(pool, {
      enabled: true,
      executionMode: 'execute',
      legalDeleteThroughGlobalSequence: '100',
    });
    await blocked.start();
    expect(await latestDetail()).toMatchObject({
      state: 'blocked',
      errorCategory: 'authorization_missing',
      lastSuccessAt: expect.any(String),
    });
    blocked.stop();

    await pool.query(`
      INSERT INTO ${eventsTable} (tenant_id, session_id, run_id, event_type, timestamp) VALUES
        ('tenant-a', 'session-a', 'run-a', 'assistant_stream_event', now() - interval '1 hour'),
        ('tenant-a', 'session-a', 'run-a', 'assistant_stream_event', now() - interval '1 hour'),
        ('tenant-a', 'session-a', 'run-a', 'run_finished', now() - interval '1 hour');
      UPDATE ${billingProjectionStateTable}
      SET last_global_sequence = (SELECT max(global_sequence) FROM ${eventsTable})
      WHERE key = 'runtime_events';
    `);
    let assistantDeleteCalls = 0;
    const partialPool = {
      query: async (text: string, params?: unknown[]) => {
        if (text.includes('retention:assistant-stream') && ++assistantDeleteCalls === 2) {
          throw new Error('injected database failure');
        }
        return pool.query(text, params);
      },
    };
    const recoverable = createRetention(partialPool as unknown as InstanceType<typeof Pool>, {
      enabled: true,
      executionMode: 'execute',
      legalDeleteThroughGlobalSequence: '100',
      authorizationRef: 'CHG-test',
      batchLimit: 1,
    });
    await recoverable.start();
    await expect(recoverable.runOnce()).rejects.toThrow('injected database failure');
    expect(await latestDetail()).toMatchObject({
      state: 'failed',
      errorCategory: 'partial_failure',
      categories: { 'assistant-stream': { eligible: 1, deleted: 1 } },
    });
    expect(await countAssistantStreamEvents()).toBe(1);
    await recoverable.runOnce();
    expect((await latestDetail()).state).toBe('execute_succeeded');
    expect(await countAssistantStreamEvents()).toBe(0);
    recoverable.stop();
  });

  it('删除当前最高序号后下一轮仍发布成功状态且 lag 语义为零', async () => {
    await pool.query(`DELETE FROM ${metricsStore.systemMetricsTable}; DELETE FROM ${eventsTable}`);
    const inserted = await pool.query<{ global_sequence: string }>(
      `INSERT INTO ${eventsTable} (tenant_id, session_id, run_id, event_type, timestamp)
       VALUES ('tenant-clean', 'session-clean', 'run-clean', 'model_request_finished', now() - interval '31 days')
       RETURNING global_sequence::text`,
    );
    const sequence = inserted.rows[0]!.global_sequence;
    await pool.query(
      `UPDATE ${billingProjectionStateTable} SET last_global_sequence = $1 WHERE key = 'runtime_events'`,
      [sequence],
    );
    const retention = createRetention(pool, {
      executionMode: 'execute',
      legalDeleteThroughGlobalSequence: sequence,
      authorizationRef: 'CHG-clean',
    });

    expect((await retention.runOnce()).deleted).toBe(1);
    const next = await retention.runOnce();
    expect(next).toMatchObject({
      billingWatermark: sequence,
      effectiveDeleteThrough: sequence,
      maxGlobalSequence: '0',
    });
    expect(await latestDetail()).toMatchObject({
      state: 'execute_succeeded',
      watermarks: { billing: sequence, effectiveDeleteThrough: sequence },
      maxGlobalSequence: '0',
    });
  });

  it('状态锁被占用时启动有界降级，释放后可重试且不触发 retention 副作用', async () => {
    await pool.query(`DELETE FROM ${metricsStore.systemMetricsTable}`);
    const lockHolder = await pool.connect();
    await lockHolder.query('BEGIN');
    await lockHolder.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [`${metricsStore.systemMetricsTable}:retention-status`],
    );
    let projectionCalls = 0;
    const retention = createRetention(pool, {
      enabled: true,
      executionMode: 'execute',
      legalDeleteThroughGlobalSequence: '100',
      authorizationRef: 'CHG-test',
      projectBillingRuntimeEvents: async () => {
        projectionCalls += 1;
        return { lastProjectedSequence: 0 };
      },
    });
    try {
      const start = retention.start();
      const startedWithinBound = await Promise.race([
        start.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
      ]);
      expect(startedWithinBound).toBe(true);
      expect(retention.isStatusPersistenceAvailable()).toBe(false);
      expect(metricsStore.isRuntimeEventRetentionStatusAvailable()).toBe(false);
      expect(projectionCalls).toBe(0);
      expect(await metricsStore.getLatestMetric('runtime_event_retention', 'status')).toBeNull();
    } finally {
      await lockHolder.query('COMMIT');
      lockHolder.release();
    }

    await retention.start();
    expect(retention.isStatusPersistenceAvailable()).toBe(true);
    expect(metricsStore.isRuntimeEventRetentionStatusAvailable()).toBe(true);
    expect(await latestDetail()).toMatchObject({ state: 'scheduled' });
    expect(projectionCalls).toBe(0);
    retention.stop();
  }, 10_000);

  it('按实际获锁顺序发布同一 authority 状态，并在裁剪和重启后保持 lastSuccessAt 单调', async () => {
    await pool.query(`DELETE FROM ${metricsStore.systemMetricsTable}`);
    const newerSuccess = statusSnapshot();
    const olderFailure = statusSnapshot({
      state: 'failed',
      lastStartedAt: '2026-08-29T11:00:00.000Z',
      lastCompletedAt: '2026-08-29T11:00:01.000Z',
      lastSuccessAt: '2026-08-29T11:00:01.000Z',
      errorCategory: 'execution_failed',
    });
    let announceLockWait!: () => void;
    let resumeLock!: () => void;
    const lockWaitStarted = new Promise<void>((resolve) => { announceLockWait = resolve; });
    const lockCanContinue = new Promise<void>((resolve) => { resumeLock = resolve; });
    const delayedPool = {
      async connect() {
        const client = await pool.connect();
        const query = client.query.bind(client) as unknown as (
          text: string,
          values?: unknown[],
        ) => Promise<unknown>;
        return {
          async query(text: string, values: unknown[] = []) {
            if (text.includes('pg_try_advisory_xact_lock')) {
              announceLockWait();
              await lockCanContinue;
            }
            return query(text, values);
          },
          release: () => client.release(),
        };
      },
    };
    const delayedStore = new PgSystemMetricsStore({
      pool: delayedPool as unknown as InstanceType<typeof Pool>,
      tablePrefix: prefix,
    });
    const delayedWrite = delayedStore.recordRuntimeEventRetentionStatus(newerSuccess);
    await lockWaitStarted;
    try {
      await metricsStore.recordRuntimeEventRetentionStatus(olderFailure);
      expect(await latestDetail()).toMatchObject({
        state: 'failed',
        lastSuccessAt: olderFailure.lastSuccessAt,
      });
    } finally {
      resumeLock();
    }
    await delayedWrite;

    expect(await latestDetail()).toMatchObject({
      state: 'execute_succeeded',
      lastSuccessAt: newerSuccess.lastSuccessAt,
    });
    const singleton = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${metricsStore.systemMetricsTable}
       WHERE metric = 'runtime_event_retention' AND label = 'status'`,
    );
    expect(singleton.rows[0]?.count).toBe('1');

    await metricsStore.insertMetric({ metric: 'disk_root', valueNum: 1, sampledAt: new Date('2000-01-01T00:00:00.000Z') });
    await pool.query(`UPDATE ${metricsStore.systemMetricsTable} SET sampled_at = '2000-01-01T00:00:00.000Z'`);
    expect(await metricsStore.pruneSystemMetrics(90)).toBeGreaterThan(0);
    expect(await latestDetail()).toMatchObject({ lastSuccessAt: newerSuccess.lastSuccessAt });

    const restartedStore = new PgSystemMetricsStore({ pool, tablePrefix: prefix });
    await restartedStore.recordRuntimeEventRetentionStatus({ ...olderFailure, lastSuccessAt: null });
    expect(await latestDetail()).toMatchObject({
      state: 'failed',
      lastSuccessAt: newerSuccess.lastSuccessAt,
    });
  });

  it('拒绝 retiring worker 在候选 claim 后迟到覆盖状态', async () => {
    await pool.query(`DELETE FROM ${metricsStore.systemMetricsTable}`);
    const oldAuthority = { writerId: 'worker-old', claim: true };
    const candidateAuthority = { writerId: 'worker-candidate', claim: true };
    await metricsStore.recordRuntimeEventRetentionStatus(statusSnapshot({ state: 'scheduled', authority: oldAuthority }));

    let announceOldWrite!: () => void;
    let resumeOldWrite!: () => void;
    const oldWriteStarted = new Promise<void>((resolve) => { announceOldWrite = resolve; });
    const oldWriteCanContinue = new Promise<void>((resolve) => { resumeOldWrite = resolve; });
    const delayedPool = {
      async connect() {
        const client = await pool.connect();
        return {
          async query(text: string, values: unknown[] = []) {
            if (text.includes('pg_try_advisory_xact_lock')) {
              announceOldWrite();
              await oldWriteCanContinue;
            }
            return client.query(text, values);
          },
          release: () => client.release(),
        };
      },
    };
    const retiringStore = new PgSystemMetricsStore({
      pool: delayedPool as unknown as InstanceType<typeof Pool>,
      tablePrefix: prefix,
    });
    const lateWrite = retiringStore.recordRuntimeEventRetentionStatus(statusSnapshot({
      state: 'failed',
      errorCategory: 'execution_failed',
      authority: { ...oldAuthority, claim: false },
    }));
    await oldWriteStarted;
    await metricsStore.recordRuntimeEventRetentionStatus(statusSnapshot({ state: 'scheduled', authority: candidateAuthority }));
    resumeOldWrite();

    await expect(lateWrite).rejects.toThrow('authority superseded');
    expect(retiringStore.isRuntimeEventRetentionStatusAvailable()).toBe(false);
    expect(await latestDetail()).toMatchObject({
      state: 'scheduled',
      authority: candidateAuthority,
    });
  });

  it('首次 bootstrap 回滚时旧 all 可重新 claim，候选停止后不能再覆盖', async () => {
    await pool.query(`DELETE FROM ${metricsStore.systemMetricsTable}`);
    const oldAll = createRetention(pool, { enabled: true });
    const candidate = createRetention(pool, { enabled: true });

    await oldAll.start();
    const oldWriterId = ((await latestDetail()).authority as { writerId: string }).writerId;
    await candidate.start();
    const candidateWriterId = ((await latestDetail()).authority as { writerId: string }).writerId;
    expect(candidateWriterId).not.toBe(oldWriterId);

    await oldAll.reassertStatusAuthority(true);
    expect(await latestDetail()).toMatchObject({
      authority: { writerId: oldWriterId, claim: true },
    });
    await expect(candidate.reassertStatusAuthority()).rejects.toThrow('failed to reassert status authority');
    expect(candidate.isStatusPersistenceAvailable()).toBe(false);
    expect(await latestDetail()).toMatchObject({ authority: { writerId: oldWriterId } });

    candidate.stop();
    oldAll.stop();
  });

  it('从长历史按索引权威行合并并收敛为单例，不执行 JSON 历史排序', async () => {
    await pool.query(`DELETE FROM ${metricsStore.systemMetricsTable}`);
    await pool.query(`
      INSERT INTO ${metricsStore.systemMetricsTable}
        (metric, label, value_num, detail_json, sampled_at)
      SELECT 'runtime_event_retention', 'status', 0,
             jsonb_build_object(
               'lastSuccessAt', CASE WHEN sequence = 128
                 THEN '2026-08-29T12:00:01.000Z'
                 ELSE '2026-08-29T11:00:01.000Z'
               END
             ),
             timestamptz '2026-08-29T12:00:00.000Z' - (sequence * interval '1 minute')
      FROM generate_series(1, 128) AS history(sequence)
      ORDER BY sequence
    `);
    expect(await latestDetail()).toMatchObject({ lastSuccessAt: '2026-08-29T12:00:01.000Z' });

    await metricsStore.recordRuntimeEventRetentionStatus(statusSnapshot({
      state: 'failed',
      lastSuccessAt: '2026-08-29T11:00:01.000Z',
      errorCategory: 'execution_failed',
    }));

    const remaining = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${metricsStore.systemMetricsTable}
       WHERE metric = 'runtime_event_retention' AND label = 'status'`,
    );
    expect(remaining.rows[0]?.count).toBe('1');
    expect(await latestDetail()).toMatchObject({
      state: 'failed',
      lastSuccessAt: '2026-08-29T12:00:01.000Z',
    });
  });

  it('非法未来 lastSuccessAt 可被同一权威 writer 的当前成功时间纠正', async () => {
    await pool.query(`DELETE FROM ${metricsStore.systemMetricsTable}`);
    const authority = { writerId: 'worker-current', claim: true };
    await metricsStore.recordRuntimeEventRetentionStatus(statusSnapshot({
      lastStartedAt: '2099-01-01T00:00:00.000Z',
      lastCompletedAt: '2099-01-01T00:00:01.000Z',
      lastSuccessAt: '2099-01-01T00:00:01.000Z',
      authority,
    }));

    await metricsStore.recordRuntimeEventRetentionStatus(statusSnapshot({
      authority: { ...authority, claim: false },
    }));
    expect(await latestDetail()).toMatchObject({
      state: 'execute_succeeded',
      lastSuccessAt: '2026-08-29T12:00:01.000Z',
      authority: { writerId: authority.writerId, claim: false },
    });
  });

  function statusSnapshot(
    overrides: Partial<RuntimeEventRetentionStatusSnapshot> = {},
  ): RuntimeEventRetentionStatusSnapshot {
    return {
      schemaVersion: 1,
      state: 'execute_succeeded',
      mode: 'execute',
      sweepIntervalMinutes: 10,
      lastStartedAt: '2026-08-29T12:00:00.000Z',
      lastCompletedAt: '2026-08-29T12:00:01.000Z',
      lastSuccessAt: '2026-08-29T12:00:01.000Z',
      durationMs: 1000,
      errorCategory: null,
      nextScheduledAt: null,
      watermarks: { legal: '100', billing: '100', effectiveDeleteThrough: '100' },
      maxGlobalSequence: '100',
      categories: {},
      ...overrides,
    };
  }

  function createRetention(
    retentionPool: InstanceType<typeof Pool>,
    overrides: Partial<ConstructorParameters<typeof RuntimeEventRetention>[0]> = {},
  ) {
    return new RuntimeEventRetention({
      pool: retentionPool,
      eventsTable,
      toolInvocationsTable,
      billingProjectionStateTable,
      legalDeleteThroughGlobalSequence: '100',
      statusRecorder: (snapshot) => metricsStore.recordRuntimeEventRetentionStatus(snapshot),
      ...overrides,
    });
  }

  async function countAssistantStreamEvents(): Promise<number> {
    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${eventsTable} WHERE event_type = 'assistant_stream_event'`,
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async function latestDetail(): Promise<Record<string, unknown>> {
    const latest = await metricsStore.getLatestMetric('runtime_event_retention', 'status');
    expect(latest?.detailJson).toBeTruthy();
    return latest!.detailJson!;
  }
});
