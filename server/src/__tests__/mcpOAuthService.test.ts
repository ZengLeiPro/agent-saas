import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { McpConfigStore } from '../data/mcpConfig.js';
import { McpOAuthService } from '../mcp/oauthService.js';
import { InMemorySecretVault } from '../security/secretVault.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mcp-oauth-'));
  roots.push(root);
  const configPath = join(root, 'mcp-config.json');
  const store = new McpConfigStore(configPath);
  await store.upsertServer({
    id: 'notion',
    name: 'Synthetic OAuth MCP',
    tenantId: '*',
    config: {
      type: 'streamable-http',
      url: 'https://example.com/mcp',
      oauth: { provider: 'notion' },
    },
  });
  await store.upsertServer({
    id: 'google_drive',
    name: 'Synthetic Google OAuth MCP',
    tenantId: '*',
    config: {
      type: 'streamable-http',
      url: 'https://example.com/google-mcp',
      oauth: {
        provider: 'google-workspace',
        beta: true,
        clientIdEnv: 'GOOGLE_MCP_OAUTH_CLIENT_ID',
        clientSecretEnv: 'GOOGLE_MCP_OAUTH_CLIENT_SECRET',
      },
    },
  });
  const vault = new InMemorySecretVault();
  return { root, configPath, store, vault };
}

