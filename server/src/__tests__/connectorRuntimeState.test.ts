import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ConnectorConnectionStore } from '../connectors/connectionStore.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function storePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'connector-runtime-state-'));
  roots.push(root);
  return join(root, 'connections.json');
}

describe('ConnectorConnectionStore runtime state', () => {
  it('defaults existing and new connectors to enabled', () => {
    const path = storePath();
    writeFileSync(path, JSON.stringify({ version: 1, users: {} }));

    const store = new ConnectorConnectionStore(path);
    expect(store.isRuntimeEnabled('alice', 'github')).toBe(true);
  });

  it('persists pause state across store reloads and removes it with user data', async () => {
    const path = storePath();
    const store = new ConnectorConnectionStore(path);
    await store.setRuntimeEnabled('alice', 'github', false);

    const reloaded = new ConnectorConnectionStore(path);
    expect(reloaded.isRuntimeEnabled('alice', 'github')).toBe(false);
    await expect(reloaded.removeUserData('alice')).resolves.toBe(true);

    const cleaned = new ConnectorConnectionStore(path);
    expect(cleaned.isRuntimeEnabled('alice', 'github')).toBe(true);
  });

  it('rolls back in-memory state when persistence fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'connector-runtime-rollback-'));
    roots.push(root);
    const directory = join(root, 'store');
    const backup = join(root, 'store-backup');
    mkdirSync(directory);
    const path = join(directory, 'connections.json');
    const store = new ConnectorConnectionStore(path);
    await store.connect({
      username: 'alice', userId: 'user-1', tenantId: 'tenant-a', connectorId: 'google-workspace',
      credentialRefs: { oauth: 'old-ref' },
    });
    renameSync(directory, backup);
    writeFileSync(directory, 'not a directory');

    await expect(store.connect({
      username: 'alice', userId: 'user-1', tenantId: 'tenant-a', connectorId: 'google-workspace',
      credentialRefs: { oauth: 'new-ref' },
    })).rejects.toThrow();
    expect(store.get('alice', 'google-workspace')?.credentialRefs.oauth).toBe('old-ref');

    rmSync(directory);
    renameSync(backup, directory);
    expect(new ConnectorConnectionStore(path).get('alice', 'google-workspace')?.credentialRefs.oauth).toBe('old-ref');
  });
});
