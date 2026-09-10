import { describe, expect, it, vi } from 'vitest';

import type { GovernancePgPool } from '../../data/governance-schema/index.js';
import type { PgKyAppDirectoryChangeLog } from './changeLog.js';
import {
  DirectoryProjector,
  GovernanceDirectorySource,
  type DirectorySourceProvider,
} from './projection.js';

describe('目录投影事实源刷新', () => {
  it('全组织投影在枚举 tenant 前只刷新一次', async () => {
    const calls: string[] = [];
    const source: DirectorySourceProvider = {
      sourceId: 'governance',
      refresh: () => {
        calls.push('refresh');
      },
      listTenantIds: async () => {
        calls.push('list');
        return [];
      },
      loadDirectory: async () => ({ users: [], groups: [] }),
    };
    const projector = new DirectoryProjector({
      pool: {} as GovernancePgPool,
      changeLog: {} as PgKyAppDirectoryChangeLog,
      source,
    });

    await expect(projector.reconcileAll()).resolves.toEqual([]);
    expect(calls).toEqual(['refresh', 'list']);
  });

  it('governance 源把刷新委托给 UserStore reader', () => {
    const reload = vi.fn();
    const source = new GovernanceDirectorySource({
      pool: {} as GovernancePgPool,
      users: { reload, listAll: () => [] },
    });

    source.refresh();
    expect(reload).toHaveBeenCalledOnce();
  });
});
