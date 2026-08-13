import { describe, expect, it, vi } from 'vitest';

import type {
  TaskBoard,
  TaskBoardExecution,
  TaskBoardTask,
} from '../../../shared/src/types/taskboard.js';
import { invokeTaskboardAction } from '../agent/taskboardToolActions.js';
import type {
  TaskboardExecutionContext,
  TaskboardExecutionService,
  TaskboardIdentity,
  TaskboardService,
} from '../taskboard/types.js';

const identity: TaskboardIdentity = {
  tenantId: 'tenant-a',
  ownerUserId: 'user-1',
  username: 'alice',
  userRole: 'user',
};

const board: TaskBoard = {
  id: 'board-1',
  name: '迭代任务',
  visibility: 'personal',
  ownerUserId: identity.ownerUserId,
  canManage: true,
  prompt: '',
  version: 1,
  createdAt: '2026-08-13T00:00:00.000Z',
  updatedAt: '2026-08-13T00:00:00.000Z',
};

const task: TaskBoardTask = {
  id: 'task-1',
  boardId: board.id,
  identifier: 'TASK-1',
  title: '实现功能',
  description: '',
  branch: 'task/TASK-1-feature',
  status: 'in_review',
  priority: 'none',
  labels: [],
  sortOrder: 1_024,
  commentCount: 0,
  version: 4,
  createdAt: board.createdAt,
  updatedAt: board.updatedAt,
};

const execution: TaskBoardExecution = {
  id: 'execution-1',
  taskId: task.id,
  runId: 'run-1',
  sessionId: 'session-1',
  status: 'queued',
  purpose: 'review',
  requestedBy: identity.ownerUserId,
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
};

function rig() {
  const service = {
    listBoards: vi.fn(async () => [board]),
    listTasks: vi.fn(async () => []),
    getTask: vi.fn(async () => task),
    listComments: vi.fn(async () => []),
    createTask: vi.fn(async (_identity, _boardId, input) => ({
      ...task,
      id: 'task-new',
      identifier: 'TASK-2',
      status: input.status ?? 'backlog',
      title: input.title,
      branch: input.branch,
      version: 1,
    })),
    updateTask: vi.fn(async (_identity, _taskId, input) => ({
      ...task,
      ...(input.branch === null ? { branch: undefined } : input.branch ? { branch: input.branch } : {}),
      version: task.version + 1,
    })),
    moveTask: vi.fn(async (_identity, _taskId, input) => ({
      ...task,
      status: input.status,
      version: task.version + 1,
    })),
  } as unknown as TaskboardService;
  const executionService = {
    listExecutions: vi.fn(async () => [execution]),
    startExecution: vi.fn(async () => ({
      task: { ...task, status: 'in_progress' as const, version: task.version + 1 },
      execution,
    })),
  } satisfies TaskboardExecutionService;
  const executionStore = {
    getExecutionContextByRunId: vi.fn(),
    moveTaskFromExecution: vi.fn(async (_identity, _runId, status) => ({
      ...task,
      status,
      version: task.version + 1,
    })),
  };
  const options = {
    service: () => service,
    executionService: () => executionService,
    executionStore: () => executionStore,
  };
  return { service, executionService, executionStore, options };
}

function executionScope(purpose: 'work' | 'review'): { execution: TaskboardExecutionContext } {
  return {
    execution: {
      identity,
      task: { ...task, status: 'in_progress' },
      boardPrompt: '',
      comments: [],
      execution: { ...execution, purpose, status: 'running' },
    },
  };
}

