import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { archivePersonalWorkspace, inventoryPersonalWorkspace } from '../app/governancePersonalDataRetention.js';
import { resolveUserCwd } from '../workspace/resolver.js';
import type { UserInfo } from '../data/users/types.js';

const roots: string[] = [];
const user: UserInfo = {
  id: 'user-1', username: 'alice', role: 'user', tenantId: 'tenant-a',
  createdAt: '2026-08-01T00:00:00.000Z', createdBy: 'system', updatedAt: '2026-08-01T00:00:00.000Z',
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('个人工作区离职留存', () => {
  it('只返回相对 ID，不读取内容；Memory 与个人文件分域 inventory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'offboarding-retention-'));
    roots.push(root);
    const workspace = resolveUserCwd(root, user);
    await mkdir(join(workspace, 'memory/topics'), { recursive: true });
    await mkdir(join(workspace, 'uploads'), { recursive: true });
    await writeFile(join(workspace, 'MEMORY.md'), 'private memory');
    await writeFile(join(workspace, 'memory/topics/customer.md'), 'private topic');
    await writeFile(join(workspace, 'uploads/contract.pdf'), 'private file');
    await writeFile(join(workspace, '.workspace-meta.json'), '{}');
    await symlink('contract.pdf', join(workspace, 'uploads/link.pdf'));

    await expect(inventoryPersonalWorkspace(root, user)).resolves.toEqual({
      personalMemoryIds: ['MEMORY.md', 'memory/topics/customer.md'],
      personalFileIds: ['uploads/contract.pdf', 'uploads/link.pdf'],
      organizationFileIds: [],
    });
  });

  it('retain_and_disable 按原相对路径移入治理留存区，源工作区不再可见', async () => {
    const root = await mkdtemp(join(tmpdir(), 'offboarding-retention-'));
    roots.push(root);
    const workspace = resolveUserCwd(root, user);
    await mkdir(join(workspace, 'memory'), { recursive: true });
    await mkdir(join(workspace, 'assets'), { recursive: true });
    await writeFile(join(workspace, 'memory/day.md'), 'memory');
    await writeFile(join(workspace, 'assets/a.txt'), 'file');

    const manifestPaths = ['memory/day.md', 'assets/a.txt'];
    await expect(archivePersonalWorkspace(root, user, 'job-1', manifestPaths))
      .resolves.toEqual({ affectedCount: 2, completedCount: 2 });
    await expect(archivePersonalWorkspace(root, user, 'job-1', manifestPaths))
      .resolves.toEqual({ affectedCount: 2, completedCount: 2 });
    await expect(access(join(workspace, 'memory/day.md'))).rejects.toThrow();
    await expect(access(join(workspace, 'assets/a.txt'))).rejects.toThrow();
    await expect(readFile(join(root, '.governance-retention/tenant-a/user-1/job-1/memory/day.md'), 'utf8')).resolves.toBe('memory');
    await expect(readFile(join(root, '.governance-retention/tenant-a/user-1/job-1/assets/a.txt'), 'utf8')).resolves.toBe('file');
    await expect(inventoryPersonalWorkspace(root, user)).resolves.toEqual({
      personalMemoryIds: [], personalFileIds: [], organizationFileIds: [],
    });
  });
});
