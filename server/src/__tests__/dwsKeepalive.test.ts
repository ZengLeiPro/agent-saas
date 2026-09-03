import { describe, expect, it, vi } from 'vitest';

import {
  DwsAuthStatusRunner,
  DwsAuthKeepaliveService,
  parseAuthStatusOutput,
  parseDwsProfilesJson,
} from '../dws/keepalive.js';
import {
  computeProfileDueAt,
  computeNextCheckAfterStatus,
  type DwsAuthCheckResult,
  type DwsConnectionRecord,
  type DwsConnectionStore,
} from '../dws/store.js';
import type { UserInfo } from '../data/users/types.js';

const NOW = new Date('2026-07-14T02:00:00.000Z');

function connection(): DwsConnectionRecord {
  return {
    tenantId: 'kaiyan',
    userId: 'ky000000000001',
    username: 'alice',
    profileId: 'ding-corp-1:staff-1',
    corpId: 'ding-corp-1',
    corpName: '示例企业',
    dingtalkUserId: 'staff-1',
    profileStatus: 'active',
    connectionStatus: 'pending',
    nextCheckAt: NOW.toISOString(),
    consecutiveFailures: 0,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

function user(): UserInfo {
  return {
    id: 'ky000000000001',
    username: 'alice',
    role: 'user',
    tenantId: 'kaiyan',
    createdAt: NOW.toISOString(),
    createdBy: 'system',
    updatedAt: NOW.toISOString(),
  };
}

describe('DWS auth keepalive', () => {
  it('从 v1 profiles.json 读取非敏感元数据并生成精确 selector', () => {
    const profiles = parseDwsProfilesJson(JSON.stringify({
      version: 1,
      currentProfile: 'ding-corp-1',
      profiles: [{
        name: 'main',
        corpId: 'ding-corp-1',
        corpName: '示例企业',
        userId: 'staff-1',
        userName: '张三',
        status: 'active',
        refreshExpAt: '2026-08-13T02:00:00.000Z',
        accessToken: '绝不能进入平台元数据',
        refreshToken: '绝不能进入平台元数据',
      }],
    }));

    expect(profiles).toEqual([{
      profileId: 'ding-corp-1:staff-1',
      corpId: 'ding-corp-1',
      isCurrent: true,
      profileName: 'main',
      corpName: '示例企业',
      dingtalkUserId: 'staff-1',
      dingtalkUserName: '张三',
      profileStatus: 'active',
      refreshExpiresAt: '2026-08-13T02:00:00.000Z',
    }]);
    expect(JSON.stringify(profiles)).not.toContain('绝不能进入平台元数据');
  });

  it('同组织双账号保留两个精确 selector，并按 currentProfile 标记本次账号', () => {
    const profiles = parseDwsProfilesJson(JSON.stringify({
      version: 3,
      currentProfile: 'ding-corp-1:staff-b',
      orgCurrentProfiles: { 'ding-corp-1': 'ding-corp-1:staff-b' },
      profiles: [
        { name: 'account-a', corpId: 'ding-corp-1', userId: 'staff-a', status: 'active' },
        { name: 'account-b', corpId: 'ding-corp-1', userId: 'staff-b', status: 'active' },
      ],
    }));

    expect(profiles.map(profile => profile.profileId)).toEqual([
      'ding-corp-1:staff-a',
      'ding-corp-1:staff-b',
    ]);
    expect(profiles.filter(profile => profile.isCurrent).map(profile => profile.profileId))
      .toEqual(['ding-corp-1:staff-b']);
  });

  it('同组织多账号只有组织级 currentProfile 且无唯一映射时 fail closed', () => {
    expect(() => parseDwsProfilesJson(JSON.stringify({
      version: 3,
      currentProfile: 'ding-corp-1',
      profiles: [
        { name: 'account-a', corpId: 'ding-corp-1', userId: 'staff-a' },
        { name: 'account-b', corpId: 'ding-corp-1', userId: 'staff-b' },
      ],
    }))).toThrow('currentProfile 无法唯一解析');
  });

  it('未来、伪造版本或超量列表时拒绝猜测解析', () => {
    expect(() => parseDwsProfilesJson(JSON.stringify({ version: 4, profiles: [] })))
      .toThrow('version 4 超出当前支持范围');
    expect(() => parseDwsProfilesJson(JSON.stringify({ version: '4', profiles: [] })))
      .toThrow('version 格式无效');
    expect(() => parseDwsProfilesJson(JSON.stringify({
      version: 3,
      profiles: Array.from({ length: 101 }, (_, index) => ({ corpId: `corp-${index}` })),
    }))).toThrow('profile 数量超过 100');
  });

  it('存在但非法的 currentProfile 不得降级为未指定', () => {
    expect(() => parseDwsProfilesJson(JSON.stringify({
      version: 3,
      currentProfile: 'x'.repeat(513),
      profiles: [{ corpId: 'ding-corp-1', userId: 'staff-a' }],
    }))).toThrow('currentProfile 格式无效');
  });

  it('解析 Shell 包装后的 dws auth status JSON', () => {
    const payload = parseAuthStatusOutput(`Exit code: 0\n\n[stdout]\n{\n  "success": true,\n  "authenticated": true,\n  "refresh_token_valid": true,\n  "corp_id": "ding-corp-1"\n}\n`);
    expect(payload.authenticated).toBe(true);
    expect(payload.corp_id).toBe('ding-corp-1');
  });

  it('通过同一用户 warm sandbox 执行精确 profile，且不改变 currentProfile', async () => {
    let wire: Record<string, any> | undefined;
    const fetchImpl: typeof fetch = vi.fn(async (_input, init) => {
      wire = JSON.parse(String(init?.body));
      const statusJson = JSON.stringify({
        success: true,
        authenticated: true,
        token_valid: true,
        refresh_token_valid: true,
        corp_id: "ding'corp",
        user_id: 'staff-1',
      });
      const chunk = {
        type: 'completed',
        response: {
          status: 'success',
          content: `Exit code: 0\n\n[stdout]\n${statusJson}\n`,
        },
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    const resolveServerRemote = vi.fn(async () => ({
      baseUrl: 'http://acs.internal',
      authToken: 'server-token',
      invokeTimeoutMs: 5_000,
    }));
    const runner = new DwsAuthStatusRunner({
      agentCwd: '/mnt/agent-saas/workspaces',
      resolveServerRemote,
      fetchImpl,
    });
    const record = {
      ...connection(),
      profileId: "ding'corp:staff-1",
      corpId: "ding'corp",
      dingtalkUserId: 'staff-1',
    };

    const result = await runner.check(user(), record);

    expect(result).toMatchObject({ authenticated: true, refreshTokenValid: true });
    expect(resolveServerRemote).toHaveBeenCalledWith(user());
    expect(wire?.toolName).toBe('Shell');
    expect(wire?.input.command).toContain("--profile 'ding'\"'\"'corp:staff-1'");
    expect(wire?.input.command).not.toContain('currentProfile');
    expect(wire?.context.workspace).toMatchObject({
      id: 'ws_kaiyan__ky000000000001',
      mountSubPath: 'workspaces/kaiyan/ky000000000001',
      sessionId: 'dws-keepalive-ky000000000001',
      workload: { class: 'cron' },
    });
    expect(JSON.stringify(wire)).not.toContain('server-token');
  });

  it('auth status 返回同组织其他账号时 fail closed', async () => {
    const fetchImpl: typeof fetch = vi.fn(async () => {
      const chunk = {
        type: 'completed',
        response: {
          status: 'success',
          content: `Exit code: 0\n\n[stdout]\n${JSON.stringify({
            success: true,
            authenticated: true,
            token_valid: true,
            refresh_token_valid: true,
            corp_id: 'ding-corp-1',
            user_id: 'staff-2',
          })}\n`,
        },
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as typeof fetch;
    const runner = new DwsAuthStatusRunner({
      agentCwd: '/mnt/agent-saas/workspaces',
      serverRemote: { baseUrl: 'http://acs.internal', authToken: 'server-token' },
      fetchImpl,
    });

    await expect(runner.check(user(), connection())).rejects.toThrow('DWS profile 账号不匹配');
  });

  it('把守活安排在 21 天内，且至少提前 7 天避开 refresh expiry', () => {
    expect(computeProfileDueAt({
      profileId: 'ding-corp-1:staff-1',
      corpId: 'ding-corp-1',
      lastUsedAt: '2026-07-10T02:00:00.000Z',
      refreshExpiresAt: '2026-08-01T02:00:00.000Z',
    }, NOW)).toBe('2026-07-25T02:00:00.000Z');
    expect(computeNextCheckAfterStatus({
      refreshExpiresAt: '2026-07-20T02:00:00.000Z',
    }, NOW)).toBe('2026-07-14T05:00:00.000Z');
  });

  it('串行认领连接并把成功结果写回状态账本', async () => {
    const claimed = connection();
    let claimCount = 0;
    let completeResolve!: (value: DwsAuthCheckResult) => void;
    const completed = new Promise<DwsAuthCheckResult>((resolve) => { completeResolve = resolve; });
    const store: DwsConnectionStore = {
      syncProfiles: vi.fn(async () => undefined),
      claimDue: vi.fn(async () => (claimCount++ === 0 ? claimed : null)),
      completeCheck: vi.fn(async (_record, _worker, result) => { completeResolve(result); }),
      failCheck: vi.fn(async () => undefined),
      releaseClaim: vi.fn(async () => undefined),
      listForUser: vi.fn(async () => []),
    };
    const currentUser = user();
    const service = new DwsAuthKeepaliveService({
      agentCwd: '/mnt/agent-saas/workspaces',
      userStore: {
        listAll: () => [],
        findById: (id: string) => id === currentUser.id ? currentUser as never : undefined,
      },
      connectionStore: store,
      runner: {
        check: vi.fn(async () => ({
          authenticated: true,
          tokenValid: true,
          refreshTokenValid: true,
          refreshed: true,
        })),
      },
      initialDelayMs: 0,
      scanIntervalMs: 60_000,
      maxChecksPerRun: 1,
    });

    service.start();
    const result = await completed;
    service.stop();

    expect(result).toMatchObject({ authenticated: true, refreshTokenValid: true, refreshed: true });
    expect(store.failCheck).not.toHaveBeenCalled();
  });

  it('授权完成后可在未启动定时扫描的 API 进程执行一次首次检测', async () => {
    const claimed = connection();
    const store: DwsConnectionStore = {
      syncProfiles: vi.fn(async () => undefined),
      claimDue: vi.fn().mockResolvedValueOnce(claimed).mockResolvedValue(null),
      completeCheck: vi.fn(async () => undefined),
      failCheck: vi.fn(async () => undefined),
      releaseClaim: vi.fn(async () => undefined),
      listForUser: vi.fn(async () => []),
    };
    const service = new DwsAuthKeepaliveService({
      agentCwd: '/mnt/agent-saas/workspaces',
      userStore: { listAll: () => [], findById: () => user() as never },
      connectionStore: store,
      runner: { check: vi.fn(async () => ({ authenticated: true, tokenValid: true, refreshTokenValid: true, refreshed: false })) },
      maxChecksPerRun: 1,
    });

    await service.runOnce(NOW, { allowStopped: true });

    expect(store.claimDue).toHaveBeenCalledOnce();
    expect(store.completeCheck).toHaveBeenCalledWith(
      claimed,
      expect.any(String),
      expect.objectContaining({ authenticated: true, refreshTokenValid: true }),
      NOW,
    );
  });
});
