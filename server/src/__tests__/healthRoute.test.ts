import express from 'express';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createHealthRouter } from '../routes/health.js';
import type { ActiveRunCounts } from '../runtime/runStore.js';
import {
  projectRuntimeWorkerReadyFile,
  readActiveRuntimeWorkerAdmissionSnapshot,
  resolveRuntimeAdmissionSnapshotReader,
} from '../runtime/runtimeWorkerReadiness.js';

const APP_CONFIG = {
  agent: { maxTurns: 4, permissionMode: 'ask' },
  tts: undefined,
} as any;
const WORKER_CONFIG_IDENTITY = {
  schemaVersion: 1 as const,
  status: 'consistent' as const,
  expected: { schemaVersion: 1, digest: `sha256:${'a'.repeat(64)}` },
  observed: {
    schemaVersion: 1,
    digest: `sha256:${'a'.repeat(64)}`,
    credentialVersionDigest: null,
    versionResolution: 'resolved' as const,
    secretRefCount: 0,
  },
};

async function startHealthServer(
  options: Parameters<typeof createHealthRouter>[1] = {},
  config: any = APP_CONFIG,
  requestUser?: unknown,
) {
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  const app = express();
  if (requestUser) {
    app.use((req, _res, next) => {
      req.user = requestUser as typeof req.user;
      next();
    });
  }
  try {
    app.use('/api', createHealthRouter(config, options));
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
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
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('reports the same fail-closed TTS capability used by server and clients', async () => {
    const requestUser = { sub: 'user-1', username: 'alice', role: 'user', tenantId: 'tenant-a' };
    const disabled = await startHealthServer(
      {},
      { ...APP_CONFIG, tts: { enabled: false, doubaoAppId: 'app', doubaoApiKey: 'key' } },
      requestUser,
    );
    const enabled = await startHealthServer(
      {},
      { ...APP_CONFIG, tts: { enabled: true, doubaoAppId: 'app', doubaoApiKey: 'key' } },
      requestUser,
    );
    servers.push(disabled, enabled);
    expect(await (await disabled.request('/api/health')).json()).toMatchObject({ ttsAvailable: false });
    expect(await (await enabled.request('/api/health')).json()).toMatchObject({ ttsAvailable: true });
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
    const body = (await response.json()) as any;

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
    const body = (await response.json()) as any;

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
    const body = (await response.json()) as any;

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
    const body = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: 'ok',
      draining: false,
      warmup: { state: 'running', totalUsers: 16, processedUsers: 4, syncedUsers: 2 },
    });
  });

  it('reports 503 when runtime admission is paused', async () => {
    const server = await startHealthServer({
      getRuntimeAdmissionSnapshot: () => ({
        state: 'paused',
        admitting: false,
        reason: 'worker_cgroup_near_high',
      }),
    });
    servers.push(server);

    const response = await server.request('/api/healthz/ready');
    const body = await response.json() as any;

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      status: 'not_ready',
      runtimeAdmission: {
        state: 'paused',
        admitting: false,
        reason: 'worker_cgroup_near_high',
      },
    });
  });

  it('fails ws-only readiness when the active runtime worker withdraws its identity-bound readyfile', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'split-role-health-'));
    cleanupDirs.push(dir);
    const activeColorFile = join(dir, 'active-color');
    const readyFile = join(dir, 'blue.ready');
    writeFileSync(activeColorFile, 'blue\n');
    const getActiveWorkerSnapshot = () => readActiveRuntimeWorkerAdmissionSnapshot({
      activeColorFile,
      readyFileForColor: () => readyFile,
      isProcessAlive: () => true,
    });
    const getRuntimeAdmissionSnapshot = resolveRuntimeAdmissionSnapshotReader(
      'ws-only',
      () => ({ state: 'unknown', admitting: true }),
      getActiveWorkerSnapshot,
    );
    projectRuntimeWorkerReadyFile(
      readyFile,
      { state: 'healthy', admitting: true },
      WORKER_CONFIG_IDENTITY,
      true,
      1234,
    );
    const server = await startHealthServer({ getRuntimeAdmissionSnapshot });
    servers.push(server);

    expect((await server.request('/api/healthz/ready')).status).toBe(200);

    projectRuntimeWorkerReadyFile(
      readyFile,
      { state: 'paused', admitting: false },
      WORKER_CONFIG_IDENTITY,
      true,
      1234,
    );
    const response = await server.request('/api/healthz/ready');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: 'not_ready',
      runtimeAdmission: { admitting: false, reason: 'runtime_worker_not_ready' },
    });
  });

  it('reports 503 not-ready while draining', async () => {
    const server = await startHealthServer({
      getIsDraining: () => true,
      getSkillsWarmupStatus: () => ({ state: 'done' }),
    });
    servers.push(server);

    const response = await server.request('/api/healthz/ready');
    const body = (await response.json()) as any;

    expect(response.status).toBe(503);
    expect(body).toMatchObject({ status: 'draining', draining: true });
  });

  it.each(['not_configured', 'disabled'])(
    'treats integration v3 %s as not applicable to site readiness',
    async () => {
      const server = await startHealthServer({
        getIntegrationV3Health: async () => ({
          status: 'not_applicable',
          releaseReady: true,
          reasons: [],
        }),
      });
      servers.push(server);

      const response = await server.request('/api/healthz/ready');
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        status: 'ok',
        integrationV3: { status: 'not_applicable', releaseReady: true },
      });
    },
  );

  it('reports 200 when enabled integration v3 adapters, gateway, and worker are healthy', async () => {
    const server = await startHealthServer({
      getIntegrationV3Health: async () => ({
        status: 'ok',
        releaseReady: true,
        reasons: [],
        metrics: {
          capturedAt: new Date().toISOString(),
          unknownOperationCount: 0,
          oldestUnknownOperationAgeMs: null,
          staleLaneCount: 0,
          staleOutboxCount: 0,
          oldestOutboxAgeMs: null,
          cleanupFailureCount: 0,
          gatewayDisabled: false,
          gatewayHealthy: true,
          activeV2Count: 0,
          activeV3Count: 1,
          costBudgetUsed: null,
          costBudgetLimit: null,
          workRoundBudgetUsed: null,
          workRoundBudgetLimit: null,
        },
      }),
    });
    servers.push(server);
    const response = await server.request('/api/healthz/ready');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'ok',
      integrationV3: { status: 'ok', releaseReady: true },
    });
  });

  it('keeps remediation deployment ready while reporting a failed candidate', async () => {
    const server = await startHealthServer({
      getIntegrationV3Health: async () => ({
        status: 'degraded',
        releaseReady: true,
        reasons: ['active_failed_candidate'],
        metrics: {
          capturedAt: new Date().toISOString(),
          unknownOperationCount: 0,
          oldestUnknownOperationAgeMs: null,
          staleLaneCount: 0,
          staleOutboxCount: 0,
          oldestOutboxAgeMs: null,
          cleanupFailureCount: 0,
          activeFailedCandidateCount: 1,
          gatewayDisabled: false,
          gatewayHealthy: true,
          activeV2Count: 0,
          activeV3Count: 1,
          costBudgetUsed: null,
          costBudgetLimit: null,
          workRoundBudgetUsed: null,
          workRoundBudgetLimit: null,
        },
      }),
    });
    servers.push(server);
    const response = await server.request('/api/healthz/ready');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'ok',
      integrationV3: {
        status: 'degraded',
        releaseReady: true,
        reasons: ['active_failed_candidate'],
      },
    });
  });

  it.each([
    'worker_or_required_adapter_unavailable',
    'runtime_isolation_attestation_unavailable',
    'gateway_unhealthy',
    'git_unavailable',
  ])(
    'fails readiness with 503 when enabled integration v3 condition %s is broken',
    async (reason) => {
      const server = await startHealthServer({
        getIntegrationV3Health: async () => ({
          status: 'degraded',
          releaseReady: false,
          reasons: [reason],
          metrics: {
            capturedAt: new Date().toISOString(),
            unknownOperationCount: 0,
            oldestUnknownOperationAgeMs: null,
            staleLaneCount: 0,
            staleOutboxCount: 0,
            oldestOutboxAgeMs: null,
            cleanupFailureCount: 0,
            gatewayDisabled: reason === 'gateway_unhealthy',
            gatewayHealthy: false,
            activeV2Count: 0,
            activeV3Count: 1,
            costBudgetUsed: null,
            costBudgetLimit: null,
            workRoundBudgetUsed: null,
            workRoundBudgetLimit: null,
          },
        }),
      });
      servers.push(server);
      const response = await server.request('/api/healthz/ready');
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        status: 'not_ready',
        integrationV3: { reasons: [reason] },
      });
    },
  );

  it('fails the release readiness gate when integration v3 is degraded', async () => {
    const server = await startHealthServer({
      getIntegrationV3Health: async () => ({
        status: 'degraded',
        releaseReady: false,
        reasons: ['gateway_disabled'],
        metrics: {
          capturedAt: new Date().toISOString(),
          unknownOperationCount: 0,
          oldestUnknownOperationAgeMs: null,
          staleLaneCount: 0,
          staleOutboxCount: 0,
          oldestOutboxAgeMs: null,
          cleanupFailureCount: 0,
          gatewayDisabled: true,
          gatewayHealthy: false,
          activeV2Count: 0,
          activeV3Count: 1,
          costBudgetUsed: null,
          costBudgetLimit: null,
          workRoundBudgetUsed: null,
          workRoundBudgetLimit: null,
        },
      }),
    });
    servers.push(server);

    const response = await server.request('/api/healthz/ready');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: 'not_ready',
      integrationV3: { releaseReady: false },
    });
  });

  it('fails readiness closed when integration v3 PostgreSQL metrics are unavailable', async () => {
    const server = await startHealthServer({
      getIntegrationV3Health: async () => {
        throw new Error('integration metrics db unavailable');
      },
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

  it('returns a non-sensitive attested release identity from readiness', async () => {
    const server = await startHealthServer({
      getRuntimeIdentity: () => ({
        environment: 'staging',
        releaseId: 'rc-20260825-01',
        releaseSha: 'a'.repeat(40),
        serverDigest: `sha256:${'b'.repeat(64)}`,
        webDigest: `sha256:${'c'.repeat(64)}`,
        safetyAttested: true,
      }),
    });
    servers.push(server);
    const response = await server.request('/api/healthz/ready');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      release: {
        environment: 'staging',
        releaseId: 'rc-20260825-01',
        releaseSha: 'a'.repeat(40),
        safetyAttested: true,
      },
    });
  });

  it.each([
    ['匿名调用者', undefined],
    ['普通调用者', { id: 'member-1', role: 'member' }],
  ])('TASK-318：%s 的公开 readiness 仅返回白名单 release identity', async (_label, user) => {
    const server = await startHealthServer(
      {
        getRuntimeIdentity: () =>
          ({
            environment: 'staging',
            releaseId: 'rc-20260825-01',
            releaseSha: 'a'.repeat(40),
            serverDigest: `sha256:${'b'.repeat(64)}`,
            webDigest: `sha256:${'c'.repeat(64)}`,
            acsOrchestratorDigest: `sha256:${'d'.repeat(64)}`,
            acsSandboxImageDigest: `sha256:${'e'.repeat(64)}`,
            safetyAttested: true,
            expectedConfigIdentity: {
              schemaVersion: 1,
              digest: `sha256:${'f'.repeat(64)}`,
              credentialVersionDigest: `sha256:${'1'.repeat(64)}`,
            },
            configIdentity: { plaintextSecretProbe: 'must-not-leak-config-identity' },
            observedIdentity: { digest: 'must-not-leak-observed-identity' },
            credentialVersionDigest: 'must-not-leak-credential-version',
          }) as any,
      },
      APP_CONFIG,
      user,
    );
    servers.push(server);

    const response = await server.request('/api/healthz/ready');
    const body = (await response.json()) as any;
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(body.release).toEqual({
      environment: 'staging',
      releaseId: 'rc-20260825-01',
      releaseSha: 'a'.repeat(40),
      serverDigest: `sha256:${'b'.repeat(64)}`,
      webDigest: `sha256:${'c'.repeat(64)}`,
      acsOrchestratorDigest: `sha256:${'d'.repeat(64)}`,
      acsSandboxImageDigest: `sha256:${'e'.repeat(64)}`,
      safetyAttested: true,
    });
    for (const forbidden of [
      'expectedConfigIdentity',
      'configIdentity',
      'observed',
      'credentialVersionDigest',
      'must-not-leak',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('fails readiness closed for an unattested staging identity', async () => {
    const server = await startHealthServer({
      getRuntimeIdentity: () => ({ environment: 'staging', safetyAttested: false }),
    });
    servers.push(server);
    const response = await server.request('/api/healthz/ready');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: 'not_ready',
      release: { safetyAttested: false },
    });
  });

  it('fails readiness closed when the live staging egress policy loses attestation', async () => {
    const server = await startHealthServer({
      getRuntimeIdentity: () => ({ environment: 'staging', safetyAttested: true }),
      getEnvironmentSafetyAttested: () => false,
    });
    servers.push(server);
    const response = await server.request('/api/healthz/ready');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: 'not_ready',
      release: { safetyAttested: false },
    });
  });

  it('TASK-318：公开 readiness 不暴露 configIdentity 或上游额外字段', async () => {
    const configIdentity = {
      schemaVersion: 1 as const,
      status: 'consistent' as const,
      expected: { schemaVersion: 1, digest: `sha256:${'a'.repeat(64)}` },
      observed: {
        schemaVersion: 1,
        digest: `sha256:${'a'.repeat(64)}`,
        credentialVersionDigest: null,
        versionResolution: 'resolved' as const,
        secretRefCount: 0,
      },
      releaseId: 'release-1',
      plaintextSecretProbe: 'must-not-leak',
    };
    const server = await startHealthServer({
      getConfigIdentitySummary: () => configIdentity as any,
    });
    servers.push(server);

    const response = await server.request('/api/healthz/ready');
    const body = (await response.json()) as any;
    expect(response.status).toBe(200);
    expect(body).not.toHaveProperty('configIdentity');
    expect(JSON.stringify(body)).not.toContain('must-not-leak');
  });

  it('TASK-318：已绑定 expected 的 drift 在匿名 readiness 只表现为 503', async () => {
    const server = await startHealthServer({
      getConfigIdentitySummary: () => ({
        schemaVersion: 1,
        status: 'drifted',
        expected: { schemaVersion: 1, digest: `sha256:${'a'.repeat(64)}` },
        observed: {
          schemaVersion: 1,
          digest: `sha256:${'b'.repeat(64)}`,
          credentialVersionDigest: null,
          versionResolution: 'resolved',
          secretRefCount: 0,
        },
        releaseId: 'release-1',
      }),
    });
    servers.push(server);

    const response = await server.request('/api/healthz/ready');
    const body = (await response.json()) as any;
    expect(response.status).toBe(503);
    expect(body).not.toHaveProperty('configIdentity');
  });

  it('未接入 provider 时 warmup 默认为 done', async () => {
    const server = await startHealthServer({});
    servers.push(server);

    const response = await server.request('/api/healthz/ready');
    const body = (await response.json()) as any;

    expect(response.status).toBe(200);
    expect(body.warmup).toEqual({ state: 'done' });
  });
});
