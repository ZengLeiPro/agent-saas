import express from 'express';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { createHealthRouter } from '../routes/health.js';
import type { ActiveRunCounts } from '../runtime/runStore.js';

const APP_CONFIG = {
  agent: { maxTurns: 4, permissionMode: 'ask' },
  tts: undefined,
} as any;

async function startHealthServer(options: Parameters<typeof createHealthRouter>[1] = {}) {
  const app = express();
  app.use('/api', createHealthRouter(APP_CONFIG, options));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const baseUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
  return {
    request: (path: string) => fetch(`${baseUrl}${path}`),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('health router', () => {
  const servers: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it('keeps /healthz as a lightweight text probe', async () => {
    const server = await startHealthServer();
    servers.push(server);

    const response = await server.request('/api/healthz');

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
  });

  it('reports drain readiness from active streams and durable active runs', async () => {
    const activeRuns: ActiveRunCounts = {
      pending: 1,
      running: 2,
      waitingApproval: 3,
      waitingUser: 4,
      waitingHand: 5,
      blocking: 3,
      total: 15,
    };
    const server = await startHealthServer({
      getActiveStreamCount: () => 1,
      getActiveRunCounts: async () => activeRuns,
      getIsDraining: () => false,
    });
    servers.push(server);

    const response = await server.request('/api/healthz/drain');
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: 'ok',
      draining: false,
      activeStreams: 1,
      activeRuns,
      idle: false,
    });
  });

  it('does not report idle when durable active run status is unavailable', async () => {
    const server = await startHealthServer({
      getActiveStreamCount: () => 0,
      getActiveRunCounts: async () => {
        throw new Error('pg unavailable');
      },
    });
    servers.push(server);

    const response = await server.request('/api/healthz/drain');
    const body = await response.json() as any;

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      status: 'error',
      activeStreams: 0,
      idle: false,
      error: 'pg unavailable',
    });
  });
});
