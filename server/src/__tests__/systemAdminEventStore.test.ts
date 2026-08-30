import type { Server } from 'node:http';

import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSystemAdminRouter } from '../routes/systemAdmin.js';
import type { PgSystemMetricsStore, SystemMetricRecord } from '../runtime/systemMetricsStore.js';

const ADMIN = { sub: 'admin1', role: 'admin', tenantId: 'pantheon' };
const NON_PLATFORM_ADMIN = { sub: 'user1', role: 'admin', tenantId: 'tenant-a' };

async function startServer(options: {
  user?: unknown;
  store?: unknown;
  getRuntimeWorkerAdmissionSnapshot?: () => { state: 'healthy' | 'paused'; admitting: boolean };
}) {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { user: unknown }).user = options.user ?? ADMIN;
    next();
  });
  app.use('/api/admin/system', createSystemAdminRouter({
    agentCwd: '/workspace',
    systemMetricsStore: options.store as PgSystemMetricsStore | undefined,
    runtimeEventRetention: { enabled: true, executionMode: 'execute', sweepIntervalMinutes: 10 },
    getRuntimeWorkerAdmissionSnapshot: options.getRuntimeWorkerAdmissionSnapshot,
    eventsTable: 'runtime_events',
  }));
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  const baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
  return {
    get: (query = '') => fetch(`${baseUrl}/api/admin/system/event-store${query}`),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function metric(overrides: Partial<SystemMetricRecord>): SystemMetricRecord {
  return {
    id: 1,
    metric: 'pg_table_size',
    label: 'runtime_events',
    valueNum: 140,
    detailJson: { tableBytes: 100, indexBytes: 40, totalBytes: 140 },
    sampledAt: new Date().toISOString(),
    ...overrides,
  };
}

function retentionCategories(
  overrides: Record<string, { eligible: number; deleted: number }> = {},
): Record<string, { eligible: number; deleted: number }> {
  return {
    'tool-delta': { eligible: 2, deleted: 2 },
    'assistant-stream': { eligible: 0, deleted: 0 },
    'tool-stream-summary': { eligible: 0, deleted: 0 },
    'model-diagnostics': { eligible: 0, deleted: 0 },
    'model-request-finished': { eligible: 0, deleted: 0 },
    'hand-events': { eligible: 0, deleted: 0 },
    ...overrides,
  };
}

function retentionDetail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    state: 'execute_succeeded',
    mode: 'execute',
    sweepIntervalMinutes: 10,
    lastStartedAt: '2026-08-29T14:00:00.000Z',
    lastCompletedAt: '2026-08-29T14:00:00.025Z',
    lastSuccessAt: '2026-08-29T14:00:00.025Z',
    durationMs: 25,
    errorCategory: null,
    nextScheduledAt: '2026-08-29T14:10:00.000Z',
    watermarks: { legal: '20', billing: '18', effectiveDeleteThrough: '18' },
    maxGlobalSequence: '22',
    categories: retentionCategories(),
    ...overrides,
  };
}

