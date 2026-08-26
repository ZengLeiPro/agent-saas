import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { initializeRuntimeGovernanceCredentials } from '../app/runtimeGovernanceCredentials.js';
import { ConnectorConnectionStore } from '../connectors/connectionStore.js';
import { GoogleWorkspaceOAuthService, resolveGoogleWorkspaceRuntimeEnv } from '../connectors/googleWorkspace.js';
import type { AppConfig } from '../types/index.js';

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('initializeRuntimeGovernanceCredentials', () => {
  it('生产 PG 模式默认使用跨进程共享的加密 Vault', async () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-governance-credentials-'));
    roots.push(root);
    vi.stubEnv('NODE_ENV', 'production');
    const config = {
      auth: { enabled: true, jwtSecret: 'runtime-governance-test-secret-32-chars', tokenExpiresIn: '30d', usersFile: './data/users.json' },
      runtimeEventStore: { backend: 'pg', connectionString: 'postgres://unused.example/test' },
    } as AppConfig;

    const first = await initializeRuntimeGovernanceCredentials(config, root);
    const caller = {
      actor: 'connector_proxy' as const,
      userId: 'user-1',
      tenantId: 'tenant-a',
      scopes: ['secret:connector:write', 'secret:connector:read'],
    };
    const ref = await first.secretVault.putSecret('user-1', 'connector', JSON.stringify({
      accessToken: 'google-access-token',
      refreshToken: 'google-refresh-token',
      expiresAt: Date.now() + 3_600_000,
      scope: 'openid',
    }), caller);
    const connectionStore = new ConnectorConnectionStore(join(root, 'connector-connections.json'));
    await connectionStore.connect({
      username: 'alice', userId: 'user-1', tenantId: 'tenant-a', connectorId: 'google-workspace',
      credentialRefs: { oauth: ref.id }, metadata: { credentialOwnerId: 'user-1', grantedScopes: 'openid' },
    });

    const worker = await initializeRuntimeGovernanceCredentials(config, root);
    const service = new GoogleWorkspaceOAuthService({
      clientId: 'client-id', clientSecret: 'client-secret', connectionStore, vault: worker.secretVault,
      authorizeSubject: async () => true, authorizeGrant: async () => true, authorizeConnect: async () => true,
    });
    await expect(resolveGoogleWorkspaceRuntimeEnv(service, {
      userId: 'user-1', username: 'alice', tenantId: 'tenant-a',
    })).resolves.toEqual({ GOOGLE_WORKSPACE_CLI_TOKEN: 'google-access-token' });

    const [webRef, workerRef] = await Promise.all([
      first.secretVault.putSecret('user-1', 'connector', 'web-secret', caller),
      worker.secretVault.putSecret('user-1', 'connector', 'worker-secret', caller),
    ]);
    await expect(first.secretVault.getSecret(webRef.id, caller)).resolves.toBe('web-secret');
    await expect(first.secretVault.getSecret(workerRef.id, caller)).resolves.toBe('worker-secret');
  });

  it('显式 memory 配置仍保留进程隔离语义', async () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-governance-credentials-'));
    roots.push(root);
    vi.stubEnv('NODE_ENV', 'production');
    const config = {
      auth: { enabled: true, jwtSecret: 'runtime-governance-test-secret-32-chars', tokenExpiresIn: '30d', usersFile: './data/users.json' },
      runtimeEventStore: { backend: 'pg', connectionString: 'postgres://unused.example/test' },
      secretVault: { backend: 'memory' },
    } as AppConfig;

    const first = await initializeRuntimeGovernanceCredentials(config, root);
    const caller = {
      actor: 'connector_proxy' as const,
      userId: 'user-1',
      tenantId: 'tenant-a',
      scopes: ['secret:connector:write', 'secret:connector:read'],
    };
    const ref = await first.secretVault.putSecret('user-1', 'connector', 'google-access-token', caller);

    const worker = await initializeRuntimeGovernanceCredentials(config, root);
    await expect(worker.secretVault.getSecret(ref.id, caller)).rejects.toThrow(/secret not found/);
  });
});
