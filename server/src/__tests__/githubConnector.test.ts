import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConnectorConnectionStore } from '../connectors/connectionStore.js';
import {
  githubMcpCredentialOverrides,
  migrateLegacyGithubConnections,
  revokePendingGithubCredentials,
  resolveGithubRuntimeEnv,
} from '../connectors/github.js';
import { McpConfigStore } from '../data/mcpConfig.js';
import type { UserStore } from '../data/users/store.js';
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
      tenantId: 'tenant-a',
      connectorId: 'github',
      credentialRefs: { token: secret.id },
      capabilities: { mcp: true },
    });

    const env = await resolveGithubRuntimeEnv(
      { connectionStore: store, vault },
      { username: 'alice', tenantId: 'tenant-a' },
    );

    expect(env).toEqual({ GH_TOKEN: 'github_pat_secret', GITHUB_TOKEN: 'github_pat_secret' });
    expect(readFileSync(file, 'utf8')).not.toContain('github_pat_secret');
  });

  it('migrates the legacy MCP ref without reading or copying plaintext', async () => {
    const root = createRoot();
    const mcp = new McpConfigStore(join(root, 'mcp.json'));
    await mcp.installBuiltinOAuthServers();
    expect(mcp.getServer('github')).toMatchObject({
      managedByConnectorId: 'github',
      secretRequirements: [{ key: 'token' }],
    });
    expect(mcp.getServer('github')?.secretRequirements?.[0]).not.toHaveProperty('runtimeEnv');
    await mcp.setUserSecretRef('alice', 'github', 'token', 'legacy-ref');
    await mcp.setUserEnabledServers('alice', ['github']);
    const connections = new ConnectorConnectionStore(join(root, 'connections.json'));
    const userStore = {
      findByUsername: (username: string) => username === 'alice'
        ? { username: 'alice', tenantId: 'tenant-a' }
        : undefined,
    } as unknown as UserStore;

    await expect(migrateLegacyGithubConnections({
      connectionStore: connections,
      mcpConfigStore: mcp,
      userStore,
    })).resolves.toBe(1);

    expect(connections.get('alice', 'github')).toMatchObject({
      status: 'connected',
      credentialRefs: { token: 'legacy-ref' },
      capabilities: { mcp: true },
    });
    expect(mcp.getUserSecretRef('alice', 'github', 'token')).toBeUndefined();
    const overrides = githubMcpCredentialOverrides(connections, 'alice');
    expect(overrides).toEqual({ github: { token: 'legacy-ref' } });
    const mcpServers = await mcp.buildUserMcpServers('alice', root, undefined, overrides);
    expect(mcpServers.mcpServers?.github).toMatchObject({
      headerSecretRefs: { Authorization: { ref: 'legacy-ref', prefix: 'Bearer ' } },
    });
  });

  it('migrates legacy refs in auth-disabled deployments with the default tenant', async () => {
    const root = createRoot();
    const mcp = new McpConfigStore(join(root, 'mcp.json'));
    await mcp.installBuiltinOAuthServers();
    await mcp.setUserSecretRef('legacy-user', 'github', 'token', 'legacy-ref');
    const connections = new ConnectorConnectionStore(join(root, 'connections.json'));

    await expect(migrateLegacyGithubConnections({
      connectionStore: connections,
      mcpConfigStore: mcp,
    })).resolves.toBe(1);
    expect(connections.get('legacy-user', 'github')).toMatchObject({
      status: 'connected',
      tenantId: 'pantheon',
    });
  });

  it('retains failed revocations for startup retry instead of orphaning old tokens', async () => {
    const root = createRoot();
    const connections = new ConnectorConnectionStore(join(root, 'connections.json'));
    const vault = new InMemorySecretVault();
    const oldSecret = await vault.putSecret('alice', 'connector', 'ghp_old', {});
    const newSecret = await vault.putSecret('alice', 'connector', 'ghp_new', {});
    await connections.connect({
      username: 'alice',
      tenantId: 'tenant-a',
      connectorId: 'github',
      credentialRefs: { token: oldSecret.id },
    });
    await connections.connect({
      username: 'alice',
      tenantId: 'tenant-a',
      connectorId: 'github',
      credentialRefs: { token: newSecret.id },
    });
    const revoke = vi.spyOn(vault, 'revokeSecret').mockRejectedValueOnce(new Error('temporary failure'));

    await expect(revokePendingGithubCredentials({ connectionStore: connections, vault })).resolves.toBe(0);
    expect(connections.get('alice', 'github')?.pendingRevokeRefs).toEqual([oldSecret.id]);

    revoke.mockRestore();
    await expect(revokePendingGithubCredentials({ connectionStore: connections, vault })).resolves.toBe(1);
    expect(connections.get('alice', 'github')?.pendingRevokeRefs).toBeUndefined();
  });

  it('keeps a disconnected tombstone so legacy refs cannot resurrect the connection', async () => {
    const root = createRoot();
    const mcp = new McpConfigStore(join(root, 'mcp.json'));
    await mcp.installBuiltinOAuthServers();
    await mcp.setUserSecretRef('alice', 'github', 'token', 'stale-ref');
    const connections = new ConnectorConnectionStore(join(root, 'connections.json'));
    await connections.disconnect('alice', 'github', 'tenant-a');
    const userStore = { findByUsername: () => ({ username: 'alice', tenantId: 'tenant-a' }) } as unknown as UserStore;

    await expect(migrateLegacyGithubConnections({
      connectionStore: connections,
      mcpConfigStore: mcp,
      userStore,
    })).resolves.toBe(0);

    expect(connections.get('alice', 'github')?.status).toBe('disconnected');
    expect(mcp.getUserSecretRef('alice', 'github', 'token')).toBeUndefined();
  });
});
