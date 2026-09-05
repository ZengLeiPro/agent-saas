/**
 * §9.3-8：权限与菜单。
 *
 * 「叶子 path 被路由覆盖」需要真实浏览器（壳发 `route.navigate`），放在 `browser.ts` 里
 * 以同一章号补录，本文件只做 HTTP 侧的部分。
 */
import {
  ADMIN_REQUIRED_MENU_KEY,
  HTTP_HEADERS,
  type MenuItem,
  type MeResponse,
} from '@kaiyan/ky-app-contract';

import { assert, expectStatus } from '../harness/http.js';
import { fixtureUsers, provisionUsers, userApiPath } from './fixtures.js';
import type { DoctorContext } from './context.js';

/** 深度优先收集所有叶子。 */
export function leaves(menus: MenuItem[]): MenuItem[] {
  const result: MenuItem[] = [];
  for (const menu of menus) {
    if (menu.children === undefined || menu.children.length === 0) result.push(menu);
    else result.push(...leaves(menu.children));
  }
  return result;
}

function hasKey(menus: MenuItem[], key: string): boolean {
  return menus.some(
    (menu) => menu.key === key || (menu.children !== undefined && hasKey(menu.children, key)),
  );
}

export async function chapter08(ctx: DoctorContext): Promise<void> {
  const reporter = ctx.reporter;
  reporter.section(8);

  const users = fixtureUsers(ctx);
  await provisionUsers(ctx, [
    { sub: users.admin.sub, roles: users.admin.roles, isTenantAdmin: true },
    { sub: users.member.sub, roles: users.member.roles },
    { sub: users.norole.sub, roles: [] },
  ]);

  let adminMe: MeResponse | null = null;

  await reporter.check(`tadm=true 的 /me 菜单含 ${ADMIN_REQUIRED_MENU_KEY}`, async () => {
    const result = await ctx.callAsUser(
      { path: '/ky/v1/me' },
      { sub: users.admin.sub, tadm: true },
    );
    expectStatus(result, 200, '管理员 /me');
    adminMe = result.json as MeResponse;
    assert(
      hasKey(adminMe.menus, ADMIN_REQUIRED_MENU_KEY),
      `管理员菜单里没有 ${ADMIN_REQUIRED_MENU_KEY}`,
    );
    assert(adminMe.user.isTenantAdmin, '/me.user.isTenantAdmin 应为 true');
  });

  await reporter.check('landing 是菜单树里的叶子', async () => {
    assert(adminMe !== null, '前一项没拿到管理员 /me');
    const paths = leaves(adminMe.menus).map((menu) => menu.path);
    assert(
      adminMe.landing !== null && paths.includes(adminMe.landing),
      `landing=${String(adminMe.landing)} 不在叶子集合 ${JSON.stringify(paths)} 内`,
    );
  });

  await reporter.check('无业务角色用户：menus=[] 且 landing=null', async () => {
    const result = await ctx.callAsUser(
      { path: '/ky/v1/me' },
      { sub: users.norole.sub, tadm: false },
    );
    expectStatus(result, 200, '无角色用户 /me');
    const me = result.json as MeResponse;
    assert(me.menus.length === 0, `期望空菜单，实际 ${JSON.stringify(me.menus.map((m) => m.key))}`);
    assert(me.landing === null, `期望 landing=null，实际 ${String(me.landing)}`);
  });

  for (const capability of ctx.manifest.capabilities) {
    await reporter.check(`无业务角色用户调用能力 ${capability.id} → 403`, async () => {
      const fixture = ctx.conformance.capabilities[capability.id];
      const input = fixture?.validInputs[0]?.input ?? {};
      const result = await ctx.invokeCapability({
        capabilityId: capability.id,
        input,
        sub: users.norole.sub,
      });
      expectStatus(result, 403, `无角色用户调用 ${capability.id}`);
    });
  }

  const menuApis = Object.entries(ctx.conformance.menuApis ?? {});
  if (menuApis.length === 0) {
    reporter.record(
      '夹具声明 menuApis（菜单叶子 → 页面接口）',
      'fail',
      '附录 J 夹具里没有 menuApis',
    );
  }
  for (const [menuKey, api] of menuApis) {
    await reporter.check(
      `无权用户访问菜单接口 ${menuKey}（${api.method} ${api.path}）→ 403`,
      async () => {
        const result = await ctx.callAsUser(
          { method: api.method, path: api.path, ...(api.method === 'POST' ? { body: {} } : {}) },
          { sub: users.norole.sub, tadm: false },
        );
        expectStatus(result, 403, `无权用户访问 ${api.path}`);
      },
    );
  }

  await reporter.check(`角色变更后 ${HTTP_HEADERS.permVersion} 变化`, async () => {
    const api = userApiPath(ctx);
    assert(api !== null, '夹具里没有 pathPrefixes.user 内的页面接口');
    const probe = async (): Promise<string> => {
      const result = await ctx.callAsUser({ path: api }, { sub: users.member.sub, tadm: false });
      expectStatus(result, 200, `读取 ${api}`);
      const version = result.headers.get(HTTP_HEADERS.permVersion);
      assert(version !== null && version !== '', `响应缺少 ${HTTP_HEADERS.permVersion}`);
      return version;
    };
    await provisionUsers(ctx, [{ sub: users.member.sub, roles: users.member.roles }]);
    const before = await probe();
    await provisionUsers(ctx, [
      { sub: users.member.sub, roles: [...users.member.roles, 'doctor-extra-role'] },
    ]);
    const after = await probe();
    assert(before !== after, `角色变更后 ${HTTP_HEADERS.permVersion} 仍是 ${before}`);
    // 还原，避免影响后续章节。
    await provisionUsers(ctx, [{ sub: users.member.sub, roles: users.member.roles }]);
  });
}
