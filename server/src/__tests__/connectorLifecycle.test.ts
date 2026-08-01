import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ConnectorConnectionStore } from '../connectors/connectionStore.js';
import { revokeAllUserConnectorCredentials } from '../connectors/lifecycle.js';
import { InMemorySecretVault } from '../security/secretVault.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('native connector credential lifecycle', () => {
  it('revokes every connector credential for the immutable user id only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'connector-lifecycle-'));
    roots.push(root);
    const store = new ConnectorConnectionStore(join(root, 'connections.json'));
    const vault = new InMemorySecretVault();
    const github = await vault.putSecret('alice', 'connector', 'github-secret', { tenantId: 'tenant-a' });
    const notion = await vault.putSecret('alice', 'connector', 'notion-secret', { tenantId: 'tenant-a' });
    const replacement = await vault.putSecret('bob', 'connector', 'replacement-secret', { tenantId: 'tenant-a' });

    await store.connect({
      connectorId: 'github', username: 'alice', userId: 'user-1', tenantId: 'tenant-a', credentialRefs: { token: github.id },
    });
    await store.connect({
      connectorId: 'notion', username: 'alice', userId: 'user-1', tenantId: 'tenant-a', credentialRefs: { token: notion.id },
    });
    await store.connect({
      connectorId: 'github', username: 'bob', userId: 'user-2', tenantId: 'tenant-a', credentialRefs: { token: replacement.id },
    });

    await expect(revokeAllUserConnectorCredentials({
      connectionStore: store,
      vault,
      userId: 'user-1',
      username: 'alice',
      tenantId: 'tenant-a',
    })).resolves.toBe(2);

    expect(store.get('alice', 'github')).toMatchObject({ status: 'disconnected', credentialRefs: {} });
    expect(store.get('alice', 'notion')).toMatchObject({ status: 'disconnected', credentialRefs: {} });
    expect(store.get('bob', 'github')).toMatchObject({ status: 'connected', userId: 'user-2' });
  });
});
