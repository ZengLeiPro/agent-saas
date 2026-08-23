import { describe, expect, it, vi } from 'vitest';

import type { TaskBoardTask } from '../../../shared/src/types/taskboard.js';
import { invokeTaskboardAction } from '../agent/taskboardToolActions.js';
import type { TaskboardIdentity, TaskboardService } from '../taskboard/types.js';

const identity: TaskboardIdentity = {
  tenantId: 'tenant-a',
  ownerUserId: 'user-1',
  username: 'alice',
  userRole: 'user',
};

const board = {
  id: 'board-1',
  name: '迭代任务',
  visibility: 'personal' as const,
  ownerUserId: identity.ownerUserId,
  role: 'owner' as const,
  canManage: true,
  version: 1,
  createdAt: '2026-08-23T00:00:00.000Z',
  updatedAt: '2026-08-23T00:00:00.000Z',
};

describe('Agent 创建任务的自动标题', () => {
  it('仅传正文时生成标题，生成失败时保存空标题', async () => {
    const createTask = vi.fn(async (_identity, _boardId, input) => ({
      id: `task-${createTask.mock.calls.length}`,
      boardId: board.id,
      identifier: `TASK-${createTask.mock.calls.length}`,
      title: input.title ?? '',
      description: input.description ?? '',
      status: 'backlog' as const,
      priority: 'none' as const,
      labels: [],
      sortOrder: 1024,
      commentCount: 0,
      version: 1,
      createdAt: board.createdAt,
      updatedAt: board.updatedAt,
    } satisfies TaskBoardTask));
    const service = { getBoard: vi.fn(async () => board), createTask } as unknown as TaskboardService;
    const generateTaskTitle = vi.fn()
      .mockResolvedValueOnce('自动生成标题')
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('生成器拒绝'));
    const options = { service: () => service, generateTaskTitle };

    await invokeTaskboardAction(options, identity, {
      action: 'task.create', boardId: board.id, description: '第一条正文',
    });
    await invokeTaskboardAction(options, identity, {
      action: 'task.create', boardId: board.id, description: '第二条正文',
    });
    await invokeTaskboardAction(options, identity, {
      action: 'task.create', boardId: board.id, description: '第三条正文',
    });

    expect(generateTaskTitle).toHaveBeenNthCalledWith(1, '第一条正文', identity);
    expect(generateTaskTitle).toHaveBeenNthCalledWith(2, '第二条正文', identity);
    expect(generateTaskTitle).toHaveBeenNthCalledWith(3, '第三条正文', identity);
    expect(createTask.mock.calls.map((call) => call[2].title)).toEqual(['自动生成标题', '', '']);
  });

  it('Execution action=create 仅传正文时生成标题，失败时保存空标题', async () => {
    const parentTask: TaskBoardTask = {
      id: 'task-parent', boardId: board.id, identifier: 'TASK-1', title: '父任务', description: '',
      kind: 'delivery', status: 'in_progress', priority: 'none', labels: [], sortOrder: 1024,
      commentCount: 0, version: 1, createdAt: board.createdAt, updatedAt: board.updatedAt,
    };
    let existingTask: TaskBoardTask | null = null;
    const createTaskFromExecutionWithResult = vi.fn(async (_identity, _runId, input) => {
      if (existingTask) return { task: existingTask, created: false };
      existingTask = {
        ...parentTask, id: 'task-2', identifier: 'TASK-2', title: input.title ?? '',
        description: input.description ?? '', status: 'todo' as const,
      };
      return { task: existingTask, created: true };
    });
    let notifyTitleStarted!: () => void;
    let releaseTitle!: () => void;
    const titleStarted = new Promise<void>((resolve) => { notifyTitleStarted = resolve; });
    const titleGate = new Promise<void>((resolve) => { releaseTitle = resolve; });
    const generateTaskTitle = vi.fn()
      .mockImplementationOnce(async () => { notifyTitleStarted(); await titleGate; return 'Execution 自动标题'; })
      .mockRejectedValueOnce(new Error('生成器拒绝'));
    const service = {
      updateTask: vi.fn(async (_identity, _taskId, input) => {
        existingTask = {
          ...existingTask!, title: input.title ?? existingTask!.title,
          attachments: input.attachments ?? existingTask!.attachments,
          version: existingTask!.version + 1,
        };
        return existingTask;
      }),
      getTask: vi.fn(async () => existingTask!),
    } as unknown as TaskboardService;
    const startDirectExecution = vi.fn(async () => ({ task: existingTask!, execution: {} }));
    const listExecutions = vi.fn(async () => [] as Record<string, unknown>[]);
    const options = {
      service: () => service,
      generateTaskTitle,
      executionService: () => ({ listExecutions, startDirectExecution } as never),
      executionStore: () => ({ createTaskFromExecutionWithResult } as never),
    };
    const scope = {
      execution: {
        identity,
        task: parentTask,
        boardPrompt: '',
        comments: [],
        execution: {
          id: 'execution-1', taskId: parentTask.id, runId: 'run-1', sessionId: 'session-1',
          status: 'running' as const, purpose: 'work' as const, requestedBy: identity.ownerUserId,
          createdAt: board.createdAt, updatedAt: board.updatedAt,
        },
      },
    };

    const firstPending = invokeTaskboardAction(options, identity, {
      action: 'create', boardId: board.id, description: 'Execution 正文', attachments: [], dispatch: true,
    }, scope);
    await titleStarted;
    const replay = await invokeTaskboardAction(options, identity, {
      action: 'create', boardId: board.id, description: 'Execution 正文', attachments: [], dispatch: true,
    }, scope);
    releaseTitle();
    const first = await firstPending;
    existingTask = null;
    const failed = await invokeTaskboardAction(options, identity, {
      action: 'create', boardId: board.id, description: 'Execution 失败正文',
    }, scope);

    expect(first).toMatchObject({ created: true, task: { title: 'Execution 自动标题' } });
    expect(replay).toMatchObject({ created: false, task: { title: '' } });
    expect(failed).toMatchObject({ created: true, task: { title: '' } });
    expect(generateTaskTitle).toHaveBeenCalledTimes(2);
    expect(service.updateTask).toHaveBeenCalledTimes(1);
    expect(startDirectExecution).toHaveBeenCalledOnce();
    expect(createTaskFromExecutionWithResult).toHaveBeenCalledTimes(3);

    existingTask = null;
    let recoveryAttempt = 0;
    createTaskFromExecutionWithResult.mockImplementation(async (_identity, _runId, input) => {
      existingTask ??= {
        ...parentTask, id: 'task-remediation', identifier: 'TASK-3', kind: 'remediation',
        title: '', description: input.description ?? '', status: 'todo' as const,
      };
      const created = recoveryAttempt++ === 0;
      return { task: existingTask, created, creationClaimToken: created ? 'claim-1' : 'claim-2' };
    });
    service.linkIntegrationRemediationV2 = vi.fn()
      .mockRejectedValueOnce(new Error('link failed'))
      .mockResolvedValueOnce({});
    service.releaseTaskCreation = vi.fn(async () => undefined);
    service.completeTaskCreation = vi.fn(async () => existingTask!);
    const integrationScope = {
      ...scope,
      execution: { ...scope.execution, task: { ...parentTask, kind: 'integration' as const } },
    };
    const remediationInput = {
      action: 'create' as const, boardId: board.id, description: '修复冲突', sourceId: 'source-1',
    };
    await expect(invokeTaskboardAction(options, identity, remediationInput, integrationScope))
      .rejects.toThrow('link failed');
    await expect(invokeTaskboardAction(options, identity, remediationInput, integrationScope))
      .resolves.toMatchObject({ created: false, task: { id: 'task-remediation' } });
    expect(service.linkIntegrationRemediationV2).toHaveBeenCalledTimes(2);
    expect(service.releaseTaskCreation).toHaveBeenCalledWith(identity, 'task-remediation', 'claim-1');
    expect(service.completeTaskCreation).toHaveBeenCalledWith(identity, 'task-remediation', 'claim-2');

    existingTask = null;
    recoveryAttempt = 0;
    service.completeTaskCreation = vi.fn()
      .mockRejectedValueOnce(new Error('complete failed'))
      .mockImplementation(async () => existingTask!);
    listExecutions.mockResolvedValueOnce([{}]);
    const dispatchInput = {
      action: 'create' as const, boardId: board.id, description: '派发后恢复', dispatch: true,
    };
    const dispatchCount = startDirectExecution.mock.calls.length;
    await expect(invokeTaskboardAction(options, identity, dispatchInput, scope)).rejects.toThrow('complete failed');
    await expect(invokeTaskboardAction(options, identity, dispatchInput, scope))
      .resolves.toMatchObject({ created: false, dispatched: true });
    expect(startDirectExecution).toHaveBeenCalledTimes(dispatchCount + 1);
  });
});
