import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConnectorConnectionStore } from '../connectors/connectionStore.js';
import {
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
});
