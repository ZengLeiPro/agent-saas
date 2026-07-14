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
    profileId: 'ding-corp-1',
    corpName: '示例企业',
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
  it('只从 profiles.json 读取非敏感 profile 元数据', () => {
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
      profileId: 'ding-corp-1',
      profileName: 'main',
      corpName: '示例企业',
      dingtalkUserId: 'staff-1',
      dingtalkUserName: '张三',
      profileStatus: 'active',
      refreshExpiresAt: '2026-08-13T02:00:00.000Z',
    }]);
    expect(JSON.stringify(profiles)).not.toContain('绝不能进入平台元数据');
  });

  it('解析 Shell 包装后的 dws auth status JSON', () => {
    const payload = parseAuthStatusOutput(`Exit code: 0\n\n[stdout]\n{\n  "success": true,\n  "authenticated": true,\n  "refresh_token_valid": true,\n  "corp_id": "ding-corp-1"\n}\n`);
    expect(payload.authenticated).toBe(true);
    expect(payload.corp_id).toBe('ding-corp-1');
  });

  it('通过同一用户 warm sandbox 执行指定 profile，且不改变 currentProfile', async () => {
    let wire: Record<string, any> | undefined;
    const fetchImpl: typeof fetch = vi.fn(async (_input, init) => {
      wire = JSON.parse(String(init?.body));
      const statusJson = JSON.stringify({
        success: true,
        authenticated: true,
        token_valid: true,
        refresh_token_valid: true,
        corp_id: "ding'corp",
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
    const runner = new DwsAuthStatusRunner({
      agentCwd: '/mnt/agent-saas/workspaces',
      serverRemote: { baseUrl: 'http://acs.internal', authToken: 'server-token', invokeTimeoutMs: 5_000 },
      fetchImpl,
    });
    const record = { ...connection(), profileId: "ding'corp" };

    const result = await runner.check(user(), record);

    expect(result).toMatchObject({ authenticated: true, refreshTokenValid: true });
    expect(wire?.toolName).toBe('Shell');
    expect(wire?.input.command).toContain("--profile 'ding'\"'\"'corp'");
    expect(wire?.input.command).not.toContain('currentProfile');
    expect(wire?.context.workspace).toMatchObject({
      id: 'ws_kaiyan__ky000000000001',
      mountSubPath: 'workspaces/kaiyan/ky000000000001',
      sessionId: 'dws-keepalive-ky000000000001',
    });
    expect(JSON.stringify(wire)).not.toContain('server-token');
  });

  it('把守活安排在 21 天内，且至少提前 7 天避开 refresh expiry', () => {
    expect(computeProfileDueAt({
      profileId: 'ding-corp-1',
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
});
