import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRuntimeOperationsAdminRouter } from '../routes/runtimeOperationsAdmin.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';

const servers: Array<{ close: () => void }> = [];

async function withApp<T>(
  fn: (args: { baseUrl: string }) => Promise<T>,
  opts: Partial<Parameters<typeof createRuntimeOperationsAdminRouter>[0]> = {},
): Promise<T> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { sub: 'admin', username: 'admin', role: 'admin', tenantId: DEFAULT_TENANT_ID };
    next();
  });
  app.use('/api/admin/runtime-operations', createRuntimeOperationsAdminRouter({
    config: {
      tenantRemoteHands: {
        hands: [{
          id: 'agent-saas-acs',
          baseUrl: 'http://acs-hand:3400',
          rollout: { mode: 'all' },
          authToken: 'secret-token-123',
          invokeTimeoutMs: 300000,
          networkPolicy: { mode: 'public-egress', denyPrivateNetworks: true },
        }],
      },
    } as any,
    ...opts,
  }));
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind test server');
  return fn({ baseUrl: `http://127.0.0.1:${address.port}` });
}

async function readJson(response: Response) {
  return response.json() as Promise<any>;
}

describe('runtime operations admin router', () => {
  afterEach(() => {
    while (servers.length > 0) servers.pop()?.close();
  });

  it('returns runtime operations summary without leaking hand auth token', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: 'Bearer secret-token-123' });
      return new Response(JSON.stringify({
        status: 'ok',
        backend: 'acs-agent-sandbox',
        sandboxes: { totalCount: 3, runningCount: 1, pausedCount: 2 },
        networkPolicy: {
          desiredPolicy: { mode: 'public-egress', denyPrivateNetworks: true },
          effectivePolicy: {
            mode: 'unknown',
            enforcement: 'unknown',
            publicEgressReachable: 'unknown',
            privateEgressBlocked: 'unknown',
            metadataBlocked: 'unknown',
          },
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    await withApp(async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/admin/runtime-operations`);
      expect(response.status).toBe(200);
      const body = await readJson(response);
      expect(body.tenantRemoteHands.hands[0]).toMatchObject({
        id: 'agent-saas-acs',
        authTokenConfigured: true,
        networkPolicy: { mode: 'public-egress', denyPrivateNetworks: true },
      });
      expect(body.tenantRemoteHands.hands[0].authToken).toBeUndefined();
      expect(body.tenantRemoteHands.health[0]).toMatchObject({
        id: 'agent-saas-acs',
        status: 'ok',
        metadata: {
          backend: 'acs-agent-sandbox',
          sandboxes: { totalCount: 3, runningCount: 1, pausedCount: 2 },
          networkPolicy: {
            desiredPolicy: { mode: 'public-egress', denyPrivateNetworks: true },
            effectivePolicy: expect.objectContaining({ enforcement: 'unknown' }),
          },
        },
      });
      expect(body.runtimeEventStore).toMatchObject({ status: 'disabled' });
      expect(JSON.stringify(body)).not.toContain('secret-token-123');
    }, { fetchImpl });
  });

  it('proxies ACS runtime config updates without exposing hand token to the browser', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('http://acs-hand:3400/runtime-config');
      expect(init?.method).toBe('PATCH');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer secret-token-123' });
      expect(JSON.parse(String(init?.body))).toEqual({
        maxRunningSandboxes: 4,
        warnRunningSandboxes: 3,
        drainDeadlineMs: 900_000,
      });
      return new Response(JSON.stringify({
        status: 'ok',
        runtimeConfig: {
          maxRunningSandboxes: 4,
          warnRunningSandboxes: 3,
          drainDeadlineMs: 900_000,
          persisted: true,
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    await withApp(async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/admin/runtime-operations/acs/runtime-config`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ maxRunningSandboxes: 4, warnRunningSandboxes: 3, drainDeadlineMs: 900_000 }),
      });
      expect(response.status).toBe(200);
      const body = await readJson(response);
      expect(body.runtimeConfig).toMatchObject({
        maxRunningSandboxes: 4,
        warnRunningSandboxes: 3,
        drainDeadlineMs: 900_000,
        persisted: true,
      });
      expect(JSON.stringify(body)).not.toContain('secret-token-123');
    }, { fetchImpl });
  });

  it('proxies ACS network policy probe without exposing hand token to the browser', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('http://acs-hand:3400/network-policy/probe');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer secret-token-123' });
      return new Response(JSON.stringify({
        status: 'ok',
        networkPolicy: {
          desiredPolicy: { mode: 'public-egress', denyPrivateNetworks: true },
          effectivePolicy: {
            mode: 'public-egress',
            enforcement: 'enforced',
            publicEgressReachable: true,
            privateEgressBlocked: true,
            metadataBlocked: true,
            dnsRebindingProtected: true,
            checkedAt: '2026-06-28T00:00:00.000Z',
          },
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    await withApp(async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/admin/runtime-operations/acs/network-policy/probe`, {
        method: 'POST',
      });
      expect(response.status).toBe(200);
      const body = await readJson(response);
      expect(body.networkPolicy.effectivePolicy).toMatchObject({
        enforcement: 'enforced',
        publicEgressReachable: true,
        privateEgressBlocked: true,
        metadataBlocked: true,
      });
      expect(JSON.stringify(body)).not.toContain('secret-token-123');
    }, { fetchImpl });
  });

  it('proxies ACS SNAT status and cleanup without exposing hand token', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: 'Bearer secret-token-123' });
      if (String(input).endsWith('/snat')) {
        expect(init?.method).toBe('GET');
        return new Response(JSON.stringify({
          status: 'ok',
          snat: {
            enabled: true,
            mode: 'probe-only',
            configured: true,
            managedCount: 1,
            unexpectedCount: 0,
            orphanCount: 0,
            entries: [],
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      expect(String(input)).toBe('http://acs-hand:3400/snat/cleanup-orphans');
      expect(init?.method).toBe('POST');
      return new Response(JSON.stringify({
        status: 'ok',
        report: { enabled: true, checked: 1, deleted: ['snat-1'], orphanCidrs: ['172.16.177.139/32'], unexpected: [] },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    await withApp(async ({ baseUrl }) => {
      const status = await fetch(`${baseUrl}/api/admin/runtime-operations/acs/snat`);
      expect(status.status).toBe(200);
      expect((await readJson(status)).snat).toMatchObject({ mode: 'probe-only', managedCount: 1 });

      const cleanup = await fetch(`${baseUrl}/api/admin/runtime-operations/acs/snat/cleanup-orphans`, { method: 'POST' });
      expect(cleanup.status).toBe(200);
      expect((await readJson(cleanup)).report.deleted).toEqual(['snat-1']);
    }, { fetchImpl });
  });
});
