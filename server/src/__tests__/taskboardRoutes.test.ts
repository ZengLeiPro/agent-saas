import type { Server } from 'node:http';

import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  TaskBoard,
  TaskBoardComment,
  TaskBoardExecution,
  TaskBoardTask,
} from '../../../shared/src/types/taskboard.js';
import type { JwtPayload } from '../auth/types.js';
import type { UserStore } from '../data/users/store.js';
import { createTaskboardRouter, type TaskboardRouterOptions } from '../routes/taskboard.js';
import {
  TaskboardConflictError,
  TaskboardNotFoundError,
  TaskboardPermissionError,
  TaskboardValidationError,
  type TaskboardExecutionService,
  type TaskboardIdentity,
  type TaskboardService,
  type TaskboardTaskListFilter,
} from '../taskboard/types.js';

const USER: JwtPayload = {
  sub: 'user-1',
  username: 'alice',
  role: 'admin',
  tenantId: 'tenant-a',
};

const BOARD: TaskBoard = {
  id: 'board-1',
  name: '研发事项',
  visibility: 'personal',
  ownerUserId: USER.sub,
  canManage: true,
  prompt: '执行看板任务',
  version: 1,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

const TASK: TaskBoardTask = {
  id: 'task-1',
  boardId: BOARD.id,
  identifier: 'TASK-1',
  title: '实现任务看板',
  description: '',
  status: 'backlog',
  priority: 'none',
  labels: [],
  sortOrder: 1024,
  commentCount: 0,
  version: 1,
  createdAt: BOARD.createdAt,
  updatedAt: BOARD.updatedAt,
};

const COMMENT: TaskBoardComment = {
  id: 'comment-1',
  taskId: TASK.id,
  body: '补充上下文',
  authorType: 'user',
  authorId: USER.sub,
  authorName: USER.username,
  version: 1,
  createdAt: BOARD.createdAt,
  updatedAt: BOARD.updatedAt,
};

const EXECUTION: TaskBoardExecution = {
  id: 'execution-1',
  taskId: TASK.id,
  runId: 'run-1',
  sessionId: 'session-1',
  status: 'queued',
  purpose: 'work',
  requestedBy: USER.sub,
  createdAt: BOARD.createdAt,
  updatedAt: BOARD.updatedAt,
};

interface Captured {
  identities: TaskboardIdentity[];
  taskFilters: TaskboardTaskListFilter[];
  createBoards: unknown[];
}

interface Rig {
  baseUrl: string;
  captured: Captured;
  setCaller(user: JwtPayload | null): void;
  request(path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

const rigs: Rig[] = [];
afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.close()));
});

