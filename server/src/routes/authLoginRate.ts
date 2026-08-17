export interface RateBucket {
  startedAt: number;
  count: number;
}

/** 定期清理过期桶；unref 避免计时器阻止进程优雅退出。 */
export function startLoginRateCleanup(
  loginAttempts: Map<string, RateBucket>,
  windowMs: number,
): void {
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, bucket] of loginAttempts) {
      if (now - bucket.startedAt > windowMs) {
        loginAttempts.delete(ip);
      }
    }
  }, windowMs * 2);
  cleanupTimer.unref();
}
