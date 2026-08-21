import type { Server } from 'node:http';

import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import type { TaskBoardTask } from '../../../shared/src/types/taskboard.js';
import type { JwtPayload } from '../auth/types.js';
import type { UserStore } from '../data/users/store.js';
import { createTaskboardRouter } from '../routes/taskboard.js';
import type { TaskboardService } from '../taskboard/types.js';

const USER: JwtPayload = {
  sub: 'user-1',
  username: 'alice',
  role: 'admin',
  tenantId: 'tenant-a',
};

const TASK: TaskBoardTask = {
  id: 'task-1',
  boardId: 'board-1',
  identifier: 'TASK-1',
  title: '实现任务看板',
  description: '',
  status: 'backlog',
  priority: 'none',
  labels: [],
  sortOrder: 1024,
  commentCount: 0,
  version: 1,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

const rigs: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.close()));
});

describe('Taskboard avatar routes', () => {
  it('returns only the current organization users with display-safe avatar data', async () => {
    const userStore = {
      listAll: () => [
        {
          id: 'user-1', username: 'alice', realName: 'Alice', tenantId: 'tenant-a',
          avatar: 'avatars/alice.png', avatarVersion: 7, phone: '13800000000',
        },
        { id: 'user-2', username: 'bob', realName: 'Bob', tenantId: 'tenant-b' },
      ],
    } as unknown as UserStore;
    const rig = await makeRig(userStore);

    const response = await rig.request('/api/taskboard/users');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      users: [{
        id: 'user-1',
        username: 'alice',
        realName: 'Alice',
        avatar: '/api/auth/avatar/user-1?v=7',
        avatarVersion: 7,
      }],
    });
  });

  it('adds the current creator avatar version to task payloads', async () => {
    const userStore = {
      listAll: () => [],
      findById: (id: string) => id === USER.sub
        ? { id, tenantId: USER.tenantId, avatarVersion: 7 }
        : undefined,
    } as unknown as UserStore;
    const rig = await makeRig(userStore);

    const response = await rig.request('/api/taskboard/boards/board-1/tasks');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{
      ...TASK,
      creatorUserId: USER.sub,
      creatorAvatarVersion: 7,
    }]);
  });
});

async function makeRig(userStore: UserStore): Promise<{
  request(path: string): Promise<Response>;
  close(): Promise<void>;
}> {
  const app = express();
  app.use((req, _res, next) => {
    req.user = USER;
    next();
  });
  const service = {
    async listTasks() { return [{ ...TASK, creatorUserId: USER.sub }]; },
  } as unknown as TaskboardService;
  app.use('/api/taskboard', createTaskboardRouter({ service, userStore }));
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  const baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
  const rig = {
    request: (path: string) => fetch(`${baseUrl}${path}`),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  rigs.push(rig);
  return rig;
}
