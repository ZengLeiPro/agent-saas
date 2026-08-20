import type { Server } from 'node:http';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JwtPayload } from '../auth/types.js';
import type { GovernanceCredential } from '../data/credentials/types.js';
import { AliyunConnectorService, type AliyunValidateCredentials } from '../connectors/aliyun.js';
import { ConnectorConnectionStore } from '../connectors/connectionStore.js';
import { resolveGithubRuntimeEnv } from '../connectors/github.js';
import { resolveXRuntimeEnv, type XGovernanceCredentialReader } from '../connectors/x.js';
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

async function createRig(options: {
  legacyWriteGate?: { assertLegacyWriteAllowed(input: { actor: 'user' | 'service'; compatibilityProjection: boolean }): Promise<void> };
  governanceCredentialStore?: XGovernanceCredentialReader;
} = {}): Promise<Rig> {
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
  app.use('/api/connectors', createConnectorsRouter({
    connectionStore, secretVault, aliyunService,
    ...(options.governanceCredentialStore ? { governanceCredentialStore: options.governanceCredentialStore } : {}),
    ...(options.legacyWriteGate ? { legacyWriteGate: options.legacyWriteGate } : {}),
  }));
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

  it('pauses and resumes GitHub without deleting or rotating its credential', async () => {
    const rig = await createRig();
    expect((await rig.request('/api/connectors/github', json('POST', {
      token: 'github_pat_pause_test',
    }))).status).toBe(200);
    const credentialRef = rig.connectionStore.get('alice', 'github')!.credentialRefs.token;

    const pause = await rig.request('/api/connectors/github/runtime', json('PATCH', { runtimeEnabled: false }));
    expect(pause.status).toBe(200);
    expect(await pause.json()).toEqual({ connectorId: 'github', runtimeEnabled: false });
    expect(rig.connectionStore.get('alice', 'github')).toMatchObject({
      status: 'connected',
      credentialRefs: { token: credentialRef },
    });
    expect(await rig.request('/api/connectors/github').then(response => response.json())).toMatchObject({
      connection: { status: 'connected', runtimeEnabled: false },
    });
    await expect(resolveGithubRuntimeEnv(
      { connectionStore: rig.connectionStore, vault: rig.secretVault },
      { userId: 'user-1', username: 'alice', tenantId: 'tenant-a' },
    )).resolves.toEqual({});

    expect((await rig.request('/api/connectors/github/runtime', json('PATCH', { runtimeEnabled: true }))).status).toBe(200);
    await expect(resolveGithubRuntimeEnv(
      { connectionStore: rig.connectionStore, vault: rig.secretVault },
      { userId: 'user-1', username: 'alice', tenantId: 'tenant-a' },
    )).resolves.toEqual({
      GH_TOKEN: 'github_pat_pause_test',
      GITHUB_TOKEN: 'github_pat_pause_test',
    });
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

  it('enforce 封闭 legacy Connector/Credential 写入口，但不影响读取', async () => {
    const gate = {
      assertLegacyWriteAllowed: vi.fn().mockRejectedValue(new Error('sealed')),
    };
    const rig = await createRig({ legacyWriteGate: gate });
    expect((await rig.request('/api/connectors/github')).status).toBe(200);
    const pause = await rig.request('/api/connectors/github/runtime', json('PATCH', { runtimeEnabled: false }));
    expect(pause.status).toBe(200);
    const write = await rig.request('/api/connectors/github', json('POST', { token: 'github_pat_route_test' }));
    expect(write.status).toBe(409);
    expect(await write.json()).toMatchObject({ code: 'MIGRATION_LEGACY_WRITE_SEALED' });
    expect(gate.assertLegacyWriteAllowed).toHaveBeenCalledWith({ actor: 'user', compatibilityProjection: false });
  });

  it('X 连接状态 GET 与 runtime env 直接读取治理 Credential', async () => {
    let governanceCredentials: GovernanceCredential[] = [];
    const governanceCredentialStore = {
      listForOwner: vi.fn().mockImplementation(async () => governanceCredentials),
    } satisfies XGovernanceCredentialReader;
    const rig = await createRig({ governanceCredentialStore });
    const secret = await rig.secretVault.putSecret('user-1', 'connector', JSON.stringify({
      authToken: 'governance-auth', ct0: 'governance-ct0',
    }), {
      actor: 'connector_proxy', userId: 'user-1', tenantId: 'tenant-a', scopes: ['secret:connector:write'],
    }, { connectorId: 'x', tenantId: 'tenant-a', credentialOwnerId: 'user-1' });
    governanceCredentials = [{
      credentialId: 'credential-x', tenantId: 'tenant-a', connectorId: 'x' as const,
      kind: 'personal_grant' as const, ownerUserId: 'user-1', purpose: 'X bird CLI 用户凭据',
      scopeSummary: { scopes: ['x:*'] }, status: 'active' as const, generation: 1,
      secretRef: secret.id, source: 'governance' as const, version: 2,
      createdAt: '2026-08-20T10:00:00.000Z', createdBy: 'user-1',
      updatedAt: '2026-08-20T10:01:00.000Z', updatedBy: 'user-1',
    }];

    const get = await rig.request('/api/connectors/x');
    expect(get.status).toBe(200);
    await expect(get.json()).resolves.toMatchObject({ connection: {
      connectorId: 'x', status: 'connected', credentialId: 'credential-x', credentialVersion: 2,
    } });
    await expect(resolveXRuntimeEnv({
      connectionStore: rig.connectionStore,
      vault: rig.secretVault,
      governanceCredentialStore,
    }, { userId: 'user-1', username: 'alice', tenantId: 'tenant-a' })).resolves.toMatchObject({
      AUTH_TOKEN: 'governance-auth', CT0: 'governance-ct0',
    });
  });

  it('connects, pauses, resumes and disconnects X cookie credentials without returning secrets', async () => {
    const rig = await createRig();
    const connect = await rig.request('/api/connectors/x', json('POST', {
      authToken: 'auth-route-test',
      ct0: 'ct0-route-test',
    }));
    expect(connect.status).toBe(200);
    const connected = await connect.json() as { connection: Record<string, unknown> };
    expect(connected.connection).toMatchObject({ connectorId: 'x', status: 'connected', runtimeEnabled: true });
    expect(JSON.stringify(connected)).not.toContain('auth-route-test');
    expect(JSON.stringify(connected)).not.toContain('ct0-route-test');

    await expect(resolveXRuntimeEnv(
      { connectionStore: rig.connectionStore, vault: rig.secretVault },
      { userId: 'user-1', username: 'alice', tenantId: 'tenant-a' },
    )).resolves.toMatchObject({
      AUTH_TOKEN: 'auth-route-test',
      CT0: 'ct0-route-test',
    });

    const pause = await rig.request('/api/connectors/x/runtime', json('PATCH', { runtimeEnabled: false }));
    expect(pause.status).toBe(200);
    await expect(resolveXRuntimeEnv(
      { connectionStore: rig.connectionStore, vault: rig.secretVault },
      { userId: 'user-1', username: 'alice', tenantId: 'tenant-a' },
    )).resolves.toEqual({});

    expect((await rig.request('/api/connectors/x/runtime', json('PATCH', { runtimeEnabled: true }))).status).toBe(200);
    expect((await rig.request('/api/connectors/x', { method: 'DELETE' })).status).toBe(200);
    expect(rig.connectionStore.get('alice', 'x')).toMatchObject({ status: 'disconnected', credentialRefs: {} });
    await expect(resolveXRuntimeEnv(
      { connectionStore: rig.connectionStore, vault: rig.secretVault },
      { userId: 'user-1', username: 'alice', tenantId: 'tenant-a' },
    )).resolves.toEqual({});
  });

  it('rejects incomplete X cookie credentials', async () => {
    const rig = await createRig();
    expect((await rig.request('/api/connectors/x', json('POST', { authToken: 'auth-only', ct0: ' ' }))).status).toBe(400);
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
