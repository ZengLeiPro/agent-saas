/**
 * WP2b 目录端点限速：**每租户每分钟 ≤ 60 次**（规范 §3.6）。
 *
 * 为什么另写而不是复用：仓库里**没有**可复用的限流件。两处先例
 * （`routes/orgAgents.ts:570-600` 的门禁试跑桶、`telemetry/mobileTelemetry.ts:158-165`
 * 的分钟槽）都是**内联在各自路由处理函数里的局部变量**，既没有导出，也没有共同抽象，
 * 强行抽出来会同时改到 WP3/WP4 之外的两条无关路由。见偏差记录 `2B-B-02`。
 *
 * 口径刻意与消费端 `packages/ky-app-server/src/directory/client.ts:63-77` 的
 * `WindowLimiter` **逐字对称**：同为 60 次 / 60 秒的**滑动**窗口。
 * 用固定分钟槽（mobileTelemetry 那种）会让跨槽的瞬时并发放行到 120 次，
 * 而消费端自己按滑动窗口自限速，两侧口径不一致时消费端会在自认为合规的节奏下被平台 429。
 *
 * 进程内计数：多进程部署时上限退化为 N × 60。这与仓库既有两处限速的性质一致，
 * 且 §3.6 的限速目的是防失控轮询而不是精确配额，因此不为它引入 Redis/PG 往返。
 */

/** §3.6：每租户每分钟 ≤ 60 次；与消费端 `DIRECTORY_RATE_LIMIT` 同值。 */
export const DIRECTORY_RATE_LIMIT = { max: 60, windowMs: 60_000 } as const;

/** 超过这个键数就顺手清一次过期桶；纯内存卫生，与判定无关。 */
const GC_THRESHOLD = 500;

export interface DirectoryRateLimitDecision {
  allowed: boolean;
  /** 本窗口内剩余可用次数（放行后计）。 */
  remaining: number;
  /** 拒绝时建议的 `Retry-After` 秒数；放行时为 0。 */
  retryAfterSeconds: number;
}

export interface DirectoryRateLimiterOptions {
  max?: number;
  windowMs?: number;
}

export class DirectoryRateLimiter {
  private readonly max: number;
  private readonly windowMs: number;
  private readonly hits = new Map<string, number[]>();

  constructor(options: DirectoryRateLimiterOptions = {}) {
    this.max = Math.max(1, options.max ?? DIRECTORY_RATE_LIMIT.max);
    this.windowMs = Math.max(1, options.windowMs ?? DIRECTORY_RATE_LIMIT.windowMs);
  }

  /**
   * 取一个令牌。`key` 用组织 id（§3.6 是**每租户**限速，不是每凭据）。
   * 被拒的请求**不计入**窗口，否则持续打满的客户端会把自己永久锁在窗口外。
   */
  take(key: string, nowMs: number): DirectoryRateLimitDecision {
    const floor = nowMs - this.windowMs;
    const kept = (this.hits.get(key) ?? []).filter((at) => at > floor);
    if (kept.length >= this.max) {
      this.hits.set(key, kept);
      const oldest = kept[0] ?? nowMs;
      const waitMs = Math.max(1, oldest + this.windowMs - nowMs);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
      };
    }
    kept.push(nowMs);
    this.hits.set(key, kept);
    if (this.hits.size > GC_THRESHOLD) this.gc(floor);
    return { allowed: true, remaining: this.max - kept.length, retryAfterSeconds: 0 };
  }

  private gc(floor: number): void {
    for (const [key, timestamps] of this.hits) {
      if (timestamps.length === 0 || timestamps[timestamps.length - 1]! <= floor) {
        this.hits.delete(key);
      }
    }
  }
}
