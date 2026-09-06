/**
 * §5.3：**重复 `(type,id)` 不丢弃而是重放缓存的同一应答，副作用只执行一次。**
 *
 * 为什么不能简单去重：子端在 5 s 超时后会重发同一条 `(type,id)`（例如网络抖动
 * 把应答吞了）。直接丢弃 → 子端永远等不到应答；不去重直接重跑 → `token.request`
 * 会多签一枚 SAT、`link.open` 会弹两次确认框。规范要求的第三条路是「副作用跑一次、
 * 应答可重放任意次」。
 *
 * 在途请求也要能重放：第二条重复消息到达时第一条可能还没算完，此时必须挂在同一个
 * Promise 上，而不是另起一次副作用。
 */
export interface ReplayCacheEntry<TReply> {
  /** 首次到达时启动的副作用；后续重复消息全部复用它。 */
  reply: Promise<TReply>;
  at: number;
}

export interface ReplayCacheOptions {
  /** 条目上限，防止子端刷 id 把壳的内存打爆。超限按 FIFO 淘汰最老的。 */
  maxEntries?: number;
  now?: () => number;
}

const DEFAULT_MAX_ENTRIES = 200;

export class ReplayCache<TReply> {
  private readonly entries = new Map<string, ReplayCacheEntry<TReply>>();
  private readonly maxEntries: number;
  private readonly now: () => number;
  /** 观测用：命中重放的次数（测试与 §8.5 观测都要看）。 */
  private replays = 0;

  constructor(options: ReplayCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
  }

  get replayCount(): number {
    return this.replays;
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * 取或建：`key` 命中则重放缓存应答（**不执行** `run`），否则执行一次并缓存。
   * `run` 抛错的条目会被剔除，让子端重发时还有一次机会 —— 失败的副作用没有
   * 「只执行一次」的语义包袱，卡死才是更坏的结果。
   */
  runOnce(key: string, run: () => Promise<TReply>): Promise<TReply> {
    const hit = this.entries.get(key);
    if (hit) {
      this.replays += 1;
      return hit.reply;
    }
    const reply = run().catch((error: unknown) => {
      this.entries.delete(key);
      throw error;
    });
    this.entries.set(key, { reply, at: this.now() });
    this.evict();
    return reply;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  clear(): void {
    this.entries.clear();
    this.replays = 0;
  }

  private evict(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) return;
      this.entries.delete(oldest.value);
    }
  }
}

/** 缓存键：§5.3 说的是 `(type, id)` 这个二元组，不是单独的 id。 */
export function replayKey(type: string, id: string): string {
  return `${type} ${id}`;
}
