/** §6.5 错误码、HTTP 映射与附录 D 错误响应构造。 */
import {
  APP_ERROR_CODES,
  GATEWAY_ERROR_CODES,
  type AppErrorCode,
  type ErrorResponse,
  type GatewayErrorCode,
} from './types/errors.js';
import { ERROR_HTTP_STATUS } from './types/constants.js';

const APP_CODE_SET: ReadonlySet<string> = new Set<string>(APP_ERROR_CODES);
const GATEWAY_CODE_SET: ReadonlySet<string> = new Set<string>(GATEWAY_ERROR_CODES);

/** 是否为定制项目可发出的错误码。 */
export function isAppErrorCode(value: unknown): value is AppErrorCode {
  return typeof value === 'string' && APP_CODE_SET.has(value);
}

/** 是否为 Gateway 内部码（定制项目不得发出）。 */
export function isGatewayErrorCode(value: unknown): value is GatewayErrorCode {
  return typeof value === 'string' && GATEWAY_CODE_SET.has(value);
}

/** §6.5 错误码 → HTTP 状态。Gateway 内部码没有 HTTP 状态，传入即抛错。 */
export function httpStatusFor(code: AppErrorCode): number {
  const status = ERROR_HTTP_STATUS[code];
  if (status === undefined) throw new Error(`未知错误码：${String(code)}`);
  return status;
}

/**
 * `retryable` 默认值。它只是给 KY Agent 的提示，
 * 真正的重试依据是 §6.2-5 的「HTTP 类别 × safeToRetry」。
 */
const DEFAULT_RETRYABLE: Readonly<Record<AppErrorCode, boolean>> = {
  unauthorized: false,
  token_replayed: false,
  forbidden: false,
  approval_required: false,
  installation_disabled: false,
  directory_stale: false,
  not_found: false,
  invalid_input: false,
  idempotency_mismatch: false,
  in_progress: true,
  digest_mismatch: false,
  state_gap: true,
  response_too_large: false,
  rate_limited: true,
  maintenance: true,
  upstream_unavailable: true,
  internal: true,
};

/** 错误码的默认 retryable 提示。 */
export function defaultRetryable(code: AppErrorCode): boolean {
  return DEFAULT_RETRYABLE[code];
}

export interface MakeErrorResponseInput {
  code: AppErrorCode;
  requestId: string;
  /** 只进日志，客户面文案由 KY Agent 按 code 渲染；超过 200 字截断。 */
  message?: string;
  retryable?: boolean;
}

/** 构造附录 D 错误响应体；不含 `details`。 */
export function makeErrorResponse(input: MakeErrorResponseInput): ErrorResponse {
  if (!isAppErrorCode(input.code)) {
    throw new Error(`不是定制项目可发出的错误码：${String(input.code)}`);
  }
  const message = (input.message ?? input.code).slice(0, 200);
  return {
    ok: false,
    error: {
      code: input.code,
      retryable: input.retryable ?? defaultRetryable(input.code),
      message,
      requestId: input.requestId,
    },
  };
}

/** 同时给出 HTTP 状态与响应体，便于框架适配器直接返回。 */
export function makeErrorHttpResponse(input: MakeErrorResponseInput): {
  status: number;
  body: ErrorResponse;
} {
  const body = makeErrorResponse(input);
  return { status: httpStatusFor(body.error.code), body };
}
