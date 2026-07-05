/**
 * 子 agent 防失控限额（D6，2026-07-06）——全部硬机制，不靠 prompt 自觉。
 *
 * 四层闸门（依据见方案 D6 表格）：
 *   - 进程级全局并发 8：OpenClaw lane 同值，防单租户 fan-out 饿死全局 brain。
 *   - 单 run 并发 4：参照 Workflow min(16, cores-2) 思路收敛；drainToolCalls 的
 *     并行窗靠这个信号量排队（等待而非拒绝，Promise.all 段内 5+ 个调用会排队）。
 *   - 单 run 总数 10：硬拒绝。Claude Code 并发无上限打挂服务器（#15487）的教训。
 *   - 硬超时 10min + maxTurns 15：SaaS 无人值守必须有；超时 = terminate + status:timeout。
 *
 * 限额值会动态渲染进 Agent 工具 description（Hermes 教训：模型看到固定文案会按
 * 默认值自我设限或幻觉能力），改这里的常量即同步改模型可见文案。
 */

export const SUBAGENT_GLOBAL_MAX_CONCURRENCY = 8;
export const SUBAGENT_PER_RUN_MAX_CONCURRENCY = 4;
export const SUBAGENT_PER_RUN_MAX_TOTAL = 10;
export const SUBAGENT_HARD_TIMEOUT_MS = 10 * 60 * 1000;
export const SUBAGENT_MAX_TURNS = 15;

/** 结果截断保险丝（D5）：静态上限 24k chars，75% head + 25% tail 按行截断。 */
export const SUBAGENT_RESULT_MAX_CHARS = 24_000;

/** per-run 计数表的清理水位：超过后回收「无活跃占用」的旧 run 条目，防 Map 无界增长。 */
const RUN_ENTRY_PRUNE_THRESHOLD = 512;

export class SubagentLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubagentLimitError';
  }
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * 简单异步信号量：acquire 超额时排队等待（FIFO），支持 AbortSignal 中断等待。
 * 不做公平性以外的花活——子 agent 并发数很小，链表队列足够。
 */
class AsyncSemaphore {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(private readonly max: number) {}

  get activeCount(): number {
    return this.active;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new SubagentLimitError('等待子 agent 并发槽时已被取消');
    if (this.active < this.max) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) this.waiters.splice(idx, 1);
          reject(new SubagentLimitError('等待子 agent 并发槽时被取消'));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      // 槽位直接移交给下一个等待者，active 计数不变
      if (next.signal && next.onAbort) next.signal.removeEventListener('abort', next.onAbort);
      next.resolve();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }
}

interface RunEntry {
  total: number;
  semaphore: AsyncSemaphore;
}

export interface SubagentSlot {
  release(): void;
}

export interface SubagentLimiterOptions {
  globalMaxConcurrency?: number;
  perRunMaxConcurrency?: number;
  perRunMaxTotal?: number;
}

/**
 * 进程级限额器。生产用模块底部的共享单例（限额语义是「本 brain 进程」级）；
 * 测试可 new 独立实例注入。
 */
export class SubagentLimiter {
  private readonly globalSemaphore: AsyncSemaphore;
  private readonly perRunMaxConcurrency: number;
  private readonly perRunMaxTotal: number;
  private readonly runs = new Map<string, RunEntry>();

  constructor(options: SubagentLimiterOptions = {}) {
    this.globalSemaphore = new AsyncSemaphore(options.globalMaxConcurrency ?? SUBAGENT_GLOBAL_MAX_CONCURRENCY);
    this.perRunMaxConcurrency = options.perRunMaxConcurrency ?? SUBAGENT_PER_RUN_MAX_CONCURRENCY;
    this.perRunMaxTotal = options.perRunMaxTotal ?? SUBAGENT_PER_RUN_MAX_TOTAL;
  }

  /**
   * 占用一个子 agent 槽位：
   *   - 单 run 总数超限 → 立即抛 SubagentLimitError（硬拒绝，不排队）
   *   - 全局 / 单 run 并发满 → 排队等待（受 signal 中断）
   * 返回的 slot.release() 只释放并发占用，总数计数不回退（spawn 即消耗配额）。
   */
  async acquire(parentRunId: string, signal?: AbortSignal): Promise<SubagentSlot> {
    const entry = this.ensureRunEntry(parentRunId);
    if (entry.total >= this.perRunMaxTotal) {
      throw new SubagentLimitError(
        `本次运行的子 agent 总数已达上限 ${this.perRunMaxTotal}，不能再派生。请合并剩余子任务或直接自己完成。`,
      );
    }
    // 先占总数名额（并行 fan-out 段里第 11 个调用应立即被拒，而不是排队后才发现超额）
    entry.total += 1;
    try {
      await this.globalSemaphore.acquire(signal);
    } catch (err) {
      entry.total -= 1;
      throw err;
    }
    try {
      await entry.semaphore.acquire(signal);
    } catch (err) {
      entry.total -= 1;
      this.globalSemaphore.release();
      throw err;
    }
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        entry.semaphore.release();
        this.globalSemaphore.release();
      },
    };
  }

  /** 观测用：当前全局活跃子 agent 数。 */
  get globalActiveCount(): number {
    return this.globalSemaphore.activeCount;
  }

  /** 观测用：某父 run 已派生的子 agent 总数。 */
  runTotal(parentRunId: string): number {
    return this.runs.get(parentRunId)?.total ?? 0;
  }

  private ensureRunEntry(parentRunId: string): RunEntry {
    let entry = this.runs.get(parentRunId);
    if (!entry) {
      this.pruneIfNeeded();
      entry = { total: 0, semaphore: new AsyncSemaphore(this.perRunMaxConcurrency) };
      this.runs.set(parentRunId, entry);
    }
    return entry;
  }

  /**
   * 总数计数必须存活整个父 run（防「拆多轮 spawn 绕过总数闸」），所以不能在
   * release 时清条目；用水位触发的惰性回收兜底：仅回收「无活跃占用」的旧条目。
   * 已结束的 run 不会再 acquire，其 total 丢失无害。
   */
  private pruneIfNeeded(): void {
    if (this.runs.size < RUN_ENTRY_PRUNE_THRESHOLD) return;
    for (const [runId, entry] of this.runs) {
      if (entry.semaphore.activeCount === 0) this.runs.delete(runId);
      if (this.runs.size < RUN_ENTRY_PRUNE_THRESHOLD / 2) break;
    }
  }
}

/** 进程级共享限额器（生产装配点唯一实例）。 */
export const sharedSubagentLimiter = new SubagentLimiter();
