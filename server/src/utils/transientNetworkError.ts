const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT',
  'EAI_AGAIN', 'EPIPE', 'ERR_NETWORK', 'ECONNABORTED',
  'EHOSTUNREACH', 'ENETUNREACH', 'ESOCKETTIMEDOUT',
]);

// node-postgres 在 socket 被远端关闭时只提供固定 message，不附带 errno code。
// 这些错误与上面的连接重置同属瞬态传输故障，不能因此终止整个 Server。
const TRANSIENT_NETWORK_MESSAGES = new Set([
  'Connection terminated',
  'Connection terminated unexpectedly',
  'Connection terminated due to connection timeout',
]);

export function isTransientNetworkError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const candidate = err as Record<string, unknown>;

  if (typeof candidate.code === 'string' && TRANSIENT_NETWORK_CODES.has(candidate.code)) {
    return true;
  }

  return err instanceof Error && TRANSIENT_NETWORK_MESSAGES.has(err.message);
}
