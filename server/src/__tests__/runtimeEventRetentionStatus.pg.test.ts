import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

import { RuntimeEventRetention } from '../runtime/runtimeEventRetention.js';
import { PgSystemMetricsStore } from '../runtime/systemMetricsStore.js';

const { Pool } = pg;
const testPgUrl = process.env.TEST_DATABASE_URL?.trim();
const describePg = testPgUrl ? describe : describe.skip;

describePg('RuntimeEventRetention 状态 PostgreSQL 集成', () => {
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
    expect((await latestDetail()).state).toBe('dry_run_succeeded');

    const execute = createRetention(pool, {
      executionMode: 'execute',
      legalDeleteThroughGlobalSequence: '100',
      authorizationRef: 'CHG-test',
    });
    await execute.runOnce();
    await execute.runOnce();
    expect((await latestDetail()).state).toBe('execute_succeeded');

    const blocked = createRetention(pool, {
      executionMode: 'execute',
      legalDeleteThroughGlobalSequence: '100',
    });
    await expect(blocked.runOnce()).rejects.toThrow(/缺少授权/);
    expect(await latestDetail()).toMatchObject({
      state: 'blocked',
      errorCategory: 'authorization_missing',
      lastSuccessAt: expect.any(String),
    });

    let failAssistantStream = true;
    const partialPool = {
      query: async (text: string, params?: unknown[]) => {
        if (failAssistantStream && text.includes('retention:assistant-stream')) {
          failAssistantStream = false;
          throw new Error('injected database failure');
        }
        return pool.query(text, params);
      },
    };
    const recoverable = createRetention(partialPool as unknown as InstanceType<typeof Pool>, {
      executionMode: 'execute',
      legalDeleteThroughGlobalSequence: '100',
      authorizationRef: 'CHG-test',
    });
    await expect(recoverable.runOnce()).rejects.toThrow('injected database failure');
    expect(await latestDetail()).toMatchObject({ state: 'failed', errorCategory: 'partial_failure' });
    await recoverable.runOnce();
    expect((await latestDetail()).state).toBe('execute_succeeded');
  });

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

  async function latestDetail(): Promise<Record<string, unknown>> {
    const latest = await metricsStore.getLatestMetric('runtime_event_retention', 'status');
    expect(latest?.detailJson).toBeTruthy();
    return latest!.detailJson!;
  }
});
