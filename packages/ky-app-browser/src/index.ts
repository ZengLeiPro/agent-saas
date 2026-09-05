/**
 * `@kaiyan/ky-app-browser` —— 定制项目子端 SDK（无框架依赖）。
 *
 * 规范：`开沿定制项目与KY Agent衔接契约-实施终稿.md` §3.1（`user` 续期）、§3.4（权限版本发现）、
 * §4.6（attest）、§5.1～5.5（嵌入、URL 与路由、信封与来源校验、握手与消息表、生命周期）。
 *
 * 令牌只在内存，绝不落 `localStorage` / cookie；本包不读 `process.env` / `import.meta.env`。
 */
export { CONTRACT_VERSION } from '@kaiyan/ky-app-contract/browser';

export { createKyApp, DEFAULT_ATTEST_URL, clampText } from './createKyApp.js';
export { KyAuthError, KyTimeoutError, KyUsageError, type KyAuthErrorReason } from './errors.js';
export { checkExternalLink, isIpLiteral, type LinkCheckResult } from './links.js';
export {
  appPathFromUrl,
  readLocation,
  resolveShellOrigin,
  toAppPath,
  type KyLocationInfo,
} from './environment.js';
export { TokenStore, type KyTokenSnapshot } from './tokenStore.js';
export {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  PROACTIVE_REFRESH_LEAD_MS,
  REFRESH_NOW_THRESHOLD_MS,
} from './tokenManager.js';
export { defaultTimers, createCounters } from './types.js';
export type {
  KyApp,
  KyAppOptions,
  KyAppState,
  KyCounters,
  KyErrorCode,
  KyErrorInfo,
  KyInitContext,
  KyLinkOutcome,
  KyLinkRejectReason,
  KyMessageEventLike,
  KyMessageListener,
  KyMode,
  KyPhase,
  KyRouteMeta,
  KyRouteOutcome,
  KySyncHistoryOptions,
  KyTimerHandle,
  KyTimers,
  KyWindowLike,
} from './types.js';
