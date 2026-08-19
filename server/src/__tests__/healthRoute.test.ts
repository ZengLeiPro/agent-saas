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
      getUploadMetrics: () => ({
        activeUploads: 2,
        completedRequests: 3,
        failedRequests: 0,
        abortedRequests: 1,
        uploadedBytes: 1024,
        cleanupRuns: 1,
        cleanedPartialRequests: 0,
        cleanedStagedFiles: 0,
        cleanedBytes: 0,
      }),
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
      activeUploads: 2,
      activeRuns,
      idle: false,
    });
  });

  it('does not report idle while an HTTP upload is active', async () => {
    const server = await startHealthServer({
      getActiveStreamCount: () => 0,
      getUploadMetrics: () => ({
        activeUploads: 1,
        completedRequests: 0,
        failedRequests: 0,
        abortedRequests: 0,
        uploadedBytes: 0,
        cleanupRuns: 0,
        cleanedPartialRequests: 0,
        cleanedStagedFiles: 0,
        cleanedBytes: 0,
      }),
      getActiveRunCounts: async () => ({
        pending: 0,
        running: 0,
        waitingApproval: 0,
        waitingUser: 0,
        waitingHand: 0,
        blocking: 0,
        total: 0,
      }),
    });
    servers.push(server);

    const response = await server.request('/api/healthz/drain');
    const body = await response.json() as any;

    expect(body).toMatchObject({ activeUploads: 1, idle: false });
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

  // ── liveness / readiness 分离（2026-07-15 零停机部署批次）──────────

  it('keeps /healthz/live 200 even while draining', async () => {
    const server = await startHealthServer({ getIsDraining: () => true });
    servers.push(server);

    const response = await server.request('/api/healthz/live');

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
  });

  it('reports readiness with warmup progress payload', async () => {
    const server = await startHealthServer({
      getIsDraining: () => false,
      getSkillsWarmupStatus: () => ({
        state: 'running',
        totalUsers: 16,
        processedUsers: 4,
        syncedUsers: 2,
      }),
    });
    servers.push(server);

    const response = await server.request('/api/healthz/ready');
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: 'ok',
      draining: false,
      warmup: { state: 'running', totalUsers: 16, processedUsers: 4, syncedUsers: 2 },
    });
  });

  it('reports 503 not-ready while draining', async () => {
    const server = await startHealthServer({
      getIsDraining: () => true,
      getSkillsWarmupStatus: () => ({ state: 'done' }),
    });
    servers.push(server);

    const response = await server.request('/api/healthz/ready');
    const body = await response.json() as any;

    expect(response.status).toBe(503);
    expect(body).toMatchObject({ status: 'draining', draining: true });
  });

  it.each(['not_configured', 'disabled'])('treats integration v3 %s as not applicable to site readiness', async () => {
    const server = await startHealthServer({
      getIntegrationV3Health: async () => ({ status: 'not_applicable', releaseReady: true, reasons: [] }),
    });
    servers.push(server);

    const response = await server.request('/api/healthz/ready');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'ok', integrationV3: { status: 'not_applicable', releaseReady: true },
    });
  });

  it('reports 200 when enabled integration v3 adapters, gateway, and worker are healthy', async () => {
    const server = await startHealthServer({
      getIntegrationV3Health: async () => ({
        status: 'ok', releaseReady: true, reasons: [],
        metrics: { capturedAt: new Date().toISOString(), unknownOperationCount: 0, oldestUnknownOperationAgeMs: null,
          staleLaneCount: 0, staleOutboxCount: 0, oldestOutboxAgeMs: null, cleanupFailureCount: 0,
          gatewayDisabled: false, gatewayHealthy: true, activeV2Count: 0, activeV3Count: 1,
          costBudgetUsed: null, costBudgetLimit: null, workRoundBudgetUsed: null, workRoundBudgetLimit: null },
      }),
    });
    servers.push(server);
    const response = await server.request('/api/healthz/ready');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok', integrationV3: { status: 'ok', releaseReady: true } });
  });

  it.each([
    'worker_or_required_adapter_unavailable',
    'runtime_isolation_attestation_unavailable',
    'gateway_unhealthy',
    'git_unavailable',
  ])('fails readiness with 503 when enabled integration v3 condition %s is broken', async (reason) => {
    const server = await startHealthServer({
      getIntegrationV3Health: async () => ({
        status: 'degraded', releaseReady: false, reasons: [reason],
        metrics: { capturedAt: new Date().toISOString(), unknownOperationCount: 0, oldestUnknownOperationAgeMs: null,
          staleLaneCount: 0, staleOutboxCount: 0, oldestOutboxAgeMs: null, cleanupFailureCount: 0,
          gatewayDisabled: reason === 'gateway_unhealthy', gatewayHealthy: false, activeV2Count: 0, activeV3Count: 1,
          costBudgetUsed: null, costBudgetLimit: null, workRoundBudgetUsed: null, workRoundBudgetLimit: null },
      }),
    });
    servers.push(server);
    const response = await server.request('/api/healthz/ready');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: 'not_ready', integrationV3: { reasons: [reason] } });
  });

  it('fails the release readiness gate when integration v3 is degraded', async () => {
    const server = await startHealthServer({
      getIntegrationV3Health: async () => ({
        status: 'degraded', releaseReady: false, reasons: ['gateway_disabled'],
        metrics: { capturedAt: new Date().toISOString(), unknownOperationCount: 0, oldestUnknownOperationAgeMs: null,
          staleLaneCount: 0, staleOutboxCount: 0, oldestOutboxAgeMs: null, cleanupFailureCount: 0,
          gatewayDisabled: true, gatewayHealthy: false, activeV2Count: 0, activeV3Count: 1,
          costBudgetUsed: null, costBudgetLimit: null, workRoundBudgetUsed: null, workRoundBudgetLimit: null },
      }),
    });
    servers.push(server);

    const response = await server.request('/api/healthz/ready');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: 'not_ready', integrationV3: { releaseReady: false } });
  });

  it('fails readiness closed when integration v3 PostgreSQL metrics are unavailable', async () => {
    const server = await startHealthServer({
      getIntegrationV3Health: async () => { throw new Error('integration metrics db unavailable'); },
    });
    servers.push(server);

    const response = await server.request('/api/healthz/ready');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: 'not_ready',
      integrationV3: { releaseReady: false, reasons: ['metrics_unavailable'] },
      error: 'integration metrics db unavailable',
    });
  });

  it('defaults warmup to done when no status provider is wired', async () => {
    const server = await startHealthServer({});
    servers.push(server);

    const response = await server.request('/api/healthz/ready');
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(body.warmup).toEqual({ state: 'done' });
  });
});
