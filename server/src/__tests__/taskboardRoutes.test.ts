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
import { createTaskboardRouter } from '../routes/taskboard.js';
import {
  TaskboardConflictError,
  TaskboardNotFoundError,
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
    }));
    expect(created.status).toBe(201);
    expect(captured.identities.at(-1)).toEqual({
      tenantId: USER.tenantId,
      ownerUserId: USER.sub,
      username: USER.username,
      userRole: USER.role,
    });
    expect(captured.createBoards).toEqual([{ name: '研发事项', description: '首期' }]);
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
    expect((await rig.request('/api/taskboard/tasks/task-1/comments', postJson({
      body: 'ok',
      attachmentId: 'forbidden',
    }))).status).toBe(400);

    const list = await rig.request(
      '/api/taskboard/boards/board-1/tasks?includeArchived=true&search=TASK&status=todo,in_progress&priority=urgent&priority=high',
    );
    expect(list.status).toBe(200);
    expect(captured.taskFilters).toEqual([{
      includeArchived: true,
      search: 'TASK',
      statuses: ['todo', 'in_progress'],
      priorities: ['urgent', 'high'],
    }]);
  });

  it('lists execution history and accepts an explicit Agent execution request', async () => {
    const executionService: TaskboardExecutionService = {
      listExecutions: async () => [EXECUTION],
      startExecution: async (identity, taskId, input) => {
        expect(identity).toEqual({
          tenantId: USER.tenantId,
          ownerUserId: USER.sub,
          username: USER.username,
          userRole: USER.role,
        });
        expect(taskId).toBe(TASK.id);
        expect(input).toEqual({ expectedVersion: TASK.version });
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

    const started = await rig.request(`/api/taskboard/tasks/${TASK.id}/execute`, postJson({
      expectedVersion: TASK.version,
    }));
    expect(started.status).toBe(202);
    expect(await started.json()).toMatchObject({
      task: { status: 'in_progress', version: TASK.version + 1 },
      execution: { id: EXECUTION.id, status: 'queued' },
    });

    expect((await rig.request(`/api/taskboard/tasks/${TASK.id}/execute`, postJson({
      expectedVersion: TASK.version,
      cronJobId: 'forbidden',
    }))).status).toBe(400);
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
});

function makeService(captured: Captured): TaskboardService {
  const remember = (identity: TaskboardIdentity) => captured.identities.push(identity);
  return {
    async listBoards(identity) { remember(identity); return [BOARD]; },
    async createBoard(identity, input) { remember(identity); captured.createBoards.push(input); return BOARD; },
    async updateBoard(identity) { remember(identity); return BOARD; },
    async archiveBoard(identity) { remember(identity); return { ...BOARD, version: 2, archivedAt: BOARD.updatedAt }; },
    async restoreBoard(identity) { remember(identity); return { ...BOARD, version: 2 }; },
    async listTasks(identity, _boardId, filter = {}) {
      remember(identity);
      captured.taskFilters.push(filter);
      return [TASK];
    },
    async createTask(identity) { remember(identity); return TASK; },
    async getTask(identity) { remember(identity); return TASK; },
    async updateTask(identity) { remember(identity); return TASK; },
    async moveTask(identity) { remember(identity); return TASK; },
    async archiveTask(identity) { remember(identity); return { ...TASK, version: 2, archivedAt: TASK.updatedAt }; },
    async restoreTask(identity) { remember(identity); return { ...TASK, version: 2 }; },
    async listComments(identity) { remember(identity); return [COMMENT]; },
    async createComment(identity) { remember(identity); return COMMENT; },
  };
}

async function makeRig(
  service: TaskboardService | undefined,
  initialCaller: JwtPayload | null,
  captured: Captured = { identities: [], taskFilters: [], createBoards: [] },
  executionService?: TaskboardExecutionService,
): Promise<Rig> {
  const app = express();
  app.use(express.json());
  let caller = initialCaller;
  app.use((req, _res, next) => {
    req.user = caller ?? undefined;
    next();
  });
  app.use('/api/taskboard', createTaskboardRouter({ service, executionService }));
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
