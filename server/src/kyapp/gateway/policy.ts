/**
 * WP3：限流、并发闸与熔断（规范 §6.2-7）。
 *
 * 四道闸，全部进程内（与 `health/prober.ts` 的 PG 持久态不同：这里是热路径，
 * 每次能力调用都要过，落 PG 会把一次工具调用变成三次往返）：
 * 1. 每安装实例并发 ≤ 8 —— 排队等待，不直接拒（照 `subagent/subagentLimits.ts:39-76`）；
 * 2. 每 run 同能力 ≤ 20 —— 超出直接拒，防模型死循环刷外部系统；
 * 3. 每租户每分钟 ≤ 300、每日 ≤ 5,000 —— 滑动窗口（照 `engine/dispatch.ts:174-215`）；
 * 4. 同安装实例连续 20 次 5xx/超时 → 熔断 5 分钟（照 `health/prober.ts:31` 的计数结构）。
 *
 * **多进程下这些额度是 per-process 的**（记进遗留清单）：blue/green + worker
 * 三个进程各自计数，实际上限是配置值的进程数倍。真正需要全局精确额度时
 * 要落 PG/Redis，但那会给每次调用加一次往返，第一期不做。
 */
import type { KyAppGatewayLimits } from '../config.js';

/** 闸门判定结果。`retryAfterMs` 只在客户面提示里用，不参与 §6.2-5 的重试判定。 */
export type PolicyDecision =
  | { allowed: true }
  | { allowed: false; code: 'rate_limited' | 'upstream_unavailable'; retryAfterMs: number };

interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
  onAbort?: () => void;
  signal?: AbortSignal;
}

export class GatewayConcurrencyAbortError extends Error {
  constructor() {
    super('等待定制系统并发槽时被取消');
    this.name = 'GatewayConcurrencyAbortError';
  }
}

/** FIFO 异步信号量。照 `subagentLimits.ts` 的实现，语义一致。 */
class AsyncSemaphore {
  private active = 0;

  private readonly waiters: Waiter[] = [];

  constructor(private readonly max: number) {}

  get activeCount(): number {
    return this.active;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new GatewayConcurrencyAbortError();
    if (this.active < this.max) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new GatewayConcurrencyAbortError());
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      if (next.signal && next.onAbort) next.signal.removeEventListener('abort', next.onAbort);
      next.resolve();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }
}

interface Window {
  startedAt: number;
  count: number;
}

interface Breaker {
  consecutiveFailures: number;
  openedUntil: number;
}

export interface GatewayPolicySlot {
  release(): void;
}

export interface GatewayPolicyOptions {
  limits: KyAppGatewayLimits;
  now?: () => number;
  /** Map 惰性回收阈值，防长跑进程无界增长。 */
  pruneThreshold?: number;
}

const DEFAULT_PRUNE_THRESHOLD = 2_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/**
 * 一次能力调用要过的全部闸门。**调用顺序有讲究**：
 * 先判熔断与计数类闸门（快、无副作用），最后才排队占并发槽 ——
 * 反过来会让被拒的调用白白占着槽位排队。
 */
export class GatewayPolicy {
  private readonly semaphores = new Map<string, AsyncSemaphore>();

  private readonly runCapabilityCounts = new Map<string, number>();

  private readonly tenantMinute = new Map<string, Window>();

  private readonly tenantDay = new Map<string, Window>();

  private readonly breakers = new Map<string, Breaker>();

  private readonly now: () => number;

  private readonly pruneThreshold: number;

  constructor(private readonly options: GatewayPolicyOptions) {
    this.now = options.now ?? Date.now;
    this.pruneThreshold = options.pruneThreshold ?? DEFAULT_PRUNE_THRESHOLD;
  }

  /**
   * 计数类闸门（熔断 → 每 run 同能力 → 每租户分钟/天）。
   * **只读判定 + 计数**，不占用任何需要释放的资源，可以安全地在拒绝路径上提前返回。
   */
  check(input: {
    tenantId: string;
    installationId: string;
    runId: string;
    capabilityId: string;
  }): PolicyDecision {
    const now = this.now();
    const limits = this.options.limits;

    const breaker = this.breakers.get(input.installationId);
    if (breaker && breaker.openedUntil > now) {
      // 熔断期内一律 upstream_unavailable：客户面「系统暂时不可用」，
      // 不说「熔断」这类技术词（客户面纪律）。
      return {
        allowed: false,
        code: 'upstream_unavailable',
        retryAfterMs: breaker.openedUntil - now,
      };
    }

    const runKey = `${input.runId}:${input.capabilityId}`;
    const runCount = this.runCapabilityCounts.get(runKey) ?? 0;
    if (runCount >= limits.perRunPerCapability) {
      // 同一个 run 里把同一能力刷到上限，多半是模型陷入循环。这一条不给重试窗口。
      return { allowed: false, code: 'rate_limited', retryAfterMs: 0 };
    }

    const minute = this.takeWindow(
      this.tenantMinute,
      input.tenantId,
      now,
      MINUTE_MS,
      limits.perTenantPerMinute,
    );
    if (minute !== null) return { allowed: false, code: 'rate_limited', retryAfterMs: minute };

    const day = this.takeWindow(
      this.tenantDay,
      input.tenantId,
      now,
      DAY_MS,
      limits.perTenantPerDay,
    );
    if (day !== null) {
      // 分钟窗已经计过数了，日窗拒绝时要把它退回去，否则被拒的调用也吃掉分钟配额。
      this.refundWindow(this.tenantMinute, input.tenantId);
      return { allowed: false, code: 'rate_limited', retryAfterMs: day };
    }

    this.runCapabilityCounts.set(runKey, runCount + 1);
    this.pruneIfNeeded();
    return { allowed: true };
  }

