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
  ownerUserId: identity.ownerUserId, role: 'owner',
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
    createExecutionCommentV2: vi.fn(async (_identity, _runId, body) => ({
      id: 'agent-comment', taskId: task.id, body, authorType: 'agent' as const,
      authorId: execution.runId, authorName: 'Agent', version: 1,
      createdAt: board.createdAt, updatedAt: board.updatedAt,
    })),
    transitionExecutionV2: vi.fn(async (_identity, _runId, input) => ({ ...task, status: input.status })),
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
    deleteTask: vi.fn(async () => ({ ...task, deletedAt: task.updatedAt, version: task.version + 1 })),
    rollbackTaskCreation: vi.fn(async () => ({ ...task, deletedAt: task.updatedAt, version: task.version + 1 })),
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
    inspectExecutionPullRequestV2: vi.fn(async () => ({
      gateStatus: 'success' as const,
      receipt: {
        inspectionId: 'inspection-1', digest: 'digest', executionId: execution.id,
        taskId: task.id, purpose: 'review' as const, repositoryId: 'repo-1',
        providerPullRequestId: '42', headOid: 'head-42', providerQueriedAt: task.updatedAt,
      },
      snapshot: {
        providerPullRequestId: '42', number: 42, state: 'open' as const, draft: false,
        headRef: task.branch!, headOid: 'head-42', baseRef: 'main', baseOid: 'base-1',
        mergeable: true, requiredChecksKnown: true,
        requiredChecks: [{ name: 'Build & Check', status: 'success' as const }],
        subjectDigest: 'subject-42', repositoryId: 'repo-1', providerQueriedAt: task.updatedAt,
        workflowRuns: [],
      },
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
    createTaskFromExecutionWithResult: vi.fn(async (_identity, _runId, input) => ({ task: { ...task, id: 'task-new', identifier: 'TASK-2', title: input.title, status: 'todo' as const, version: 1 }, created: true })),
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

  it('Execution 只用 comment 写交付并用 transition 指定下一状态', async () => {
    const { service, options } = rig();
    const scope = executionScope('review', 2);

    await expect(invokeTaskboardAction(options, identity, {
      action: 'execution.comment', body: '复核通过，检查记录见评论。',
    }, scope)).resolves.toMatchObject({ created: true, comment: { body: '复核通过，检查记录见评论。' } });
    await expect(invokeTaskboardAction(options, identity, {
      action: 'execution.transition', status: 'ready_to_merge',
    }, scope)).resolves.toMatchObject({ transitioned: true, task: { status: 'ready_to_merge' } });

    expect(service.transitionExecutionV2).toHaveBeenCalledWith(
      identity, execution.runId, { status: 'ready_to_merge' },
    );
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

  it('V2 Execution 禁止使用旧 move 回写，必须通过 transition 指定下一状态', async () => {
    const { executionStore, options } = rig();

    await expect(invokeTaskboardAction(
      options,
      identity,
      { action: 'move', id: task.id, status: 'ready_to_merge' },
      executionScope('review', 2),
    )).rejects.toThrow('execution.transition');
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
    expect(executionStore.createTaskFromExecutionWithResult).toHaveBeenCalledWith(
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

  it('task.update 携带附件时追加既有任务附件而不是替换', async () => {
    const { service, options } = rig();
    const attachmentId = '33333333-3333-4333-8333-333333333333';
    const existing = {
      attachmentId: 'old-attachment',
      originalName: '已有证据.png',
      relativePath: 'taskboard/attachments/task-1/old-attachment-已有证据.png',
      size: 2,
      mimeType: 'image/png',
      isImage: true,
    };
    const source = {
      attachmentId,
      originalName: '新增证据.txt',
      relativePath: `uploads/${attachmentId}_新增证据.txt`,
      size: 1,
      mimeType: 'text/plain',
      isImage: false,
    };
    const scoped = {
      ...source,
      relativePath: `taskboard/attachments/${task.id}/${attachmentId}-新增证据.txt`,
    };
    vi.mocked(service.getTask).mockResolvedValueOnce({ ...task, attachments: [existing] });
    const attachmentOptions = {
      ...options,
      resolveAttachments: vi.fn(async () => [source]),
      materializeTaskAttachments: vi.fn(async () => [scoped]),
      markAttachmentsReferenced: vi.fn(async () => undefined),
    };

    await invokeTaskboardAction(attachmentOptions, identity, {
      action: 'task.update', taskId: task.id, expectedVersion: task.version,
      attachments: [{ attachmentId }],
    }, { sessionId: 'session-append' });

    expect(service.updateTask).toHaveBeenCalledWith(identity, task.id, {
      attachments: [existing, scoped], expectedVersion: task.version,
    });
  });

  it('兼容 create/update 携带附件时先标记，失败不落库', async () => {
    const { service, executionStore, options } = rig();
    const attachmentId = '66666666-6666-4666-8666-666666666666';
    const source = {
      attachmentId,
      originalName: '兼容证据.txt',
      relativePath: `uploads/${attachmentId}_兼容证据.txt`,
      size: 1,
      mimeType: 'text/plain',
      isImage: false,
    };
    const materializeTaskAttachments = vi.fn(async () => [source]);
    const attachmentOptions = {
      ...options,
      resolveAttachments: vi.fn(async () => [source]),
      materializeTaskAttachments,
      markAttachmentsReferenced: vi.fn(async () => { throw new Error('reference failed'); }),
    };
    const scope = { ...executionScope('work'), sessionId: 'session-legacy' };

    await expect(invokeTaskboardAction(attachmentOptions, identity, {
      action: 'create', boardId: board.id, title: '兼容创建', attachments: [{ attachmentId }],
    }, scope)).rejects.toThrow('reference failed');
    await expect(invokeTaskboardAction(attachmentOptions, identity, {
      action: 'update', id: task.id, attachments: [{ attachmentId }],
    }, scope)).rejects.toThrow('reference failed');

    expect(executionStore.createTaskFromExecution).not.toHaveBeenCalled();
    expect(service.updateTask).not.toHaveBeenCalled();
    expect(materializeTaskAttachments).toHaveBeenCalledTimes(1);
  });

  it('兼容 create/update 落库失败时清理任务作用域附件', async () => {
    const { service, executionStore, options } = rig();
    const attachmentId = '77777777-7777-4777-8777-777777777777';
    const source = {
      attachmentId,
      originalName: '兼容失败.txt',
      relativePath: `uploads/${attachmentId}_兼容失败.txt`,
      size: 1,
      mimeType: 'text/plain',
      isImage: false,
    };
    const scoped = {
      ...source,
      relativePath: `taskboard/attachments/${task.id}/${attachmentId}-兼容失败.txt`,
    };
    const cleanupTaskAttachments = vi.fn(async () => undefined);
    const attachmentOptions = {
      ...options,
      resolveAttachments: vi.fn(async () => [source]),
      materializeTaskAttachments: vi.fn(async () => [scoped]),
      cleanupTaskAttachments,
      markAttachmentsReferenced: vi.fn(async () => undefined),
    };
    vi.mocked(service.updateTask).mockRejectedValueOnce(new Error('legacy update failed'));
    const scope = { ...executionScope('work'), sessionId: 'session-legacy-cleanup' };

    await expect(invokeTaskboardAction(attachmentOptions, identity, {
      action: 'update', id: task.id, attachments: [{ attachmentId }],
    }, scope)).rejects.toThrow('legacy update failed');
    expect(cleanupTaskAttachments).toHaveBeenCalledWith(identity, task.id, identity.ownerUserId, [scoped]);

    vi.mocked(service.updateTask).mockRejectedValueOnce(new Error('execution create update failed'));
    await expect(invokeTaskboardAction(attachmentOptions, identity, {
      action: 'create', boardId: board.id, title: '兼容复制失败', attachments: [{ attachmentId }],
    }, scope)).rejects.toThrow('execution create update failed');
    expect(executionStore.createTaskFromExecutionWithResult).toHaveBeenCalledTimes(1);
    expect(service.rollbackTaskCreation).toHaveBeenCalledWith(identity, 'task-new', { expectedVersion: 1 });
    expect(cleanupTaskAttachments).toHaveBeenCalledWith(identity, 'task-new', identity.ownerUserId, [scoped]);
  });

  it('附件引用标记失败时不落库任务、更新或评论', async () => {
    const { service, options } = rig();
    const attachmentId = '44444444-4444-4444-8444-444444444444';
    const cleanupTaskAttachments = vi.fn(async () => undefined);
    const attachmentOptions = {
      ...options,
      resolveAttachments: vi.fn(async () => [{
        attachmentId,
        originalName: '证据.txt',
        relativePath: `uploads/${attachmentId}_证据.txt`,
        size: 1,
        mimeType: 'text/plain',
        isImage: false,
      }]),
      materializeTaskAttachments: vi.fn(async (
        _identity: TaskboardIdentity,
        _taskId: string,
        _ownerUserId: string,
        attachments: readonly TaskBoardUploadAttachment[],
      ) => [...attachments]),
      cleanupTaskAttachments,
      markAttachmentsReferenced: vi.fn(async () => { throw new Error('reference failed'); }),
    };
    const scope = { sessionId: 'session-reference-failure' };

    await expect(invokeTaskboardAction(attachmentOptions, identity, {
      action: 'task.create', boardId: board.id, title: '引用失败任务', attachments: [{ attachmentId }],
    }, scope)).rejects.toThrow('reference failed');
    await expect(invokeTaskboardAction(attachmentOptions, identity, {
      action: 'task.update', taskId: task.id, expectedVersion: task.version, attachments: [{ attachmentId }],
    }, scope)).rejects.toThrow('reference failed');
    await expect(invokeTaskboardAction(attachmentOptions, identity, {
      action: 'comment.create', taskId: task.id, attachments: [{ attachmentId }],
    }, scope)).rejects.toThrow('reference failed');
    expect(service.createTask).not.toHaveBeenCalled();
    expect(service.updateTask).not.toHaveBeenCalled();
    expect(service.createComment).not.toHaveBeenCalled();
    expect(cleanupTaskAttachments).toHaveBeenCalledTimes(2);
  });

  it('任务或评论落库失败时清理已复制的任务作用域附件', async () => {
    const { service, options } = rig();
    const attachmentId = '55555555-5555-4555-8555-555555555555';
    const source = {
      attachmentId,
      originalName: '证据.txt',
      relativePath: `uploads/${attachmentId}_证据.txt`,
      size: 1,
      mimeType: 'text/plain',
      isImage: false,
    };
    const scoped = { ...source, relativePath: `taskboard/attachments/${task.id}/${attachmentId}-证据.txt` };
    const cleanupTaskAttachments = vi.fn(async () => undefined);
    const attachmentOptions = {
      ...options,
      resolveAttachments: vi.fn(async () => [source]),
      materializeTaskAttachments: vi.fn(async () => [scoped]),
      markAttachmentsReferenced: vi.fn(async () => undefined),
      cleanupTaskAttachments,
    };
    vi.mocked(service.updateTask).mockRejectedValueOnce(new Error('task write failed'));
    await expect(invokeTaskboardAction(attachmentOptions, identity, {
      action: 'task.update', taskId: task.id, expectedVersion: task.version,
      attachments: [{ attachmentId }],
    }, { sessionId: 'session-cleanup' })).rejects.toThrow('task write failed');
    vi.mocked(service.createComment).mockRejectedValueOnce(new Error('comment write failed'));
    await expect(invokeTaskboardAction(attachmentOptions, identity, {
      action: 'comment.create', taskId: task.id, attachments: [{ attachmentId }],
    }, { sessionId: 'session-cleanup' })).rejects.toThrow('comment write failed');
    expect(cleanupTaskAttachments).toHaveBeenCalledTimes(2);
    expect(cleanupTaskAttachments).toHaveBeenCalledWith(identity, task.id, identity.ownerUserId, [scoped]);
  });

  it('附件写入缺少会话上下文时拒绝，不向 resolver 传空 scope', async () => {
    const { options } = rig();
    const resolveAttachments = vi.fn(async () => [] as TaskBoardUploadAttachment[]);
    const attachmentOptions = { ...options, resolveAttachments };

    await expect(invokeTaskboardAction(attachmentOptions, identity, {
      action: 'comment.create', taskId: task.id,
      attachments: [{ attachmentId: '11111111-1111-4111-8111-111111111111' }],
    })).rejects.toMatchObject({ code: 'TASKBOARD_ATTACHMENT_SESSION_REQUIRED' });
    expect(resolveAttachments).not.toHaveBeenCalled();
  });

  it('task.create 附件复制失败时删除已创建任务', async () => {
    const { service, options } = rig();
    const attachmentId = '22222222-2222-4222-8222-222222222222';
    const attachmentOptions = {
      ...options,
      resolveAttachments: vi.fn(async () => [{
        attachmentId,
        originalName: '证据.txt',
        relativePath: `uploads/${attachmentId}_证据.txt`,
        size: 1,
        mimeType: 'text/plain',
        isImage: false,
      }]),
      materializeTaskAttachments: vi.fn(async () => {
        throw new Error('copy failed');
      }),
      markAttachmentsReferenced: vi.fn(async () => undefined),
    };

    await expect(invokeTaskboardAction(attachmentOptions, identity, {
      action: 'task.create', boardId: board.id, title: '复制失败任务',
      attachments: [{ attachmentId }],
    }, { sessionId: 'session-copy-failure' })).rejects.toThrow('copy failed');
    expect(service.rollbackTaskCreation).toHaveBeenCalledWith(identity, 'task-new', { expectedVersion: 1 });
  });

  it('当前 Work/Review Execution 可通过受控 action 检查登记 PR 与 CI', async () => {
    const { service, options } = rig();
    const scope = executionScope('review');

    await expect(invokeTaskboardAction(options, identity,
      { action: 'execution.pull_request.inspect', taskId: task.id }, scope)).resolves.toMatchObject({
      gateStatus: 'success',
      receipt: { executionId: execution.id, taskId: task.id, headOid: 'head-42' },
    });
    expect(service.inspectExecutionPullRequestV2).toHaveBeenCalledWith(identity, execution.runId); });
});
