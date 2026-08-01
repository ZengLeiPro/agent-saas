import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConnectorConnectionStore } from '../connectors/connectionStore.js';
import {
  revokePendingGithubCredentials,
  resolveGithubRuntimeEnv,
} from '../connectors/github.js';
import { InMemorySecretVault } from '../security/secretVault.js';

const roots: string[] = [];

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'github-connector-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('GitHub native connector', () => {
  it('stores only vault refs and exports token through native runtime env', async () => {
    const root = createRoot();
    const file = join(root, 'connections.json');
    const store = new ConnectorConnectionStore(file);
    const vault = new InMemorySecretVault();
    const secret = await vault.putSecret('alice', 'connector', 'github_pat_secret', {
      connectorId: 'github',
    });
    await store.connect({
      username: 'alice',
      userId: 'user-1',
      tenantId: 'tenant-a',
      connectorId: 'github',
      credentialRefs: { token: secret.id },
    });

    const env = await resolveGithubRuntimeEnv(
      { connectionStore: store, vault },
      { userId: 'user-1', username: 'alice', tenantId: 'tenant-a' },
    );

    expect(env).toEqual({ GH_TOKEN: 'github_pat_secret', GITHUB_TOKEN: 'github_pat_secret' });
    await expect(resolveGithubRuntimeEnv(
      { connectionStore: store, vault },
      { userId: 'replacement-user', username: 'alice', tenantId: 'tenant-a' },
    )).resolves.toEqual({});
    expect(readFileSync(file, 'utf8')).not.toContain('github_pat_secret');
  });

  it('retains failed revocations for startup retry instead of orphaning old tokens', async () => {
    const root = createRoot();
    const connections = new ConnectorConnectionStore(join(root, 'connections.json'));
    const vault = new InMemorySecretVault();
    const oldSecret = await vault.putSecret('alice', 'connector', 'ghp_old', {});
    const newSecret = await vault.putSecret('alice', 'connector', 'ghp_new', {});
    await connections.connect({
      username: 'alice', userId: 'user-1', tenantId: 'tenant-a', connectorId: 'github', credentialRefs: { token: oldSecret.id },
    });
    await connections.connect({
      username: 'alice', userId: 'user-1', tenantId: 'tenant-a', connectorId: 'github', credentialRefs: { token: newSecret.id },
    });
    const revoke = vi.spyOn(vault, 'revokeSecret').mockRejectedValueOnce(new Error('temporary failure'));

    await expect(revokePendingGithubCredentials({ connectionStore: connections, vault })).resolves.toBe(0);
    expect(connections.get('alice', 'github')?.pendingRevokeRefs).toEqual([oldSecret.id]);

    revoke.mockRestore();
    await expect(revokePendingGithubCredentials({ connectionStore: connections, vault })).resolves.toBe(1);
    expect(connections.get('alice', 'github')?.pendingRevokeRefs).toBeUndefined();
  });


});
