/**
 * §3.8 `/ky/v1/test/*`：**仅 `KY_ENV=test`** 开放，非 test 环境不得注册。
 *
 * 三件事：预置角色（`provision`，§9.3-7）、驱动兜底模式（`break-glass`）、时钟偏移（`clock`）。
 * 这些端点公开可达（一致性测试只打隔离测试环境），因此路由注册本身就受 `KY_ENV` 约束。
 */
import { KyAppError } from '../errors.js';
import type { KyAppRuntime } from './runtime.js';
import type { KyAppRouter } from './router.js';

export function registerTestRoutes(app: KyAppRouter, runtime: KyAppRuntime): void {
  if (!runtime.testEndpointsEnabled()) return;
  const hooks = runtime.options.testHooks ?? {};

  app.post('/ky/v1/test/provision', async (c) => {
    if (hooks.provision === undefined) {
      throw new KyAppError('not_found', { message: '未提供 provision 钩子' });
    }
    return c.json({
      ok: true,
      result: await hooks.provision(await c.req.json().catch(() => null)),
    });
  });

  app.post('/ky/v1/test/break-glass', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { action?: unknown } | null;
    if (hooks.breakGlass !== undefined) {
      return c.json({ ok: true, result: await hooks.breakGlass(body) });
    }
    const breakGlass = runtime.options.breakGlass;
    if (breakGlass === undefined) {
      throw new KyAppError('not_found', { message: '本部署未启用兜底登录' });
    }
    if (body?.action === 'disable') {
      await breakGlass.disable();
      return c.json({ ok: true, active: false });
    }
    throw new KyAppError('invalid_input', {
      message: '默认实现只支持 action=disable，启用请走 /ky-local/enable 或自定义钩子',
    });
  });

  app.post('/ky/v1/test/clock', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { offsetMs?: unknown } | null;
    if (body === null || !Number.isSafeInteger(body.offsetMs)) {
      throw new KyAppError('invalid_input', { message: '需要整数 offsetMs' });
    }
    runtime.setClockOffset(body.offsetMs as number);
    return c.json({ ok: true, offsetMs: runtime.clockOffset() });
  });
}