  /** 并发槽（每安装实例 ≤ 8）。满则 FIFO 排队，`signal` 中断即抛。 */
  async acquire(installationId: string, signal?: AbortSignal): Promise<GatewayPolicySlot> {
    let semaphore = this.semaphores.get(installationId);
    if (!semaphore) {
      semaphore = new AsyncSemaphore(this.options.limits.perInstallationConcurrency);
      this.semaphores.set(installationId, semaphore);
    }
    await semaphore.acquire(signal);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        semaphore.release();
      },
    };
  }

  /**
   * 记一次「算熔断」的失败（5xx 或超时/无响应）。
   * **4xx 不算**：那是请求本身的问题，不代表系统不可用，累计它会让参数写错的
   * Agent 把整个安装实例熔断掉。
   */
  recordFailure(installationId: string): void {
    const limits = this.options.limits;
    const breaker = this.breakers.get(installationId) ?? { consecutiveFailures: 0, openedUntil: 0 };
    breaker.consecutiveFailures += 1;
    if (breaker.consecutiveFailures >= limits.breakerFailureThreshold) {
      breaker.openedUntil = this.now() + limits.breakerCooldownMs;
      breaker.consecutiveFailures = 0;
    }
    this.breakers.set(installationId, breaker);
  }

  /** 一次成功即清零连续失败计数（照 `prober.ts:188/:286`）。 */
  recordSuccess(installationId: string): void {
    const breaker = this.breakers.get(installationId);
    if (!breaker) return;
    breaker.consecutiveFailures = 0;
    if (breaker.openedUntil <= this.now()) this.breakers.delete(installationId);
  }

  /** run 结束时回收计数（不调用也不会泄漏，`pruneIfNeeded` 会兜住）。 */
  forgetRun(runId: string): void {
    for (const key of this.runCapabilityCounts.keys()) {
      if (key.startsWith(`${runId}:`)) this.runCapabilityCounts.delete(key);
    }
  }

  /** 只读视图，供测试与诊断。 */
  inspect(installationId: string): { active: number; breakerOpenUntil: number } {
    return {
      active: this.semaphores.get(installationId)?.activeCount ?? 0,
      breakerOpenUntil: this.breakers.get(installationId)?.openedUntil ?? 0,
    };
  }

  /** 命中返回剩余毫秒；未命中返回 `null` 并已计数。 */
  private takeWindow(
    buckets: Map<string, Window>,
    key: string,
    now: number,
    windowMs: number,
    max: number,
  ): number | null {
    const bucket = buckets.get(key);
    if (!bucket || now - bucket.startedAt >= windowMs) {
      buckets.set(key, { startedAt: now, count: 1 });
      return null;
    }
    if (bucket.count >= max) return windowMs - (now - bucket.startedAt);
    bucket.count += 1;
    return null;
  }

  private refundWindow(buckets: Map<string, Window>, key: string): void {
    const bucket = buckets.get(key);
    if (bucket && bucket.count > 0) bucket.count -= 1;
  }

  private pruneIfNeeded(): void {
    const now = this.now();
    if (this.runCapabilityCounts.size >= this.pruneThreshold) {
      // run 计数没有时间戳，只能整体清空：最坏情况是某些在跑的 run 的
      // 「同能力 ≤ 20」计数被重置，属于放宽而非收紧，且需要 2000 个并发 run 才会发生。
      this.runCapabilityCounts.clear();
    }
    if (this.tenantMinute.size >= this.pruneThreshold) {
      for (const [key, bucket] of this.tenantMinute) {
        if (now - bucket.startedAt >= MINUTE_MS) this.tenantMinute.delete(key);
      }
    }
    if (this.tenantDay.size >= this.pruneThreshold) {
      for (const [key, bucket] of this.tenantDay) {
        if (now - bucket.startedAt >= DAY_MS) this.tenantDay.delete(key);
      }
    }
    if (this.semaphores.size >= this.pruneThreshold) {
      for (const [key, semaphore] of this.semaphores) {
        if (semaphore.activeCount === 0) this.semaphores.delete(key);
      }
    }
  }
}
