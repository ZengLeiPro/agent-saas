import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TaskBoardTask } from '../../../shared/src/types/taskboard.js';
import type { JwtPayload } from '../auth/types.js';
import { createTaskboardRouter } from '../routes/taskboard.js';
import type { TaskboardService } from '../taskboard/types.js';

const user: JwtPayload = {
  sub: 'user-1',
  username: 'alice',
  role: 'admin',
  tenantId: 'tenant-1',
};
const task: TaskBoardTask = {
  id: 'task-1', boardId: 'board-1', identifier: 'TASK-1', kind: 'advisory',
  title: '答复事项', description: '', status: 'todo', priority: 'none', labels: [],
  sortOrder: 1024, commentCount: 0, version: 3,
  createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z',
};
const servers: Server[] = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => (
  new Promise<void>((resolve) => server.close(() => resolve()))
))));

describe('POST /tasks/:id/complete', () => {
  it('forwards the current identity, task id and CAS version', async () => {
    const completed = {
      ...task,
      status: 'done' as const,
      version: task.version + 1,
      completedAt: task.updatedAt,
    };
    const completeTask = vi.fn(async () => completed);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = user; next(); });
    app.use('/api/taskboard', createTaskboardRouter({
      service: { completeTask } as unknown as TaskboardService,
    }));
    const server: Server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    servers.push(server);
    const address = server.address();
    const baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';

    const response = await fetch(`${baseUrl}/api/taskboard/tasks/${task.id}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: task.version }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'done', version: task.version + 1 });
    expect(completeTask).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: user.tenantId, ownerUserId: user.sub }),
      task.id,
      { expectedVersion: task.version },
    );
  });
});
