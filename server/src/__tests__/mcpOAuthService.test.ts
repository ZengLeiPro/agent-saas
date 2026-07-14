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
  await store.installBuiltinOAuthServers();
  const vault = new InMemorySecretVault();
  return { root, configPath, store, vault };
}

describe('McpOAuthService', () => {
  it('按用户保存 PKCE/OAuth token，并用一次性 state 完成回调', async () => {
    const { configPath, store, vault } = await fixture();
    const authFn = vi.fn(async (provider, options) => {
      if (!options.authorizationCode) {
        await provider.saveClientInformation?.({ client_id: 'dynamic-client' });
        await provider.saveCodeVerifier('pkce-verifier');
        const state = await provider.state?.();
        await provider.redirectToAuthorization(new URL(`https://github.com/login/oauth/authorize?state=${state}`));
        return 'REDIRECT' as const;
      }
      expect(options.authorizationCode).toBe('authorization-code');
      await expect(provider.codeVerifier()).resolves.toBe('pkce-verifier');
      await provider.saveTokens({ access_token: 'user-access-token', refresh_token: 'user-refresh-token', token_type: 'bearer' });
      return 'AUTHORIZED' as const;
    });
    const service = new McpOAuthService({ store, vault, authFn });
    const server = store.getServer('github')!;

    const started = await service.start({
      username: 'alice',
      tenantId: 'kaiyan',
      server,
      redirectUrl: 'https://agent.example.com/api/mcp/oauth/callback',
      returnTo: '/?tab=capabilities',
    });
    expect(started.status).toBe('pending');
    expect(started.authorizationUrl).toContain('github.com/login/oauth/authorize');
    const pending = store.getUserOAuthConnection('alice', 'github')!;
    expect(pending.secretRef).toBeTruthy();
    expect(pending.pendingState).toBeTruthy();
    expect(await readFile(configPath, 'utf-8')).not.toContain('user-access-token');

    const finished = await service.finish({ state: pending.pendingState!, code: 'authorization-code' });
    expect(finished?.ok).toBe(true);
    expect(store.getUserOAuthConnection('alice', 'github')?.status).toBe('connected');
    expect(await readFile(configPath, 'utf-8')).not.toContain('user-access-token');
    await expect(service.finish({ state: pending.pendingState!, code: 'replay' })).resolves.toBeUndefined();

    const runtimeProvider = await service.runtimeProvider({ username: 'alice', tenantId: 'kaiyan', serverName: 'github' });
    await expect(runtimeProvider?.tokens()).resolves.toMatchObject({ access_token: 'user-access-token' });
    await expect(service.runtimeProvider({ username: 'alice', tenantId: 'wain', serverName: 'github' })).resolves.toBeUndefined();
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
    const server = store.getServer('github')!;
    await service.start({ username: 'alice', tenantId: 'kaiyan', server, redirectUrl: 'https://agent.example.com/api/mcp/oauth/callback', returnTo: '/' });
    const state = store.getUserOAuthConnection('alice', 'github')!.pendingState!;

    const result = await service.finish({ state, code: 'code' });
    expect(result).toMatchObject({ ok: false, tenantId: 'kaiyan' });
    expect(store.getUserOAuthConnection('alice', 'github')?.status).toBe('error');
    expect(authFn).toHaveBeenCalledTimes(1);
  });

  it('安装内置预设时不覆盖管理员已有的同 id 配置', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-preset-'));
    roots.push(root);
    const store = new McpConfigStore(join(root, 'mcp-config.json'));
    await store.upsertServer({
      id: 'github',
      name: 'Existing GitHub',
      tenantId: '*',
      config: { type: 'streamable-http', url: 'https://existing.example.com/mcp' },
    });
    expect(await store.installBuiltinOAuthServers()).toBe(6);
    expect(store.getServer('github')).toMatchObject({
      name: 'Existing GitHub',
      config: { url: 'https://existing.example.com/mcp' },
    });
    await expect(store.installBuiltinOAuthServers()).resolves.toBe(0);
  });
});
