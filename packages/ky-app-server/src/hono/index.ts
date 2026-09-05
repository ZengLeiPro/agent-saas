/**
 * `@kaiyan/ky-app-server/hono` —— 参考 Hono 适配器（默认值 #1）。
 *
 * `hono` 是**可选 peer 依赖**：只有 import 这个子路径入口才会真正加载它，
 * 用其他框架的项目按线协议自实现即可，主入口不受影响。
 */
export { createKyAppRouter, type KyAppRouter } from './router.js';
export {
  errorResponder,
  permVersionHeader,
  requestContext,
  requireIdentity,
  requireUser,
  type RequireUserOptions,
} from './middleware.js';
export {
  CONTENT_SECURITY_POLICY,
  SHELL_ORIGIN,
  STRICT_TRANSPORT_SECURITY,
  securityHeaders,
  type SecurityHeadersOptions,
} from './securityHeaders.js';
export { createKyAppRuntime, type KyAppRuntime, type AuthenticateInput } from './runtime.js';
export { registerTestRoutes } from './testRoutes.js';
export type {
  KyAppRouterConfig,
  KyAppRouterHealth,
  KyAppTestHooks,
  KyAppVariables,
  KyLogEntry,
  KyRequestIdentity,
} from './types.js';
