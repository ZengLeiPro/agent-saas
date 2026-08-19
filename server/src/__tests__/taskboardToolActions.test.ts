import { describe, expect, it, vi } from 'vitest';

import type {
  TaskBoard,
  TaskBoardExecution,
  TaskBoardTask,
  TaskBoardUploadAttachment,
} from '../../../shared/src/types/taskboard.js';
import { invokeTaskboardAction } from '../agent/taskboardToolActions.js';
import {
  TaskboardValidationError,
  type TaskboardExecutionContext,
  type TaskboardExecutionService,
  type TaskboardIdentity,
  type TaskboardService,
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
    searchBoards: vi.fn(async () => ({ items: [board], page: 1, pageSize: 20, total: 1, hasMore: false })),
    getBoard: vi.fn(async () => board),
    listTasks: vi.fn(async () => []),
    searchTasks: vi.fn(async () => ({ items: [], page: 1, pageSize: 20, total: 0, hasMore: false })),
    getTask: vi.fn(async () => task),
    listComments: vi.fn(async () => []),
    searchComments: vi.fn(async () => ({ items: [], page: 1, pageSize: 20, total: 0, hasMore: false })),
    createComment: vi.fn(async (_identity, taskId, input) => ({
      id: 'comment-1', taskId, body: input.body, attachments: input.attachments, authorType: 'user' as const,
      authorId: identity.ownerUserId, authorName: identity.username, version: 1,
      createdAt: board.createdAt, updatedAt: board.updatedAt,
    })),
    updateComment: vi.fn(async (_identity, id, input) => ({
      id, taskId: task.id, body: input.body, authorType: 'user' as const,
      authorId: identity.ownerUserId, authorName: identity.username, version: input.expectedVersion + 1,
      createdAt: board.createdAt, updatedAt: board.updatedAt,
    })),
    deleteComment: vi.fn(async (_identity, id, input) => ({
      id, taskId: task.id, body: '删除我', authorType: 'user' as const,
      authorId: identity.ownerUserId, authorName: identity.username, version: input.expectedVersion,
      createdAt: board.createdAt, updatedAt: board.updatedAt,
    })),
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
      ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
      version: task.version + 1,
    })),
    moveTask: vi.fn(async (_identity, _taskId, input) => ({
      ...task,
      status: input.status,
      version: task.version + 1,
    })),
    cancelIntegrationTask: vi.fn(async (_identity, _taskId, input) => ({
      ...task,
      kind: 'integration' as const,
      status: 'canceled' as const,
      version: input.expectedVersion + 1,
    })),
  } as unknown as TaskboardService;
  const executionService = {
    listExecutions: vi.fn(async () => [execution]),
    searchExecutions: vi.fn(async () => ({
      items: [execution], page: 1, pageSize: 20, total: 1, hasMore: false,
    })),
    startExecution: vi.fn(async () => ({
      task: { ...task, status: 'in_progress' as const, version: task.version + 1 },
      execution,
    })),
    startDirectExecution: vi.fn(async () => ({
      task: { ...task, status: 'in_progress' as const, version: task.version + 1 },
      execution,
    })),
  } satisfies TaskboardExecutionService;
  const executionStore = {
    getExecutionContextByRunId: vi.fn(),
    getExecutionContextBySessionId: vi.fn(),
    updateTaskBranchFromExecution: vi.fn(async (_identity, _runId, branch) => ({
      ...task, branch: branch ?? undefined, version: task.version + 1,
    })),
    createTaskFromExecution: vi.fn(async (_identity, _runId, input) => ({
      ...task, id: 'task-new', identifier: 'TASK-2', title: input.title,
      status: 'todo' as const, version: 1,
    })),
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

function executionScope(purpose: 'work' | 'review', protocolVersion?: 2): { execution: TaskboardExecutionContext } {
  return {
    execution: {
      identity,
      task: { ...task, status: 'in_progress' },
      boardPrompt: '',
      comments: [],
      execution: { ...execution, purpose, status: 'running', ...(protocolVersion ? { protocolVersion } : {}) },
    },
  };
}

describe('CronManage taskboard actions', () => {
  it('列出看板、任务详情与独立执行记录', async () => {
    const { service, executionService, options } = rig();

    await expect(invokeTaskboardAction(options, identity, { action: 'board.list' }))
      .resolves.toEqual({
        count: 1, total: 1, page: 1, pageSize: 20, hasMore: false, boards: [board],
      });
    await expect(invokeTaskboardAction(options, identity, {
      action: 'comment.list', taskId: task.id, page: 1, pageSize: 20,
    })).resolves.toMatchObject({ total: 0, page: 1, pageSize: 20, comments: [] });
    await expect(invokeTaskboardAction(options, identity, {
      action: 'execution.list', taskId: task.id, page: 1, pageSize: 20,
    })).resolves.toMatchObject({ total: 1, page: 1, pageSize: 20, executions: [execution] });
    await expect(invokeTaskboardAction(options, identity, { action: 'list', id: task.id }))
      .rejects.toThrow('普通会话请使用');
    await expect(invokeTaskboardAction(options, identity, { action: 'list', id: task.id }, executionScope('work')))
      .resolves.toEqual({ task, comments: [], executions: [execution] });

    expect(service.searchBoards).toHaveBeenCalledWith(identity, {
      includeArchived: undefined,
      search: undefined,
      page: undefined,
      pageSize: undefined,
    });
    expect(service.searchComments).toHaveBeenCalledWith(identity, task.id, { page: 1, pageSize: 20 });
    expect(executionService.searchExecutions).toHaveBeenCalledWith(
      identity, task.id, { page: 1, pageSize: 20 },
    );
    expect(executionService.listExecutions).toHaveBeenCalledWith(identity, task.id);
  });

  it('普通会话创建带分支任务并用显式版本回写字段', async () => {
    const { service, options } = rig();

    await invokeTaskboardAction(options, identity, {
      action: 'task.create',
      boardId: board.id,
      title: '合并功能分支',
      branch: task.branch,
      status: 'todo',
    });
    await invokeTaskboardAction(options, identity, {
      action: 'task.update',
      taskId: task.id,
      branch: 'task/TASK-1-renamed',
      expectedVersion: task.version,
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

  it('普通会话用 CAS 移动任务并显式派发 review 执行', async () => {
    const { service, executionService, options } = rig();
    const donePeer = { ...task, id: 'task-done', status: 'done' as const, sortOrder: 2_048 };

    await invokeTaskboardAction(options, identity, {
      action: 'task.move', taskId: task.id, status: 'done', previousTaskId: donePeer.id,
      expectedVersion: task.version,
    });
    await invokeTaskboardAction(options, identity, {
      action: 'task.dispatch', taskId: task.id, purpose: 'review', expectedVersion: task.version,
    });

    expect(service.moveTask).toHaveBeenCalledWith(identity, task.id, {
      status: 'done', previousTaskId: donePeer.id, expectedVersion: task.version,
    });
    expect(executionService.startExecution).toHaveBeenCalledWith(identity, task.id, {
      expectedVersion: task.version, purpose: 'review',
    });
  });

  it('普通会话可用 CAS 取消集成任务', async () => {
    const { service, options } = rig();

    await expect(invokeTaskboardAction(options, identity, {
      action: 'integration.cancel', taskId: task.id, expectedVersion: task.version, reason: '人工终止',
    })).resolves.toMatchObject({ canceled: true, task: { status: 'canceled' } });
    expect(service.cancelIntegrationTask).toHaveBeenCalledWith(identity, task.id, {
      expectedVersion: task.version,
      reason: '人工终止',
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
    await invokeTaskboardAction(
      options,
      identity,
      { action: 'move', id: task.id, status: 'ready_to_merge' },
      executionScope('review'),
    );
    await invokeTaskboardAction(
      options,
      identity,
      { action: 'move', id: task.id, status: 'blocked' },
      executionScope('review'),
    );
    await expect(invokeTaskboardAction(
      options,
      identity,
      { action: 'move', id: task.id, status: 'ready_to_merge' },
      executionScope('work'),
    )).rejects.toThrow('只有当前任务的复核 Agent');
    await expect(invokeTaskboardAction(
      options,
      identity,
      { action: 'move', id: 'task-other', status: 'ready_to_merge' },
      executionScope('review'),
    )).rejects.toThrow('只有当前任务的复核 Agent');
    await expect(invokeTaskboardAction(
      options,
      identity,
      { action: 'move', id: task.id, status: 'done' },
      executionScope('review'),
    )).rejects.toThrow('只有当前任务的复核 Agent');

    expect(service.moveTask).not.toHaveBeenCalled();
    expect(executionStore.moveTaskFromExecution).toHaveBeenCalledWith(
      identity, execution.runId, 'todo',
    );
    expect(executionStore.moveTaskFromExecution).toHaveBeenCalledWith(
      identity, execution.runId, 'ready_to_merge',
    );
    expect(executionStore.moveTaskFromExecution).toHaveBeenCalledWith(
      identity, execution.runId, 'blocked',
    );
  });

  it('V2 Execution 禁止使用旧 move 回写，必须提交结构化 resolution', async () => {
    const { executionStore, options } = rig();

    await expect(invokeTaskboardAction(
      options,
      identity,
      { action: 'move', id: task.id, status: 'ready_to_merge' },
      executionScope('review', 2),
    )).rejects.toThrow('结构化 resolution');
    expect(executionStore.moveTaskFromExecution).not.toHaveBeenCalled();
  });

  it('普通会话可跨看板分页搜索，并用显式 CAS 修改任务和评论', async () => {
    const { service, options } = rig();
    vi.mocked(service.searchTasks).mockResolvedValueOnce({
      items: [task], page: 2, pageSize: 10, total: 11, hasMore: false,
    });

    await expect(invokeTaskboardAction(options, identity, {
      action: 'task.search', search: '实现', statuses: ['in_review'], labels: ['backend'],
      page: 2, pageSize: 10,
    })).resolves.toMatchObject({ total: 11, page: 2, tasks: [task] });
    await invokeTaskboardAction(options, identity, {
      action: 'task.update', taskId: task.id, title: '实现普通会话管理', expectedVersion: task.version,
    });
    await invokeTaskboardAction(options, identity, {
      action: 'comment.update', id: 'comment-1', body: '更新评论', expectedVersion: 2,
    });

    expect(service.searchTasks).toHaveBeenCalledWith(identity, expect.objectContaining({
      search: '实现', statuses: ['in_review'], labels: ['backend'], page: 2, pageSize: 10,
    }));
    expect(service.updateTask).toHaveBeenCalledWith(identity, task.id, {
      title: '实现普通会话管理', expectedVersion: task.version,
    });
    expect(service.updateComment).toHaveBeenCalledWith(identity, 'comment-1', {
      body: '更新评论', expectedVersion: 2,
    });
    await expect(invokeTaskboardAction(options, identity, {
      action: 'task.update', taskId: task.id, title: '缺版本',
    })).rejects.toThrow('expectedVersion');
    await expect(invokeTaskboardAction(options, identity, {
      action: 'update', id: task.id, branch: '绕过 CAS',
    })).rejects.toThrow('普通会话请使用');
  });

  it('普通会话派发 work Agent，Execution 上下文不能进入资源管理 action', async () => {
    const { executionService, options } = rig();

    await invokeTaskboardAction(options, identity, {
      action: 'task.dispatch', taskId: task.id, expectedVersion: task.version,
    });
    expect(executionService.startExecution).toHaveBeenCalledWith(identity, task.id, {
      expectedVersion: task.version, purpose: 'work',
    });
    await expect(invokeTaskboardAction(options, identity, {
      action: 'task.get', taskId: task.id,
    }, executionScope('work'))).rejects.toThrow('不能进入普通会话管理域');

    vi.mocked(options.service()!.getBoard).mockResolvedValueOnce({ ...board, canManage: false });
    await expect(invokeTaskboardAction(options, identity, {
      action: 'task.dispatch', taskId: task.id, expectedVersion: task.version,
    })).rejects.toMatchObject({ code: 'TASKBOARD_PERMISSION_DENIED' });
  });

  it('task.dispatch 连续派发同一任务时透传活跃 Execution 冲突', async () => {
    const { executionService, options } = rig();

    await invokeTaskboardAction(options, identity, {
      action: 'task.dispatch', taskId: task.id, expectedVersion: task.version,
    });
    vi.mocked(executionService.startExecution).mockRejectedValueOnce(new TaskboardValidationError(
      'Task already has an active Agent execution',
      'TASKBOARD_EXECUTION_ACTIVE',
    ));

    await expect(invokeTaskboardAction(options, identity, {
      action: 'task.dispatch', taskId: task.id, expectedVersion: task.version + 1,
    })).rejects.toMatchObject({ code: 'TASKBOARD_EXECUTION_ACTIVE' });
    expect(executionService.startExecution).toHaveBeenCalledTimes(2);
  });

  it('create+dispatch 在派发失败时明确返回已创建任务，服务未启用时不创建', async () => {
    const { service, executionService, options } = rig();
    vi.mocked(executionService.startDirectExecution).mockRejectedValueOnce(new Error('默认模型不可用'));

    await expect(invokeTaskboardAction(options, identity, {
      action: 'task.create', boardId: board.id, title: '派发失败任务', dispatch: true,
    })).resolves.toMatchObject({
      created: true,
      dispatched: false,
      task: { id: 'task-new', title: '派发失败任务' },
      dispatchError: { message: '默认模型不可用' },
    });
    expect(service.createTask).toHaveBeenCalledTimes(1);

    const unavailable = { ...options, executionService: () => undefined };
    await expect(invokeTaskboardAction(unavailable, identity, {
      action: 'task.create', boardId: board.id, title: '不应创建', dispatch: true,
    })).rejects.toThrow('执行服务未启用');
    expect(service.createTask).toHaveBeenCalledTimes(1);
  });

  it('Execution fencing 限制当前分支回写，并用 create+dispatch 派发新任务', async () => {
    const { service, executionService, executionStore, options } = rig();
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

    expect(service.updateTask).not.toHaveBeenCalled();
    expect(executionStore.updateTaskBranchFromExecution).toHaveBeenCalledWith(
      identity, execution.runId, 'task/TASK-1-updated',
    );
    expect(executionStore.createTaskFromExecution).toHaveBeenCalledWith(
      identity,
      execution.runId,
      expect.objectContaining({
        title: '合并分支',
        status: 'todo',
        clientRequestId: expect.stringMatching(/^taskboard-tool:/),
      }),
    );
    expect(executionService.startDirectExecution).toHaveBeenCalledWith(identity, 'task-new', 1);
  });

  it('task/comment 写入只接收会话 attachmentId，并持久化服务端解析出的元数据', async () => {
    const { service, options } = rig();
    const attachmentId = '11111111-1111-4111-8111-111111111111';
    const canonical: TaskBoardUploadAttachment = {
      attachmentId,
      originalName: '验收证据.png',
      relativePath: `uploads/${attachmentId}_验收证据.png`,
      size: 128,
      mimeType: 'image/png',
      isImage: true,
    };
    const resolveAttachments = vi.fn(async (
      _identity: TaskboardIdentity,
      ids: readonly string[],
      refs?: { sessionId?: string },
    ) => {
      expect(ids).toEqual([attachmentId]);
      expect(refs).toEqual({ sessionId: 'session-attachment-test' });
      return [canonical];
    });
    const markAttachmentsReferenced = vi.fn(async (
      _identity: TaskboardIdentity,
      attachments: readonly TaskBoardUploadAttachment[],
      refs: { sessionId?: string },
    ) => {
      expect(attachments).toEqual([canonical]);
      expect(refs).toEqual({ sessionId: 'session-attachment-test' });
    });
    const materializeTaskAttachments = vi.fn(async (
      _identity: TaskboardIdentity,
      taskId: string,
      ownerUserId: string,
      attachments: readonly TaskBoardUploadAttachment[],
    ) => {
      expect(ownerUserId).toBe(identity.ownerUserId);
      return attachments.map((attachment) => ({
        ...attachment,
        relativePath: `taskboard/attachments/${taskId}/${attachment.attachmentId}-验收证据.png`,
      }));
    });
    const attachmentOptions = {
      ...options,
      resolveAttachments,
      materializeTaskAttachments,
      markAttachmentsReferenced,
    };
    const scope = { sessionId: 'session-attachment-test' };

    await invokeTaskboardAction(attachmentOptions, identity, {
      action: 'task.create', boardId: board.id, title: '带证据任务',
      attachments: [{ attachmentId }],
    }, scope);
    await invokeTaskboardAction(attachmentOptions, identity, {
      action: 'task.update', taskId: task.id, expectedVersion: task.version,
      attachments: [{ attachmentId }],
    }, scope);
    await invokeTaskboardAction(attachmentOptions, identity, {
      action: 'comment.create', taskId: task.id, attachments: [{ attachmentId }],
    }, scope);

    expect(service.createTask).toHaveBeenCalledWith(identity, board.id, expect.objectContaining({
      title: '带证据任务',
    }));
    expect(service.createTask).toHaveBeenCalledWith(identity, board.id, expect.not.objectContaining({
      attachments: [canonical],
    }));
    expect(service.updateTask).toHaveBeenCalledWith(identity, task.id, expect.objectContaining({
      attachments: [expect.objectContaining({ relativePath: `taskboard/attachments/${task.id}/${attachmentId}-验收证据.png` })],
      expectedVersion: task.version,
    }));
    expect(service.createComment).toHaveBeenCalledWith(identity, task.id, {
      body: '', attachments: [expect.objectContaining({ relativePath: `taskboard/attachments/${task.id}/${attachmentId}-验收证据.png` })],
    });
    expect(resolveAttachments).toHaveBeenCalledTimes(3);
    expect(materializeTaskAttachments).toHaveBeenCalledTimes(3);
    expect(markAttachmentsReferenced).toHaveBeenCalledTimes(3);
  });
});
