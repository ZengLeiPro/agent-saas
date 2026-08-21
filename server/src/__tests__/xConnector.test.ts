import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConnectorConnectionStore } from '../connectors/connectionStore.js';
import {
  getXConnectionWithGovernance,
  revokePendingXCredentials,
  resolveXRuntimeEnv,
} from '../connectors/x.js';
import { InMemorySecretVault } from '../security/secretVault.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'x-connector-'));
  roots.push(root);
  return root;
}

const writer = {
  actor: 'connector_proxy' as const,
  userId: 'user-1',
  tenantId: 'tenant-a',
  scopes: ['secret:connector:write'],
};

function cookieCredential(authToken: string, ct0: string): string {
  return JSON.stringify({ authToken, ct0 });
}

describe('X native connector', () => {
  it('uses the governance Credential as the source for status and runtime env without a legacy connection record', async () => {
    const root = createRoot();
    const store = new ConnectorConnectionStore(join(root, 'connections.json'));
    const vault = new InMemorySecretVault();
    const secret = await vault.putSecret(
      'user-1',
      'connector',
      cookieCredential('governance-auth', 'governance-ct0'),
      writer,
      { connectorId: 'x', tenantId: 'tenant-a', credentialOwnerId: 'user-1' },
    );
    const governanceCredential = {
      credentialId: 'credential-x', tenantId: 'tenant-a', connectorId: 'x' as const,
      kind: 'personal_grant' as const, ownerUserId: 'user-1', purpose: 'X bird CLI 用户凭据',
      scopeSummary: { scopes: ['x:*'] }, status: 'active' as const, generation: 1,
      secretRef: secret.id, source: 'governance' as const, version: 2,
      createdAt: '2026-08-20T10:00:00.000Z', createdBy: 'user-1',
      updatedAt: '2026-08-20T10:01:00.000Z', updatedBy: 'user-1',
    };
    const governanceCredentialStore = {
      listForOwner: vi.fn().mockResolvedValue([governanceCredential]),
    };
    const context = { userId: 'user-1', username: 'alice', tenantId: 'tenant-a' };

    await expect(resolveXRuntimeEnv(
      { connectionStore: store, vault, governanceCredentialStore }, context,
    )).resolves.toEqual({
      AUTH_TOKEN: 'governance-auth',
      CT0: 'governance-ct0',
      TWITTER_AUTH_TOKEN: 'governance-auth',
      TWITTER_CT0: 'governance-ct0',
    });
    await expect(getXConnectionWithGovernance({
      connectionStore: store, governanceCredentialStore, context,
    })).resolves.toMatchObject({
      connectorId: 'x', status: 'connected', runtimeEnabled: true,
      credentialId: 'credential-x', credentialVersion: 2,
    });
  });

  it('does not fall back to a legacy connected record after governance Credential revocation', async () => {
    const root = createRoot();
    const store = new ConnectorConnectionStore(join(root, 'connections.json'));
    const vault = new InMemorySecretVault();
    const legacySecret = await vault.putSecret('user-1', 'connector', cookieCredential('legacy-auth', 'legacy-ct0'), writer);
    await store.connect({
      username: 'alice', userId: 'user-1', tenantId: 'tenant-a', connectorId: 'x',
      credentialRefs: { cookies: legacySecret.id },
    });
    const revokedCredential = {
      credentialId: 'credential-x', tenantId: 'tenant-a', connectorId: 'x' as const,
      kind: 'personal_grant' as const, ownerUserId: 'user-1', purpose: 'X bird CLI 用户凭据',
      scopeSummary: { scopes: ['x:*'] }, status: 'revoked' as const, generation: 2,
      secretRef: legacySecret.id, source: 'governance' as const, version: 2,
      createdAt: '2026-08-20T10:00:00.000Z', createdBy: 'user-1',
      updatedAt: '2026-08-20T10:01:00.000Z', updatedBy: 'user-1',
    };
    const governanceCredentialStore = { listForOwner: vi.fn().mockResolvedValue([revokedCredential]) };
    const context = { userId: 'user-1', username: 'alice', tenantId: 'tenant-a' };

    await expect(resolveXRuntimeEnv(
      { connectionStore: store, vault, governanceCredentialStore }, context,
    )).resolves.toEqual({});
    await expect(getXConnectionWithGovernance({
      connectionStore: store, governanceCredentialStore, context,
    })).resolves.toMatchObject({ connectorId: 'x', status: 'disconnected' });
  });

  it('stores only one vault ref and injects both bird cookie env aliases for the owning user', async () => {
    const root = createRoot();
    const file = join(root, 'connections.json');
    const store = new ConnectorConnectionStore(file);
    const vault = new InMemorySecretVault();
    const secret = await vault.putSecret(
      'user-1',
      'connector',
      cookieCredential('auth-cookie', 'ct0-cookie'),
      writer,
      { connectorId: 'x' },
    );
    await store.connect({
      username: 'alice',
      userId: 'user-1',
      tenantId: 'tenant-a',
      connectorId: 'x',
      credentialRefs: { cookies: secret.id },
      metadata: { credentialOwnerId: 'user-1' },
    });

    await expect(resolveXRuntimeEnv(
      { connectionStore: store, vault },
      { userId: 'user-1', username: 'alice', tenantId: 'tenant-a' },
    )).resolves.toEqual({
      AUTH_TOKEN: 'auth-cookie',
      CT0: 'ct0-cookie',
      TWITTER_AUTH_TOKEN: 'auth-cookie',
      TWITTER_CT0: 'ct0-cookie',
    });
    await expect(resolveXRuntimeEnv(
      { connectionStore: store, vault },
      { userId: 'replacement-user', username: 'alice', tenantId: 'tenant-a' },
    )).resolves.toEqual({});
    await expect(resolveXRuntimeEnv(
      { connectionStore: store, vault },
      { userId: 'user-1', username: 'alice', tenantId: 'other-tenant' },
    )).resolves.toEqual({});
    expect(readFileSync(file, 'utf8')).not.toContain('auth-cookie');
    expect(readFileSync(file, 'utf8')).not.toContain('ct0-cookie');
  });

  it('does not inject paused X credentials', async () => {
    const root = createRoot();
    const store = new ConnectorConnectionStore(join(root, 'connections.json'));
    const vault = new InMemorySecretVault();
    const secret = await vault.putSecret('user-1', 'connector', cookieCredential('auth', 'ct0'), writer);
    await store.connect({
      username: 'alice', userId: 'user-1', tenantId: 'tenant-a', connectorId: 'x',
      credentialRefs: { cookies: secret.id },
    });
    await store.setRuntimeEnabled('alice', 'x', false);

    await expect(resolveXRuntimeEnv(
      { connectionStore: store, vault },
      { userId: 'user-1', username: 'alice', tenantId: 'tenant-a' },
    )).resolves.toEqual({});
  });

  it('retains failed replacement revocations for retry', async () => {
    const root = createRoot();
    const store = new ConnectorConnectionStore(join(root, 'connections.json'));
    const vault = new InMemorySecretVault();
    const oldSecret = await vault.putSecret('user-1', 'connector', cookieCredential('old-auth', 'old-ct0'), writer);
    const newSecret = await vault.putSecret('user-1', 'connector', cookieCredential('new-auth', 'new-ct0'), writer);
    await store.connect({
      username: 'alice', userId: 'user-1', tenantId: 'tenant-a', connectorId: 'x',
      credentialRefs: { cookies: oldSecret.id },
    });
    await store.connect({
      username: 'alice', userId: 'user-1', tenantId: 'tenant-a', connectorId: 'x',
      credentialRefs: { cookies: newSecret.id },
    });

    const revoke = vi.spyOn(vault, 'revokeSecret').mockRejectedValueOnce(new Error('temporary failure'));
    await expect(revokePendingXCredentials({ connectionStore: store, vault })).resolves.toBe(0);
    expect(store.get('alice', 'x')?.pendingRevokeRefs).toEqual([oldSecret.id]);

    revoke.mockRestore();
    await expect(revokePendingXCredentials({ connectionStore: store, vault })).resolves.toBe(1);
    expect(store.get('alice', 'x')?.pendingRevokeRefs).toBeUndefined();
  });

  it('keeps the original owner and tenant for same-username replacement revocation', async () => {
    const root = createRoot();
    const store = new ConnectorConnectionStore(join(root, 'connections.json'));
    const vault = new InMemorySecretVault();
    const oldCaller = {
      actor: 'connector_proxy' as const,
      userId: 'old-user',
      tenantId: 'old-tenant',
      scopes: ['secret:connector:write'],
    };
    const newCaller = {
      actor: 'connector_proxy' as const,
      userId: 'new-user',
      tenantId: 'new-tenant',
      scopes: ['secret:connector:write'],
    };
    const oldSecret = await vault.putSecret(
      'old-user',
      'connector',
      cookieCredential('old-auth', 'old-ct0'),
      oldCaller,
    );
    const newSecret = await vault.putSecret(
      'new-user',
      'connector',
      cookieCredential('new-auth', 'new-ct0'),
      newCaller,
    );
    await store.connect({
      username: 'alice', userId: 'old-user', tenantId: 'old-tenant', connectorId: 'x',
      credentialRefs: { cookies: oldSecret.id },
      metadata: { credentialOwnerId: 'old-user' },
    });
    await store.connect({
      username: 'alice', userId: 'new-user', tenantId: 'new-tenant', connectorId: 'x',
      credentialRefs: { cookies: newSecret.id },
      metadata: { credentialOwnerId: 'new-user' },
    });

    expect(store.get('alice', 'x')?.pendingRevokeRefOwners?.[oldSecret.id]).toEqual({
      userId: 'old-user',
      tenantId: 'old-tenant',
    });
    const revoke = vi.spyOn(vault, 'revokeSecret');
    await expect(revokePendingXCredentials({ connectionStore: store, vault })).resolves.toBe(1);
    expect(revoke).toHaveBeenCalledWith(oldSecret.id, expect.objectContaining({
      userId: 'old-user',
      tenantId: 'old-tenant',
    }));
  });
});
