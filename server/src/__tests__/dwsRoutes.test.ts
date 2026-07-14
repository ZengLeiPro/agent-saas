import express from 'express';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDwsRouter } from '../routes/dws.js';
import type { DwsConnectionRecord, DwsConnectionStore } from '../dws/store.js';

const USER = { sub: 'ky000000000001', username: 'alice', role: 'user', tenantId: 'tenant-a' } as const;

function storeWith(rows: DwsConnectionRecord[]): DwsConnectionStore {
  return {
    syncProfiles: vi.fn(async () => undefined),
    claimDue: vi.fn(async () => null),
    completeCheck: vi.fn(async () => undefined),
    failCheck: vi.fn(async () => undefined),
    releaseClaim: vi.fn(async () => undefined),
    listForUser: vi.fn(async () => rows),
  };
}

async function listen(connectionStore?: DwsConnectionStore): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { user: typeof USER }).user = USER;
    next();
  });
  app.use('/api', createDwsRouter({ connectionStore }));
  return await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

describe('DWS connections route', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it('只按 JWT 中的 tenantId + userId 返回当前用户连接', async () => {
    const row: DwsConnectionRecord = {
      tenantId: 'tenant-a',
      userId: USER.sub,
      username: USER.username,
      profileId: 'ding-corp-1',
      corpName: '示例企业',
      profileStatus: 'active',
      connectionStatus: 'connected',
      authenticated: true,
      refreshTokenValid: true,
      nextCheckAt: '2026-08-04T02:00:00.000Z',
      lastCheckedAt: '2026-07-14T02:00:00.000Z',
      consecutiveFailures: 0,
      createdAt: '2026-07-14T02:00:00.000Z',
      updatedAt: '2026-07-14T02:00:00.000Z',
    };
    const store = storeWith([row]);
    const opened = await listen(store);
    server = opened.server;

    const response = await fetch(`${opened.baseUrl}/api/dws/connections?tenantId=tenant-b&userId=other`);
    expect(response.status).toBe(200);
    expect(store.listForUser).toHaveBeenCalledWith('tenant-a', USER.sub);
    const body = await response.json() as { connections: Array<Record<string, unknown>> };
    expect(body.connections).toHaveLength(1);
    expect(body.connections[0]).not.toHaveProperty('tenantId');
    expect(body.connections[0]).not.toHaveProperty('userId');
    expect(body.connections[0]).not.toHaveProperty('lastError');
  });

  it('PG 状态账本未装配时 fail closed 返回 503', async () => {
    const opened = await listen();
    server = opened.server;
    const response = await fetch(`${opened.baseUrl}/api/dws/connections`);
    expect(response.status).toBe(503);
  });
});
