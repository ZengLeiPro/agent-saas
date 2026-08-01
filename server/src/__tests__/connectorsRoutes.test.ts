import type { Server } from 'node:http';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { JwtPayload } from '../auth/types.js';
import { ConnectorConnectionStore } from '../connectors/connectionStore.js';
import { resolveGithubRuntimeEnv } from '../connectors/github.js';
import { createConnectorsRouter } from '../routes/connectors.js';
import { InMemorySecretVault } from '../security/secretVault.js';

interface Rig {
  request(path: string, init?: RequestInit): Promise<Response>;
  connectionStore: ConnectorConnectionStore;
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
  const secretVault = new InMemorySecretVault();
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
  app.use('/api/connectors', createConnectorsRouter({ connectionStore, secretVault }));
  const server: Server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const address = server.address();
  const baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
  const rig: Rig = {
    connectionStore,
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
  it('connects GitHub and exposes the credential only through native runtime env', async () => {
    const rig = await createRig();

    const connect = await rig.request('/api/connectors/github', json('POST', {
      token: 'github_pat_route_test',
    }));
    expect(connect.status).toBe(200);
    const body = await connect.json() as { connection: Record<string, unknown> };
    expect(body.connection).toMatchObject({ status: 'connected' });
    expect(body.connection).not.toHaveProperty('credentialRefs');
    expect(body.connection).not.toHaveProperty('mcpEnabled');

    await expect(resolveGithubRuntimeEnv(
      { connectionStore: rig.connectionStore, vault: rig.secretVault },
      { userId: 'user-1', username: 'alice', tenantId: 'tenant-a' },
    )).resolves.toEqual({
      GH_TOKEN: 'github_pat_route_test',
      GITHUB_TOKEN: 'github_pat_route_test',
    });

    const legacyMcpToggle = await rig.request('/api/connectors/github', json('PATCH', { mcpEnabled: true }));
    expect(legacyMcpToggle.status).toBe(410);
  });

  it('disconnects and revokes the active credential', async () => {
    const rig = await createRig();
    expect((await rig.request('/api/connectors/github', json('PUT', {
      token: 'ghp_route_test',
    }))).status).toBe(200);

    expect((await rig.request('/api/connectors/github', { method: 'DELETE' })).status).toBe(200);
    expect(rig.connectionStore.get('alice', 'github')).toMatchObject({
      status: 'disconnected',
      credentialRefs: {},
    });
    await expect(resolveGithubRuntimeEnv(
      { connectionStore: rig.connectionStore, vault: rig.secretVault },
      { userId: 'user-1', username: 'alice', tenantId: 'tenant-a' },
    )).resolves.toEqual({});
  });

  it('rejects invalid tokens', async () => {
    const rig = await createRig();
    expect((await rig.request('/api/connectors/github', json('POST', { token: 'not-a-token' }))).status).toBe(400);
  });
});
