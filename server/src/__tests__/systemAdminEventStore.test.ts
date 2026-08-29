import type { Server } from 'node:http';

import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSystemAdminRouter } from '../routes/systemAdmin.js';
import type { PgSystemMetricsStore, SystemMetricRecord } from '../runtime/systemMetricsStore.js';

const ADMIN = { sub: 'admin1', role: 'admin', tenantId: 'pantheon' };
const NON_PLATFORM_ADMIN = { sub: 'user1', role: 'admin', tenantId: 'tenant-a' };

async function startServer(options: { user?: unknown; store?: unknown }) {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { user: unknown }).user = options.user ?? ADMIN;
    next();
  });
  app.use('/api/admin/system', createSystemAdminRouter({
    agentCwd: '/workspace',
    systemMetricsStore: options.store as PgSystemMetricsStore | undefined,
    runtimeEventRetention: { enabled: true, executionMode: 'execute', sweepIntervalMinutes: 10 },
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

  it('serializes persisted retention and capacity series without querying runtime_events', async () => {
    const retention = metric({
      metric: 'runtime_event_retention',
      label: 'status',
      valueNum: 25,
      detailJson: {
        schemaVersion: 1,
        state: 'execute_succeeded',
        mode: 'execute',
        lastStartedAt: '2026-08-29T14:00:00.000Z',
        lastCompletedAt: '2026-08-29T14:00:00.025Z',
        lastSuccessAt: '2026-08-29T14:00:00.025Z',
        durationMs: 25,
        errorCategory: null,
        nextScheduledAt: '2026-08-29T14:10:00.000Z',
        watermarks: { legal: '20', billing: '18', effectiveDeleteThrough: '18' },
        maxGlobalSequence: '22',
        categories: { 'tool-delta': { eligible: 2, deleted: 2 } },
      },
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
    expect(body.capacity.series).toHaveLength(1);
    expect(store.listMetricSeries).toHaveBeenCalledWith('pg_table_size', 'runtime_events', 48);
    expect(JSON.stringify(body)).not.toContain('authorizationRef');
  });

  it('returns never-run rather than healthy when the store has no retention snapshot', async () => {
    const store = {
      getLatestMetric: vi.fn(async () => null),
      listMetricSeries: vi.fn(async () => []),
    };
    const server = await startServer({ store });
    servers.push(server);
    expect(await (await server.get()).json()).toMatchObject({
      available: true,
      retention: { enabled: true, status: 'never_run', stale: false, categories: {} },
    });
  });

  it('marks old snapshots stale and rejects invalid hours', async () => {
    const old = metric({
      metric: 'runtime_event_retention',
      label: 'status',
      sampledAt: '2020-01-01T00:00:00.000Z',
      detailJson: { schemaVersion: 1, state: 'failed', mode: 'execute' },
    });
    const store = {
      getLatestMetric: vi.fn(async (name: string) => name === 'runtime_event_retention' ? old : null),
      listMetricSeries: vi.fn(async () => []),
    };
    const server = await startServer({ store });
    servers.push(server);
    expect(await (await server.get()).json()).toMatchObject({ retention: { status: 'stale', stale: true } });
    expect((await server.get('?hours=0')).status).toBe(400);
  });
});
