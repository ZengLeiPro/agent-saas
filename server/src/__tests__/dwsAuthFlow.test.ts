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

  it('DWS 未返回官方授权页时失败，且不把已有 profile 误判成新连接成功', async () => {
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

  it('logout runner 拒绝空列表、组织级及畸形 selector，不执行 CLI 命令', async () => {
    const resolveServerRemote = vi.fn(async () => ({
      baseUrl: 'http://acs.internal',
      authToken: 'server-secret',
    }));
    const runner = new DwsDeviceLoginRunner({
      agentCwd: '/mnt/agent-saas/workspaces',
      resolveServerRemote,
      fetchImpl: vi.fn() as never,
    });

    await expect(runner.logout(user(), [])).rejects.toThrow('corpId:dingtalkUserId');
    await expect(runner.logout(user(), ['ding-corp-1'])).rejects.toThrow('corpId:dingtalkUserId');
    await expect(runner.logout(user(), ['ding-corp-1::staff-1'])).rejects.toThrow('corpId:dingtalkUserId');
    await expect(runner.logout(user(), ['ding-corp-1: staff-1'])).rejects.toThrow('corpId:dingtalkUserId');
    expect(resolveServerRemote).not.toHaveBeenCalled();
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
        userId: 'staff-1',
        userName: '张三',
        status: 'active',
        accessToken: '不应进入状态账本',
      }],
    }));

    let connected!: () => void;
    const completed = new Promise<void>((resolve) => { connected = resolve; });
    const events: string[] = [];
    const authStore: DwsAuthSessionStore = {
      createOrReuse: vi.fn(async () => ({ record: session(), created: true })),
      markAwaitingUser: vi.fn(async () => undefined),
      markConnected: vi.fn(async () => { events.push('marked_connected'); connected(); }),
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
    const onConnected = vi.fn(async () => { events.push('verified'); });
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
      [expect.objectContaining({
        profileId: 'ding-corp-1:staff-1', corpId: 'ding-corp-1', corpName: '示例企业',
      })],
    );
    expect(JSON.stringify(vi.mocked(connectionStore.syncProfiles).mock.calls)).not.toContain('不应进入状态账本');
    await vi.waitFor(() => expect(onConnected).toHaveBeenCalledWith(user()));
    expect(events).toEqual(['verified', 'marked_connected']);
    expect(authStore.markFailed).not.toHaveBeenCalled();
  });

  it('组织级 selector 只清理平台账本，绝不传给 CLI logout', async () => {
    const removeProfile = vi.fn(async () => 1);
    const logout = vi.fn(async () => undefined);
    const connectionStore: DwsConnectionStore = {
      syncProfiles: vi.fn(async () => undefined),
      claimDue: vi.fn(async () => null),
      completeCheck: vi.fn(async () => undefined),
      failCheck: vi.fn(async () => undefined),
      releaseClaim: vi.fn(async () => undefined),
      listForUser: vi.fn(async () => [{
        tenantId: user().tenantId,
        userId: user().id,
        username: user().username,
        profileId: 'ding-corp-1',
        corpId: 'ding-corp-1',
        connectionStatus: 'disconnected' as const,
        nextCheckAt: NOW,
        consecutiveFailures: 0,
        createdAt: NOW,
        updatedAt: NOW,
      }]),
      removeProfile,
    };
    const service = new DwsAuthFlowService({
      agentCwd: '/missing-workspaces',
      authSessionStore: {
        createOrReuse: vi.fn(), markAwaitingUser: vi.fn(), markConnected: vi.fn(),
        markFailed: vi.fn(), getLatestForUser: vi.fn(),
      },
      connectionStore,
      runner: { login: vi.fn(), logout },
    });

    await expect(service.revokeProfile(user(), 'ding-corp-1')).resolves.toBeUndefined();
    expect(logout).not.toHaveBeenCalled();
    expect(removeProfile).toHaveBeenCalledWith(user().tenantId, user().id, 'ding-corp-1');
  });

  it('断开用户时仅把精确 selector 交给 CLI，并清理全部平台记录', async () => {
    const removeForUser = vi.fn(async () => 2);
    const logout = vi.fn(async () => undefined);
    const base = {
      tenantId: user().tenantId,
      userId: user().id,
      username: user().username,
      connectionStatus: 'disconnected' as const,
      nextCheckAt: NOW,
      consecutiveFailures: 0,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const connectionStore: DwsConnectionStore = {
      syncProfiles: vi.fn(async () => undefined),
      claimDue: vi.fn(async () => null),
      completeCheck: vi.fn(async () => undefined),
      failCheck: vi.fn(async () => undefined),
      releaseClaim: vi.fn(async () => undefined),
      listForUser: vi.fn(async () => [
        { ...base, profileId: 'ding-corp-1', corpId: 'ding-corp-1' },
        {
          ...base,
          profileId: 'ding-corp-1:staff-1',
          corpId: 'ding-corp-1',
          dingtalkUserId: 'staff-1',
        },
      ]),
      removeForUser,
    };
    const service = new DwsAuthFlowService({
      agentCwd: '/missing-workspaces',
      authSessionStore: {
        createOrReuse: vi.fn(), markAwaitingUser: vi.fn(), markConnected: vi.fn(),
        markFailed: vi.fn(), getLatestForUser: vi.fn(),
      },
      connectionStore,
      runner: { login: vi.fn(), logout },
    });

    await expect(service.revokeUser(user())).resolves.toBeUndefined();
    expect(logout).toHaveBeenCalledWith(user(), ['ding-corp-1:staff-1']);
    expect(removeForUser).toHaveBeenCalledWith(user().tenantId, user().id);
  });

  it('本地 profile 已不存在时仍清理陈旧连接账本', async () => {
    const removeProfile = vi.fn(async () => 1);
    const connectionStore: DwsConnectionStore = {
      syncProfiles: vi.fn(async () => undefined),
      claimDue: vi.fn(async () => null),
      completeCheck: vi.fn(async () => undefined),
      failCheck: vi.fn(async () => undefined),
      releaseClaim: vi.fn(async () => undefined),
      listForUser: vi.fn(async () => [{
        tenantId: user().tenantId,
        userId: user().id,
        username: user().username,
        profileId: 'ding-corp-1:staff-1',
        corpId: 'ding-corp-1',
        dingtalkUserId: 'staff-1',
        connectionStatus: 'disconnected' as const,
        nextCheckAt: NOW,
        consecutiveFailures: 0,
        createdAt: NOW,
        updatedAt: NOW,
      }]),
      removeProfile,
    };
    const service = new DwsAuthFlowService({
      agentCwd: '/missing-workspaces',
      authSessionStore: {
        createOrReuse: vi.fn(),
        markAwaitingUser: vi.fn(),
        markConnected: vi.fn(),
        markFailed: vi.fn(),
        getLatestForUser: vi.fn(),
      },
      connectionStore,
      runner: {
        login: vi.fn(),
        logout: vi.fn(async () => { throw new Error('profile "ding-corp-1:staff-1" not found'); }),
      },
    });

    await expect(service.revokeProfile(user(), 'ding-corp-1:staff-1')).resolves.toBeUndefined();
    expect(removeProfile).toHaveBeenCalledWith(user().tenantId, user().id, 'ding-corp-1:staff-1');
  });

  it('精确 selector 的本地退出发生真实故障时保留连接账本并返回失败', async () => {
    const removeProfile = vi.fn(async () => 1);
    const connectionStore: DwsConnectionStore = {
      syncProfiles: vi.fn(async () => undefined),
      claimDue: vi.fn(async () => null),
      completeCheck: vi.fn(async () => undefined),
      failCheck: vi.fn(async () => undefined),
      releaseClaim: vi.fn(async () => undefined),
      listForUser: vi.fn(async () => [{
        tenantId: user().tenantId,
        userId: user().id,
        username: user().username,
        profileId: 'ding-corp-1:staff-1',
        corpId: 'ding-corp-1',
        dingtalkUserId: 'staff-1',
        connectionStatus: 'connected' as const,
        nextCheckAt: NOW,
        consecutiveFailures: 0,
        createdAt: NOW,
        updatedAt: NOW,
      }]),
      removeProfile,
    };
    const service = new DwsAuthFlowService({
      agentCwd: '/missing-workspaces',
      authSessionStore: {
        createOrReuse: vi.fn(),
        markAwaitingUser: vi.fn(),
        markConnected: vi.fn(),
        markFailed: vi.fn(),
        getLatestForUser: vi.fn(),
      },
      connectionStore,
      runner: {
        login: vi.fn(),
        logout: vi.fn(async () => { throw new Error('hand-server 调用超时'); }),
      },
    });

    await expect(service.revokeProfile(user(), 'ding-corp-1:staff-1')).rejects.toThrow('hand-server 调用超时');
    expect(removeProfile).not.toHaveBeenCalled();
  });

  it('检测到上个进程遗留的授权会话时重新发起 device flow', async () => {
    const interrupted = session();
    const replacement = { ...session(), sessionId: 'auth-session-2' };
    const authStore: DwsAuthSessionStore = {
      createOrReuse: vi.fn()
        .mockResolvedValueOnce({ record: interrupted, created: false })
        .mockResolvedValueOnce({ record: replacement, created: true }),
      markAwaitingUser: vi.fn(async () => undefined),
      markConnected: vi.fn(async () => undefined),
      markFailed: vi.fn(async () => undefined),
      getLatestForUser: vi.fn(async () => replacement),
    };
    const service = new DwsAuthFlowService({
      agentCwd: '/missing-workspaces',
      authSessionStore: authStore,
      connectionStore: {
        syncProfiles: vi.fn(async () => undefined),
        claimDue: vi.fn(async () => null),
        completeCheck: vi.fn(async () => undefined),
        failCheck: vi.fn(async () => undefined),
        releaseClaim: vi.fn(async () => undefined),
        listForUser: vi.fn(async () => []),
      },
      runner: { login: vi.fn(async () => undefined) },
    });

    await expect(service.start(user())).resolves.toEqual(replacement);
    expect(authStore.markFailed).toHaveBeenCalledWith(
      'auth-session-1',
      expect.objectContaining({ tenantId: 'kaiyan', userId: user().id }),
      'authorization_interrupted',
      '上次钉钉授权已中断，已重新生成授权页面',
    );
    expect(authStore.createOrReuse).toHaveBeenCalledTimes(2);
  });
});
