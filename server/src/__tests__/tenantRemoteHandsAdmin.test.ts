import express from 'express';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseAppConfig } from '../app/config.js';
import { createTenantRemoteHandsAdminRouter } from '../routes/tenantRemoteHandsAdmin.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';

const servers: Array<{ close: () => void }> = [];

function baseRawConfig() {
  return {
    agent: { cwd: '/tmp/agent' },
    server: { port: 3200 },
    runtimeEventStore: {
      backend: 'pg',
      connectionString: 'postgresql://user:pass@localhost:5432/runtime',
    },
    tenantRemoteHands: {
      hands: [{
        id: 'tenant-ecs',
        description: 'Tenant ECS hand',
        rollout: { mode: 'allowlist', userIds: ['admin'], usernames: ['admin'] },
        baseUrl: 'http://tenant-ecs-hand:3300',
        authToken: 'tenant-token-123',
        invokeTimeoutMs: 120000,
        networkPolicy: { mode: 'public-egress', denyPrivateNetworks: true },
      }],
    },
  };
}

function makeWorkspace(rawConfig = baseRawConfig()) {
  const root = mkdtempSync(join(tmpdir(), 'tenant-remote-hands-admin-'));
  const processCwd = join(root, 'server');
  mkdirSync(processCwd, { recursive: true });
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify(rawConfig, null, 2), 'utf-8');
  return { root, processCwd, configPath };
}

async function withApp<T>(
  rawConfig: ReturnType<typeof baseRawConfig>,
  fn: (args: { baseUrl: string; configPath: string; runtimeConfig: ReturnType<typeof parseAppConfig> }) => Promise<T>,
  opts: Partial<Parameters<typeof createTenantRemoteHandsAdminRouter>[0]> = {},
): Promise<T> {
  const { processCwd, configPath } = makeWorkspace(rawConfig);
  const runtimeConfig = parseAppConfig(rawConfig);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { sub: 'admin', username: 'admin', role: 'admin', tenantId: DEFAULT_TENANT_ID };
    next();
  });
  app.use('/api/admin/tenant-remote-hands', createTenantRemoteHandsAdminRouter({
    processCwd,
    config: runtimeConfig,
    ...opts,
  }));
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind test server');
  return fn({ baseUrl: `http://127.0.0.1:${address.port}`, configPath, runtimeConfig });
}

async function readJson(response: Response) {
  return response.json() as Promise<any>;
}

describe('tenant remote hands admin router', () => {
  afterEach(() => {
    while (servers.length > 0) servers.pop()?.close();
  });

  it('returns tenant remote hand config without leaking inline authToken', async () => {
    await withApp(baseRawConfig(), async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/admin/tenant-remote-hands`);
      expect(response.status).toBe(200);
      const body = await readJson(response);
      expect(body.tenantRemoteHands.hands[0]).toMatchObject({
        id: 'tenant-ecs',
        authTokenConfigured: true,
        rollout: { mode: 'allowlist', userIds: ['admin'], usernames: ['admin'] },
        networkPolicy: { mode: 'public-egress', denyPrivateNetworks: true },
      });
      expect(body.tenantRemoteHands.hands[0].authToken).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain('tenant-token-123');
    });
  });

  it('updates tenant remote hands while preserving existing authToken by id', async () => {
    const onTenantRemoteHandsUpdated = vi.fn();
    await withApp(baseRawConfig(), async ({ baseUrl, configPath, runtimeConfig }) => {
      const response = await fetch(`${baseUrl}/api/admin/tenant-remote-hands`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tenantRemoteHands: {
            hands: [{
              id: 'tenant-ecs',
              description: 'Updated hand',
              rollout: { mode: 'tenant', tenantIds: ['kaiyan'] },
              baseUrl: 'http://tenant-ecs-hand:3300',
              networkPolicy: { mode: 'isolated', denyPrivateNetworks: true },
              authTokenConfigured: true,
              invokeTimeoutMs: 90000,
            }],
          },
        }),
      });
      expect(response.status).toBe(200);
      const body = await readJson(response);
      expect(body.tenantRemoteHands.hands[0]).toMatchObject({
        id: 'tenant-ecs',
        description: 'Updated hand',
        rollout: { mode: 'tenant', tenantIds: ['kaiyan'] },
        invokeTimeoutMs: 90000,
        networkPolicy: { mode: 'isolated', denyPrivateNetworks: true },
        authTokenConfigured: true,
      });
      expect(body.tenantRemoteHands.hands[0].authToken).toBeUndefined();
      expect(runtimeConfig.tenantRemoteHands?.hands[0]).toMatchObject({
        description: 'Updated hand',
        networkPolicy: { mode: 'isolated', denyPrivateNetworks: true },
        authToken: 'tenant-token-123',
      });
      expect(onTenantRemoteHandsUpdated).toHaveBeenCalledWith(runtimeConfig.tenantRemoteHands);
      const written = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(written.tenantRemoteHands.hands[0].authToken).toBe('tenant-token-123');
      expect(written.tenantRemoteHands.hands[0].preserveAuth).toBeUndefined();
      expect(written.tenantRemoteHands.hands[0].authTokenConfigured).toBeUndefined();
    }, { onTenantRemoteHandsUpdated });
  });

  it('omits default networkPolicy when writing config.json', async () => {
    await withApp(baseRawConfig(), async ({ baseUrl, configPath, runtimeConfig }) => {
      const response = await fetch(`${baseUrl}/api/admin/tenant-remote-hands`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tenantRemoteHands: {
            hands: [{
              id: 'tenant-ecs',
              rollout: { mode: 'all' },
              baseUrl: 'http://tenant-ecs-hand:3300',
              networkPolicy: { mode: 'public-egress', denyPrivateNetworks: true },
              authTokenConfigured: true,
            }],
          },
        }),
      });
      expect(response.status).toBe(200);
      expect(runtimeConfig.tenantRemoteHands?.hands[0].networkPolicy).toMatchObject({
        mode: 'public-egress',
        denyPrivateNetworks: true,
      });
      const written = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(written.tenantRemoteHands.hands[0].networkPolicy).toBeUndefined();
    });
  });

  it('rejects invalid rollout config before writing config.json', async () => {
    await withApp(baseRawConfig(), async ({ baseUrl, configPath }) => {
      const before = readFileSync(configPath, 'utf-8');
      const response = await fetch(`${baseUrl}/api/admin/tenant-remote-hands`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tenantRemoteHands: {
            hands: [{
              id: 'tenant-ecs',
              rollout: { mode: 'allowlist' },
              baseUrl: 'http://tenant-ecs-hand:3300',
              authTokenConfigured: true,
            }],
          },
        }),
      });
      expect(response.status).toBe(400);
      const body = await readJson(response);
      expect(body.error).toContain('allowlist rollout requires userIds or usernames');
      expect(readFileSync(configPath, 'utf-8')).toBe(before);
    });
  });

  it('probes hand health with the configured bearer token', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: 'Bearer tenant-token-123' });
      return new Response(JSON.stringify({ status: 'ok', backend: 'container' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    await withApp(baseRawConfig(), async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/admin/tenant-remote-hands/tenant-ecs/health`, {
        method: 'POST',
      });
      expect(response.status).toBe(200);
      const body = await readJson(response);
      expect(body).toMatchObject({
        id: 'tenant-ecs',
        status: 'ok',
        metadata: { status: 'ok', backend: 'container' },
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }, { fetchImpl });
  });
});
