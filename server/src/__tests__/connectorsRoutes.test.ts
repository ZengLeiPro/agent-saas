import type { Server } from 'node:http';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JwtPayload } from '../auth/types.js';
import { ConnectorConnectionStore } from '../connectors/connectionStore.js';
import { resolveGithubRuntimeEnv } from '../connectors/github.js';
import { McpConfigStore } from '../data/mcpConfig.js';
import type { McpClientManager } from '../mcp/clientManager.js';
import { createConnectorsRouter } from '../routes/connectors.js';
import { InMemorySecretVault } from '../security/secretVault.js';

interface Rig {
  request(path: string, init?: RequestInit): Promise<Response>;
  connectionStore: ConnectorConnectionStore;
  mcpConfigStore: McpConfigStore;
  secretVault: InMemorySecretVault;
  close(): Promise<void>;
}

const rigs: Rig[] = [];
afterEach(async () => {
  await Promise.all(rigs.splice(0).map(rig => rig.close()));
});

async function createRig(): Promise<Rig> {
  const root = mkdtempSync(join(tmpdir(), 'connectors-route-'));
  const connectionStore = new ConnectorConnectionStore(join(root, 'connections.json'));
  const mcpConfigStore = new McpConfigStore(join(root, 'mcp.json'));
  await mcpConfigStore.installBuiltinOAuthServers();
  const secretVault = new InMemorySecretVault();
  const invalidateUser = vi.fn(async () => undefined);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      sub: 'user-1',
      username: 'alice',
      tenantId: 'tenant-a',
      role: 'user',
    } satisfies JwtPayload;
    next();
  });
  app.use('/api/connectors', createConnectorsRouter({
    connectionStore,
    mcpConfigStore,
    mcpClientManager: { invalidateUser } as unknown as McpClientManager,
    secretVault,
  }));
  const server: Server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const address = server.address();
  const baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
  const rig: Rig = {
    connectionStore,
    mcpConfigStore,
    secretVault,
    request: (path, init) => fetch(`${baseUrl}${path}`, init),
    close: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    },
  };
  rigs.push(rig);
  return rig;
}

function json(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

describe('native connectors routes', () => {
  it('connects GitHub once and serves both native env and optional MCP adapter', async () => {
    const rig = await createRig();

    const connect = await rig.request('/api/connectors/github', json('PUT', {
      token: 'github_pat_route_test',
      mcpEnabled: true,
    }));
    expect(connect.status).toBe(200);
    const body = await connect.json() as { connection: Record<string, unknown> };
    expect(body.connection).toMatchObject({ status: 'connected', mcpEnabled: true });
    expect(body.connection).not.toHaveProperty('credentialRefs');

    expect(rig.mcpConfigStore.getUserConfig('alice').enabledServers).toContain('github');
    expect(rig.mcpConfigStore.getUserSecretRef('alice', 'github', 'token')).toBeUndefined();
    await expect(resolveGithubRuntimeEnv(
      { connectionStore: rig.connectionStore, vault: rig.secretVault },
      { username: 'alice', tenantId: 'tenant-a' },
    )).resolves.toEqual({
      GH_TOKEN: 'github_pat_route_test',
      GITHUB_TOKEN: 'github_pat_route_test',
    });

    const toggle = await rig.request('/api/connectors/github', json('PATCH', { mcpEnabled: false }));
    expect(toggle.status).toBe(200);
    expect(rig.mcpConfigStore.getUserConfig('alice').enabledServers).not.toContain('github');
    expect(rig.connectionStore.get('alice', 'github')).toMatchObject({
      status: 'connected',
      capabilities: { mcp: false },
    });
  });

  it('disconnects without allowing a legacy MCP ref to resurrect the account', async () => {
    const rig = await createRig();
    expect((await rig.request('/api/connectors/github', json('PUT', {
      token: 'ghp_route_test',
      mcpEnabled: true,
    }))).status).toBe(200);

    expect((await rig.request('/api/connectors/github', { method: 'DELETE' })).status).toBe(200);
    expect(rig.connectionStore.get('alice', 'github')).toMatchObject({
      status: 'disconnected',
      credentialRefs: {},
      capabilities: { mcp: false },
    });
    await expect(resolveGithubRuntimeEnv(
      { connectionStore: rig.connectionStore, vault: rig.secretVault },
      { username: 'alice', tenantId: 'tenant-a' },
    )).resolves.toEqual({});
  });

  it('rejects invalid tokens and enabling MCP before connection', async () => {
    const rig = await createRig();
    expect((await rig.request('/api/connectors/github', json('PUT', { token: 'not-a-token' }))).status).toBe(400);
    expect((await rig.request('/api/connectors/github', json('PATCH', { mcpEnabled: true }))).status).toBe(409);
  });
});
