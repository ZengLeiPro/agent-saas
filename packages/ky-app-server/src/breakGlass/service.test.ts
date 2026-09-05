/** §3.5 / §9.3-11 本地兜底登录。 */
import { decodeJwt } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';

import type { InstallationState } from '@kaiyan/ky-app-contract';

import { createLocalKeyRing } from '../local/keys.js';
import { verifyLocalToken } from '../local/token.js';
import {
  ENABLE_RATE_LIMIT,
  LOCKOUT_MS,
  MAX_FAILED_ATTEMPTS,
  RECOVERY_CODE_COUNT,
  createBreakGlass,
  type BreakGlass,
  type BreakGlassAlert,
} from './service.js';
import { MemoryBreakGlassStore } from './store.js';
import { BASE_NOW_MS, TEST_MANIFEST, createClock, createTestConfig } from '../__tests__/helpers.js';

const config = createTestConfig();
const keys = createLocalKeyRing(config, { rotatedAt: BASE_NOW_MS });
const PASSWORD = 'recover-me-2026!';

let clock: ReturnType<typeof createClock>;
let store: MemoryBreakGlassStore;
let alerts: BreakGlassAlert[];
let state: InstallationState;
let service: BreakGlass;
let codes: string[];

beforeEach(async () => {
  clock = createClock();
  store = new MemoryBreakGlassStore();
  alerts = [];
  state = 'enabled';
  service = createBreakGlass({
    config,
    keys,
    store,
    pathPrefixes: TEST_MANIFEST.pathPrefixes,
    installationState: () => state,
    onAlert: (alert) => alerts.push(alert),
    now: clock.now,
  });
  ({ codes } = await service.setupRecoveryRecord({ sub: 'u_admin', password: PASSWORD }));
}, 30_000);

