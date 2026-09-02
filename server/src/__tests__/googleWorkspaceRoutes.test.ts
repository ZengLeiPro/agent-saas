import express from 'express';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGoogleWorkspaceRouter } from '../routes/googleWorkspace.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

async function request(
  options: Parameters<typeof createGoogleWorkspaceRouter>[0],
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { sub: 'user-1', username: 'alice', tenantId: 'tenant-a' } as never;
    next();
  });
  app.use('/api/connectors', createGoogleWorkspaceRouter(options));
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server unavailable');
  return fetch(`http://127.0.0.1:${address.port}${path}`, init);
}

function fixture() {
  const finishAuthorization = vi.fn(async (input: {
    recordGrant?: (
      result: { user: { id: string; username: string; tenantId: string }; scopeSummary: string[] },
      previousScopes: string[],
    ) => Promise<unknown>;
  }) => {
    const result = {
      user: { id: 'user-1', username: 'alice', tenantId: 'tenant-a' },
      scopeSummary: ['drive.readonly'],
    };
    await input.recordGrant?.(result, []);
    return result;
  });
  const disconnect = vi.fn().mockResolvedValue(undefined);
  const rejectAuthorization = vi.fn().mockResolvedValue(true);
  const recordOAuthGrant = vi.fn().mockResolvedValue({ grantId: 'grant-1' });
  const revokeOAuthGrant = vi.fn().mockResolvedValue({ grantId: 'grant-1' });
  const ensureOAuthGrant = vi.fn().mockResolvedValue({ grantId: 'google-workspace:tenant-a:user-1' });
  const complete = vi.fn().mockRejectedValue(new Error('delivery commit outcome unknown'));
  return {
    finishAuthorization,
    disconnect,
    rejectAuthorization,
    recordOAuthGrant,
    revokeOAuthGrant,
    ensureOAuthGrant,
    complete,
    options: {
      oauthService: { finishAuthorization, disconnect, rejectAuthorization } as never,
      recordOAuthGrant,
      revokeOAuthGrant,
      ensureOAuthGrant,
      nativeOAuthHandoff: { complete } as never,
      webBaseUrl: 'https://agent.example.com',
    },
  };
}

describe('Google Workspace OAuth callback handoff delivery', () => {
  it('Grant 已生效后 handoff delivery 失败返回 202，且绝不回滚 Grant 或写 failed handoff', async () => {
    const test = fixture();
    const response = await request(test.options, '/api/connectors/oauth/callback?state=state-12345678&code=oauth-code');
    expect(response.status).toBe(202);
    expect(await response.text()).toContain('App 回跳交付暂时失败');
    expect(test.recordOAuthGrant).toHaveBeenCalledTimes(1);
    expect(test.disconnect).not.toHaveBeenCalled();
    expect(test.complete).toHaveBeenCalledTimes(1);
    expect(test.complete).toHaveBeenCalledWith('state-12345678', { status: 'succeeded' });
  });

  it('为已连接的旧 Google Workspace 记录补齐 OAuth Grant，供签名撤销流程使用', async () => {
    const test = fixture();
    const response = await request(
      test.options,
      '/api/connectors/google-workspace/oauth-grant/ensure',
      { method: 'POST' },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ grantId: 'google-workspace:tenant-a:user-1' });
    expect(test.ensureOAuthGrant).toHaveBeenCalledWith({ userId: 'user-1', username: 'alice', tenantId: 'tenant-a' });
  });

  it('OAuth Grant 无法补齐时返回受控清理标识', async () => {
    const test = fixture();
    test.ensureOAuthGrant.mockResolvedValueOnce(undefined);
    const response = await request(
      test.options,
      '/api/connectors/google-workspace/oauth-grant/ensure',
      { method: 'POST' },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: 'GOOGLE_WORKSPACE_SCOPE_UNVERIFIABLE',
    });
  });

  it('仅在无法补齐可验证 OAuth Grant 时允许清理历史连接', async () => {
    const test = fixture();
    test.ensureOAuthGrant.mockResolvedValueOnce(undefined);
    const response = await request(
      test.options,
      '/api/connectors/google-workspace/unverified-disconnect',
      { method: 'POST' },
    );

    expect(response.status).toBe(204);
    expect(test.ensureOAuthGrant).toHaveBeenCalledWith({
      userId: 'user-1', username: 'alice', tenantId: 'tenant-a',
    });
    expect(test.disconnect).toHaveBeenCalledWith('user-1', 'alice', 'tenant-a');
  });

  it('已有可验证 OAuth Grant 时拒绝绕过签名撤销', async () => {
    const test = fixture();
    const response = await request(
      test.options,
      '/api/connectors/google-workspace/unverified-disconnect',
      { method: 'POST' },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: 'OAUTH_GRANT_SIGNED_REVOCATION_REQUIRED',
    });
    expect(test.disconnect).not.toHaveBeenCalled();
  });

  it('callback 缺少 code 时消费 state 并终结 pending handoff', async () => {
    const test = fixture();
    const response = await request(test.options, '/api/connectors/oauth/callback?state=state-12345678');
    expect(response.status).toBe(400);
    expect(test.rejectAuthorization).toHaveBeenCalledWith('state-12345678');
    expect(test.complete).toHaveBeenCalledWith('state-12345678', {
      status: 'failed', errorCode: 'OAUTH_CALLBACK_INCOMPLETE',
    });
    expect(test.finishAuthorization).not.toHaveBeenCalled();
  });

  it('callback 失败会终结 pending handoff，且持久层可拒绝重放降级', async () => {
    const test = fixture();
    test.finishAuthorization.mockRejectedValue(new Error('Google Workspace OAuth state 已过期'));
    const response = await request(test.options, '/api/connectors/oauth/callback?state=state-12345678&code=oauth-code');
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('返回连接与授权页面刷新状态');
    expect(test.recordOAuthGrant).not.toHaveBeenCalled();
    expect(test.complete).toHaveBeenCalledWith('state-12345678', {
      status: 'failed', errorCode: 'OAUTH_CALLBACK_FAILED',
    });
  });
  it('callback code/error 互斥，歧义输入不进入 exchange 并终结 transaction', async () => {
    const test = fixture();
    const response = await request(test.options, '/api/connectors/oauth/callback?state=state-12345678&code=oauth-code&error=access_denied');
    expect(response.status).toBe(400);
    expect(test.finishAuthorization).not.toHaveBeenCalled();
    expect(test.rejectAuthorization).toHaveBeenCalledWith('state-12345678');
    expect(test.complete).toHaveBeenCalledWith('state-12345678', {
      status: 'failed', errorCode: 'OAUTH_CALLBACK_AMBIGUOUS',
    });
  });

});
