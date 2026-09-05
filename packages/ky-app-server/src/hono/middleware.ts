/**
 * Hono 中间件：请求 id 回显与结构化日志、统一错误输出、`pathPrefixes` 内业务路由的鉴权。
 */
import type { Context, MiddlewareHandler, Next } from 'hono';

import { HTTP_HEADERS, isEndpointAllowed } from '@kaiyan/ky-app-contract';

import { KyAppError, forbidden, toErrorResponse } from '../errors.js';
import type { KyAppRuntime } from './runtime.js';
import type { KyAppVariables, KyRequestIdentity } from './types.js';

type KyContext = Context<{ Variables: KyAppVariables }>;

/** 从上下文取已验签身份；未鉴权时抛 401。业务 handler 用它构造 `ctx`（§9.2）。 */
export function requireIdentity(c: KyContext): KyRequestIdentity {
  const identity = c.get('kyIdentity');
  if (identity === undefined) {
    throw new KyAppError('unauthorized', { message: '当前请求没有经过验签中间件' });
  }
  return identity;
}

/** `X-KY-Request-Id` 回显 + 结构化日志钩子（§4、§8.5）。 */
export function requestContext(runtime: KyAppRuntime): MiddlewareHandler {
  return async (c, next) => {
    const requestId = runtime.requestId(c.req.raw.headers);
    (c as KyContext).set('kyRequestId', requestId);
    const startedAt = Date.now();
    await next();
    c.res.headers.set(HTTP_HEADERS.requestId, requestId);
    const identity = (c as KyContext).get('kyIdentity');
    runtime.options.onLog?.({
      requestId,
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: c.res.status,
      durationMs: Date.now() - startedAt,
      ...(identity === undefined ? {} : { act: identity.act }),
      ...(identity?.sub === undefined ? {} : { sub: identity.sub }),
    });
  };
}

/** 把任何异常转成附录 D 结构。 */
export function errorResponder(c: KyContext, error: unknown): Response {
  const requestId = c.get('kyRequestId') ?? '';
  const { status, body } = toErrorResponse(error, requestId);
  const response = Response.json(body, { status });
  response.headers.set(HTTP_HEADERS.requestId, requestId);
  return response;
}

export interface RequireUserOptions {
  /** 非 GET 视为写入口，受 §3.4「目录陈旧 > 2 小时拒写」约束。默认按 HTTP 方法判断。 */
  write?: boolean;
}

/**
 * `pathPrefixes` 内业务路由的鉴权中间件。
 *
 * - 只接受 `user` / `local_admin` / `local_user`；
 * - 端点 × act 矩阵按 manifest 的 `pathPrefixes` 判定，`tadm=false` 打 admin 前缀 → 403；
 * - 安装实例 `disabled`/`deleted` → 403 `installation_disabled`；
 * - 目录陈旧度三级门禁（兜底模式不受约束，§3.4）；
 * - 响应带 `X-KY-Perm-Version`（§9.2）。
 */
export function requireUser(
  runtime: KyAppRuntime,
  options: RequireUserOptions = {},
): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const url = new URL(c.req.url);
    await runtime.assertInstallationUsable(url.pathname);

    const identity = await runtime.authenticate({
      method: c.req.method,
      pathname: url.pathname,
      authorization: c.req.header('authorization') ?? null,
      requestId: (c as KyContext).get('kyRequestId') ?? '',
    });
    if (identity.act === 'agent' || identity.act === 'platform') {
      throw forbidden(`act=${identity.act} 不允许访问业务接口`);
    }

    // 纵深防御：authenticate 内部已按矩阵判过一次，这里再按 manifest 前缀判一次，
    // 保证即便调用方把中间件挂到了矩阵外的路径上也不会放行。
    const allowed = isEndpointAllowed(identity.act, c.req.method, url.pathname, {
      pathPrefixes: runtime.options.manifest.pathPrefixes,
      tadm: identity.tadm,
      localMode: await runtime.localModeActive(),
      testEndpoints: runtime.testEndpointsEnabled(),
    });
    if (!allowed) throw forbidden(`act=${identity.act} 不允许访问 ${c.req.method} ${url.pathname}`);

    const isWrite = options.write ?? c.req.method !== 'GET';
    if (identity.local === undefined) {
      const gate = await runtime.stalenessGate();
      if (gate !== null && !gate.allowRead) {
        throw new KyAppError('directory_stale', {
          message: '组织目录已超过 24 小时未同步，业务接口全部拒绝',
        });
      }
      if (gate !== null && isWrite && !gate.allowWrite) {
        throw new KyAppError('directory_stale', {
          message: '组织目录已超过 2 小时未同步，写入口拒绝',
        });
      }
    }

    (c as KyContext).set('kyIdentity', identity);
    await next();
    c.res.headers.set(
      HTTP_HEADERS.permVersion,
      String(await runtime.options.permVersion(identity)),
    );
  };
}

/** 只给响应加 `X-KY-Perm-Version`，供已有自建鉴权的应用单独挂载。 */
export function permVersionHeader(runtime: KyAppRuntime): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const identity = (c as KyContext).get('kyIdentity');
    if (identity === undefined) return;
    c.res.headers.set(
      HTTP_HEADERS.permVersion,
      String(await runtime.options.permVersion(identity)),
    );
  };
}
