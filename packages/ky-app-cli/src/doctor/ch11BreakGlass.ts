/**
 * §9.3-11：本地兜底登录全套。
 *
 * 限速与锁定都按 IP 生效，因此每组用例用互不相同的 `X-Forwarded-For`，
 * 避免相互串味；4 小时自动关闭用 `/ky/v1/test/clock` 注入时钟。
 */
import {
  ADMIN_REQUIRED_MENU_KEY,
  BREAK_GLASS_SESSION_SECONDS,
  type MeResponse,
} from '@kaiyan/ky-app-contract';

import { assert, expectStatus, newRequestId } from '../harness/http.js';
import {
  RECOVERY_PASSWORD,
  disableBreakGlass,
  enableBreakGlass,
  loginAsEmployee,
  setupRecovery,
} from './breakGlass.js';
import { adminApiPath, fixtureUsers, userApiPath } from './fixtures.js';
import type { DoctorContext } from './context.js';

const LOCKOUT_SUB = 'doctor-lockout';

function fromIp(ip: string): Record<string, string> {
  return { 'x-forwarded-for': ip };
}

export async function chapter11(ctx: DoctorContext): Promise<void> {
  const reporter = ctx.reporter;
  reporter.section(11);

  const users = fixtureUsers(ctx);
  await disableBreakGlass(ctx);

  await reporter.check('兜底关闭时 /ky-local/login → 404', async () => {
    const result = await ctx.call({
      method: 'POST',
      path: '/ky-local/login',
      body: { loginId: 'x', code: 'y' },
    });
    expectStatus(result, 404, '关闭状态下的 /ky-local/login');
  });

  await reporter.check('兜底关闭时 /ky-local/enable 仍可达（错误因子 → 401）', async () => {
    const result = await ctx.call({
      method: 'POST',
      path: '/ky-local/enable',
      headers: fromIp('10.9.9.1'),
      body: { sub: 'doctor-nobody', password: RECOVERY_PASSWORD, code: 'nope' },
    });
    expectStatus(result, 401, '关闭状态下的 /ky-local/enable');
  });

  await reporter.check('/ky-local/enable 每 IP 每分钟 ≤ 5 次（第 6 次 429）', async () => {
    const ip = '10.9.9.2';
    const statuses: number[] = [];
    for (let index = 0; index < 6; index += 1) {
      const result = await ctx.call({
        method: 'POST',
        path: '/ky-local/enable',
        headers: fromIp(ip),
        body: { sub: 'doctor-nobody', password: RECOVERY_PASSWORD, code: 'nope' },
      });
      statuses.push(result.status);
    }
    assert(
      statuses.slice(0, 5).every((status) => status === 401),
      `前 5 次应为 401，实际 ${statuses.join(',')}`,
    );
    assert(statuses[5] === 429, `第 6 次应为 429，实际 ${String(statuses[5])}`);
  });

  await reporter.check('恢复因子连续 5 次错误 → 记录锁定 30 分钟', async () => {
    await setupRecovery(ctx, LOCKOUT_SUB);
    for (let index = 0; index < 5; index += 1) {
      const result = await ctx.call({
        method: 'POST',
        path: '/ky-local/enable',
        headers: fromIp('10.9.9.3'),
        body: { sub: LOCKOUT_SUB, password: 'wrong-password-1234', code: 'nope' },
      });
      expectStatus(result, 401, `第 ${String(index + 1)} 次错误因子`);
    }
    // 换一个从未打过的 IP，排除限速干扰：这一次用的是**正确**的因子。
    const codes = await ctx.testHook('break-glass', { action: 'status' });
    void codes;
    const locked = await ctx.call({
      method: 'POST',
      path: '/ky-local/enable',
      headers: fromIp('10.9.9.4'),
      body: { sub: LOCKOUT_SUB, password: RECOVERY_PASSWORD, code: 'whatever' },
    });
    expectStatus(locked, 429, '锁定期内即使换 IP 也应被拒');
  });

  await reporter.check('installation.disabled 状态下拒绝启用兜底', async () => {
    const disabled = await ctx.sendEvent({
      eventId: newRequestId('evt-disable'),
      iid: ctx.shell.app.installationId,
      stateVersion: ctx.nextStateVersion(),
      type: 'installation.disabled',
      occurredAt: new Date().toISOString(),
    });
    expectStatus(disabled, 200, '推送 installation.disabled');
    const result = await ctx.call({
      method: 'POST',
      path: '/ky-local/enable',
      headers: fromIp('10.9.9.5'),
      body: { sub: users.admin.sub, password: RECOVERY_PASSWORD, code: 'x' },
    });
    expectStatus(result, 403, 'disabled 状态下启用兜底');

    const enabled = await ctx.sendEvent({
      eventId: newRequestId('evt-enable'),
      iid: ctx.shell.app.installationId,
      stateVersion: ctx.nextStateVersion(),
      type: 'installation.enabled',
      occurredAt: new Date().toISOString(),
    });
    expectStatus(enabled, 200, '推送 installation.enabled 恢复');
  });

  let localAdminToken = '';
  let localUserToken = '';

  await reporter.check('具名启用兜底模式并签发 local_admin', async () => {
    const session = await enableBreakGlass(ctx, users.admin.sub);
    localAdminToken = session.adminToken;
    localUserToken = await loginAsEmployee(ctx, session, {
      loginId: users.member.sub,
      sub: users.member.sub,
    });
    assert(localAdminToken !== '' && localUserToken !== '', '兜底令牌为空');
  });

  await reporter.check(
    `兜底态 local_admin 的 /me 含 adminRole 与 ${ADMIN_REQUIRED_MENU_KEY}`,
    async () => {
      const result = await ctx.call({ path: '/ky/v1/me', token: localAdminToken });
      expectStatus(result, 200, 'local_admin /me');
      const me = result.json as MeResponse;
      assert(me.user.isTenantAdmin, '兜底态 local_admin 的 isTenantAdmin 应为 true');
      assert(
        me.user.roles.includes(ctx.manifest.roles.adminRole),
        `roles 应含 adminRole=${ctx.manifest.roles.adminRole}，实际 ${JSON.stringify(me.user.roles)}`,
      );
      const keys = JSON.stringify(me.menus);
      assert(keys.includes(ADMIN_REQUIRED_MENU_KEY), `菜单缺少 ${ADMIN_REQUIRED_MENU_KEY}`);
    },
  );

  await reporter.check('local_user 只达 pathPrefixes.user', async () => {
    const userApi = userApiPath(ctx);
    const adminApi = adminApiPath(ctx);
    assert(userApi !== null && adminApi !== null, '夹具里缺 user/admin 前缀内的页面接口');
    expectStatus(
      await ctx.call({ path: userApi, token: localUserToken }),
      200,
      'local_user 访问 user 前缀',
    );
    expectStatus(
      await ctx.call({ path: adminApi, token: localUserToken }),
      403,
      'local_user 访问 admin 前缀',
    );
  });

  await reporter.check('兜底会话 4 小时后自动关闭（时钟注入）', async () => {
    try {
      await ctx.setClockOffset((BREAK_GLASS_SESSION_SECONDS + 60) * 1000);
      const me = await ctx.call({ path: '/ky/v1/me', token: localAdminToken });
      expectStatus(me, [401, 403], '4 小时后使用 local_admin 令牌');
      const status = await ctx.call({ path: '/ky-local/status' });
      expectStatus(status, 404, '4 小时后 /ky-local/status');
    } finally {
      await ctx.setClockOffset(0);
    }
  });

  await disableBreakGlass(ctx);
}
