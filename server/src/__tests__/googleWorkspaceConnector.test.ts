import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConnectorConnectionStore } from '../connectors/connectionStore.js';
import {
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
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        email: 'alice@example.com',
        sub: 'google-user-1',
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const service = new GoogleWorkspaceOAuthService({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      connectionStore,
      vault,
      fetchImpl,
    });

    const started = await service.startAuthorization(user(), 'https://agent.example.com/api/connectors/oauth/callback');
    const authorizationUrl = new URL(started.authorizationUrl);
    expect(authorizationUrl.hostname).toBe('accounts.google.com');
    expect(authorizationUrl.searchParams.get('access_type')).toBe('offline');
    expect(authorizationUrl.searchParams.get('scope')).toContain('gmail.modify');

    await service.finishAuthorization({
      state: started.state,
      code: 'oauth-code',
      redirectUri: 'https://agent.example.com/api/connectors/oauth/callback',
    });

    expect(service.connectionView('user-1', 'alice', 'tenant-a')).toMatchObject({
      status: 'connected',
      accountEmail: 'alice@example.com',
      envAvailable: true,
    });
    await expect(resolveGoogleWorkspaceRuntimeEnv(service, {
      userId: 'user-1',
      username: 'alice',
      tenantId: 'tenant-a',
    })).resolves.toEqual({ GOOGLE_WORKSPACE_CLI_TOKEN: 'access-1' });
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

  it('keeps the local credential when Google provider revocation fails so deletion can retry safely', async () => {
    const root = mkdtempSync(join(tmpdir(), 'google-workspace-'));
    roots.push(root);
    const connectionStore = new ConnectorConnectionStore(join(root, 'connections.json'));
    const vault = new InMemorySecretVault();
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600,
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ email: 'alice@example.com' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('provider unavailable', { status: 503 }));
    const service = new GoogleWorkspaceOAuthService({
      clientId: 'client-id', clientSecret: 'client-secret', connectionStore, vault, fetchImpl,
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
        access_token: 'shared-access', refresh_token: 'shared-refresh', expires_in: 3600,
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ email: 'alice@example.com' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    const serviceA = new GoogleWorkspaceOAuthService({
      clientId: 'client-id', clientSecret: 'client-secret', connectionStore, vault, stateStore, fetchImpl,
    });
    const serviceB = new GoogleWorkspaceOAuthService({
      clientId: 'client-id', clientSecret: 'client-secret', connectionStore, vault, stateStore, fetchImpl,
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

  it('rejects mismatched redirects and consumes OAuth state once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'google-workspace-'));
    roots.push(root);
    const service = new GoogleWorkspaceOAuthService({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      connectionStore: new ConnectorConnectionStore(join(root, 'connections.json')),
      vault: new InMemorySecretVault(),
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
