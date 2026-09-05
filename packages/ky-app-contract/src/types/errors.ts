/**
 * §6.5 定制项目**可发出**的错误码集合（附录 D 的 `error.code` 枚举）。
 * Gateway 内部码单独列在 GatewayErrorCode，定制项目不得发出。
 */
export const APP_ERROR_CODES = [
  'unauthorized',
  'token_replayed',
  'forbidden',
  'approval_required',
  'installation_disabled',
  'directory_stale',
  'not_found',
  'invalid_input',
  'idempotency_mismatch',
  'in_progress',
  'digest_mismatch',
  'state_gap',
  'response_too_large',
  'rate_limited',
  'maintenance',
  'upstream_unavailable',
  'internal',
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

/** §6.5 表末尾三个 Gateway 内部码：不落 HTTP、不出现在定制项目响应里。 */
export const GATEWAY_ERROR_CODES = [
  'outcome_unknown',
  'approval_channel_unavailable',
  'system_needs_reregistration',
] as const;

export type GatewayErrorCode = (typeof GATEWAY_ERROR_CODES)[number];

/** 契约里出现过的全部错误码。 */
export type ErrorCode = AppErrorCode | GatewayErrorCode;

/** 附录 D 错误响应体。`message` 只进日志，客户面文案由 KY Agent 按 code 渲染。 */
export interface ErrorResponse {
  ok: false;
  error: {
    code: AppErrorCode;
    retryable: boolean;
    message: string;
    requestId: string;
  };
}

/** 目录快照/变更流的 410 响应（附录 L `error410`）。 */
export type DirectoryGoneCode = 'snapshot_expired' | 'cursor_expired';

export interface DirectoryGoneResponse {
  code: DirectoryGoneCode;
  requestId?: string;
}
