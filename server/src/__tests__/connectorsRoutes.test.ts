import type { Server } from 'node:http';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JwtPayload } from '../auth/types.js';
import { AliyunConnectorService, type AliyunValidateCredentials } from '../connectors/aliyun.js';
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
  const aliyunService = new AliyunConnectorService({
    connectionStore,
    vault: secretVault,
    validateCredentials: vi.fn<AliyunValidateCredentials>().mockResolvedValue({
      accountId: '1234567890123456',
      arn: 'acs:ram::1234567890123456:user/agent-saas',
      identityType: 'RAMUser',
    }),
  });
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
  app.use('/api/connectors', createConnectorsRouter({ connectionStore, secretVault, aliyunService }));
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
    const stored = rig.connectionStore.get('alice', 'github')!;
    const tokenRef = stored.credentialRefs.token!;
    expect(stored.metadata?.credentialOwnerId).toBe('user-1');
    await expect(rig.secretVault.getSecret(tokenRef, {
      actor: 'connector_proxy',
      userId: 'user-1',
      tenantId: 'tenant-a',
      scopes: ['secret:connector:read'],
    })).resolves.toBe('github_pat_route_test');
    await expect(rig.secretVault.getSecret(tokenRef, {
      actor: 'connector_proxy',
      userId: 'alice',
      tenantId: 'tenant-a',
      scopes: ['secret:connector:read'],
    })).rejects.toThrow(/user owner mismatch/);

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

  it('connects, reads and disconnects an Aliyun AccessKey without returning secrets', async () => {
    const rig = await createRig();
    const connect = await rig.request('/api/connectors/aliyun', json('POST', {
      accessKeyId: 'LTAIroute',
      accessKeySecret: 'source-route-secret',
      regionId: 'cn-shenzhen',
    }));
    expect(connect.status).toBe(200);
    const connected = await connect.json() as { connection: Record<string, unknown> };
    expect(connected.connection).toMatchObject({
      status: 'connected',
      accountId: '1234567890123456',
      identityArn: 'acs:ram::1234567890123456:user/agent-saas',
      identityType: 'RAMUser',
      regionId: 'cn-shenzhen',
    });
    expect(JSON.stringify(connected)).not.toContain('source-route-secret');
    expect(JSON.stringify(connected)).not.toContain('LTAIroute');

    const get = await rig.request('/api/connectors/aliyun');
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({ connection: { status: 'connected' } });

    const disconnect = await rig.request('/api/connectors/aliyun', { method: 'DELETE' });
    expect(disconnect.status).toBe(200);
    expect(await disconnect.json()).toMatchObject({ connection: { status: 'disconnected' } });
  });
});