describe('Taskboard routes', () => {
  it('requires login before checking service availability, then returns 503 when PG service is disabled', async () => {
    const rig = await makeRig(undefined, null);
    expect((await rig.request('/api/taskboard/boards')).status).toBe(401);

    rig.setCaller(USER);
    const unavailable = await rig.request('/api/taskboard/boards');
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ code: 'TASKBOARD_UNAVAILABLE' });
  });

  it('uses tenantId/sub/username from req.user and rejects ownership fields through strict schemas', async () => {
    const captured: Captured = { identities: [], taskFilters: [], createBoards: [] };
    const rig = await makeRig(makeService(captured), USER, captured);

    const forged = await rig.request('/api/taskboard/boards', postJson({
      name: '伪造看板',
      tenantId: 'tenant-b',
      ownerUserId: 'victim',
    }));
    expect(forged.status).toBe(400);
    expect(captured.createBoards).toHaveLength(0);

    const created = await rig.request('/api/taskboard/boards', postJson({
      name: '研发事项',
      description: '首期',
      prompt: '只处理当前看板任务',
      model: 'group-a/model-a',
      stageModels: { work: 'group-a/model-work', review: 'group-a/model-review', merge: 'group-a/model-merge' },
      visibility: 'organization',
    }));
    expect(created.status).toBe(201);
    expect(captured.identities.at(-1)).toEqual({
      tenantId: USER.tenantId,
      ownerUserId: USER.sub,
      username: USER.username,
      displayName: USER.username,
      userRole: USER.role,
    });
    expect(captured.createBoards).toEqual([{
      name: '研发事项',
      description: '首期',
      prompt: '只处理当前看板任务',
      model: 'group-a/model-a',
      stageModels: { work: 'group-a/model-work', review: 'group-a/model-review', merge: 'group-a/model-merge' },
      visibility: 'organization',
    }]);
  });

  it('parses and validates per-stage prompts on board create/patch', async () => {
    const captured: Captured = { identities: [], taskFilters: [], createBoards: [] };
    const rig = await makeRig(makeService(captured), USER, captured);

    const created = await rig.request('/api/taskboard/boards', postJson({
      name: '阶段提示语看板',
      prompt: '看板总提示语',
      stagePrompts: {
        work: '只负责实施。',
        review: '复核时检查证据链。',
      },
    }));
    expect(created.status).toBe(201);
    expect(captured.createBoards).toEqual([{
      name: '阶段提示语看板',
      prompt: '看板总提示语',
      stagePrompts: { work: '只负责实施。', review: '复核时检查证据链。' },
    }]);

    const patched = await rig.request('/api/taskboard/boards/board-1', patchJson({
      stagePrompts: { merge: '负责合并交付。' },
      expectedVersion: 1,
    }));
    expect(patched.status).toBe(200);

    const cleared = await rig.request('/api/taskboard/boards/board-1', patchJson({
      stagePrompts: null,
      expectedVersion: 1,
    }));
    expect(cleared.status).toBe(200);

    // 未知阶段字段在 strict schema 下被拒绝。
    const rejected = await rig.request('/api/taskboard/boards/board-1', patchJson({
      stagePrompts: { deploy: '不允许的阶段' },
      expectedVersion: 1,
    }));
    expect(rejected.status).toBe(400);
  });

  it('parses model fields on board/task mutations and injects display name from userStore', async () => {
    const captured: Captured = { identities: [], taskFilters: [], createBoards: [] };
    const userStore = {
      findById: (id: string) => (id === USER.sub ? { realName: '曾磊' } : undefined),
    } as unknown as UserStore;
    const rig = await makeRig(makeService(captured), USER, captured, undefined, userStore);

    const patchedBoard = await rig.request('/api/taskboard/boards/board-1', patchJson({
      model: null,
      stageModels: { merge: 'group-a/model-merge' },
      expectedVersion: 1,
    }));
    expect(patchedBoard.status).toBe(200);
    expect(captured.identities.at(-1)).toEqual({
      tenantId: USER.tenantId,
      ownerUserId: USER.sub,
      username: USER.username,
      displayName: `曾磊 @${USER.username}`,
      userRole: USER.role,
    });

    const createdTask = await rig.request('/api/taskboard/boards/board-1/tasks', postJson({
      title: '新任务',
      branch: 'task/TASK-2-feature',
      model: 'group-a/model-b',
    }));
    expect(createdTask.status).toBe(201);

    expect((await rig.request('/api/taskboard/tasks/task-1', patchJson({
      branch: null,
      model: null,
      expectedVersion: 1,
    }))).status).toBe(200);
  });

  it('strictly validates every mutation shape and parses search/status/priority filters', async () => {
    const captured: Captured = { identities: [], taskFilters: [], createBoards: [] };
    const rig = await makeRig(makeService(captured), USER, captured);

    expect((await rig.request('/api/taskboard/tasks/task-1/move', postJson({
      status: 'done',
      expectedVersion: 1,
      runId: 'forbidden',
    }))).status).toBe(400);
    expect((await rig.request('/api/taskboard/tasks/task-1', patchJson({
      expectedVersion: 1,
    }))).status).toBe(400);
    expect((await rig.request('/api/taskboard/tasks/task-1', patchJson({
      kind: 'delivery',
      expectedVersion: 1,
    }))).status).toBe(200);
    expect((await rig.request('/api/taskboard/tasks/task-1', patchJson({
      kind: 'advisory',
      expectedVersion: 1,
    }))).status).toBe(400);
    expect((await rig.request('/api/taskboard/boards/board-1', patchJson({
      stageModels: { unknownStage: 'group-a/model-a' },
      expectedVersion: 1,
    }))).status).toBe(400);
    expect((await rig.request('/api/taskboard/boards/board-1', patchJson({
      stageModels: { work: '' },
      expectedVersion: 1,
    }))).status).toBe(400);
    expect((await rig.request('/api/taskboard/tasks/task-1/comments', postJson({
      body: 'ok',
      attachmentId: 'forbidden',
    }))).status).toBe(400);

    const list = await rig.request(
      '/api/taskboard/boards/board-1/tasks?includeArchived=true&search=TASK&status=todo,in_progress,ready_to_merge&priority=urgent&priority=high',
    );
    expect(list.status).toBe(200);
    expect(captured.taskFilters).toEqual([{
      includeArchived: true,
      search: 'TASK',
      statuses: ['todo', 'in_progress', 'ready_to_merge'],
      priorities: ['urgent', 'high'],
    }]);
  });

  it('lists execution history and accepts an explicit Agent execution request', async () => {
    const executionService: TaskboardExecutionService = {
      listExecutions: async () => [EXECUTION],
      searchExecutions: async (_identity, _taskId, filter = {}) => ({
        items: [EXECUTION], page: filter.page ?? 1, pageSize: filter.pageSize ?? 20, total: 1, hasMore: false,
      }),
      startExecution: async (identity, taskId, input) => {
        expect(identity).toEqual({
          tenantId: USER.tenantId,
          ownerUserId: USER.sub,
          username: USER.username,
          displayName: USER.username,
          userRole: USER.role,
        });
        expect(taskId).toBe(TASK.id);
        expect(input).toEqual({ expectedVersion: TASK.version, purpose: 'review' });
        return {
          task: { ...TASK, status: 'in_review', version: TASK.version + 1 },
          execution: EXECUTION,
        };
      },
      startDirectExecution: async (_identity, taskId, expectedVersion) => {
        expect(taskId).toBe(TASK.id);
        expect(expectedVersion).toBe(TASK.version);
        return {
          task: { ...TASK, status: 'in_progress', version: TASK.version + 1 },
          execution: EXECUTION,
        };
      },
      continueExecution: async (_identity, taskId, commentId) => {
        expect(taskId).toBe(TASK.id);
        expect(commentId).toBe(COMMENT.id);
        return {
          task: { ...TASK, status: 'in_progress', version: TASK.version + 1 },
          execution: EXECUTION,
        };
      },
    };
    const rig = await makeRig(
      makeService({ identities: [], taskFilters: [], createBoards: [] }),
      USER,
      undefined,
      executionService,
    );

    const listed = await rig.request(`/api/taskboard/tasks/${TASK.id}/executions`);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual([EXECUTION]);
    const paged = await rig.request(`/api/taskboard/tasks/${TASK.id}/executions?page=1&pageSize=10`);
    expect(paged.status).toBe(200);
    expect(await paged.json()).toMatchObject({ items: [EXECUTION], page: 1, pageSize: 10, total: 1 });

    const started = await rig.request(`/api/taskboard/tasks/${TASK.id}/execute`, postJson({
      expectedVersion: TASK.version,
      purpose: 'review',
    }));
    expect(started.status).toBe(202);
    expect(await started.json()).toMatchObject({
      task: { status: 'in_review', version: TASK.version + 1 },
      execution: { id: EXECUTION.id, status: 'queued' },
    });

    const createdAndStarted = await rig.request(`/api/taskboard/boards/${BOARD.id}/tasks`, postJson({
      title: '直接执行',
      status: 'in_progress',
      clientRequestId: 'create-and-run-1',
      dispatch: true,
    }));
    expect(createdAndStarted.status).toBe(201);
    expect(await createdAndStarted.json()).toMatchObject({ status: 'in_progress' });

    const continued = await rig.request(
      `/api/taskboard/tasks/${TASK.id}/comments/${COMMENT.id}/execute`,
      postJson({}),
    );
    expect(continued.status).toBe(202);
    expect(await continued.json()).toMatchObject({ task: { status: 'in_progress' } });

    expect((await rig.request(`/api/taskboard/tasks/${TASK.id}/execute`, postJson({
      expectedVersion: TASK.version,
      cronJobId: 'forbidden',
    }))).status).toBe(400);
  });

  it('blocked task resume endpoint validates and forwards the explicit decision', async () => {
    const service = makeService({ identities: [], taskFilters: [], createBoards: [] });
    let received: unknown;
    service.resumeBlockedTask = async (_identity, taskId, input) => {
      expect(taskId).toBe(TASK.id);
      received = input;
      return { ...TASK, status: 'todo', version: TASK.version + 1 };
    };
    const rig = await makeRig(service, USER);

    const response = await rig.request(`/api/taskboard/tasks/${TASK.id}/resume`, postJson({
      expectedVersion: TASK.version,
      decision: '批准恢复失败来源',
      sourceIds: ['source-1'],
    }));

    expect(response.status).toBe(200);
    expect(received).toEqual({
      expectedVersion: TASK.version,
      decision: '批准恢复失败来源',
      sourceIds: ['source-1'],
    });
    expect(await response.json()).toMatchObject({ status: 'todo', version: TASK.version + 1 });
  });

  it('评论可仅携带附件，并使用服务端解析出的可信元数据', async () => {
    const service = makeService({ identities: [], taskFilters: [], createBoards: [] });
    let received: unknown;
    service.createComment = async (_identity, _taskId, input) => {
      received = input;
      return { ...COMMENT, body: input.body, attachments: input.attachments };
    };
    const attachmentId = '11111111-1111-4111-8111-111111111111';
    const canonical = {
      attachmentId,
      originalName: '现场图.png',
      relativePath: 'uploads/111_现场图.png',
      size: 123,
      mimeType: 'image/png',
      isImage: true,
    };
    const uploadManager = {
      resolveAttachments: async (_userCwd: string, ids: readonly string[]) => {
        expect(ids).toEqual([attachmentId]);
        return [canonical];
      },
      materializeTaskAttachments: async (
        _sourceCwd: string,
        _targetCwd: string,
        taskId: string,
        attachments: readonly (typeof canonical)[],
      ) => attachments.map((attachment) => ({
        ...attachment,
        relativePath: `taskboard/attachments/${taskId}/${attachmentId}-现场图.png`,
      })),
      resolveTaskAttachment: async (_ownerCwd: string, taskId: string, attachment: typeof canonical) => {
        expect(taskId).toBe(TASK.id);
        expect(attachment.attachmentId).toBe(attachmentId);
        return `${process.cwd()}/package.json`;
      },
      markReferenced: async () => undefined,
    } as unknown as TaskboardRouterOptions['uploadManager'];
    const rig = await makeRig(service, USER, undefined, undefined, undefined, {
      agentCwd: '/agent',
      uploadManager,
    });

    const response = await rig.request(`/api/taskboard/tasks/${TASK.id}/comments`, postJson({
      body: '',
      attachments: [{ ...canonical, originalName: '伪造名称.exe', relativePath: '../../etc/passwd' }],
    }));

    expect(response.status).toBe(201);
    expect(received).toEqual({
      body: '',
      attachments: [expect.objectContaining({
        attachmentId,
        relativePath: `taskboard/attachments/${TASK.id}/${attachmentId}-现场图.png`,
      })],
    });
    expect(await response.json()).toMatchObject({
      attachments: [expect.objectContaining({ relativePath: `taskboard/attachments/${TASK.id}/${attachmentId}-现场图.png` })],
    });

    const taskWithAttachment = {
      ...TASK,
      attachments: [{ ...canonical, mimeType: 'application/json', isImage: false }],
    };
    service.getTask = async (identity, taskId) => {
      if (identity.ownerUserId !== USER.sub) throw new TaskboardPermissionError();
      expect(taskId).toBe(TASK.id);
      return taskWithAttachment;
    };
    const download = await rig.request(
      `/api/taskboard/tasks/${TASK.id}/attachments/${attachmentId}?download=1`,
    );
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toContain('application/json');
    expect(await download.text()).toContain('"name"');

    service.getTask = async (identity, taskId) => {
      if (identity.ownerUserId !== USER.sub) throw new TaskboardPermissionError();
      expect(taskId).toBe(TASK.id);
      return TASK;
    };
    service.listComments = async (identity, taskId) => {
      if (identity.ownerUserId !== USER.sub) throw new TaskboardPermissionError();
      expect(taskId).toBe(TASK.id);
      return [{ ...COMMENT, attachments: [canonical] }];
    };
    const commentDownload = await rig.request(
      `/api/taskboard/tasks/${TASK.id}/attachments/${attachmentId}`,
    );
    expect(commentDownload.status).toBe(200);
    expect(commentDownload.headers.get('content-type')).toContain('image/png');

    rig.setCaller({ ...USER, sub: 'user-2', username: 'bob' });
    const forbidden = await rig.request(
      `/api/taskboard/tasks/${TASK.id}/attachments/${attachmentId}`,
    );
    expect(forbidden.status).toBe(403);
  });

  it('HTTP 附件引用标记失败时不落库任务、更新或评论', async () => {
    const service = makeService({ identities: [], taskFilters: [], createBoards: [] });
    let created = 0;
    let updated = 0;
    let comments = 0;
    service.createTask = async () => { created += 1; return TASK; };
    service.updateTask = async () => { updated += 1; return TASK; };
    service.createComment = async () => { comments += 1; return COMMENT; };
    const attachmentId = '44444444-4444-4444-8444-444444444444';
    const canonical = {
      attachmentId,
      originalName: '证据.txt',
      relativePath: `uploads/${attachmentId}_证据.txt`,
      size: 1,
      mimeType: 'text/plain',
      isImage: false,
    };
    const uploadManager = {
      resolveAttachments: async () => [canonical],
      materializeTaskAttachments: async (
        _sourceCwd: string,
        _targetCwd: string,
        _taskId: string,
        attachments: readonly (typeof canonical)[],
      ) => attachments,
      markReferenced: async () => { throw new Error('reference failed'); },
    } as unknown as TaskboardRouterOptions['uploadManager'];
    const rig = await makeRig(service, USER, undefined, undefined, undefined, {
      agentCwd: '/agent', uploadManager,
    });
    const attachment = { ...canonical };

    expect((await rig.request('/api/taskboard/boards/board-1/tasks', postJson({
      title: '引用失败任务', attachments: [attachment],
    }))).status).toBe(503);
    expect((await rig.request('/api/taskboard/tasks/task-1', patchJson({
      title: '引用失败更新', attachments: [attachment], expectedVersion: TASK.version,
    }))).status).toBe(503);
    expect((await rig.request('/api/taskboard/tasks/task-1/comments', postJson({
      body: '', attachments: [attachment],
    }))).status).toBe(503);
    expect({ created, updated, comments }).toEqual({ created: 0, updated: 0, comments: 0 });
  });

  it('创建任务的附件复制失败时回滚已创建任务', async () => {
    const service = makeService({ identities: [], taskFilters: [], createBoards: [] });
    let rolledBackTask: { id: string; version: number } | undefined;
    service.rollbackTaskCreation = async (_identity, taskId, input) => {
      rolledBackTask = { id: taskId, version: input.expectedVersion };
      return { ...TASK, id: taskId, version: input.expectedVersion + 1, deletedAt: TASK.updatedAt };
    };
    const attachmentId = '33333333-3333-4333-8333-333333333333';
    const uploadManager = {
      resolveAttachments: async () => [{
        attachmentId,
        originalName: '证据.txt',
        relativePath: `uploads/${attachmentId}_证据.txt`,
        size: 1,
        mimeType: 'text/plain',
        isImage: false,
      }],
      materializeTaskAttachments: async () => {
        throw new Error('copy failed');
      },
      markReferenced: async () => undefined,
    } as unknown as TaskboardRouterOptions['uploadManager'];
    const rig = await makeRig(service, USER, undefined, undefined, undefined, {
      agentCwd: '/agent',
      uploadManager,
    });
    const response = await rig.request('/api/taskboard/boards/board-1/tasks', postJson({
      title: '复制失败任务',
      attachments: [{
        attachmentId,
        originalName: '伪造名称.exe',
        relativePath: '../../etc/passwd',
        size: 1,
        mimeType: 'application/octet-stream',
        isImage: false,
      }],
    }));

    expect(response.status).toBe(400);
    expect(rolledBackTask).toEqual({ id: TASK.id, version: TASK.version });
  });

  it('provides paged board/task search and comment update/delete endpoints', async () => {
    const captured: Captured = { identities: [], taskFilters: [], createBoards: [] };
    const service = makeService(captured);
    const rig = await makeRig(service, USER, captured);

    const boards = await rig.request('/api/taskboard/boards/search?search=研发&page=1&pageSize=10');
    expect(boards.status).toBe(200);
    expect(await boards.json()).toMatchObject({ total: 1, page: 1, pageSize: 10, items: [BOARD] });

    const tasks = await rig.request('/api/taskboard/tasks/search?search=看板&status=backlog&labels=backend&pageSize=5');
    expect(tasks.status).toBe(200);
    expect(await tasks.json()).toMatchObject({ total: 1, pageSize: 5, items: [TASK] });

    const comments = await rig.request(`/api/taskboard/tasks/${TASK.id}/comments?page=1&pageSize=5`);
    expect(comments.status).toBe(200);
    expect(await comments.json()).toMatchObject({ total: 1, page: 1, pageSize: 5, items: [COMMENT] });

    const updated = await rig.request(`/api/taskboard/comments/${COMMENT.id}`, patchJson({
      body: '更新后的评论', expectedVersion: COMMENT.version,
    }));
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ body: '更新后的评论', version: 2 });

    const deleted = await rig.request(`/api/taskboard/comments/${COMMENT.id}`, {
      ...postJson({ expectedVersion: 2 }), method: 'DELETE',
    });
    expect(deleted.status).toBe(200);
  });

  it('maps comment permission denial to 403', async () => {
    const service = makeService({ identities: [], taskFilters: [], createBoards: [] });
    service.updateComment = async () => {
      throw new TaskboardPermissionError('Only the comment author or board owner may manage this comment');
    };
    const rig = await makeRig(service, USER);

    const response = await rig.request(`/api/taskboard/comments/${COMMENT.id}`, patchJson({
      body: '越权修改', expectedVersion: 1,
    }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'TASKBOARD_PERMISSION_DENIED' });
  });

  it('maps not found, domain validation, CAS with current object, and database faults', async () => {
    const service = makeService({ identities: [], taskFilters: [], createBoards: [] });
    service.getTask = async () => { throw new TaskboardNotFoundError('Task not found'); };
    service.updateBoard = async () => { throw new TaskboardValidationError('Archived boards are read-only'); };
    service.moveTask = async () => { throw new TaskboardConflictError({ ...TASK, version: 3 }); };
    service.listComments = async () => { throw new Error('connection lost'); };
    const rig = await makeRig(service, USER);

    expect((await rig.request('/api/taskboard/tasks/missing')).status).toBe(404);
    expect((await rig.request('/api/taskboard/boards/board-1', patchJson({
      name: 'new',
      expectedVersion: 1,
    }))).status).toBe(400);

    const conflict = await rig.request('/api/taskboard/tasks/task-1/move', postJson({
      status: 'todo',
      expectedVersion: 1,
    }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      code: 'TASKBOARD_VERSION_CONFLICT',
      current: { id: TASK.id, version: 3 },
    });

    expect((await rig.request('/api/taskboard/tasks/task-1/comments')).status).toBe(503);
  });

  it('deletes a task via DELETE with CAS version and forwards 409', async () => {
    const captured: Captured = { identities: [], taskFilters: [], createBoards: [] };
    const service = makeService(captured);
    const rig = await makeRig(service, USER, captured);

    const deleted = await rig.request(`/api/taskboard/tasks/${TASK.id}`, {
      ...postJson({ expectedVersion: TASK.version }),
      method: 'DELETE',
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ id: TASK.id, version: TASK.version + 1, deletedAt: TASK.updatedAt });
    expect(captured.identities.map((identity) => identity.ownerUserId)).toEqual([USER.sub]);

    service.deleteTask = async () => {
      throw new TaskboardConflictError({ ...TASK, version: 3 });
    };
    const conflict = await rig.request(`/api/taskboard/tasks/${TASK.id}`, {
      ...postJson({ expectedVersion: 1 }),
      method: 'DELETE',
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: 'TASKBOARD_VERSION_CONFLICT' });
  });
});

