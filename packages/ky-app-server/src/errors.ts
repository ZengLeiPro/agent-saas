/**
 * 服务端统一错误：所有对外响应都走附录 D 结构（`{ok:false,error:{code,retryable,message,requestId}}`）。
 *
 * `message` 只进日志，客户面文案由 KY Agent 按 `code` 渲染（§6.5）。
 */
import {
  defaultRetryable,
  httpStatusFor,
  makeErrorResponse,
  type AppErrorCode,
  type ErrorResponse,
} from '@kaiyan/ky-app-contract';

export interface KyAppErrorOptions {
  /** 只进日志的诊断信息。 */
  message?: string;
  /** 覆盖 §6.5 的默认 retryable 提示。 */
  retryable?: boolean;
  cause?: unknown;
}

/** 契约错误。抛出后由适配器转成附录 D 响应体 + §6.5 的 HTTP 状态。 */
export class KyAppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  readonly retryable: boolean;

  constructor(code: AppErrorCode, options: KyAppErrorOptions = {}) {
    super(
      options.message ?? code,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'KyAppError';
    this.code = code;
    this.status = httpStatusFor(code);
    this.retryable = options.retryable ?? defaultRetryable(code);
  }

  /** 转成附录 D 响应体。 */
  toResponse(requestId: string): ErrorResponse {
    return makeErrorResponse({
      code: this.code,
      requestId,
      message: this.message,
      retryable: this.retryable,
    });
  }
}

/** 任意异常 → 附录 D 响应体；非契约错误一律收敛成 `internal`，不外泄堆栈。 */
export function toErrorResponse(
  error: unknown,
  requestId: string,
): { status: number; body: ErrorResponse } {
  if (error instanceof KyAppError) {
    return { status: error.status, body: error.toResponse(requestId) };
  }
  const internal = new KyAppError('internal', {
    message: error instanceof Error ? error.message : String(error),
  });
  return { status: internal.status, body: internal.toResponse(requestId) };
}

/** 401：未认证（验签失败、claims 不合矩阵、时间窗不符）。 */
export function unauthorized(message: string): KyAppError {
  return new KyAppError('unauthorized', { message });
}

/** 403：已认证但端点 / `cap` / `lcid` / `pfx` / `rid` 不符。 */
export function forbidden(message: string): KyAppError {
  return new KyAppError('forbidden', { message });
}