describe('McpOAuthService', () => {
  it('CIMD 文档包含与公开 metadata URL 完全一致的 client_id', async () => {
    const { store, vault } = await fixture();
    const service = new McpOAuthService({ store, vault });

    expect(service.clientMetadata('https://api.example.com/api/mcp/oauth/callback')).toMatchObject({
      client_id: 'https://api.example.com/api/mcp/oauth/client-metadata',
      client_name: '开沿 AI 员工',
      redirect_uris: ['https://api.example.com/api/mcp/oauth/callback'],
      token_endpoint_auth_method: 'none',
    });
  });

  it('按用户保存 PKCE/OAuth token，并用一次性 state 完成回调', async () => {
    const { configPath, store, vault } = await fixture();
    const authFn = vi.fn(async (provider, options) => {
      if (!options.authorizationCode) {
        await provider.saveClientInformation?.({ client_id: 'dynamic-client' });
        await provider.saveCodeVerifier('pkce-verifier');
        const state = await provider.state?.();
        await provider.redirectToAuthorization(new URL(`https://mcp.notion.com/authorize?state=${state}`));
        return 'REDIRECT' as const;
      }
      expect(options.authorizationCode).toBe('authorization-code');
      await expect(provider.codeVerifier()).resolves.toBe('pkce-verifier');
      await provider.saveTokens({ access_token: 'user-access-token', refresh_token: 'user-refresh-token', token_type: 'bearer' });
      return 'AUTHORIZED' as const;
    });
    const service = new McpOAuthService({ store, vault, authFn });
    const server = store.getServer('notion')!;

    const started = await service.start({
      username: 'alice',
      tenantId: 'kaiyan',
      server,
      redirectUrl: 'https://agent.example.com/api/mcp/oauth/callback',
      returnTo: '/?tab=capabilities',
    });
    expect(started.status).toBe('pending');
    expect(started.authorizationUrl).toContain('mcp.notion.com/authorize');
    const pending = store.getUserOAuthConnection('alice', 'notion')!;
    expect(pending.secretRef).toBeTruthy();
    expect(pending.pendingState).toBeTruthy();
    expect(await readFile(configPath, 'utf-8')).not.toContain('user-access-token');

    const finished = await service.finish({ state: pending.pendingState!, code: 'authorization-code' });
    expect(finished?.ok).toBe(true);
    expect(store.getUserOAuthConnection('alice', 'notion')?.status).toBe('connected');
    expect(await readFile(configPath, 'utf-8')).not.toContain('user-access-token');
    await expect(service.finish({ state: pending.pendingState!, code: 'replay' })).resolves.toBeUndefined();

    const runtimeProvider = await service.runtimeProvider({ username: 'alice', tenantId: 'kaiyan', serverName: 'notion' });
    await expect(runtimeProvider?.tokens()).resolves.toMatchObject({ access_token: 'user-access-token' });
    await expect(service.runtimeProvider({ username: 'alice', tenantId: 'wain', serverName: 'notion' })).resolves.toBeUndefined();
  });

  it('断开连接后撤销 vault secret，不影响其他用户', async () => {
    const { store, vault } = await fixture();
    const authFn = async (provider: Parameters<NonNullable<ConstructorParameters<typeof McpOAuthService>[0]['authFn']>>[0], options: Parameters<NonNullable<ConstructorParameters<typeof McpOAuthService>[0]['authFn']>>[1]) => {
      if (!options.authorizationCode) {
        await provider.saveClientInformation?.({ client_id: 'dynamic-client' });
        await provider.saveCodeVerifier('verifier');
        await provider.redirectToAuthorization(new URL(`https://auth.example.com/?state=${await provider.state?.()}`));
        return 'REDIRECT' as const;
      }
      await provider.saveTokens({ access_token: `token-${options.authorizationCode}`, token_type: 'bearer' });
      return 'AUTHORIZED' as const;
    };
    const service = new McpOAuthService({ store, vault, authFn });
    const server = store.getServer('notion')!;
    for (const username of ['alice', 'bob']) {
      await service.start({ username, tenantId: 'kaiyan', server, redirectUrl: 'https://agent.example.com/api/mcp/oauth/callback', returnTo: '/' });
      const state = store.getUserOAuthConnection(username, 'notion')!.pendingState!;
      await service.finish({ state, code: username });
    }

    await service.disconnect('alice', 'kaiyan', 'notion');
    expect(store.getUserOAuthConnection('alice', 'notion')).toBeUndefined();
    expect(store.getUserOAuthConnection('bob', 'notion')?.status).toBe('connected');
    await expect(service.runtimeProvider({ username: 'alice', tenantId: 'kaiyan', serverName: 'notion' })).resolves.toBeUndefined();
    await expect(service.runtimeProvider({ username: 'bob', tenantId: 'kaiyan', serverName: 'notion' })).resolves.toBeTruthy();
  });

  it('Google 预设在平台 OAuth client 未配置时 fail closed', async () => {
    const { store, vault } = await fixture();
    const service = new McpOAuthService({ store, vault, env: {} });
    const server = store.getServer('google_drive')!;
    expect(service.summary('alice', server)).toMatchObject({
      provider: 'google-workspace',
      beta: true,
      platformConfigured: false,
      status: 'disconnected',
    });
    await expect(service.start({
      username: 'alice',
      tenantId: 'kaiyan',
      server,
      redirectUrl: 'https://agent.example.com/api/mcp/oauth/callback',
      returnTo: '/',
    })).rejects.toThrow(/GOOGLE_MCP_OAUTH_CLIENT_ID/);
  });

  it('回调期间用户组织发生变化时拒绝交换 token', async () => {
    const { store, vault } = await fixture();
    const authFn = vi.fn(async (provider, options) => {
      if (!options.authorizationCode) {
        await provider.saveClientInformation?.({ client_id: 'dynamic-client' });
        await provider.saveCodeVerifier('verifier');
        await provider.redirectToAuthorization(new URL(`https://auth.example.com/?state=${await provider.state?.()}`));
        return 'REDIRECT' as const;
      }
      await provider.saveTokens({ access_token: 'must-not-be-saved', token_type: 'bearer' });
      return 'AUTHORIZED' as const;
    });
    const service = new McpOAuthService({
      store,
      vault,
      authFn,
      userResolver: () => ({ tenantId: 'wain' }),
    });
    const server = store.getServer('notion')!;
    await service.start({ username: 'alice', tenantId: 'kaiyan', server, redirectUrl: 'https://agent.example.com/api/mcp/oauth/callback', returnTo: '/' });
    const state = store.getUserOAuthConnection('alice', 'notion')!.pendingState!;

    const result = await service.finish({ state, code: 'code' });
    expect(result).toMatchObject({ ok: false, tenantId: 'kaiyan' });
    expect(store.getUserOAuthConnection('alice', 'notion')?.status).toBe('error');
    expect(authFn).toHaveBeenCalledTimes(1);
  });

  it('v5 不再安装能力中心内置 MCP preset，也不覆盖管理员自建服务', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-preset-'));
    roots.push(root);
    const store = new McpConfigStore(join(root, 'mcp-config.json'));
    await store.upsertServer({
      id: 'github',
      name: 'Existing GitHub',
      tenantId: '*',
      config: { type: 'streamable-http', url: 'https://existing.example.com/mcp' },
    });
    expect(await store.installBuiltinOAuthServers()).toBe(0);
    expect(store.getServer('github')).toMatchObject({
      name: 'Existing GitHub',
      config: { url: 'https://existing.example.com/mcp' },
    });
    await expect(store.installBuiltinOAuthServers()).resolves.toBe(0);
  });

  it('v5 会从用户 MCP 选择中移除旧的内置连接器，但保留管理员同名自建服务', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-preset-v5-'));
    roots.push(root);
    const file = join(root, 'mcp-config.json');
    const store = new McpConfigStore(file);
    await store.upsertServer({
      id: 'notion',
      name: 'Legacy Notion',
      tenantId: '*',
      createdFromTemplateId: 'notion',
      createdFromTemplateVersion: 1,
      config: { type: 'streamable-http', url: 'https://mcp.notion.com/mcp' },
    });
    await store.upsertServer({
      id: 'custom',
      name: 'Custom',
      tenantId: '*',
      config: { type: 'streamable-http', url: 'https://example.com/mcp' },
    });
    await store.setUserEnabledServers('alice', ['notion', 'custom']);
    const raw = JSON.parse(await readFile(file, 'utf-8')) as any;
    raw.builtinPresetsVersion = 4;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, JSON.stringify(raw));

    const upgraded = new McpConfigStore(file);
    await upgraded.installBuiltinOAuthServers();
    expect(upgraded.getUserConfig('alice').enabledServers).toEqual(['custom']);
    expect(upgraded.listServersVisibleToUser('alice', '*').map(server => server.id)).toEqual(['custom']);
  });
});
