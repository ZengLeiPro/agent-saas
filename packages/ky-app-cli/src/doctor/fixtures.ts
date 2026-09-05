/** 从 manifest + 附录 J 夹具里挑出各章要用的路径与输入。 */
import { matchPathPrefix } from '@kaiyan/ky-app-contract';

import type { DoctorContext } from './context.js';

/** 夹具里声明的、落在 `pathPrefixes.user` 内的页面接口（GET）。 */
export function userApiPath(ctx: DoctorContext): string | null {
  return pickPath(ctx, ctx.manifest.pathPrefixes.user);
}

/** 夹具里声明的、落在 `pathPrefixes.admin` 内的页面接口（GET）。 */
export function adminApiPath(ctx: DoctorContext): string | null {
  return pickPath(ctx, ctx.manifest.pathPrefixes.admin);
}

function pickPath(ctx: DoctorContext, prefixes: string[]): string | null {
  const candidates: string[] = [];
  for (const entry of Object.values(ctx.conformance.menuApis ?? {})) {
    if (entry.method === 'GET') candidates.push(entry.path);
  }
  for (const fixture of Object.values(ctx.conformance.capabilities)) {
    const equivalence = fixture.pageApiEquivalence;
    if (equivalence !== undefined && equivalence.method === 'GET')
      candidates.push(equivalence.path);
  }
  candidates.push(...ctx.conformance.endpoints);
  for (const candidate of candidates) {
    if (matchPathPrefix(candidate, prefixes)) return candidate;
  }
  return null;
}

/** 某个能力的第一组合法输入。 */
export function firstValidInput(ctx: DoctorContext, capabilityId: string): Record<string, unknown> {
  const fixture = ctx.conformance.capabilities[capabilityId];
  return fixture?.validInputs[0]?.input ?? {};
}

/** 夹具声明的测试用户。 */
export function fixtureUsers(ctx: DoctorContext): {
  admin: { sub: string; tadm: boolean; roles: string[] };
  member: { sub: string; tadm: boolean; roles: string[] };
  norole: { sub: string; tadm: boolean; roles: string[] };
} {
  const normalize = (user: {
    sub: string;
    tadm?: boolean;
    roles?: string[];
  }): {
    sub: string;
    tadm: boolean;
    roles: string[];
  } => ({ sub: user.sub, tadm: user.tadm === true, roles: user.roles ?? [] });
  return {
    admin: normalize(ctx.conformance.users.admin),
    member: normalize(ctx.conformance.users.member),
    norole: normalize(ctx.conformance.users.norole),
  };
}

/**
 * 用 `/ky/v1/test/provision` 预置测试用户（§9.3-7）。
 * 约定：请求体 `{ users:[{sub, displayName?, roles[], isTenantAdmin?, groupIds?}] }`。
 */
export async function provisionUsers(
  ctx: DoctorContext,
  users: Array<{ sub: string; roles?: string[]; isTenantAdmin?: boolean; displayName?: string }>,
): Promise<void> {
  const result = await ctx.testHook('provision', { users });
  if (result.status !== 200) {
    throw new Error(
      `/ky/v1/test/provision 失败：HTTP ${String(result.status)} ${result.text.slice(0, 200)}`,
    );
  }
}

/** 设置能力 handler 的人为延迟（§9.3-6 的 `in_progress` 并发用例需要）。 */
export async function setCapabilityDelay(ctx: DoctorContext, delayMs: number): Promise<void> {
  const result = await ctx.testHook('provision', { capabilityDelayMs: delayMs });
  if (result.status !== 200) {
    throw new Error(
      `/ky/v1/test/provision 设置 capabilityDelayMs 失败：HTTP ${String(result.status)}`,
    );
  }
}
