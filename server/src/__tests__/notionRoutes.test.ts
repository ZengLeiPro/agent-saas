import type { Server } from 'node:http';

import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NotionAuthFlowServiceLike } from '../notion/authFlow.js';
import { createNotionRouter } from '../routes/notion.js';

const USER = {
  id: 'user-a',
  username: 'alice',
  tenantId: 'tenant-a',
  disabled: false,
};

let server: Server | undefined;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
});

async function listen(options: Parameters<typeof createNotionRouter>[0]): Promise<string> {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).user = { sub: USER.id, username: USER.username, role: 'user', tenantId: USER.tenantId };
    next();
  });
  app.use('/api', createNotionRouter(options));
  return await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server!.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function authFlow(): NotionAuthFlowServiceLike {
  return {
    start: vi.fn(async () => { throw new Error('not used in route test'); }),
    getLatest: vi.fn(async () => null),
    stop: vi.fn(async () => undefined),
  };
}

describe('Notion connector routes', () => {
  it('GET 返回实时验证后的 workspace 与 identity', async () => {
    const getConnection = vi.fn(async () => ({
      connectorId: 'notion' as const,
      status: 'connected' as const,
      workspaceId: 'workspace-a',
      workspaceName: 'Product Wiki',
      identity: { type: 'person' as const, id: 'notion-user-a', name: 'Alice' },
      disconnectNotice: '本地断开不会远程撤销 Notion 授权。',
    }));
    const baseUrl = await listen({
      authFlowService: authFlow(),
      connectionStore: { isRuntimeEnabled: vi.fn(() => true) } as any,
      available: true,
      getConnection: getConnection as any,
      userStore: { findById: vi.fn(() => USER) } as any,
    });

    const response = await fetch(`${baseUrl}/api/connectors/notion`);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.connection).toMatchObject({
      status: 'connected',
      workspaceName: 'Product Wiki',
      identity: { id: 'notion-user-a' },
    });
    expect(getConnection).toHaveBeenCalledWith({
      userId: USER.id,
      username: USER.username,
      tenantId: USER.tenantId,
    });
  });

  it('DELETE 幂等本地断开并明确 provider 未远程撤销', async () => {
    const disconnect = vi.fn(async () => ({
      connection: {
        connectorId: 'notion' as const,
        status: 'disconnected' as const,
        disconnectNotice: '本地断开不会远程撤销 Notion 授权。',
      },
      providerRevoked: false as const,
      notice: '请在 Notion 中移除连接或撤销令牌。',
    }));
    const baseUrl = await listen({
      authFlowService: authFlow(),
      connectionStore: {} as any,
      available: true,
      disconnect: disconnect as any,
      userStore: { findById: vi.fn(() => USER) } as any,
    });

    const response = await fetch(`${baseUrl}/api/connectors/notion`, { method: 'DELETE' });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      connection: { status: 'disconnected' },
      providerRevoked: false,
    });
    expect(disconnect).toHaveBeenCalledWith(USER.id, USER.username, USER.tenantId);
  });

  it('服务未配置时明确返回 unavailable', async () => {
    const baseUrl = await listen({
      authFlowService: authFlow(),
      connectionStore: {} as any,
      userStore: { findById: vi.fn(() => USER) } as any,
      available: false,
    });
    const response = await fetch(`${baseUrl}/api/connectors/notion`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ available: false });
  });
});
