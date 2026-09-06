import { describe, expect, it, vi } from 'vitest';

import type { TaskBoardTask } from '../../../shared/src/types/taskboard.js';
import { getExecutionContextBySessionId } from '../taskboard/storeExecutions.js';

describe('任务看板 Session 执行上下文', () => {
  it('只加载 fencing 所需事实，不查询或返回评论', async () => {
    const row = {
      id: 'execution-1',
      task_id: 'task-1',
      run_id: 'run-1',
      session_id: 'session-1',
      status: 'running',
      purpose: 'work',
      requested_by: 'user-1',
      tenant_id: 'tenant-1',
      owner_user_id: 'user-1',
      board_prompt: '按看板约束执行。',
      board_stage_prompts: {},
      created_at: '2026-09-06T08:00:00.000Z',
      updated_at: '2026-09-06T08:00:00.000Z',
    };
    const pool = { query: vi.fn(async (_statement: string) => ({ rows: [row] })) };
    const task = { id: 'task-1', boardId: 'board-1' } as TaskBoardTask;
    const getTask = vi.fn(async () => task);

    const context = await getExecutionContextBySessionId(
      {
        pool,
        boardsTable: 'boards',
        tasksTable: 'tasks',
        executionsTable: 'executions',
        changesTable: 'changes',
        getTask,
      } as never,
      'session-1',
    );

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query.mock.calls[0]?.[0]).toContain('WHERE e.session_id=$1');
    expect(getTask).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', ownerUserId: 'user-1', username: '' },
      'task-1',
    );
    expect(context).toMatchObject({
      task,
      boardPrompt: '按看板约束执行。',
      execution: { runId: 'run-1' },
    });
    expect(context).not.toHaveProperty('comments');
  });
});
