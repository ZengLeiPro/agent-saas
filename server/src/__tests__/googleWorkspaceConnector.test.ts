import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConnectorConnectionStore } from '../connectors/connectionStore.js';
import {
  GOOGLE_WORKSPACE_REQUESTED_SCOPES,
  GoogleWorkspaceOAuthService,
  InMemoryGoogleWorkspaceOAuthStateStore,
  resolveGoogleWorkspaceRuntimeEnv,
} from '../connectors/googleWorkspace.js';
import type { UserInfo } from '../data/users/types.js';
import { InMemorySecretVault } from '../security/secretVault.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function user(): UserInfo {
  return {
    id: 'user-1',
    username: 'alice',
    tenantId: 'tenant-a',
    role: 'user',
    disabled: false,
  } as UserInfo;
}

describe('Google Workspace native connector', () => {
  it('stores OAuth credentials in Vault and injects only the current user access token', async () => {
    const root = mkdtempSync(join(tmpdir(), 'google-workspace-'));
    roots.push(root);
    const connectionStore = new ConnectorConnectionStore(join(root, 'connections.json'));
    const vault = new InMemorySecretVault();
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'openid https://www.googleapis.com/auth/drive',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        email: 'alice@example.com',
        sub: 'google-user-1',
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    let grantActive = true;
    const service = new GoogleWorkspaceOAuthService({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      connectionStore,
      vault,
      authorizeGrant: async () => grantActive,
      authorizeConnect: async () => true,
      fetchImpl,
    });

    const started = await service.startAuthorization(user(), 'https://agent.example.com/api/connectors/oauth/callback');
    const authorizationUrl = new URL(started.authorizationUrl);
    expect(authorizationUrl.hostname).toBe('accounts.google.com');
    expect(authorizationUrl.searchParams.get('access_type')).toBe('offline');
    expect(authorizationUrl.searchParams.get('scope')).toContain('gmail.settings.basic');
    expect(authorizationUrl.searchParams.get('scope')).toContain('spreadsheets');
    expect(started.requestedScopes).toEqual([...GOOGLE_WORKSPACE_REQUESTED_SCOPES]);
    expect(started.requestedScopes).toHaveLength(54);

    const finished = await service.finishAuthorization({
      state: started.state,
      code: 'oauth-code',
      redirectUri: 'https://agent.example.com/api/connectors/oauth/callback',
    });
    expect(finished.scopeSummary).toEqual(['https://www.googleapis.com/auth/drive', 'openid']);

    expect(service.connectionView('user-1', 'alice', 'tenant-a')).toMatchObject({
      status: 'connected',
      accountEmail: 'alice@example.com',
      envAvailable: true,
    });
    const stored = connectionStore.get('alice', 'google-workspace')!;
    const tokenRef = stored.credentialRefs.oauth!;
    expect(stored.metadata?.credentialOwnerId).toBe('user-1');
    await expect(vault.getSecret(tokenRef, {
      actor: 'connector_proxy',
      userId: 'alice',
      tenantId: 'tenant-a',
      scopes: ['secret:connector:read'],
    })).rejects.toThrow(/user owner mismatch/);
    await expect(resolveGoogleWorkspaceRuntimeEnv(service, {
      userId: 'user-1',
      username: 'alice',
      tenantId: 'tenant-a',
    })).resolves.toEqual({ GOOGLE_WORKSPACE_CLI_TOKEN: 'access-1' });
    grantActive = false;
    await expect(resolveGoogleWorkspaceRuntimeEnv(service, {
      userId: 'user-1', username: 'alice', tenantId: 'tenant-a',
    })).resolves.toEqual({});
    grantActive = true;
    await expect(resolveGoogleWorkspaceRuntimeEnv(service, {
      userId: 'user-2',
      username: 'bob',
      tenantId: 'tenant-a',
    })).resolves.toEqual({});
    await expect(resolveGoogleWorkspaceRuntimeEnv(service, {
      userId: 'replacement-user',
      username: 'alice',
      tenantId: 'tenant-a',
    })).resolves.toEqual({});
    expect(JSON.stringify(connectionStore.get('alice', 'google-workspace'))).not.toContain('access-1');
    expect(JSON.stringify(connectionStore.get('alice', 'google-workspace'))).not.toContain('refresh-1');
  });

  it('accepts Google canonical userinfo scopes for signed email and profile aliases', async () => {
    const root = mkdtempSync(join(tmpdir(), 'google-workspace-'));
    roots.push(root);
    const connectionStore = new ConnectorConnectionStore(join(root, 'connections.json'));
    const service = new GoogleWorkspaceOAuthService({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      connectionStore,
      vault: new InMemorySecretVault(),
      authorizeConnect: async () => true,
      fetchImpl: vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify({
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          expires_in: 3600,
          scope: [
            'openid',
            'https://www.googleapis.com/auth/userinfo.email',
            'https://www.googleapis.com/auth/userinfo.profile',
            'https://www.googleapis.com/auth/drive',
          ].join(' '),
        }), { status: 200, headers: { 'content-type': 'application/json' } }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ email: 'alice@example.com' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })),
    });
    const started = await service.startAuthorization(user(), 'https://agent.example.com/api/connectors/oauth/callback');

    await expect(service.finishAuthorization({
      state: started.state,
      code: 'oauth-code',
      redirectUri: 'https://agent.example.com/api/connectors/oauth/callback',
    })).resolves.toMatchObject({
      scopeSummary: ['email', 'https://www.googleapis.com/auth/drive', 'openid', 'profile'],
    });
    await expect(service.grantedScopes('user-1', 'alice', 'tenant-a')).resolves.toEqual([
      'email',
      'https://www.googleapis.com/auth/drive',
      'openid',
      'profile',
    ]);
  });

  it('still rejects Google scopes outside the signed request', async () => {
    const root = mkdtempSync(join(tmpdir(), 'google-workspace-'));
    roots.push(root);
    const connectionStore = new ConnectorConnectionStore(join(root, 'connections.json'));
    const service = new GoogleWorkspaceOAuthService({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      connectionStore,
      vault: new InMemorySecretVault(),
      authorizeConnect: async () => true,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 3600,
        scope: 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.addons.current.message.readonly',
      }), { status: 200, headers: { 'content-type': 'application/json' } })),
    });
    const started = await service.startAuthorization(user(), 'https://agent.example.com/api/connectors/oauth/callback');

    await expect(service.finishAuthorization({
      state: started.state,
      code: 'oauth-code',
      redirectUri: 'https://agent.example.com/api/connectors/oauth/callback',
    })).rejects.toThrow('granted scope exceeds the signed request');
    expect(connectionStore.get('alice', 'google-workspace')).toBeUndefined();
  });

  it('从旧连接的 Vault token bundle 恢复授权范围', async () => {
    const root = mkdtempSync(join(tmpdir(), 'google-workspace-'));
    roots.push(root);
    const connectionStore = new ConnectorConnectionStore(join(root, 'connections.json'));
    const vault = new InMemorySecretVault();
    const secret = await vault.putSecret(
      'user-1',
      'connector',
      JSON.stringify({
        accessToken: 'legacy-access',
        refreshToken: 'legacy-refresh',
        expiresAt: Date.now() + 3_600_000,
        scope: 'openid https://www.googleapis.com/auth/drive.readonly',
      }),
      { actor: 'connector_proxy', userId: 'user-1', tenantId: 'tenant-a', scopes: ['secret:connector:write'] },
    );
    await connectionStore.connect({
      username: 'alice', userId: 'user-1', tenantId: 'tenant-a', connectorId: 'google-workspace',
      credentialRefs: { oauth: secret.id }, metadata: { credentialOwnerId: 'user-1' },
    });
    const service = new GoogleWorkspaceOAuthService({
      clientId: 'client-id', clientSecret: 'client-secret', connectionStore, vault,
    });

    await expect(service.grantedScopes('user-1', 'alice', 'tenant-a')).resolves.toEqual([
      'https://www.googleapis.com/auth/drive.readonly',
      'openid',
    ]);
  });

  it('刷新响应省略 scope 时保留原授权范围证据', async () => {
    const root = mkdtempSync(join(tmpdir(), 'google-workspace-'));
    roots.push(root);
    const connectionStore = new ConnectorConnectionStore(join(root, 'connections.json'));
    const vault = new InMemorySecretVault();
    const secret = await vault.putSecret(
      'user-1',
      'connector',
      JSON.stringify({
        accessToken: 'expired-access',
        refreshToken: 'refresh-1',
        expiresAt: Date.now() - 1,
        scope: 'openid https://www.googleapis.com/auth/gmail.settings.basic',
        tokenType: 'Bearer',
      }),
      { actor: 'connector_proxy', userId: 'user-1', tenantId: 'tenant-a', scopes: ['secret:connector:write'] },
    );
    await connectionStore.connect({
      username: 'alice', userId: 'user-1', tenantId: 'tenant-a', connectorId: 'google-workspace',
      credentialRefs: { oauth: secret.id }, metadata: {
        credentialOwnerId: 'user-1',
        grantedScopes: 'openid https://www.googleapis.com/auth/gmail.settings.basic',
      },
    });
    const service = new GoogleWorkspaceOAuthService({
      clientId: 'client-id', clientSecret: 'client-secret', connectionStore, vault,
      authorizeGrant: async () => true, authorizeConnect: async () => true,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'refreshed-access', expires_in: 3600,
      }), { status: 200, headers: { 'content-type': 'application/json' } })),
    });

    await expect(service.accessToken('user-1', 'alice', 'tenant-a')).resolves.toBe('refreshed-access');
    const refreshed = JSON.parse(await vault.getSecret(secret.id, {
      actor: 'connector_proxy', userId: 'user-1', tenantId: 'tenant-a', scopes: ['secret:connector:read'],
    })) as { refreshToken?: string; scope?: string; tokenType?: string };
    expect(refreshed).toMatchObject({
      refreshToken: 'refresh-1',
      scope: 'openid https://www.googleapis.com/auth/gmail.settings.basic',
      tokenType: 'Bearer',
    });
  });

  it('keeps the local credential when Google provider revocation fails so deletion can retry safely', async () => {
    const root = mkdtempSync(join(tmpdir(), 'google-workspace-'));
    roots.push(root);
    const connectionStore = new ConnectorConnectionStore(join(root, 'connections.json'));
    const vault = new InMemorySecretVault();
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600, scope: 'openid',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ email: 'alice@example.com' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('provider unavailable', { status: 503 }));
    const service = new GoogleWorkspaceOAuthService({
      clientId: 'client-id', clientSecret: 'client-secret', connectionStore, vault, authorizeConnect: async () => true, fetchImpl,
    });
    const started = await service.startAuthorization(user(), 'https://agent.example.com/api/connectors/oauth/callback');
    await service.finishAuthorization({
      state: started.state, code: 'oauth-code', redirectUri: 'https://agent.example.com/api/connectors/oauth/callback',
    });

    await expect(service.disconnect('user-1', 'alice', 'tenant-a')).rejects.toThrow('HTTP 503');
    expect(connectionStore.get('alice', 'google-workspace')).toMatchObject({ status: 'connected', userId: 'user-1' });
  });

  it('can finish an OAuth callback in another service instance through a shared state store', async () => {
    const root = mkdtempSync(join(tmpdir(), 'google-workspace-'));
    roots.push(root);
    const connectionStore = new ConnectorConnectionStore(join(root, 'connections.json'));
    const vault = new InMemorySecretVault();
    const stateStore = new InMemoryGoogleWorkspaceOAuthStateStore();
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'shared-access', refresh_token: 'shared-refresh', expires_in: 3600, scope: 'openid',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ email: 'alice@example.com' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    const serviceA = new GoogleWorkspaceOAuthService({
      clientId: 'client-id', clientSecret: 'client-secret', connectionStore, vault, stateStore, authorizeConnect: async () => true, fetchImpl,
    });
    const serviceB = new GoogleWorkspaceOAuthService({
      clientId: 'client-id', clientSecret: 'client-secret', connectionStore, vault, stateStore, authorizeConnect: async () => true, fetchImpl,
    });
    const started = await serviceA.startAuthorization(user(), 'https://agent.example.com/api/connectors/oauth/callback');

    await expect(serviceB.finishAuthorization({
      state: started.state,
      code: 'oauth-code',
      redirectUri: 'https://agent.example.com/api/connectors/oauth/callback',
    })).resolves.toMatchObject({ user: { id: 'user-1', username: 'alice', tenantId: 'tenant-a' } });
  });

  it('cancels pending OAuth states durably when a user is disabled or deleted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'google-workspace-'));
    roots.push(root);
    const service = new GoogleWorkspaceOAuthService({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      connectionStore: new ConnectorConnectionStore(join(root, 'connections.json')),
      vault: new InMemorySecretVault(),
      authorizeConnect: async () => true,
      fetchImpl: vi.fn<typeof fetch>(),
    });
    const started = await service.startAuthorization(user(), 'https://agent.example.com/api/connectors/oauth/callback');
    await service.cancelUser('user-1');

    await expect(service.finishAuthorization({
      state: started.state,
      code: 'oauth-code',
      redirectUri: 'https://agent.example.com/api/connectors/oauth/callback',
    })).rejects.toThrow('state 已过期');
  });

  it('rejects a callback when the authorizing user was deleted or disabled meanwhile', async () => {
    const root = mkdtempSync(join(tmpdir(), 'google-workspace-'));
    roots.push(root);
    let currentUser: UserInfo | undefined = user();
    const fetchImpl = vi.fn<typeof fetch>();
    const service = new GoogleWorkspaceOAuthService({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      connectionStore: new ConnectorConnectionStore(join(root, 'connections.json')),
      vault: new InMemorySecretVault(),
      userResolver: () => currentUser,
      authorizeConnect: async () => true,
      fetchImpl,
    });
    const started = await service.startAuthorization(user(), 'https://agent.example.com/api/connectors/oauth/callback');
    currentUser = undefined;

    await expect(service.finishAuthorization({
      state: started.state,
      code: 'oauth-code',
      redirectUri: 'https://agent.example.com/api/connectors/oauth/callback',
    })).rejects.toThrow('授权用户已失效');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('active membership 与 offboarding authority 在交换 token 前 fail closed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'google-workspace-'));
    roots.push(root);
    let active = true;
    const fetchImpl = vi.fn<typeof fetch>();
    const service = new GoogleWorkspaceOAuthService({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      connectionStore: new ConnectorConnectionStore(join(root, 'connections.json')),
      vault: new InMemorySecretVault(),
      userResolver: () => user(),
      authorizeSubject: async () => active,
      authorizeConnect: async () => true,
      fetchImpl,
    });
    const started = await service.startAuthorization(user(), 'https://agent.example.com/api/connectors/oauth/callback');
    active = false;
    await expect(service.finishAuthorization({
      state: started.state,
      code: 'oauth-code',
      redirectUri: 'https://agent.example.com/api/connectors/oauth/callback',
    })).rejects.toThrow('授权用户已失效');
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(service.startAuthorization(user(), 'https://agent.example.com/api/connectors/oauth/callback')).rejects.toThrow('授权用户已失效');
  });

  it('rejects mismatched redirects and consumes OAuth state once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'google-workspace-'));
    roots.push(root);
    const service = new GoogleWorkspaceOAuthService({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      connectionStore: new ConnectorConnectionStore(join(root, 'connections.json')),
      vault: new InMemorySecretVault(),
      authorizeConnect: async () => true,
      fetchImpl: vi.fn<typeof fetch>(),
    });
    const started = await service.startAuthorization(user(), 'https://agent.example.com/api/connectors/oauth/callback');
    await expect(service.finishAuthorization({
      state: started.state,
      code: 'oauth-code',
      redirectUri: 'https://evil.example.com/callback',
    })).rejects.toThrow('redirect_uri');
    await expect(service.finishAuthorization({
      state: started.state,
      code: 'oauth-code',
      redirectUri: 'https://agent.example.com/api/connectors/oauth/callback',
    })).rejects.toThrow('state');
  });
});
