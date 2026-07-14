import express from 'express';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDwsRouter } from '../routes/dws.js';
import type { DwsAuthFlowServiceLike } from '../dws/authFlow.js';
import type { DwsAuthSessionRecord } from '../dws/authStore.js';
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

async function listen(options: {
  connectionStore?: DwsConnectionStore;
  authFlowService?: DwsAuthFlowServiceLike;
  userStore?: { findById(id: string): any };
} = {}): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { user: typeof USER }).user = USER;
    next();
  });
  app.use('/api', createDwsRouter(options));
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
    const opened = await listen({ connectionStore: store });
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

  it('为 JWT 当前用户启动授权，不接受请求体伪造 tenant/user', async () => {
    const authSession: DwsAuthSessionRecord = {
      sessionId: 'auth-1',
      tenantId: 'tenant-a',
      userId: USER.sub,
      username: USER.username,
      status: 'awaiting_user',
      authorizationUrl: 'https://login.dingtalk.com/oauth2/device/verify.htm?user_code=CFFJ-MVLS',
      userCode: 'CFFJ-MVLS',
      expiresAt: '2099-07-14T08:15:00.000Z',
      createdAt: '2026-07-14T08:00:00.000Z',
      updatedAt: '2026-07-14T08:00:01.000Z',
    };
    const currentUser = { ...USER, id: USER.sub, disabled: false };
    const authFlowService: DwsAuthFlowServiceLike = {
      start: vi.fn(async () => authSession),
      getLatest: vi.fn(async () => authSession),
    };
    const opened = await listen({
      authFlowService,
      userStore: { findById: vi.fn(() => currentUser) },
    });
    server = opened.server;

    const response = await fetch(`${opened.baseUrl}/api/dws/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: 'tenant-b', userId: 'other' }),
    });
    expect(response.status).toBe(202);
    expect(authFlowService.start).toHaveBeenCalledWith(currentUser);
    const body = await response.json() as { session: Record<string, unknown> };
    expect(body.session).toMatchObject({
      sessionId: 'auth-1',
      status: 'awaiting_user',
      userCode: 'CFFJ-MVLS',
      authorizationUrl: authSession.authorizationUrl,
    });
    expect(body.session).not.toHaveProperty('tenantId');
    expect(body.session).not.toHaveProperty('userId');
  });

  it('授权会话查询只使用 JWT tenantId + userId，且非等待状态不返回授权码', async () => {
    const authFlowService: DwsAuthFlowServiceLike = {
      start: vi.fn(),
      getLatest: vi.fn(async () => ({
        ...sessionRecord(),
        status: 'connected' as const,
        authorizationUrl: 'https://login.dingtalk.com/oauth2/device/verify.htm?user_code=CFFJ-MVLS',
        userCode: 'CFFJ-MVLS',
      })),
    };
    const opened = await listen({ authFlowService });
    server = opened.server;

    const response = await fetch(`${opened.baseUrl}/api/dws/auth/session?tenantId=tenant-b&userId=other`);
    expect(response.status).toBe(200);
    expect(authFlowService.getLatest).toHaveBeenCalledWith('tenant-a', USER.sub);
    const body = await response.json() as { session: Record<string, unknown> };
    expect(body.session.authorizationUrl).toBeNull();
    expect(body.session.userCode).toBeNull();
  });
});

function sessionRecord(): DwsAuthSessionRecord {
  return {
    sessionId: 'auth-1',
    tenantId: 'tenant-a',
    userId: USER.sub,
    username: USER.username,
    status: 'starting',
    expiresAt: '2099-07-14T08:15:00.000Z',
    createdAt: '2026-07-14T08:00:00.000Z',
    updatedAt: '2026-07-14T08:00:00.000Z',
  };
}
