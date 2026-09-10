import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { UsersFileDirectoryReader } from './usersFileReader.js';

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{ filePath: string; reader: UsersFileDirectoryReader }> {
  const root = await mkdtemp(join(tmpdir(), 'ky-directory-users-'));
  cleanupRoots.push(root);
  return {
    filePath: join(root, 'users.json'),
    reader: new UsersFileDirectoryReader({
      filePath: join(root, 'users.json'),
      initialUsers: [{ id: 'u-alice', username: 'alice', role: 'user', tenantId: 'tenant-a' }],
    }),
  };
}

function storedUser(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'u-bob',
    username: 'bob',
    passwordHash: 'hash',
    role: 'user',
    tenantId: 'tenant-a',
    createdAt: '2026-09-10T00:00:00.000Z',
    createdBy: 'system',
    updatedAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  };
}

describe('目录 users.json 快照读取', () => {
  it('完整校验后替换为新快照', async () => {
    const { filePath, reader } = await fixture();
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, debugModeMigrationVersion: 1, users: [storedUser()] }),
    );

    reader.reload();
    expect(reader.listAll()).toEqual([
      { id: 'u-bob', username: 'bob', role: 'user', tenantId: 'tenant-a' },
    ]);
  });

  it.each([
    ['JSON 语法损坏', '{broken-json'],
    ['缺少 users', JSON.stringify({ version: 1 })],
    ['users 为 null', JSON.stringify({ version: 1, users: null })],
    ['users 不是数组', JSON.stringify({ version: 1, users: {} })],
    ['数组元素损坏', JSON.stringify({ version: 1, users: [{ id: 'broken-user' }] })],
  ])('%s时保留上一版有效快照', async (_case, invalidSnapshot) => {
    const { filePath, reader } = await fixture();
    await writeFile(filePath, invalidSnapshot);

    expect(() => reader.reload()).toThrow('已保留上一版用户快照');
    expect(reader.listAll()).toEqual([
      { id: 'u-alice', username: 'alice', role: 'user', tenantId: 'tenant-a' },
    ]);
  });

  it('接受结构完整的空用户数组', async () => {
    const { filePath, reader } = await fixture();
    await writeFile(filePath, JSON.stringify({ version: 1, users: [] }));

    expect(() => reader.reload()).not.toThrow();
    expect(reader.listAll()).toEqual([]);
  });

  it('对旧记录沿用既有 tenantId 回填口径', async () => {
    const { filePath, reader } = await fixture();
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        users: [storedUser({ username: 'admin', role: 'admin', tenantId: undefined })],
      }),
    );

    reader.reload();
    expect(reader.listAll()[0]?.tenantId).toBe('pantheon');
  });
});
