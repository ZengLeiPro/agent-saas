import { describe, expect, it, vi } from 'vitest';

import { isStoredTaskWatched, setStoredTaskWatched } from './taskWatchStore.js';

const identity = { tenantId: 'tenant-1', ownerUserId: 'user-1', username: 'alice' };

function storeWith(query: ReturnType<typeof vi.fn>) {
  const client = { query };
  return {
    pool: { query },
    watchersTable: 'watchers',
    changesTable: 'changes',
    requireTask: vi.fn().mockResolvedValue({ id: 'task-1' }),
    requireTaskWithBoard: vi.fn().mockResolvedValue({ task: { id: 'task-1' } }),
    withTransaction: vi.fn(async (operation) => operation(client)),
  };
}

describe('taskWatchStore', () => {
  it('读取关注状态前先校验任务访问权限', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ exists: 1 }] });
    const store = storeWith(query);

    await expect(isStoredTaskWatched(store as never, identity, 'task-1')).resolves.toBe(true);
    expect(store.requireTask).toHaveBeenCalledWith(store.pool, identity, 'task-1', false);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM watchers'), ['task-1', 'user-1']);
  });

  it.each([
    [true, 'INSERT INTO watchers'],
    [false, 'DELETE FROM watchers'],
  ])('幂等写入 watched=%s 并记录任务变更', async (watched, sqlFragment) => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const store = storeWith(query);

    await expect(setStoredTaskWatched(store as never, identity, 'task-1', watched)).resolves.toBe(watched);
    expect(store.requireTaskWithBoard).toHaveBeenCalledWith(expect.anything(), identity, 'task-1', true);
    expect(query.mock.calls.map(([sql]) => String(sql))).toContainEqual(expect.stringContaining(sqlFragment));
    expect(query.mock.calls.map(([sql]) => String(sql))).toContainEqual(expect.stringContaining('INSERT INTO changes'));
  });
});
