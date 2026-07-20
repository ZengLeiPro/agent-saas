import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DwsAuthFlowService,
  DwsDeviceLoginRunner,
  parseDwsDeviceAuthorization,
} from '../dws/authFlow.js';
import type { DwsAuthSessionRecord, DwsAuthSessionStore } from '../dws/authStore.js';
import type { DwsConnectionStore } from '../dws/store.js';
import type { UserInfo } from '../data/users/types.js';

const NOW = '2026-07-14T08:00:00.000Z';

function user(): UserInfo {
  return {
    id: 'ky000000000001',
    username: 'alice',
    role: 'user',
    tenantId: 'kaiyan',
    createdAt: NOW,
    createdBy: 'system',
    updatedAt: NOW,
  };
}

function session(): DwsAuthSessionRecord {
  return {
    sessionId: 'auth-session-1',
    tenantId: 'kaiyan',
    userId: 'ky000000000001',
    username: 'alice',
    status: 'starting',
    expiresAt: '2026-07-14T08:15:00.000Z',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe('DWS device authorization flow', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('只接受钉钉官方 device URL，并规范化一次性授权码', () => {
    expect(parseDwsDeviceAuthorization(`
      请访问 https://login.dingtalk.com/oauth2/device/verify.htm?user_code=cffj-mvls
      授权码 CFFJ-MVLS
    `)).toEqual({
      userCode: 'CFFJ-MVLS',
      authorizationUrl: 'https://login.dingtalk.com/oauth2/device/verify.htm?user_code=CFFJ-MVLS',
    });
    expect(parseDwsDeviceAuthorization('https://evil.example/device?user_code=CFFJ-MVLS')).toBeNull();
    expect(parseDwsDeviceAuthorization('没有有效授权码')).toBeNull();
  });

  it('在当前用户 warm sandbox 执行固定 DWS 命令，且不把服务凭证放进 wire body', async () => {
    let wire: Record<string, any> | undefined;
    const fetchImpl: typeof fetch = vi.fn(async (_input, init) => {
      wire = JSON.parse(String(init?.body));
      const output = {
        type: 'output',
        content: '请打开 https://login.dingtalk.com/oauth2/device/verify.htm?user_code=CFFJ-MVLS\n',
      };
      const completed = {
        type: 'completed',
        response: { status: 'success', content: 'Exit code: 0' },
      };
      return new Response(
        `data: ${JSON.stringify(output)}\n\ndata: ${JSON.stringify(completed)}\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }) as typeof fetch;
    const resolveServerRemote = vi.fn(async () => ({
      baseUrl: 'http://acs.internal',
      authToken: 'server-secret',
      invokeTimeoutMs: 5_000,
    }));
    const runner = new DwsDeviceLoginRunner({
      agentCwd: '/mnt/agent-saas/workspaces',
      resolveServerRemote,
      fetchImpl,
    });
    const onAuthorization = vi.fn();

    await runner.login(user(), onAuthorization);

    expect(onAuthorization).toHaveBeenCalledWith({
      userCode: 'CFFJ-MVLS',
      authorizationUrl: 'https://login.dingtalk.com/oauth2/device/verify.htm?user_code=CFFJ-MVLS',
    });
    expect(resolveServerRemote).toHaveBeenCalledWith(user());
    expect(wire?.toolName).toBe('Shell');
    expect(wire?.input).toEqual({
      command: 'dws auth login --device --format json',
      timeoutMs: 900_000,
    });
    expect(wire?.context.workspace).toMatchObject({
      id: 'ws_kaiyan__ky000000000001',
      mountSubPath: 'workspaces/kaiyan/ky000000000001',
      userId: 'ky000000000001',
    });
    expect(JSON.stringify(wire)).not.toContain('server-secret');
  });

  it('DWS 未返回官方授权页时失败，不把已有 profile 误判成新连接成功', async () => {
    const fetchImpl: typeof fetch = vi.fn(async () => {
      const completed = {
        type: 'completed',
        response: { status: 'success', content: 'Exit code: 0' },
      };
      return new Response(`data: ${JSON.stringify(completed)}\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as typeof fetch;
    const runner = new DwsDeviceLoginRunner({
      agentCwd: '/mnt/agent-saas/workspaces',
      serverRemote: { baseUrl: 'http://acs.internal', authToken: 'server-secret' },
      fetchImpl,
    });

    await expect(runner.login(user(), vi.fn())).rejects.toThrow('DWS 未返回钉钉官方授权页面');
  });

  it('授权完成后从用户持久化目录同步非敏感 profile，并标记连接成功', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dws-auth-flow-'));
    tempDirs.push(root);
    const profileDir = join(root, 'workspaces', 'kaiyan', user().id, '.dws', 'config');
    await mkdir(profileDir, { recursive: true });
    await writeFile(join(profileDir, 'profiles.json'), JSON.stringify({
      profiles: [{
        name: 'main',
        corpId: 'ding-corp-1',
        corpName: '示例企业',
        userName: '张三',
        status: 'active',
        accessToken: '不应进入状态账本',
      }],
    }));

    let connected!: () => void;
    const completed = new Promise<void>((resolve) => { connected = resolve; });
    const authStore: DwsAuthSessionStore = {
      createOrReuse: vi.fn(async () => ({ record: session(), created: true })),
      markAwaitingUser: vi.fn(async () => undefined),
      markConnected: vi.fn(async () => { connected(); }),
      markFailed: vi.fn(async () => undefined),
      getLatestForUser: vi.fn(async () => session()),
    };
    const connectionStore: DwsConnectionStore = {
      syncProfiles: vi.fn(async () => undefined),
      claimDue: vi.fn(async () => null),
      completeCheck: vi.fn(async () => undefined),
      failCheck: vi.fn(async () => undefined),
      releaseClaim: vi.fn(async () => undefined),
      listForUser: vi.fn(async () => []),
    };
    const onConnected = vi.fn(async () => undefined);
    const service = new DwsAuthFlowService({
      agentCwd: join(root, 'workspaces'),
      authSessionStore: authStore,
      connectionStore,
      runner: {
        login: vi.fn(async (_user, onAuthorization) => {
          await onAuthorization({
            userCode: 'CFFJ-MVLS',
            authorizationUrl: 'https://login.dingtalk.com/oauth2/device/verify.htm?user_code=CFFJ-MVLS',
          });
        }),
      },
      onConnected,
    });

    await service.start(user());
    await completed;

    expect(authStore.markAwaitingUser).toHaveBeenCalledWith(
      'auth-session-1',
      expect.objectContaining({ tenantId: 'kaiyan', userId: user().id }),
      'CFFJ-MVLS',
      'https://login.dingtalk.com/oauth2/device/verify.htm?user_code=CFFJ-MVLS',
    );
    expect(connectionStore.syncProfiles).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'kaiyan', userId: user().id }),
      [expect.objectContaining({ profileId: 'ding-corp-1', corpName: '示例企业' })],
    );
    expect(JSON.stringify(vi.mocked(connectionStore.syncProfiles).mock.calls)).not.toContain('不应进入状态账本');
    await vi.waitFor(() => expect(onConnected).toHaveBeenCalledWith(user()));
    expect(authStore.markFailed).not.toHaveBeenCalled();
  });
});
