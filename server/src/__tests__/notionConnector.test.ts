import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ConnectorConnectionStore } from '../connectors/connectionStore.js';
import { connectNotionCredential, disconnectNotion, resolveNotionRuntimeEnv } from '../connectors/notion.js';
import { InMemorySecretVault } from '../security/secretVault.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Notion native connector', () => {
  it('injects NOTION_API_TOKEN only for the immutable user id and revokes on disconnect', async () => {
    const root = mkdtempSync(join(tmpdir(), 'notion-connector-'));
    roots.push(root);
    const connectionStore = new ConnectorConnectionStore(join(root, 'connections.json'));
    const vault = new InMemorySecretVault();
    await connectNotionCredential({
      connectionStore,
      vault,
      userId: 'user-1',
      username: 'alice',
      tenantId: 'tenant-a',
      token: 'ntn_secret_token',
    });

    await expect(resolveNotionRuntimeEnv(
      { connectionStore, vault },
      { userId: 'user-1', username: 'alice', tenantId: 'tenant-a' },
    )).resolves.toEqual({ NOTION_API_TOKEN: 'ntn_secret_token' });
    await expect(resolveNotionRuntimeEnv(
      { connectionStore, vault },
      { userId: 'replacement-user', username: 'alice', tenantId: 'tenant-a' },
    )).resolves.toEqual({});

    await disconnectNotion({
      connectionStore,
      vault,
      userId: 'user-1',
      username: 'alice',
      tenantId: 'tenant-a',
    });
    await expect(resolveNotionRuntimeEnv(
      { connectionStore, vault },
      { userId: 'user-1', username: 'alice', tenantId: 'tenant-a' },
    )).resolves.toEqual({});
  });
});
