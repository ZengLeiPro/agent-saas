import type { Server } from 'node:http';

import express from 'express';
import { describe, expect, it } from 'vitest';

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
      generateTaskTitle: async () => {
        titleGenerationCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
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
      }
      expect(titleGenerationCalls).toBe(0);

      let existingTask: Awaited<ReturnType<TaskboardService['createTask']>> | null = null;
      service.getBoard = async () => ({ ...VIEWER_BOARD, id: 'owner-board', role: 'owner', canManage: true });
      let lockTail = Promise.resolve();
      service.acquireTaskClientRequestLock = async () => {
        const previous = lockTail;
        let release!: () => void;
        lockTail = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        return async () => release();
      };
      service.findTaskByClientRequestId = async () => existingTask;
      service.createTask = async (_identity, boardId, input) => existingTask ??= {
        id: 'task-1', boardId, identifier: 'TASK-1', title: input.title ?? '',
        description: input.description ?? '', status: 'backlog', priority: 'none', labels: [],
        sortOrder: 1024, commentCount: 0, version: 1,
        createdAt: VIEWER_BOARD.createdAt, updatedAt: VIEWER_BOARD.updatedAt,
      };
      const responses = await Promise.all(Array.from({ length: 2 }, () => fetch(
        `${baseUrl}/api/taskboard/boards/owner-board/tasks`,
        {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ description: '幂等创建', clientRequestId: 'request-1' }),
        },
      )));
      expect(responses.map((response) => response.status)).toEqual([201, 201]);
      expect(titleGenerationCalls).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