describe('CronManage taskboard actions', () => {
  it('列出看板、任务详情与独立执行记录', async () => {
    const { service, executionService, options } = rig();

    await expect(invokeTaskboardAction(options, identity, { action: 'list' }))
      .resolves.toEqual({ count: 1, boards: [board] });
    await expect(invokeTaskboardAction(options, identity, { action: 'list', id: task.id }))
      .resolves.toEqual({ task, comments: [], executions: [execution] });

    expect(service.listBoards).toHaveBeenCalledWith(identity, undefined);
    expect(executionService.listExecutions).toHaveBeenCalledWith(identity, task.id);
  });

  it('创建带分支的独立任务并用最新版本回写字段', async () => {
    const { service, options } = rig();

    await invokeTaskboardAction(options, identity, {
      action: 'create',
      boardId: board.id,
      title: '合并功能分支',
      branch: task.branch,
    });
    await invokeTaskboardAction(options, identity, {
      action: 'update',
      id: task.id,
      branch: 'task/TASK-1-renamed',
    });

    expect(service.createTask).toHaveBeenCalledWith(identity, board.id, expect.objectContaining({
      title: '合并功能分支',
      branch: task.branch,
      status: 'todo',
    }));
    expect(service.updateTask).toHaveBeenCalledWith(identity, task.id, {
      branch: 'task/TASK-1-renamed',
      expectedVersion: task.version,
    });
  });

  it('移动任务追加到目标列，并为待复核任务推断 review 执行', async () => {
    const { service, executionService, options } = rig();
    const donePeer = { ...task, id: 'task-done', status: 'done' as const, sortOrder: 2_048 };
    vi.mocked(service.listTasks).mockResolvedValueOnce([donePeer]);

    await invokeTaskboardAction(options, identity, { action: 'move', id: task.id, status: 'done' });
    await invokeTaskboardAction(options, identity, { action: 'execute', id: task.id });

    expect(service.moveTask).toHaveBeenCalledWith(identity, task.id, {
      status: 'done',
      previousTaskId: donePeer.id,
      expectedVersion: task.version,
    });
    expect(executionService.startExecution).toHaveBeenCalledWith(identity, task.id, {
      expectedVersion: task.version,
      purpose: 'review',
    });
  });

  it('Execution fencing 只允许复核 Agent 决策自己的任务', async () => {
    const { service, executionStore, options } = rig();

    await invokeTaskboardAction(
      options,
      identity,
      { action: 'move', id: task.id, status: 'todo' },
      executionScope('review'),
    );
    await expect(invokeTaskboardAction(
      options,
      identity,
      { action: 'move', id: task.id, status: 'done' },
      executionScope('work'),
    )).rejects.toThrow('只有当前任务的独立复核 Agent');
    await expect(invokeTaskboardAction(
      options,
      identity,
      { action: 'move', id: 'task-other', status: 'done' },
      executionScope('review'),
    )).rejects.toThrow('只有当前任务的独立复核 Agent');

    expect(service.moveTask).not.toHaveBeenCalled();
    expect(executionStore.moveTaskFromExecution).toHaveBeenCalledWith(
      identity, execution.runId, 'todo',
    );
  });

  it('Execution fencing 限制当前分支回写，并用 create+dispatch 派发新任务', async () => {
    const { service, executionService, options } = rig();
    const scope = executionScope('work');

    await invokeTaskboardAction(options, identity, {
      action: 'update', id: task.id, branch: 'task/TASK-1-updated',
    }, scope);
    await expect(invokeTaskboardAction(options, identity, {
      action: 'update', id: task.id, title: '越权改标题',
    }, scope)).rejects.toThrow('只能回写当前任务的 branch');
    await invokeTaskboardAction(options, identity, {
      action: 'create', boardId: board.id, title: '合并分支', status: 'todo', dispatch: true,
    }, scope);
    await expect(invokeTaskboardAction(options, identity, {
      action: 'execute', id: 'task-other',
    }, scope)).rejects.toThrow('不能派发已有任务');

    expect(service.updateTask).toHaveBeenCalledWith(identity, task.id, {
      branch: 'task/TASK-1-updated', expectedVersion: task.version,
    });
    expect(executionService.startExecution).toHaveBeenCalledWith(identity, 'task-new', {
      expectedVersion: 1, purpose: 'work',
    });
  });
});
