import express from 'express';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FeishuAuthFlowService,
  FeishuDeviceLoginRunner,
  parseFeishuJson,
  validateFeishuAuthorizationUrl,
} from '../feishu/authFlow.js';
import type { FeishuAuthSessionRecord, FeishuAuthSessionStore } from '../feishu/authStore.js';
import { FeishuAuthStatusRunner } from '../feishu/keepalive.js';
import { computeNextCheckAfterStatus, type FeishuConnectionRecord, type FeishuConnectionStore } from '../feishu/store.js';
import { createFeishuRouter } from '../routes/feishu.js';
import type { UserInfo } from '../data/users/types.js';

const NOW = '2026-07-21T03:30:00.000Z';
const USER: UserInfo = {
  id: 'ky000000000001',
  username: 'alice',
  role: 'user',
  tenantId: 'kaiyan',
  createdAt: NOW,
  createdBy: 'system',
  updatedAt: NOW,
};

function session(): FeishuAuthSessionRecord {
  return {
    sessionId: 'feishu-auth-1',
    tenantId: USER.tenantId,
    userId: USER.id,
    username: USER.username,
    status: 'starting',
    expiresAt: '2099-07-21T03:45:00.000Z',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function connection(): FeishuConnectionRecord {
  return {
    tenantId: USER.tenantId,
    userId: USER.id,
    username: USER.username,
    profileId: 'kaiyan-agent',
    appId: 'cli_test',
    userOpenId: 'ou_test',
    userName: 'Alice',
    connectionStatus: 'connected',
    authenticated: true,
    verified: true,
    nextCheckAt: '2026-07-26T03:30:00.000Z',
    consecutiveFailures: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function connectionStore(rows: FeishuConnectionRecord[] = []): FeishuConnectionStore {
  return {
    upsertLogin: vi.fn(async () => undefined),
    claimDue: vi.fn(async () => null),
    completeCheck: vi.fn(async () => undefined),
    failCheck: vi.fn(async () => undefined),
    releaseClaim: vi.fn(async () => undefined),
    listForUser: vi.fn(async () => rows),
  };
}

describe('飞书官方 CLI 连接器', () => {
  it('只接受飞书官方 HTTPS 授权页', () => {
    expect(validateFeishuAuthorizationUrl('https://accounts.feishu.cn/open-apis/authen/v1/index?code=abc'))
      .toBe('https://accounts.feishu.cn/open-apis/authen/v1/index?code=abc');
    expect(validateFeishuAuthorizationUrl('https://open.feishu.cn/page/cli?user_code=ABC'))
      .toBe('https://open.feishu.cn/page/cli?user_code=ABC');
    expect(() => validateFeishuAuthorizationUrl('https://evil.example/feishu')).toThrow('非官方');
    expect(() => validateFeishuAuthorizationUrl('http://accounts.feishu.cn/auth')).toThrow('非官方');
  });

  it('解析授权完成 JSON 及嵌套字段', () => {
    expect(parseFeishuJson('notice\n{"event":"authorization_complete","user_open_id":"ou_1"}'))
      .toMatchObject({ event: 'authorization_complete', user_open_id: 'ou_1' });
  });

  it('在用户专属 Sandbox 依次执行固定 init/start/complete 动作', async () => {
    const wires: Array<Record<string, any>> = [];
    const fetchImpl: typeof fetch = vi.fn(async (_input, init) => {
      const wire = JSON.parse(String(init?.body)) as Record<string, any>;
      wires.push(wire);
      const operation = wire.input.operation;
      const content = operation === 'start_auth'
        ? JSON.stringify({
            verification_url: 'https://accounts.feishu.cn/device?user_code=ABC',
            device_code: 'device-code-1',
            expires_in: 600,
          })
        : operation === 'complete_auth'
          ? JSON.stringify({
              event: 'authorization_complete',
              user_open_id: 'ou_1',
              user_name: 'Alice',
              scope: 'offline_access docs:document:readonly',
            })
          : JSON.stringify({ appId: 'cli_test', appSecret: '****', brand: 'feishu' });
      return new Response(JSON.stringify({ status: 'success', content }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const runner = new FeishuDeviceLoginRunner({
      agentCwd: '/mnt/agent-saas/workspaces',
      appId: 'cli_test',
      appSecret: 'server-only-secret',
      resolveServerRemote: vi.fn(async () => ({ baseUrl: 'http://acs.internal', authToken: 'acs-token' })),
      fetchImpl,
    });
    const onAuthorization = vi.fn(async () => undefined);

    await expect(runner.login(USER, onAuthorization)).resolves.toMatchObject({
      profileId: 'kaiyan-agent',
      appId: 'cli_test',
      userOpenId: 'ou_1',
      userName: 'Alice',
    });
    expect(onAuthorization).toHaveBeenCalledWith({
      authorizationUrl: 'https://accounts.feishu.cn/device?user_code=ABC',
    });
    expect(wires.map((wire) => wire.toolName)).toEqual(['__FeishuCli', '__FeishuCli', '__FeishuCli']);
    expect(wires.map((wire) => wire.input.operation)).toEqual(['init', 'start_auth', 'complete_auth']);
    expect(wires[0]?.input).not.toHaveProperty('command');
    expect(wires[0]?.context.workspace).toMatchObject({
      id: 'ws_kaiyan__ky000000000001',
      mountSubPath: 'workspaces/kaiyan/ky000000000001',
      userId: USER.id,
    });
    expect(JSON.stringify(wires)).not.toContain('acs-token');
  });

  it('授权成功后只把公开身份元数据写入 PG，并触发技能启用回调', async () => {
    let connected!: () => void;
    const done = new Promise<void>((resolve) => { connected = resolve; });
    const authStore: FeishuAuthSessionStore = {
      createOrReuse: vi.fn(async () => ({ record: session(), created: true })),
      markAwaitingUser: vi.fn(async () => undefined),
      markConnected: vi.fn(async () => { connected(); }),
      markFailed: vi.fn(async () => undefined),
      getLatestForUser: vi.fn(async () => session()),
    };
    const store = connectionStore();
    const onConnected = vi.fn(async () => undefined);
    const service = new FeishuAuthFlowService({
      authSessionStore: authStore,
      connectionStore: store,
      runner: {
        login: vi.fn(async (_user, publish) => {
          await publish({ authorizationUrl: 'https://accounts.feishu.cn/device?user_code=ABC' });
          return {
            profileId: 'kaiyan-agent',
            appId: 'cli_test',
            userOpenId: 'ou_1',
            userName: 'Alice',
            scope: 'offline_access',
          };
        }),
      },
      onConnected,
    });

    await service.start(USER);
    await done;
    expect(authStore.markAwaitingUser).toHaveBeenCalledWith(
      session().sessionId,
      expect.objectContaining({ tenantId: USER.tenantId, userId: USER.id }),
      'https://accounts.feishu.cn/device?user_code=ABC',
    );
    expect(store.upsertLogin).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: USER.tenantId, userId: USER.id }),
      expect.objectContaining({ userOpenId: 'ou_1', userName: 'Alice' }),
    );
    await vi.waitFor(() => expect(onConnected).toHaveBeenCalledWith(USER));
    expect(authStore.markFailed).not.toHaveBeenCalled();
  });

  it('按 5 天巡检且至少提前 2 天检查 refresh expiry', () => {
    const now = new Date(NOW);
    expect(computeNextCheckAfterStatus({}, now)).toBe('2026-07-26T03:30:00.000Z');
    expect(computeNextCheckAfterStatus({ refreshExpiresAt: '2026-07-24T03:30:00.000Z' }, now))
      .toBe('2026-07-22T03:30:00.000Z');
  });

  it('按官方 auth status JSON 契约识别可用且已校验的用户身份', async () => {
    const runner = new FeishuAuthStatusRunner({
      agentCwd: '/mnt/agent-saas/workspaces',
      resolveServerRemote: vi.fn(async () => ({
        baseUrl: 'http://acs.internal',
        authToken: 'acs-token',
      })),
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        status: 'success',
        content: JSON.stringify({
          appId: 'cli_test',
          identity: 'user',
          verified: true,
          identities: {
            user: {
              status: 'available',
              userName: 'Alice',
              openId: 'ou_test',
              tokenStatus: 'valid',
              scope: 'offline_access docs:document:readonly',
              expiresAt: '2026-07-21T05:30:00.000Z',
              refreshExpiresAt: '2026-07-28T03:30:00.000Z',
            },
          },
        }),
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch,
    });

    await expect(runner.check(USER, connection())).resolves.toMatchObject({
      authenticated: true,
      verified: true,
      tokenStatus: 'valid',
      userOpenId: 'ou_test',
      userName: 'Alice',
      refreshExpiresAt: '2026-07-28T03:30:00.000Z',
    });
  });
});

describe('飞书连接器路由', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it('只使用 JWT 身份返回非敏感元数据', async () => {
    const store = connectionStore([connection()]);
    const app = express();
    app.use((req, _res, next) => {
      (req as any).user = { sub: USER.id, username: USER.username, role: 'user', tenantId: USER.tenantId };
      next();
    });
    app.use('/api', createFeishuRouter({ connectionStore: store }));
    const opened = await new Promise<{ server: Server; baseUrl: string }>((resolve) => {
      const current = app.listen(0, '127.0.0.1', () => {
        const address = current.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        resolve({ server: current, baseUrl: `http://127.0.0.1:${port}` });
      });
    });
    server = opened.server;

    const response = await fetch(`${opened.baseUrl}/api/feishu/connections?tenantId=other&userId=other`);
    expect(response.status).toBe(200);
    expect(store.listForUser).toHaveBeenCalledWith(USER.tenantId, USER.id);
    const body = await response.json() as { connections: Array<Record<string, unknown>> };
    expect(body.connections[0]).toMatchObject({ profileId: 'kaiyan-agent', userName: 'Alice', status: 'connected' });
    expect(body.connections[0]).not.toHaveProperty('tenantId');
    expect(body.connections[0]).not.toHaveProperty('userOpenId');
    expect(body.connections[0]).not.toHaveProperty('appId');
    expect(body.connections[0]).not.toHaveProperty('scope');
  });
});
