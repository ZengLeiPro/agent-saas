import type { Server } from 'node:http';

import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTaskboardRouter } from '../routes/taskboard.js';
import type { TaskboardService } from '../taskboard/types.js';

let server: Server | undefined;
afterEach(() => new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve()));

describe('Taskboard CI policy discovery route', () => {
  it('returns only the board-scoped service result for the authenticated identity', async () => {
    const getBoardCiPolicyDiscovery = vi.fn(async () => ({
      boardId: 'board-1', repositoryId: 'repo-1', providerKnown: true,
      effectiveSource: 'unconfigured' as const, githubRequiredChecks: [], boardRequiredChecks: [],
      effectiveRequiredChecks: [], observedChecks: [], providerQueriedAt: '2026-08-23T00:00:00.000Z',
    }));
    const app = express();
    app.use((req, _res, next) => {
      req.user = { sub: 'user-1', username: 'alice', role: 'admin', tenantId: 'tenant-a' };
      next();
    });
    app.use('/api/taskboard', createTaskboardRouter({
      service: { getBoardCiPolicyDiscovery } as unknown as TaskboardService,
    }));
    const listening = await new Promise<Server>((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    server = listening;
    const address = listening.address();
    const response = await fetch(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/api/taskboard/boards/board-1/ci-policy`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ boardId: 'board-1', effectiveSource: 'unconfigured' });
    expect(getBoardCiPolicyDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-a', ownerUserId: 'user-1' }), 'board-1',
    );
  });
});