describe('GET /api/admin/system/event-store', () => {

  const servers: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => Promise.all(servers.splice(0).map((server) => server.close())));

  it('keeps the platform-admin gate', async () => {
    const server = await startServer({ user: NON_PLATFORM_ADMIN, store: {} });
    servers.push(server);
    expect((await server.get()).status).toBe(403);
  });

  it('returns unavailable with nulls when the store is absent', async () => {
    const server = await startServer({});
    servers.push(server);
    const body = await (await server.get()).json() as any;
    expect(body).toMatchObject({
      schemaVersion: 1,
      available: false,
      retention: {
        status: 'unavailable',
        lastSuccessAt: null,
        categories: {},
        watermarks: { legal: null, billing: null, effective: null, maxGlobalSequence: null, lag: null },
      },
      capacity: { available: false, totalBytes: null, tableBytes: null, indexBytes: null, series: [] },
    });
  });

  it('keeps a fresh old success unavailable after startup persistence failure until a successful retry', async () => {
    const retention = metric({
      metric: 'runtime_event_retention',
      label: 'status',
      detailJson: retentionDetail(),
    });
    const capacity = metric({});
    let statusAvailable = false;
    const store = {
      getLatestMetric: vi.fn(async (name: string) => name === 'runtime_event_retention' ? retention : capacity),
      listMetricSeries: vi.fn(async () => [capacity]),
      isRuntimeEventRetentionStatusAvailable: () => statusAvailable,
    };
    const server = await startServer({ store });
    servers.push(server);

    expect(await (await server.get()).json()).toMatchObject({
      available: true,
      retention: { status: 'unavailable', stale: false },
      capacity: { available: true, totalBytes: 140 },
    });

    statusAvailable = true;
    expect(await (await server.get()).json()).toMatchObject({
      retention: { status: 'execute_succeeded', stale: false },
    });
  });

  it('uses active runtime-worker readiness instead of the API Store local availability flag', async () => {
    const retention = metric({
      metric: 'runtime_event_retention',
      label: 'status',
      detailJson: retentionDetail(),
    });
    const capacity = metric({});
    let workerReady = false;
    const store = {
      getLatestMetric: vi.fn(async (name: string) => name === 'runtime_event_retention' ? retention : capacity),
      listMetricSeries: vi.fn(async () => [capacity]),
      isRuntimeEventRetentionStatusAvailable: () => true,
    };
    const server = await startServer({
      store,
      getRuntimeWorkerAdmissionSnapshot: () => ({
        state: workerReady ? 'healthy' : 'paused',
        admitting: workerReady,
      }),
    });
    servers.push(server);

    expect(await (await server.get()).json()).toMatchObject({
      retention: { status: 'unavailable', stale: false },
      capacity: { available: true, totalBytes: 140 },
    });

    workerReady = true;
    expect(await (await server.get()).json()).toMatchObject({
      retention: { status: 'execute_succeeded', stale: false },
    });
  });

  it('serializes persisted retention and capacity series without querying live runtime_events', async () => {
    const retention = metric({
      metric: 'runtime_event_retention',
      label: 'status',
      valueNum: 25,
      detailJson: retentionDetail(),
    });
    const capacity = metric({});
    const store = {
      getLatestMetric: vi.fn(async (name: string) => name === 'runtime_event_retention' ? retention : capacity),
      listMetricSeries: vi.fn(async () => [capacity]),
    };
    const server = await startServer({ store });
    servers.push(server);
    const response = await server.get('?hours=48');
    const body = await response.json() as any;
    expect(response.status).toBe(200);
    expect(body.retention).toMatchObject({
      status: 'execute_succeeded',
      stale: false,
      durationMs: 25,
      watermarks: {
        legal: '20',
        billing: '18',
        effective: '18',
        maxGlobalSequence: '22',
        lag: '4',
      },
      categories: { 'tool-delta': { eligible: 2, deleted: 2 } },
    });
    expect(body.capacity).toMatchObject({
      available: true, tableName: 'runtime_events', totalBytes: 140, tableBytes: 100, indexBytes: 40,
    });
    expect(body.capacity.series).toEqual([expect.objectContaining({
      totalBytes: 140,
      tableBytes: 100,
      indexBytes: 40,
    })]);
    expect(store.listMetricSeries).toHaveBeenCalledWith('pg_table_size', 'runtime_events', 48);
    expect(JSON.stringify(body)).not.toContain('authorizationRef');
  });

  it('keeps a cleaned EventStore successful when current max is below monotonic watermarks', async () => {
    const retention = metric({
      metric: 'runtime_event_retention',
      label: 'status',
      detailJson: retentionDetail({
        watermarks: { legal: '100', billing: '100', effectiveDeleteThrough: '100' },
        maxGlobalSequence: '0',
      }),
    });
    const store = {
      getLatestMetric: vi.fn(async (name: string) => name === 'runtime_event_retention' ? retention : null),
      listMetricSeries: vi.fn(async () => []),
    };
    const server = await startServer({ store });
    servers.push(server);

    expect(await (await server.get()).json()).toMatchObject({
      retention: {
        status: 'execute_succeeded',
        watermarks: { billing: '100', effective: '100', maxGlobalSequence: '0', lag: '0' },
      },
    });
  });

  it.each([
    ['旧格式', { table: 'runtime_events' }],
    ['负数', { tableBytes: 100, indexBytes: -1, totalBytes: 99 }],
  ])('treats a fresh %s capacity sample as unavailable', async (_name, detailJson) => {
    const capacity = metric({ detailJson });
    const store = {
      getLatestMetric: vi.fn(async (name: string) => name === 'pg_table_size' ? capacity : null),
      listMetricSeries: vi.fn(async () => [capacity]),
    };
    const server = await startServer({ store });
    servers.push(server);

    expect(await (await server.get()).json()).toMatchObject({
      capacity: {
        available: false,
        totalBytes: null,
        tableBytes: null,
        indexBytes: null,
        sampledAt: null,
        series: [],
      },
    });
  });

  it('rejects a capacity snapshot sampled beyond the clock-skew allowance', async () => {
    const future = metric({ sampledAt: '2099-01-01T00:00:00.000Z' });
    const store = {
      getLatestMetric: vi.fn(async (name: string) => name === 'pg_table_size' ? future : null),
      listMetricSeries: vi.fn(async () => [future]),
    };
    const server = await startServer({ store });
    servers.push(server);

    expect(await (await server.get()).json()).toMatchObject({
      capacity: { available: false, sampledAt: null, stale: false, series: [] },
    });
  });

  it('drops future capacity series points while preserving a valid latest snapshot', async () => {
    const latest = metric({});
    const future = metric({ id: 2, sampledAt: '2099-01-01T00:00:00.000Z' });
    const store = {
      getLatestMetric: vi.fn(async (name: string) => name === 'pg_table_size' ? latest : null),
      listMetricSeries: vi.fn(async () => [latest, future]),
    };
    const server = await startServer({ store });
    servers.push(server);

    const body = await (await server.get()).json() as any;
    expect(body.capacity).toMatchObject({ available: true, sampledAt: latest.sampledAt });
    expect(body.capacity.series).toEqual([expect.objectContaining({ sampledAt: latest.sampledAt })]);
  });

  it('returns never-run with an unknown legal watermark when the store has no retention snapshot', async () => {
    const store = {
      getLatestMetric: vi.fn(async () => null),
      listMetricSeries: vi.fn(async () => []),
    };
    const server = await startServer({ store });
    servers.push(server);
    expect(await (await server.get()).json()).toMatchObject({
      available: true,
      retention: {
        enabled: true,
        status: 'never_run',
        stale: false,
        watermarks: { legal: null, billing: null, effective: null, maxGlobalSequence: null, lag: null },
        categories: {},
      },
    });
  });

  it('recovers from a future persisted success after the current writer publishes a valid success', async () => {
    let retention = metric({
      metric: 'runtime_event_retention',
      label: 'status',
      detailJson: retentionDetail({
        lastStartedAt: '2099-01-01T00:00:00.000Z',
        lastCompletedAt: '2099-01-01T00:00:01.000Z',
        lastSuccessAt: '2099-01-01T00:00:01.000Z',
        nextScheduledAt: '2099-01-01T00:10:00.000Z',
      }),
    });
    const store = {
      getLatestMetric: vi.fn(async (name: string) => name === 'runtime_event_retention' ? retention : null),
      listMetricSeries: vi.fn(async () => []),
    };
    const server = await startServer({ store });
    servers.push(server);

    expect(await (await server.get()).json()).toMatchObject({
      retention: { status: 'unavailable', stale: false },
    });

    retention = metric({ metric: 'runtime_event_retention', label: 'status', detailJson: retentionDetail() });
    expect(await (await server.get()).json()).toMatchObject({
      retention: { status: 'execute_succeeded', stale: false },
    });
  });

  it('serializes persisted never_run with its configured legal watermark', async () => {
    const retention = metric({
      metric: 'runtime_event_retention',
      label: 'status',
      detailJson: retentionDetail({
        state: 'never_run',
        lastStartedAt: null,
        lastCompletedAt: null,
        lastSuccessAt: null,
        durationMs: null,
        errorCategory: null,
        nextScheduledAt: null,
        watermarks: { legal: '20', billing: null, effectiveDeleteThrough: null },
        maxGlobalSequence: null,
        categories: {},
      }),
    });
    const store = {
      getLatestMetric: vi.fn(async (name: string) => name === 'runtime_event_retention' ? retention : null),
      listMetricSeries: vi.fn(async () => []),
    };
    const server = await startServer({ store });
    servers.push(server);

    expect(await (await server.get()).json()).toMatchObject({
      retention: {
        enabled: true,
        status: 'never_run',
        stale: false,
        lastSuccessAt: null,
        nextScheduledAt: null,
        watermarks: { legal: '20', billing: null, effective: null, maxGlobalSequence: null, lag: null },
        categories: {},
      },
    });
  });

  it('returns the current scheduled mode and schedule while preserving historical success time', async () => {
    const retention = metric({
      metric: 'runtime_event_retention',
      label: 'status',
      detailJson: retentionDetail({
        state: 'scheduled',
        lastStartedAt: null,
        lastCompletedAt: null,
        durationMs: null,
        errorCategory: null,
        watermarks: { legal: '20', billing: null, effectiveDeleteThrough: null },
        maxGlobalSequence: null,
        categories: {},
      }),
    });
    const store = {
      getLatestMetric: vi.fn(async (name: string) => name === 'runtime_event_retention' ? retention : null),
      listMetricSeries: vi.fn(async () => []),
    };
    const server = await startServer({ store });
    servers.push(server);

    expect(await (await server.get()).json()).toMatchObject({
      retention: {
        mode: 'execute',
        status: 'scheduled',
        stale: false,
        lastSuccessAt: '2026-08-29T14:00:00.025Z',
        nextScheduledAt: '2026-08-29T14:10:00.000Z',
      },
    });
  });

  it.each([
    ['never_run 携带旧成功时间', retentionDetail({
      state: 'never_run',
      lastStartedAt: null,
      lastCompletedAt: null,
      durationMs: null,
      errorCategory: null,
      nextScheduledAt: null,
      watermarks: { legal: '20', billing: null, effectiveDeleteThrough: null },
      maxGlobalSequence: null,
      categories: {},
    })],
    ['scheduled 携带进度水位', retentionDetail({
      state: 'scheduled',
      lastStartedAt: null,
      lastCompletedAt: null,
      durationMs: null,
      errorCategory: null,
      watermarks: { legal: '20', billing: '1', effectiveDeleteThrough: '1' },
      maxGlobalSequence: '1',
      categories: {},
    })],
    ['running 携带分类进度', retentionDetail({
      state: 'running',
      lastCompletedAt: null,
      durationMs: null,
      errorCategory: null,
      watermarks: { legal: '20', billing: null, effectiveDeleteThrough: null },
      maxGlobalSequence: null,
      categories: { 'tool-delta': { eligible: 1, deleted: 0 } },
    })],
  ])('fails closed for a fresh %s snapshot', async (_name, detailJson) => {
    const retention = metric({ metric: 'runtime_event_retention', label: 'status', detailJson });
    const store = {
      getLatestMetric: vi.fn(async (name: string) => name === 'runtime_event_retention' ? retention : null),
      listMetricSeries: vi.fn(async () => []),
    };
    const server = await startServer({ store });
    servers.push(server);

    expect(await (await server.get()).json()).toMatchObject({
      retention: { mode: 'execute', status: 'unavailable', stale: false },
    });
  });

  it.each([
    ['缺失完成字段', { lastCompletedAt: undefined }],
    ['缺失成功字段', { lastSuccessAt: null }],
    ['非法时间', { lastCompletedAt: 'not-a-time' }],
    ['未来成功时间', { lastSuccessAt: '2099-01-01T00:00:00.000Z' }],
    ['负耗时', { durationMs: -1 }],
    ['非法水位', { watermarks: { legal: '20', billing: 'bad', effectiveDeleteThrough: '18' } }],
    ['effective 不是双水位最小值', { watermarks: { legal: '20', billing: '18', effectiveDeleteThrough: '17' } }],
    ['负数最大序号', { maxGlobalSequence: '-1' }],
    ['空分类', { categories: {} }],
    ['分类不完整', { categories: { 'tool-delta': { eligible: 2, deleted: 2 } } }],
    ['未知分类', { categories: retentionCategories({ future: { eligible: 0, deleted: 0 } }) }],
    ['负数分类', { categories: retentionCategories({ 'tool-delta': { eligible: -1, deleted: 0 } }) }],
    ['删除量超过候选量', { categories: retentionCategories({ 'tool-delta': { eligible: 1, deleted: 2 } }) }],
    ['dry-run 出现删除量', {
      state: 'dry_run_succeeded',
      mode: 'dry-run',
      categories: retentionCategories({ 'tool-delta': { eligible: 2, deleted: 1 } }),
    }],
    ['旧运行模式', { mode: 'dry-run' }],
    ['旧调度间隔', { sweepIntervalMinutes: 60 }],
  ])('fails closed for a fresh successful snapshot with %s', async (_name, detailOverrides) => {
    const retention = metric({
      metric: 'runtime_event_retention',
      label: 'status',
      detailJson: retentionDetail(detailOverrides),
    });
    const store = {
      getLatestMetric: vi.fn(async (name: string) => name === 'runtime_event_retention' ? retention : null),
      listMetricSeries: vi.fn(async () => []),
    };
    const server = await startServer({ store });
    servers.push(server);

    expect(await (await server.get()).json()).toMatchObject({
      retention: {
        mode: 'execute',
        status: 'unavailable',
        stale: false,
        lastSuccessAt: null,
        nextScheduledAt: null,
        categories: {},
      },
    });
  });

  it.each(['db down', 'future_error_category'])('rejects an unstable error category %s', async (errorCategory) => {
    const retention = metric({
      metric: 'runtime_event_retention',
      label: 'status',
      detailJson: retentionDetail({
        state: 'failed',
        errorCategory,
        lastSuccessAt: null,
      }),
    });
    const store = {
      getLatestMetric: vi.fn(async (name: string) => name === 'runtime_event_retention' ? retention : null),
      listMetricSeries: vi.fn(async () => []),
    };
    const server = await startServer({ store });
    servers.push(server);

    expect(await (await server.get()).json()).toMatchObject({
      retention: { status: 'unavailable', errorCategory: null },
    });
  });

  it('rejects a retention status sampled beyond the clock-skew allowance', async () => {
    const retention = metric({
      metric: 'runtime_event_retention',
      label: 'status',
      sampledAt: '2099-01-01T00:00:00.000Z',
      detailJson: retentionDetail(),
    });
    const store = {
      getLatestMetric: vi.fn(async (name: string) => name === 'runtime_event_retention' ? retention : null),
      listMetricSeries: vi.fn(async () => []),
    };
    const server = await startServer({ store });
    servers.push(server);

    expect(await (await server.get()).json()).toMatchObject({
      retention: { status: 'unavailable', stale: false },
    });
  });

  it('normalizes an unknown old retention state to unavailable before staleness', async () => {

    const retention = metric({
      metric: 'runtime_event_retention',
      label: 'status',
      sampledAt: '2020-01-01T00:00:00.000Z',
      detailJson: retentionDetail({ state: 'future_state' }),
    });
    const store = {
      getLatestMetric: vi.fn(async (name: string) => name === 'runtime_event_retention' ? retention : null),
      listMetricSeries: vi.fn(async () => []),
    };
    const server = await startServer({ store });
    servers.push(server);

    expect(await (await server.get()).json()).toMatchObject({
      retention: { mode: 'execute', status: 'unavailable', stale: false },
    });
  });

  it.each([
    ['failed', 'execution_failed'],
    ['blocked', 'authorization_missing'],
    ['execute_succeeded', null],
  ])('preserves a stale %s result and error category independently from freshness', async (state, errorCategory) => {
    const completedAt = '2019-12-31T23:59:59.000Z';
    const old = metric({
      metric: 'runtime_event_retention',
      label: 'status',
      sampledAt: '2020-01-01T00:00:00.000Z',
      detailJson: retentionDetail({
        state,
        lastStartedAt: '2019-12-31T23:59:58.000Z',
        lastCompletedAt: completedAt,
        lastSuccessAt: state === 'execute_succeeded' ? completedAt : null,
        durationMs: 10,
        errorCategory,
        nextScheduledAt: '2020-01-01T00:10:00.000Z',
      }),
    });
    const store = {
      getLatestMetric: vi.fn(async (name: string) => name === 'runtime_event_retention' ? old : null),
      listMetricSeries: vi.fn(async () => []),
    };
    const server = await startServer({ store });
    servers.push(server);

    expect(await (await server.get()).json()).toMatchObject({
      retention: { status: state, stale: true, errorCategory },
    });
  });

  it('rejects invalid hours', async () => {
    const server = await startServer({ store: {
      getLatestMetric: vi.fn(async () => null),
      listMetricSeries: vi.fn(async () => []),
    } });
    servers.push(server);
    expect((await server.get('?hours=0')).status).toBe(400);
  });
});
