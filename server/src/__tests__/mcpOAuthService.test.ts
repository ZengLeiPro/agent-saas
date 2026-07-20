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

  it('presets v2：存量内置 github OAuth 实例就地升级为 v3 PAT 模式，保留 tenantId', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-preset-v2-'));
    roots.push(root);
    const store = new McpConfigStore(join(root, 'mcp-config.json'));
    await store.installBuiltinOAuthServers();
    // 手工降级 github 到 v2 OAuth 旧形态，并把版本标记退回 1，模拟旧生产数据 + 新代码首启
    await store.upsertServer({
      id: 'github',
      name: 'GitHub',
      tenantId: '*',
      createdFromTemplateId: 'github',
      createdFromTemplateVersion: 2,
      config: { type: 'streamable-http', url: 'https://api.githubcopilot.com/mcp/', oauth: { provider: 'github' } },
      secretRequirements: [],
    });
    const raw = JSON.parse(await readFile(join(root, 'mcp-config.json'), 'utf-8')) as Record<string, unknown>;
    raw.builtinPresetsVersion = 1;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(root, 'mcp-config.json'), JSON.stringify(raw));

    const store2 = new McpConfigStore(join(root, 'mcp-config.json'));
    await store2.installBuiltinOAuthServers();
    const upgraded = store2.getServer('github')!;
    expect(upgraded.createdFromTemplateVersion).toBe(3);
    expect(upgraded.tenantId).toBe('*');
    expect('oauth' in upgraded.config && upgraded.config.oauth).toBeFalsy();
    expect(upgraded.secretRequirements?.[0]).toMatchObject({ key: 'token', target: 'header', name: 'Authorization', scope: 'user' });
  });
});
