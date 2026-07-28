import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GLOBAL_TENANT_ID, McpConfigStore } from '../data/mcpConfig.js';
import { resolveConnectorRuntimeEnv } from '../mcp/connectorRuntimeEnv.js';
import { InMemorySecretVault, GLOBAL_OWNER_ID, tenantOwnerId } from '../security/secretVault.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeStore(): McpConfigStore {
  const root = mkdtempSync(join(tmpdir(), 'connector-runtime-env-'));
  roots.push(root);
  return new McpConfigStore(join(root, 'mcp-config.json'));
}

const userCaller = { actor: 'mcp_proxy' as const, userId: 'alice', tenantId: 'tenant-a', scopes: ['secret:mcp:read'] };
const adminCaller = { actor: 'admin' as const, userId: 'admin', tenantId: 'tenant-a', scopes: ['secret:mcp:write'] };

describe('resolveConnectorRuntimeEnv', () => {
  it('注入已启用连接器的 env secret 与额外 runtimeEnv', async () => {
    const store = makeStore();
    const vault = new InMemorySecretVault();
    await store.upsertServer({
      id: 'github',
      name: 'GitHub',
      tenantId: GLOBAL_TENANT_ID,
      config: { type: 'streamable-http', url: 'https://api.githubcopilot.com/mcp/' },
      secretRequirements: [{
        key: 'token', label: 'Token', target: 'header', name: 'Authorization', scope: 'user',
        runtimeEnv: ['GH_TOKEN', 'GITHUB_TOKEN'],
      }],
    });
    await store.upsertServer({
      id: 'env_connector',
      name: 'Env Connector',
      tenantId: 'tenant-a',
      config: { type: 'stdio', command: 'env-connector' },
      secretRequirements: [{
        key: 'api_key', label: 'API key', target: 'env', name: 'CONNECTOR_API_KEY', scope: 'user',
      }],
    });
    await store.setUserEnabledServers('alice', ['github', 'env_connector'], 'tenant-a');
    const githubRef = await vault.putSecret('alice', 'mcp', 'gh_secret', userCaller);
    const envRef = await vault.putSecret('alice', 'mcp', 'env_secret', userCaller);
    await store.setUserSecretRef('alice', 'github', 'token', githubRef.id);
    await store.setUserSecretRef('alice', 'env_connector', 'api_key', envRef.id);

    await expect(resolveConnectorRuntimeEnv({ store, vault }, { username: 'alice', tenantId: 'tenant-a' })).resolves.toEqual({
      GH_TOKEN: 'gh_secret',
      GITHUB_TOKEN: 'gh_secret',
      CONNECTOR_API_KEY: 'env_secret',
    });
  });

  it('支持 tenant/global secret，禁用连接器不注入', async () => {
    const store = makeStore();
    const vault = new InMemorySecretVault();
    const tenantRef = await vault.putSecret(tenantOwnerId('tenant-a'), 'mcp', 'tenant_secret', adminCaller);
    const globalRef = await vault.putSecret(GLOBAL_OWNER_ID, 'mcp', 'global_secret', { ...adminCaller, role: 'admin', scopes: ['secret:mcp:write', 'secret:global:write'] });
    await store.upsertServer({
      id: 'scoped',
      name: 'Scoped',
      tenantId: 'tenant-a',
      config: { type: 'stdio', command: 'scoped' },
      secretRequirements: [
        { key: 'tenant', label: 'Tenant', target: 'env', name: 'TENANT_TOKEN', scope: 'tenant' },
        { key: 'global', label: 'Global', target: 'env', name: 'GLOBAL_TOKEN', scope: 'global' },
      ],
      secretRefs: { tenant: tenantRef.id, global: globalRef.id },
    });
    await store.setUserEnabledServers('alice', [], 'tenant-a');
    await expect(resolveConnectorRuntimeEnv({ store, vault }, { username: 'alice', tenantId: 'tenant-a' })).resolves.toEqual({});

    await store.setUserEnabledServers('alice', ['scoped'], 'tenant-a');
    await expect(resolveConnectorRuntimeEnv({ store, vault }, { username: 'alice', tenantId: 'tenant-a' })).resolves.toEqual({
      TENANT_TOKEN: 'tenant_secret',
      GLOBAL_TOKEN: 'global_secret',
    });
  });

  it('OAuth access token 按 connector 声明注入，单个坏连接器 fail-open', async () => {
    const store = makeStore();
    const vault = new InMemorySecretVault();
    await store.upsertServer({
      id: 'oauth_connector',
      name: 'OAuth',
      tenantId: 'tenant-a',
      config: {
        type: 'streamable-http',
        url: 'https://oauth.example.com/mcp',
        oauth: { provider: 'generic', runtimeEnv: ['OAUTH_TOKEN'] },
      },
    });
    await store.upsertServer({
      id: 'broken',
      name: 'Broken',
      tenantId: 'tenant-a',
      config: { type: 'stdio', command: 'broken' },
      secretRequirements: [{ key: 'token', label: 'Token', target: 'env', name: 'BROKEN_TOKEN', scope: 'user' }],
    });
    await store.setUserEnabledServers('alice', ['broken', 'oauth_connector'], 'tenant-a');
    await store.setUserSecretRef('alice', 'broken', 'token', 'missing-secret');
    const onError = vi.fn();
    const oauthService = {
      runtimeAccessToken: vi.fn().mockResolvedValue('oauth_secret'),
    };

    await expect(resolveConnectorRuntimeEnv({
      store,
      vault,
      oauthService: oauthService as never,
      onError,
    }, { username: 'alice', tenantId: 'tenant-a' })).resolves.toEqual({ OAUTH_TOKEN: 'oauth_secret' });
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { serverId: 'broken', source: 'secret' });
  });
});