describe('具名恢复记录', () => {
  it('发 8 个一次性恢复码，明文只出现一次', () => {
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
    for (const code of codes) expect(code.length).toBeGreaterThanOrEqual(22);
  });

  it('兜底模式开启时不允许重设恢复因子', async () => {
    await service.enable({ sub: 'u_admin', password: PASSWORD, code: codes[0] });
    await expect(
      service.setupRecoveryRecord({ sub: 'u_admin', password: PASSWORD }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('启用（POST /ky-local/enable）', () => {
  it('具名启用成功：进入兜底模式 4 小时并签发 local_admin', async () => {
    const result = await service.enable({ sub: 'u_admin', password: PASSWORD, code: codes[0] });
    expect(result.sessionExpiresAt - BASE_NOW_MS).toBe(4 * 60 * 60 * 1000);
    const claims = decodeJwt(result.token);
    expect(claims.act).toBe('local_admin');
    expect(claims.pfx).toEqual(['/api/app/', '/api/admin/']);
    expect(alerts.some((alert) => alert.kind === 'enabled')).toBe(true);

    const identity = await verifyLocalToken(result.token, {
      config,
      keys,
      localMode: true,
      installationState: 'enabled',
      request: { method: 'GET', pathname: '/api/admin/roles' },
      pathPrefixes: TEST_MANIFEST.pathPrefixes,
      now: clock.now,
    });
    expect(identity).toMatchObject({ act: 'local_admin', sub: 'u_admin', tadm: true });
  });

  it('同一恢复码不能第二次使用', async () => {
    await service.enable({ sub: 'u_admin', password: PASSWORD, code: codes[0] });
    await service.disable();
    await expect(
      service.enable({ sub: 'u_admin', password: PASSWORD, code: codes[0] }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('安装实例 disabled / deleted 时拒绝启用', async () => {
    for (const value of ['disabled', 'deleted'] as const) {
      state = value;
      await expect(
        service.enable({ sub: 'u_admin', password: PASSWORD, code: codes[1] }),
      ).rejects.toMatchObject({ code: 'installation_disabled' });
    }
  });

  it('每 IP ≤ 5 次 / 分钟', async () => {
    for (let index = 0; index < ENABLE_RATE_LIMIT.max; index += 1) {
      await expect(
        service.enable({ sub: 'u_nobody', password: 'x'.repeat(16), code: 'nope', ip: '1.2.3.4' }),
      ).rejects.toMatchObject({ code: 'unauthorized' });
    }
    await expect(
      service.enable({ sub: 'u_admin', password: PASSWORD, code: codes[0], ip: '1.2.3.4' }),
    ).rejects.toMatchObject({ code: 'rate_limited' });

    clock.advance(ENABLE_RATE_LIMIT.windowMs + 1);
    await expect(
      service.enable({ sub: 'u_admin', password: PASSWORD, code: codes[0], ip: '1.2.3.4' }),
    ).resolves.toBeDefined();
  }, 30_000);

  it('5 次失败锁定 30 分钟并触发告警', async () => {
    for (let index = 0; index < MAX_FAILED_ATTEMPTS; index += 1) {
      await expect(
        service.enable({ sub: 'u_admin', password: 'wrong-password', code: codes[0] }),
      ).rejects.toMatchObject({ code: 'unauthorized' });
    }
    expect(alerts.filter((alert) => alert.kind === 'lockout')).toHaveLength(1);
    await expect(
      service.enable({ sub: 'u_admin', password: PASSWORD, code: codes[0] }),
    ).rejects.toMatchObject({ code: 'rate_limited' });

    clock.advance(LOCKOUT_MS + 1);
    await expect(
      service.enable({ sub: 'u_admin', password: PASSWORD, code: codes[0] }),
    ).resolves.toBeDefined();
  }, 60_000);
});

describe('会话生命周期', () => {
  it('4 小时后自动关闭（时钟注入）', async () => {
    await service.enable({ sub: 'u_admin', password: PASSWORD, code: codes[0] });
    expect(await service.isActive()).toBe(true);
    clock.advance(4 * 60 * 60 * 1000 + 1);
    expect(await service.isActive()).toBe(false);
  });

  it('可续期', async () => {
    await service.enable({ sub: 'u_admin', password: PASSWORD, code: codes[0] });
    clock.advance(3 * 60 * 60 * 1000);
    const renewed = await service.renew();
    expect(renewed.expiresAt).toBe(clock.now() + 4 * 60 * 60 * 1000);
  });

  it('disable 是模式级撤销：已签发的 Local Token 一并失效', async () => {
    const result = await service.enable({ sub: 'u_admin', password: PASSWORD, code: codes[0] });
    await service.disable();
    expect(await service.isActive()).toBe(false);
    await expect(
      verifyLocalToken(result.token, {
        config,
        keys,
        localMode: false,
        installationState: 'enabled',
        request: { method: 'GET', pathname: '/ky/v1/me' },
        pathPrefixes: TEST_MANIFEST.pathPrefixes,
        now: clock.now,
      }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });
});

describe('员工一次性码', () => {
  beforeEach(async () => {
    await service.enable({ sub: 'u_admin', password: PASSWORD, code: codes[0] });
  }, 30_000);

  it('15 分钟 TTL，登录后拿到 local_user', async () => {
    const issued = await service.issueEmployeeCode({ loginId: 'E1024', sub: 'u_member' });
    expect(issued.expiresAt - clock.now()).toBe(15 * 60 * 1000);
    const result = await service.login({ loginId: 'E1024', code: issued.code });
    const claims = decodeJwt(result.token);
    expect(claims.act).toBe('local_user');
    expect(claims.pfx).toEqual(['/api/app/']);
    expect(claims.sub).toBe('u_member');
  });

  it('码过期后拒绝', async () => {
    const issued = await service.issueEmployeeCode({ loginId: 'E1024', sub: 'u_member' });
    clock.advance(15 * 60 * 1000 + 1);
    await expect(service.login({ loginId: 'E1024', code: issued.code })).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });

  it('码只能用一次', async () => {
    const issued = await service.issueEmployeeCode({ loginId: 'E1024', sub: 'u_member' });
    await service.login({ loginId: 'E1024', code: issued.code });
    await expect(service.login({ loginId: 'E1024', code: issued.code })).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });

  it('5 次错误锁定', async () => {
    const issued = await service.issueEmployeeCode({ loginId: 'E1024', sub: 'u_member' });
    for (let index = 0; index < MAX_FAILED_ATTEMPTS; index += 1) {
      await expect(service.login({ loginId: 'E1024', code: 'wrong' })).rejects.toMatchObject({
        code: 'unauthorized',
      });
    }
    await expect(service.login({ loginId: 'E1024', code: issued.code })).rejects.toMatchObject({
      code: 'rate_limited',
    });
  });

  it('兜底模式关闭后不能签码也不能登录', async () => {
    const issued = await service.issueEmployeeCode({ loginId: 'E1024', sub: 'u_member' });
    await service.disable();
    await expect(
      service.issueEmployeeCode({ loginId: 'E2048', sub: 'u_other' }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(service.login({ loginId: 'E1024', code: issued.code })).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });
});

describe('本地审计', () => {
  it('每次启用 / 登录都留痕', async () => {
    await service.enable({ sub: 'u_admin', password: PASSWORD, code: codes[0] });
    await expect(
      service.enable({ sub: 'u_admin', password: 'wrong-password', code: codes[1] }),
    ).rejects.toThrow();
    const entries = await store.listAudit();
    expect(entries.map((entry) => `${entry.action}:${entry.outcome}`)).toEqual([
      'recovery.setup:success',
      'enable:success',
      'enable:failure',
    ]);
  }, 30_000);
});
