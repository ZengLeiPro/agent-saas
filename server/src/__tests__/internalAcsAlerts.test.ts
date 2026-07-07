import type { Server } from 'node:http';

import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createInternalAcsAlertsRouter, type InternalAcsAlertsRouterOptions } from '../routes/internalAcsAlerts.js';
import type { AlertNotifier } from '../runtime/alertNotifier.js';

const INBOUND_TOKEN = 'test-inbound-token-0123456789abcdef';

const SAMPLE_BODY = {
  source: 'acs-orchestrator',
  namespace: 'ns1',
  event: 'sandbox_down',
  severity: 'error',
  message: 'sandbox ns1/sb1 down for 312s',
  occurredAt: '2026-07-07T00:00:00.000Z',
};

async function startServer(options: InternalAcsAlertsRouterOptions) {
  const app = express();
  app.use(express.json());
  app.use('/api/internal', createInternalAcsAlertsRouter(options));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  const baseUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
  return {
    post: (body: unknown, token?: string) => fetch(`${baseUrl}/api/internal/acs-alerts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('internal ACS alerts inbound endpoint', () => {
  const servers: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  function fakeNotifier(impl?: () => Promise<{ considered: number; notified: number }>) {
    return {
      notifyExternal: vi.fn(impl ?? (async () => ({ considered: 1, notified: 1 }))),
    };
  }

  it('returns 503 when the inbound token is not configured', async () => {
    const notifier = fakeNotifier();
    const server = await startServer({ alertNotifier: notifier as unknown as AlertNotifier });
    servers.push(server);

    const response = await server.post(SAMPLE_BODY, INBOUND_TOKEN);
    expect(response.status).toBe(503);
    expect(notifier.notifyExternal).not.toHaveBeenCalled();
  });

  it('returns 401 without an Authorization header', async () => {
    const notifier = fakeNotifier();
    const server = await startServer({ alertNotifier: notifier as unknown as AlertNotifier, inboundToken: INBOUND_TOKEN });
    servers.push(server);

    const response = await server.post(SAMPLE_BODY);
    expect(response.status).toBe(401);
    expect(notifier.notifyExternal).not.toHaveBeenCalled();
  });

  it('returns 401 for wrong tokens, including tokens of a different length', async () => {
    const notifier = fakeNotifier();
    const server = await startServer({ alertNotifier: notifier as unknown as AlertNotifier, inboundToken: INBOUND_TOKEN });
    servers.push(server);

    expect((await server.post(SAMPLE_BODY, 'x'.repeat(INBOUND_TOKEN.length))).status).toBe(401);
    // FIX-5b: 长度不同不能抛异常（timingSafeEqual 直接比较会 throw），必须仍是 401
    expect((await server.post(SAMPLE_BODY, 'short')).status).toBe(401);
    expect(notifier.notifyExternal).not.toHaveBeenCalled();
  });

  it('accepts a valid token and passes the namespace:event dedupe key through', async () => {
    const notifier = fakeNotifier();
    const server = await startServer({ alertNotifier: notifier as unknown as AlertNotifier, inboundToken: INBOUND_TOKEN });
    servers.push(server);

    const response = await server.post(SAMPLE_BODY, INBOUND_TOKEN);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, result: { considered: 1, notified: 1 } });
    expect(notifier.notifyExternal).toHaveBeenCalledWith('acs-orchestrator', [
      expect.objectContaining({
        kind: 'acs_sandbox_down',
        severity: 'high',
        title: SAMPLE_BODY.message,
        dedupeKey: 'ns1:sandbox_down',
      }),
    ]);
  });

  it('FIX-3 regression: returns 500 when notifyExternal throws instead of leaving an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const notifier = fakeNotifier(async () => { throw new Error('pg down'); });
      const server = await startServer({ alertNotifier: notifier as unknown as AlertNotifier, inboundToken: INBOUND_TOKEN });
      servers.push(server);

      const response = await server.post(SAMPLE_BODY, INBOUND_TOKEN);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('pg down') });
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('returns 400 for invalid payloads', async () => {
    const notifier = fakeNotifier();
    const server = await startServer({ alertNotifier: notifier as unknown as AlertNotifier, inboundToken: INBOUND_TOKEN });
    servers.push(server);

    const response = await server.post({ event: 'sandbox_down' }, INBOUND_TOKEN);
    expect(response.status).toBe(400);
    expect(notifier.notifyExternal).not.toHaveBeenCalled();
  });
});
