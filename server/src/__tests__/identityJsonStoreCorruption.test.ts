import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AgentStore, AgentStoreUnavailableError } from '../data/agents/store.js';
import { GroupStore, GroupStoreUnavailableError } from '../data/groups/store.js';
import { UserStore, UserStoreUnavailableError } from '../data/users/store.js';

const cleanupRoots: string[] = [];
const CORRUPT = '{broken-json';

async function temporaryPath(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'identity-store-corruption-'));
  cleanupRoots.push(root);
  return join(root, name);
}

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('identity JSON stores fail closed on existing unreadable state', () => {
  it('UserStore rejects mutation and preserves the exact corrupt bytes', async () => {
    const filePath = await temporaryPath('users.json');
    const store = new UserStore(filePath);
    const user = await store.create({
      username: 'alice',
      password: 'password123',
      role: 'user',
      createdBy: 'system',
      tenantId: 'kaiyan',
    });
    await writeFile(filePath, CORRUPT);

    await expect(
      store.updatePreferences(user.id, { defaultModel: 'provider/model' }),
    ).rejects.toBeInstanceOf(UserStoreUnavailableError);
    expect(await readFile(filePath, 'utf8')).toBe(CORRUPT);
    expect(() => new UserStore(filePath)).toThrow(UserStoreUnavailableError);
  });

  it('GroupStore rejects mutation and preserves the exact corrupt bytes', async () => {
    const filePath = await temporaryPath('groups.json');
    const store = new GroupStore(filePath);
    await store.create({ name: 'existing', userId: 'user-1' });
    await writeFile(filePath, CORRUPT);

    await expect(
      store.create({ name: 'must-not-overwrite', userId: 'user-1' }),
    ).rejects.toBeInstanceOf(GroupStoreUnavailableError);
    expect(await readFile(filePath, 'utf8')).toBe(CORRUPT);
    expect(() => new GroupStore(filePath)).toThrow(GroupStoreUnavailableError);
  });

  it('AgentStore rejects defaults and writes while preserving corrupt bytes', async () => {
    const filePath = await temporaryPath('agents.json');
    const store = new AgentStore(filePath);
    await store.set('alice', { name: 'Alice Agent' }, 'admin');
    await writeFile(filePath, CORRUPT);

    await expect(store.initDefaults(['bob'])).rejects.toBeInstanceOf(AgentStoreUnavailableError);
    await expect(store.set('bob', { name: 'Bob Agent' }, 'admin')).rejects.toBeInstanceOf(
      AgentStoreUnavailableError,
    );
    expect(await readFile(filePath, 'utf8')).toBe(CORRUPT);
    expect(() => new AgentStore(filePath)).toThrow(AgentStoreUnavailableError);
  });

  it('rejects valid JSON with an unknown or incomplete schema', async () => {
    const userPath = await temporaryPath('users-invalid.json');
    const groupPath = await temporaryPath('groups-invalid.json');
    const agentPath = await temporaryPath('agents-invalid.json');
    await Promise.all([
      writeFile(userPath, JSON.stringify({ version: 2, users: [] })),
      writeFile(groupPath, JSON.stringify({ version: 1 })),
      writeFile(agentPath, JSON.stringify({ version: 1, agents: [] })),
    ]);

    expect(() => new UserStore(userPath)).toThrow(UserStoreUnavailableError);
    expect(() => new GroupStore(groupPath)).toThrow(GroupStoreUnavailableError);
    expect(() => new AgentStore(agentPath)).toThrow(AgentStoreUnavailableError);
  });

  it.runIf(process.platform !== 'win32')(
    'does not treat EACCES as a missing empty store',
    async () => {
      const filePath = await temporaryPath('groups-unreadable.json');
      const store = new GroupStore(filePath);
      await store.create({ name: 'existing', userId: 'user-1' });
      const original = await readFile(filePath, 'utf8');
      await chmod(filePath, 0o000);
      try {
        await expect(
          store.create({ name: 'must-not-overwrite', userId: 'user-1' }),
        ).rejects.toBeInstanceOf(GroupStoreUnavailableError);
      } finally {
        await chmod(filePath, 0o600);
      }
      expect(await readFile(filePath, 'utf8')).toBe(original);
    },
  );
});
