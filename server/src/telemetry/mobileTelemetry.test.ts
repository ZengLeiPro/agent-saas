import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createMobileTelemetryRouter, type MobileTelemetryStore } from './mobileTelemetry.js';

const release = 'b'.repeat(40);
const pseudonymKey = 'p'.repeat(32);
const signingKey = 's'.repeat(32);
const hash = (value: string) =>
  `h1:${createHmac('sha256', `${release}:${pseudonymKey}`).update(value).digest('hex')}`;
const fixedNow = Date.parse('2026-09-01T07:00:00.000Z');
const eventHash = `h1:${'a'.repeat(64)}`;
function batch(id = '22222222-2222-4222-8222-222222222222', nonce = 'c'.repeat(32)) {
  const releaseFacts = {
    commit: release,
    appVersion: '1.9.5',
    build: '85',
    profile: 'production' as const,
  };
  return {
    schemaVersion: 1 as const,
    batchId: id,
    nonce,
    sentAt: '2026-09-01T07:00:00.000Z',
    owner: { tenantId: hash('tenant-a'), userId: hash('user-a') },
    release: releaseFacts,
    events: [
      {
        schemaVersion: 1 as const,
        eventId: '11111111-1111-4111-8111-111111111111',
        kind: 'startup' as const,
        wallTimestamp: '2026-09-01T07:00:00.000Z',
        monotonicMs: 12,
        correlation: { correlationId: eventHash },
        release: releaseFacts,
        runtime: { deviceClass: 'mid' as const, os: 'ios' as const },
        measurements: { durationMs: 12, cold: true },
      },
    ],
  };
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function rig(
  options: {
    store?: MobileTelemetryStore;
    provider?: { publish: () => Promise<void> };
    configured?: boolean;
    providerFacts?: {
      kind: string;
      owner: string;
      dashboardId: string;
      alertPolicyId: string;
      dsnSecretReference: string;
      release: string;
    };
  } = {},
) {
  const writes: unknown[] = [];
  const store = options.store ?? {
    write: vi.fn(async (value) => {
      writes.push(value);
      return 'first-party:receipt';
    }),
  };
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use((req, _res, next) => {
    req.user = { sub: 'user-a', username: 'alice', role: 'user', tenantId: 'tenant-a' };
    next();
  });
  app.use(
    '/api',
    createMobileTelemetryRouter({
      store,
      ...(options.configured === false ? {} : { pseudonymKey, signingKey }),
      retentionDays: 30,
      sampleRate: 1,
      rateLimitPerMinute: 20,
      provider: options.provider,
      providerFacts: options.providerFacts,
      now: () => fixedNow,
    }),
  );
  const server = await new Promise<Server>((resolve) => {
    const next = app.listen(0, '127.0.0.1', () => resolve(next));
  });
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mobile/telemetry`;
  return { url: base, healthUrl: `${base}/health`, writes };
}

async function post(url: string, value: unknown, overrides: Record<string, string> = {}) {
  const body = JSON.stringify(value);
  const signature = createHmac('sha256', signingKey).update(body).digest('hex');
  const candidate = value as ReturnType<typeof batch>;
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telemetry-Signature': `v1=${signature}`,
      'X-Telemetry-Release': candidate.release?.commit ?? release,
      'Idempotency-Key': candidate.batchId ?? 'none',
      ...overrides,
    },
    body,
  });
}

describe('authenticated mobile telemetry intake', () => {
  it('validates identity/release/signature and stores only the strict first-party event', async () => {
    const { url, writes } = await rig();
    const response = await post(url, batch());
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      accepted: true,
      receiptId: 'first-party:receipt',
    });
    expect(writes).toHaveLength(1);
  });

  it('rejects malicious, proto, oversize, bad signature and cross-tenant/wrong-owner batches', async () => {
    const { url } = await rig();
    expect((await post(url, { ...batch(), prompt: 'secret' })).status).toBe(400);
    const proto = JSON.parse(JSON.stringify(batch()));
    Object.defineProperty(proto, '__proto__', { enumerable: true, value: { polluted: true } });
    expect((await post(url, proto)).status).toBe(400);
    expect((await post(url, { ...batch(), padding: 'x'.repeat(70 * 1024) })).status).toBe(413);
    expect(
      (await post(url, batch(), { 'X-Telemetry-Signature': `v1=${'0'.repeat(64)}` })).status,
    ).toBe(401);
    expect(
      (
        await post(url, {
          ...batch(),
          owner: { tenantId: hash('tenant-b'), userId: hash('user-a') },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await post(url, {
          ...batch(),
          owner: { tenantId: hash('tenant-a'), userId: hash('user-b') },
        })
      ).status,
    ).toBe(403);
  });

  it('provides idempotency but rejects nonce replay under a different batch id', async () => {
    const { url } = await rig();
    expect((await post(url, batch())).status).toBe(202);
    expect((await post(url, batch())).status).toBe(200);
    expect((await post(url, batch('33333333-3333-4333-8333-333333333333'))).status).toBe(409);
  });

  it('accepts first-party telemetry when provider delivery fails and never impacts business response', async () => {
    const { url, writes } = await rig({
      provider: {
        publish: vi.fn(async () => {
          throw new Error('provider down');
        }),
      },
    });
    expect((await post(url, batch())).status).toBe(202);
    expect(writes).toHaveLength(1);
  });

  it('fails closed when production configuration or provider health facts are absent', async () => {
    const { url, healthUrl } = await rig({ configured: false });
    expect((await post(url, batch())).status).toBe(503);
    expect((await fetch(healthUrl)).status).toBe(503);
    const ready = await rig({
      providerFacts: {
        kind: 'injected-adapter',
        owner: 'mobile-oncall',
        dashboardId: 'dashboard-id',
        alertPolicyId: 'alert-id',
        dsnSecretReference: 'secret://mobile/dsn',
        release,
      },
    });
    expect((await fetch(ready.healthUrl)).status).toBe(200);
  });
});
