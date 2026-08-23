import { describe, expect, it, vi } from 'vitest';

import { acquireTaskClientRequestLock } from '../taskboard/taskClientRequests.js';
import type { TaskboardIdentity } from '../taskboard/types.js';

const identity: TaskboardIdentity = {
  tenantId: 'tenant-a', ownerUserId: 'user-1', username: 'alice', userRole: 'user',
};

describe('任务创建幂等锁', () => {
  it('按看板和 clientRequestId 持有 PostgreSQL advisory lock 并可靠释放', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const releaseClient = vi.fn();
    const store = {
      pool: { connect: vi.fn(async () => ({ query, release: releaseClient })) },
      tasksTable: 'test_tasks', commentsTable: 'test_comments', changesTable: 'test_changes',
      getBoard: vi.fn(async () => ({
        id: 'board-1', name: '看板', visibility: 'personal', ownerUserId: identity.ownerUserId,
        role: 'owner', canManage: true, prompt: '', version: 1,
        createdAt: '2026-08-23T00:00:00.000Z', updatedAt: '2026-08-23T00:00:00.000Z',
      })),
    };

    const release = await acquireTaskClientRequestLock(
      store as never, identity, 'board-1', 'request-1',
    );
    expect(query).toHaveBeenNthCalledWith(
      1,
      'SELECT pg_advisory_lock(hashtext($1),hashtext($2))',
      ['test_tasks:client-request:board-1', 'request-1'],
    );

    await release();
    await release();
    expect(query).toHaveBeenNthCalledWith(
      2,
      'SELECT pg_advisory_unlock(hashtext($1),hashtext($2))',
      ['test_tasks:client-request:board-1', 'request-1'],
    );
    expect(releaseClient).toHaveBeenCalledOnce();
  });
});
