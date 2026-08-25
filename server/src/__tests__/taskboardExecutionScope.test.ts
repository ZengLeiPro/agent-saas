import { describe, expect, it } from 'vitest';

import { assertTaskboardExecutionScope } from '../agent/taskboardExecutionScope.js';
import type { TaskboardExecutionContext, TaskboardIdentity } from '../taskboard/types.js';

const identity: TaskboardIdentity = {
  tenantId: 'tenant-a', ownerUserId: 'user-1', username: 'alice', userRole: 'user',
};

function context(status: TaskboardExecutionContext['execution']['status']): TaskboardExecutionContext {
  return {
    identity,
    boardPrompt: '', comments: [],
    task: {
      id: 'task-current', boardId: 'board-1', identifier: 'TASK-1', title: '当前任务', description: '',
      status: 'in_progress', priority: 'none', labels: [], sortOrder: 1, commentCount: 0, version: 1,
      createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z',
    },
    execution: {
      id: 'execution-1', taskId: 'task-current', runId: 'run-1', sessionId: 'session-1',
      status, purpose: 'work', requestedBy: identity.ownerUserId,
      createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z',
    },
  };
}

describe('taskboard Execution 读写边界', () => {
  it.each([
    'board.list', 'board.search', 'board.get',
    'task.list', 'task.search', 'task.get',
    'comment.list', 'execution.list', 'execution.context',
  ])('%s 可按用户权限跨任务读取，且不受 Execution 终态影响', (action) => {
    for (const status of ['running', 'succeeded'] as const) {
      expect(() => assertTaskboardExecutionScope(
        { action, taskId: 'task-other' }, context(status), identity,
      )).not.toThrow();
    }
  });

  it('终态 Execution 仍不能写入任何任务', () => {
    expect(() => assertTaskboardExecutionScope(
      { action: 'task.update', taskId: 'task-current', title: '越界写入' }, context('succeeded'), identity,
    )).toThrow('已终止');
  });

  it('只读查询仍校验 Execution 身份', () => {
    expect(() => assertTaskboardExecutionScope(
      { action: 'task.get', taskId: 'task-other' }, context('running'),
      { ...identity, ownerUserId: 'user-2' },
    )).toThrow('身份不匹配');
  });
});
