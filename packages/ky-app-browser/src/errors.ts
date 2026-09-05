/** SDK 抛出的错误类型。客户面文案由应用层渲染，这里只给机器可读的 code / reason。 */
import type { TokenRefreshErrorReason } from '@kaiyan/ky-app-contract/browser';

/** 令牌不可用 / 401 无法自动恢复；写请求必须由页面用幂等键自行处理。 */
export type KyAuthErrorReason =
  | TokenRefreshErrorReason
  | 'no_token'
  | 'handshake_failed'
  | 'unauthorized'
  | 'destroyed'
  | 'timeout';

export class KyAuthError extends Error {
  readonly reason: KyAuthErrorReason;
  /** 401 响应本身（写请求不自动重放，交页面判断）。 */
  readonly response?: Response;

  constructor(reason: KyAuthErrorReason, message: string, response?: Response) {
    super(message);
    this.name = 'KyAuthError';
    this.reason = reason;
    this.response = response;
  }
}

/** 需应答消息 5 s 内没有收到应答。 */
export class KyTimeoutError extends Error {
  readonly messageType: string;

  constructor(messageType: string) {
    super(`等待 ${messageType} 的应答超时`);
    this.name = 'KyTimeoutError';
    this.messageType = messageType;
  }
}

/** 调用方参数不合法（纯本地校验，不发消息）。 */
export class KyUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KyUsageError';
  }
}
