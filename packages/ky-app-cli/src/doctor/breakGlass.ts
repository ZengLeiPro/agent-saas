/**
 * 兜底登录（§3.5）的驱动帮手：ch03（`local_*` 行）与 ch11 共用。
 *
 * 与被测项目的约定（写进模板 README 与 CLAUDE.md）：
 * `POST /ky/v1/test/break-glass`
 *   `{action:'setup', sub, password}` → `{codes:[8 个一次性恢复码]}`
 *   `{action:'disable'}`             → 关闭兜底模式
 *   `{action:'status'}`              → `{active, session}`
 * 启用与登录一律走真实端点 `/ky-local/enable`、`/ky-local/login`，不走捷径。
 */
import { assert, expectStatus } from '../harness/http.js';
import type { DoctorContext } from './context.js';

export const RECOVERY_PASSWORD = 'doctor-recovery-2026!';

export interface LocalSession {
  adminToken: string;
  adminSub: string;
  codes: string[];
  /** 剩余未用的恢复码。 */
  remaining: string[];
}

/** 建立具名恢复记录，返回 8 个一次性恢复码。 */
export async function setupRecovery(ctx: DoctorContext, sub: string): Promise<string[]> {
  const result = await ctx.testHook('break-glass', {
    action: 'setup',
    sub,
    password: RECOVERY_PASSWORD,
  });
  expectStatus(result, 200, `建立 ${sub} 的具名恢复记录`);
  const codes = (result.json as { result?: { codes?: unknown } }).result?.codes;
  assert(Array.isArray(codes) && codes.length === 8, '恢复记录应返回 8 个一次性恢复码');
  return codes as string[];
}

/** 走真实 `/ky-local/enable` 进入兜底模式，返回 `local_admin` 令牌。 */
export async function enableBreakGlass(ctx: DoctorContext, sub: string): Promise<LocalSession> {
  const codes = await setupRecovery(ctx, sub);
  const result = await ctx.call({
    method: 'POST',
    path: '/ky-local/enable',
    body: { sub, password: RECOVERY_PASSWORD, code: codes[0] },
  });
  expectStatus(result, 200, 'POST /ky-local/enable');
  const token = (result.json as { token?: unknown }).token;
  assert(typeof token === 'string' && token.length > 0, '/ky-local/enable 应返回 local_admin 令牌');
  return { adminToken: token, adminSub: sub, codes, remaining: codes.slice(1) };
}

/** `local_admin` 给员工签一次性码，员工换 `local_user` 令牌。 */
export async function loginAsEmployee(
  ctx: DoctorContext,
  session: LocalSession,
  input: { loginId: string; sub: string },
): Promise<string> {
  const issued = await ctx.call({
    method: 'POST',
    path: '/ky-local/employee-code',
    token: session.adminToken,
    body: input,
  });
  expectStatus(issued, 200, 'POST /ky-local/employee-code');
  const code = (issued.json as { code?: unknown }).code;
  assert(typeof code === 'string', '员工一次性码应是字符串');

  const login = await ctx.call({
    method: 'POST',
    path: '/ky-local/login',
    body: { loginId: input.loginId, code },
  });
  expectStatus(login, 200, 'POST /ky-local/login');
  const token = (login.json as { token?: unknown }).token;
  assert(typeof token === 'string', '/ky-local/login 应返回 local_user 令牌');
  return token;
}

/** 关闭兜底模式。 */
export async function disableBreakGlass(ctx: DoctorContext): Promise<void> {
  const result = await ctx.testHook('break-glass', { action: 'disable' });
  expectStatus(result, 200, '关闭兜底模式');
}
