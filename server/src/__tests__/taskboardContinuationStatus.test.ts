import { describe, expect, it, vi } from 'vitest';

import { listTaskExecutions } from '../taskboard/continuationStore.js';
import type { TaskboardIdentity } from '../taskboard/types.js';

const identity: TaskboardIdentity = {
  tenantId: 'tenant-1',
  ownerUserId: 'user-1',
  username: 'alice',
};

describe('任务看板续跑状态', () => {
  it('正式 Execution 已终态时列表暴露独立续跑活跃标记', async () => {
    const executions = await listTaskExecutions({
      pool: { query: vi.fn(async () => ({ rows: [{
        id: 'execution-1',
        task_id: 'task-1',
        run_id: 'run-1',
        session_id: 'session-1',
        status: 'succeeded',
        purpose: 'work',
        requested_by: identity.ownerUserId,
        created_at: '2026-08-01T00:00:00.000Z',
        updated_at: '2026-08-01T01:00:00.000Z',
        continuation_active: true,
      }] })) },
      boardsTable: 'boards',
      tasksTable: 'tasks',
      commentsTable: 'comments',
      executionsTable: 'executions',
      continuationOutboxTable: 'continuation_outbox',
    } as never, identity, 'task-1');

    expect(executions).toEqual([expect.objectContaining({
      id: 'execution-1',
      status: 'succeeded',
      continuationActive: true,
    })]);
  });
});
