import type { Server } from 'node:http';

import express from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { JwtPayload } from '../auth/types.js';
import { createTaskboardRouter } from '../routes/taskboard.js';
import {
  TaskboardNotFoundError,
  type TaskboardService,
} from '../taskboard/types.js';

const USER: JwtPayload = {
  sub: 'user-1',
  username: 'alice',
  role: 'user',
  tenantId: 'tenant-a',
};

const VIEWER_BOARD = {
  id: 'viewer-board',
  name: '只读看板',
  visibility: 'organization' as const,
  ownerUserId: 'owner-1',
  role: 'viewer' as const,
  canManage: false,
  prompt: '',
  version: 1,
  createdAt: '2026-08-23T00:00:00.000Z',
  updatedAt: '2026-08-23T00:00:00.000Z',
};

describe('创建任务前的标题生成保护', () => {
  it('先校验权限，并在幂等重试时跳过重复标题生成', async () => {
    let titleGenerationCalls = 0;
    let existingTask: Awaited<ReturnType<TaskboardService['createTask']>> | null = null;
    let notifyTitleStarted!: () => void;
    let releaseTitle!: () => void;
    const titleStarted = new Promise<void>((resolve) => { notifyTitleStarted = resolve; });
    const titleGate = new Promise<void>((resolve) => { releaseTitle = resolve; });
    const listExecutions = vi.fn(async () => [] as Record<string, unknown>[]);
    const startDirectExecution = vi.fn(async () => ({
      task: { ...existingTask!, version: existingTask!.version + 1 }, execution: {},
    }));
    const service = {
      getBoard: async (_identity: unknown, boardId: string) => {
        if (boardId === VIEWER_BOARD.id) return VIEWER_BOARD;
        throw new TaskboardNotFoundError('Board not found');
      },
    } as unknown as TaskboardService;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = USER; next(); });
    app.use('/api/taskboard', createTaskboardRouter({
      service,
      executionService: { listExecutions, startDirectExecution } as never,
      generateTaskTitle: async (description) => {
        titleGenerationCalls += 1;
        if (description === '生成器拒绝') throw new Error('生成器拒绝');
        notifyTitleStarted();
        await titleGate;
        return '自动标题';
      },
    }));
    const server: Server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });

    try {
      const address = server.address();
      const baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
      for (const [boardId, expectedStatus] of [['viewer-board', 403], ['missing', 404]] as const) {
        const response = await fetch(`${baseUrl}/api/taskboard/boards/${boardId}/tasks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ description: '无权限请求不得触发模型' }),
        });
        expect(response.status).toBe(expectedStatus);
        await response.json();
      }
      expect(titleGenerationCalls).toBe(0);

      service.getBoard = async () => ({ ...VIEWER_BOARD, id: 'owner-board', role: 'owner', canManage: true });
      const empty = await fetch(`${baseUrl}/api/taskboard/boards/owner-board/tasks`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      expect(empty.status).toBe(400);
      await empty.json();
      let createTail = Promise.resolve();
      service.createTaskWithResult = async (_identity, boardId, input) => {
        const previous = createTail;
        let release!: () => void;
        createTail = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        try {
          if (existingTask) return { task: existingTask, created: false };
          existingTask = {
            id: 'task-1', boardId, identifier: 'TASK-1', title: input.title ?? '',
            description: input.description ?? '', status: 'backlog', priority: 'none', labels: [],
            sortOrder: 1024, commentCount: 0, version: 1,
            createdAt: VIEWER_BOARD.createdAt, updatedAt: VIEWER_BOARD.updatedAt,
          };
          return { task: existingTask, created: true };
        } finally { release(); }
      };
      service.updateTask = vi.fn(async (_identity, _taskId, input) => existingTask = {
        ...existingTask!, title: input.title ?? existingTask!.title,
        attachments: input.attachments ?? existingTask!.attachments,
        version: existingTask!.version + 1,
      });
      service.getTask = async () => existingTask!;
      service.createTask = async (_identity, boardId, input) => ({
        id: 'task-2', boardId, identifier: 'TASK-2', title: input.title ?? '',
        description: input.description ?? '', status: 'backlog', priority: 'none', labels: [],
        sortOrder: 2048, commentCount: 0, version: 1,
        createdAt: VIEWER_BOARD.createdAt, updatedAt: VIEWER_BOARD.updatedAt,
      });
      service.rollbackTaskCreation = vi.fn();
      const first = fetch(`${baseUrl}/api/taskboard/boards/owner-board/tasks`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ description: '幂等创建', clientRequestId: 'request-1', attachments: [], status: 'in_progress', dispatch: true }),
      });
      await titleStarted;
      const replay = await fetch(`${baseUrl}/api/taskboard/boards/owner-board/tasks`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ description: '幂等创建', clientRequestId: 'request-1', attachments: [], status: 'in_progress', dispatch: true }),
      });
      expect(replay.status).toBe(201);
      await replay.json();
      releaseTitle();
      const firstResponse = await first;
      expect(firstResponse.status).toBe(201);
      await firstResponse.json();
      expect(titleGenerationCalls).toBe(1);
      expect(service.updateTask).toHaveBeenCalledTimes(1);
      expect(startDirectExecution).toHaveBeenCalledOnce();
      expect(service.rollbackTaskCreation).not.toHaveBeenCalled();

      const rejected = await fetch(`${baseUrl}/api/taskboard/boards/owner-board/tasks`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ description: '生成器拒绝' }),
      });
      expect(rejected.status).toBe(201);
      expect((await rejected.json()).title).toBe('');

      existingTask = {
        id: 'task-recovery', boardId: 'owner-board', identifier: 'TASK-3', title: '',
        description: '恢复 dispatch', status: 'in_progress', priority: 'none', labels: [],
        sortOrder: 3072, commentCount: 0, version: 1,
        createdAt: VIEWER_BOARD.createdAt, updatedAt: VIEWER_BOARD.updatedAt,
      };
      let recoveryAttempt = 0;
      service.createTaskWithResult = vi.fn(async () => ({
        task: existingTask!, created: recoveryAttempt++ === 0,
        creationClaimToken: recoveryAttempt === 1 ? 'claim-1' : 'claim-2',
      }));
      service.releaseTaskCreation = vi.fn(async () => undefined);
      service.completeTaskCreation = vi.fn(async () => existingTask!);
      startDirectExecution.mockRejectedValueOnce(new Error('dispatch failed'));
      const recoveryBody = JSON.stringify({
        description: '恢复 dispatch', clientRequestId: 'request-recovery', status: 'in_progress', dispatch: true,
      });
      const failedDispatch = await fetch(`${baseUrl}/api/taskboard/boards/owner-board/tasks`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: recoveryBody,
      });
      expect(failedDispatch.status).toBe(503);
      await failedDispatch.json();
      const recovered = await fetch(`${baseUrl}/api/taskboard/boards/owner-board/tasks`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: recoveryBody,
      });
      expect(recovered.status).toBe(201);
      await recovered.json();
      expect(service.releaseTaskCreation).toHaveBeenCalledWith(expect.anything(), 'task-recovery', 'claim-1');
      expect(service.completeTaskCreation).toHaveBeenCalledWith(expect.anything(), 'task-recovery', 'claim-2');
      expect(listExecutions).toHaveBeenCalledTimes(1);
      expect(startDirectExecution).toHaveBeenCalledTimes(3);

      recoveryAttempt = 0;
      service.completeTaskCreation = vi.fn()
        .mockRejectedValueOnce(new Error('complete failed'))
        .mockResolvedValue(existingTask!);
      listExecutions.mockResolvedValueOnce([{}]);
      const dispatchCount = startDirectExecution.mock.calls.length;
      const failedComplete = await fetch(`${baseUrl}/api/taskboard/boards/owner-board/tasks`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: recoveryBody,
      });
      expect(failedComplete.status).toBe(503);
      await failedComplete.json();
      const completeRecovered = await fetch(`${baseUrl}/api/taskboard/boards/owner-board/tasks`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: recoveryBody,
      });
      expect(completeRecovered.status).toBe(201);
      await completeRecovered.json();
      expect(startDirectExecution).toHaveBeenCalledTimes(dispatchCount + 1);
      expect(service.releaseTaskCreation).toHaveBeenCalledWith(expect.anything(), 'task-recovery', 'claim-1');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
