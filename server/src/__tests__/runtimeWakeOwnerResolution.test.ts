import { describe, expect, it } from 'vitest';

import {
  resolveSessionOwnerTenantId,
  resolveWakeSessionOwner,
  type RawRuntimeRunDispatchConfig,
} from '../runtime/rawRuntimeRunDispatch.js';
import type { RuntimeSessionRecord } from '../runtime/sessionCatalog.js';

describe('resolveWakeSessionOwner', () => {
  const session: RuntimeSessionRecord = {
    sessionId: 'session-real-name',
    userId: 'user-zenglei',
    username: 'zenglei',
    userRole: 'admin',
    channel: 'web',
    cwd: '/tmp/zenglei',
    transcriptPath: '/tmp/zenglei/session.jsonl',
    modelRef: 'gpt-5.4-mini',
    executionTarget: 'server-local',
    workspaceId: 'workspace-zenglei',
    status: 'running',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  function makeConfig(overrides: Partial<RawRuntimeRunDispatchConfig> = {}): RawRuntimeRunDispatchConfig {
    return {
      agentCwd: '/tmp',
      sharedDir: '/tmp',
      ...overrides,
    } as RawRuntimeRunDispatchConfig;
  }

  it('restores the account full name instead of using the username on scheduler wake', () => {
    const seen: Array<{ userId?: string; username?: string }> = [];
    const owner = resolveWakeSessionOwner(makeConfig({
      resolveUserRealName: (identity) => {
        seen.push(identity);
        return '曾磊';
      },
      resolveUserTenantId: () => 'kaiyan',
    }), session);

    expect(seen).toEqual([{ userId: 'user-zenglei', username: 'zenglei' }]);
    expect(owner).toEqual({
      id: 'user-zenglei',
      username: 'zenglei',
      role: 'admin',
      tenantId: 'kaiyan',
      realName: '曾磊',
    });
  });

  it('keeps username fallback behavior when the account has no full name', () => {
    const owner = resolveWakeSessionOwner(makeConfig({
      resolveUserRealName: () => undefined,
    }), session);

    expect(owner.username).toBe('zenglei');
    expect(owner).not.toHaveProperty('realName');
  });
});

// 疑点 3 加固（2026-06-22）：sessionOwner.tenantId 是 A+C execution routing
// 主防御的关键身份字段。runStore.Shell gate 用 `isPlatformAdmin = role==='admin'
// && tenantId === DEFAULT_TENANT_ID` 判定，若 tenantId 在 wake 路径上被静默
// 回填为默认 'kaiyan'，组织 admin 会被误判为平台 admin → 可在 server-local 跑
// Shell → 跨组织读取宿主文件复发。这里把 `resolveSessionOwnerTenantId`
// helper 的 4 个分支锁死，确保任何回归会立刻被门禁拦下。
describe('resolveSessionOwnerTenantId', () => {
  const baseSession: RuntimeSessionRecord = {
    sessionId: 'session-tenant',
    userId: 'user-wain-admin',
    username: 'wain_admin',
    channel: 'web',
    cwd: '/tmp/wain_admin',
    transcriptPath: '/tmp/wain_admin/session.jsonl',
    modelRef: 'doubao-seed-2.0-pro',
    executionTarget: 'server-container',
    workspaceId: 'workspace-wain',
    status: 'running',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // 最小可用 config（只放本 helper 真消费的字段）
  function makeConfig(overrides: Partial<RawRuntimeRunDispatchConfig> = {}): RawRuntimeRunDispatchConfig {
    return {
      agentCwd: '/tmp',
      sharedDir: '/tmp',
      ...overrides,
    } as RawRuntimeRunDispatchConfig;
  }

  it('returns the resolver value verbatim when resolveUserTenantId returns a valid tenant slug', () => {
    const seen: Array<{ userId?: string; username?: string }> = [];
    const config = makeConfig({
      resolveUserTenantId: (input) => {
        seen.push(input);
        return 'wain-test';
      },
    });

    const tenantId = resolveSessionOwnerTenantId(config, baseSession);

    expect(tenantId).toBe('wain-test');
    // 确认查表用的是 session 自带的 userId + username（不是默认值或猜测）
    expect(seen).toEqual([{ userId: 'user-wain-admin', username: 'wain_admin' }]);
  });

  it('returns undefined (not the default tenant) when resolveUserTenantId is not configured', () => {
    const config = makeConfig({ resolveUserTenantId: undefined });
    expect(resolveSessionOwnerTenantId(config, baseSession)).toBeUndefined();
  });

  it('returns undefined verbatim when resolveUserTenantId resolves to undefined (no silent fallback to DEFAULT_TENANT_ID)', () => {
    // 模拟：用户已删 / UserStore.findById 找不到 → 返回 undefined。
    // 关键不变量：这种情况下绝不能静默回填为 'kaiyan'，否则组织 admin 被误判为
    // 平台 admin（isPlatformAdmin = role==='admin' && tenantId===DEFAULT_TENANT_ID）。
    const config = makeConfig({ resolveUserTenantId: () => undefined });
    expect(resolveSessionOwnerTenantId(config, baseSession)).toBeUndefined();
  });

  it('fail-safe to undefined (not throw upward) when resolveUserTenantId throws', () => {
    // UserStore 故障（DB 临时不可用 / 文件读 IO 错）不应让一次 wake 全栈 throw，
    // 否则 scheduler 会把 run 标记为 failed，用户体验等同 brain 崩溃。
    // 设计：catch + warn log + 返回 undefined → 下游 `isPlatformAdmin=false` 自然 fail-closed。
    const config = makeConfig({
      resolveUserTenantId: () => {
        throw new Error('UserStore unavailable');
      },
    });

    let returnedValue: string | undefined;
    expect(() => {
      returnedValue = resolveSessionOwnerTenantId(config, baseSession);
    }).not.toThrow();
    expect(returnedValue).toBeUndefined();
  });
});