function makeService(captured: Captured): TaskboardService {
  const remember = (identity: TaskboardIdentity) => captured.identities.push(identity);
  return {
    async listBoards(identity) { remember(identity); return [BOARD]; },
    async searchBoards(identity, filter = {}) {
      remember(identity);
      return { items: [BOARD], page: filter.page ?? 1, pageSize: filter.pageSize ?? 20, total: 1, hasMore: false };
    },
    async getBoard(identity) { remember(identity); return BOARD; },
    async createBoard(identity, input) { remember(identity); captured.createBoards.push(input); return BOARD; },
    async updateBoard(identity) { remember(identity); return BOARD; },
    async archiveBoard(identity) { remember(identity); return { ...BOARD, version: 2, archivedAt: BOARD.updatedAt }; },
    async restoreBoard(identity) { remember(identity); return { ...BOARD, version: 2 }; },
    async listTasks(identity, _boardId, filter = {}) {
      remember(identity);
      captured.taskFilters.push(filter);
      return [TASK];
    },
    async searchTasks(identity, filter = {}) {
      remember(identity);
      return { items: [TASK], page: filter.page ?? 1, pageSize: filter.pageSize ?? 20, total: 1, hasMore: false };
    },
    async createTask(identity) { remember(identity); return TASK; },
    async getTask(identity) { remember(identity); return TASK; },
    async updateTask(identity) { remember(identity); return TASK; },
    async moveTask(identity) { remember(identity); return TASK; },
    async archiveTask(identity) { remember(identity); return { ...TASK, version: 2, archivedAt: TASK.updatedAt }; },
    async restoreTask(identity) { remember(identity); return { ...TASK, version: 2 }; },
    async deleteTask(identity) { remember(identity); return { ...TASK, version: 2, deletedAt: TASK.updatedAt }; },
    async rollbackTaskCreation(identity) { remember(identity); return { ...TASK, version: 2, deletedAt: TASK.updatedAt }; },
    async listComments(identity) { remember(identity); return [COMMENT]; },
    async searchComments(identity, _taskId, filter = {}) {
      remember(identity);
      return { items: [COMMENT], page: filter.page ?? 1, pageSize: filter.pageSize ?? 20, total: 1, hasMore: false };
    },
    async createComment(identity) { remember(identity); return COMMENT; },
    async updateComment(identity, _commentId, input) {
      remember(identity);
      return { ...COMMENT, body: input.body, version: input.expectedVersion + 1 };
    },
    async deleteComment(identity) { remember(identity); return COMMENT; },
  };
}

async function makeRig(
  service: TaskboardService | undefined,
  initialCaller: JwtPayload | null,
  captured: Captured = { identities: [], taskFilters: [], createBoards: [] },
  executionService?: TaskboardExecutionService,
  userStore?: UserStore,
  routerOptions: Partial<TaskboardRouterOptions> = {},
): Promise<Rig> {
  const app = express();
  app.use(express.json());
  let caller = initialCaller;
  app.use((req, _res, next) => {
    req.user = caller ?? undefined;
    next();
  });
  app.use('/api/taskboard', createTaskboardRouter({
    service,
    executionService,
    userStore,
    ...routerOptions,
  }));
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  const baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
  const rig: Rig = {
    baseUrl,
    captured,
    setCaller(next) { caller = next; },
    request(path, init) { return fetch(`${baseUrl}${path}`, init); },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  rigs.push(rig);
  return rig;
}

function postJson(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function patchJson(body: unknown): RequestInit {
  return { ...postJson(body), method: 'PATCH' };
}
