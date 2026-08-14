import { describe, expect, it, vi } from 'vitest';

import { completeContinuation, listTaskExecutions } from '../taskboard/continuationStore.js';
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

  it('成功续跑不会覆盖用户主动设置的 blocked 状态', async () => {
    const queries: string[] = [];
    const taskRow = {
      id: 'task-1', board_id: 'board-1', identifier: 'TASK-1', title: '用户主动阻塞',
      description: '', status: 'blocked', priority: 'high', labels: [], sort_order: 1024,
      comment_count: 1, version: 4, created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-01T01:00:00.000Z', board_archived_at: null,
    };
    const client = {
      query: vi.fn(async (statement: string) => {
        queries.push(statement);
        if (statement.includes('SELECT t.board_id, b.tenant_id')) {
          return { rows: [{ board_id: 'board-1', tenant_id: identity.tenantId, owner_user_id: identity.ownerUserId }] };
        }
        if (statement.includes('SELECT t.*, b.archived_at')) return { rows: [taskRow] };
        if (statement.includes('continuation_run_id=$2')) return { rows: [{ id: 'comment-1' }] };
        if (statement.includes('SELECT t.*')) return { rows: [taskRow] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };

    const result = await completeContinuation({
      pool: { connect: vi.fn(async () => client) }, boardsTable: 'boards', tasksTable: 'tasks',
      commentsTable: 'comments', executionsTable: 'executions', continuationOutboxTable: 'continuation_outbox',
    } as never, taskRow.id, 'continuation-after-user-block', {
      status: 'succeeded', commentBody: 'Agent 交付\n\n续跑成功',
    });

    expect(result?.status).toBe('blocked');
    expect(queries.some((statement) => (
      statement.includes('UPDATE tasks') && statement.includes('status=$2')
    ))).toBe(false);
  });
});
