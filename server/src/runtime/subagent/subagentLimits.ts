/**
 * 子 agent 防失控限额（D6，2026-07-06）——全部硬机制，不靠 prompt 自觉。
 *
 * 三层闸门（依据见方案 D6 表格）：
 *   - Runtime Worker 进程并发 30：跨用户、会话和 run 的共享背压，满额时排队而非拒绝。
 *   - 单 run 并发 6：防单个任务独占 Worker；drainToolCalls 的并行窗靠这个信号量排队。
 *   - 硬超时 60min + maxTurns 200：给复杂调研/执行任务充分空间；上下文阈值与
 *     工具失败熔断由 RawAgentLoop 独立治理，超时 = terminate + status:timeout。
 *
 * 不限制单 run 累计派生次数：累计次数与瞬时资源压力无关，长任务可以分批派生。
 *
 * 限额值会动态渲染进 Agent 工具 description（Hermes 教训：模型看到固定文案会按
 * 默认值自我设限或幻觉能力），改这里的常量即同步改模型可见文案。
 */

export const SUBAGENT_GLOBAL_MAX_CONCURRENCY = 30;
export const SUBAGENT_PER_RUN_MAX_CONCURRENCY = 6;
export const SUBAGENT_HARD_TIMEOUT_MS = 60 * 60 * 1000;
export const SUBAGENT_MAX_TURNS = 200;

/** 结果截断保险丝（D5）：静态上限 24k chars，75% head + 25% tail 按行截断。 */
export const SUBAGENT_RESULT_MAX_CHARS = 24_000;

/** per-run 信号量表的清理水位：超过后回收「无活跃占用」的旧 run 条目，防 Map 无界增长。 */
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
  semaphore: AsyncSemaphore;
}

export interface SubagentSlot {
  release(): void;
}

export interface SubagentLimiterOptions {
  globalMaxConcurrency?: number;
  perRunMaxConcurrency?: number;
}

/**
 * 进程级限额器。生产用模块底部的共享单例（限额语义是「本 Runtime Worker 进程」级）；
 * 测试可 new 独立实例注入。
 */
export class SubagentLimiter {
  private readonly globalSemaphore: AsyncSemaphore;
  private readonly perRunMaxConcurrency: number;
  private readonly runs = new Map<string, RunEntry>();

  constructor(options: SubagentLimiterOptions = {}) {
    this.globalSemaphore = new AsyncSemaphore(options.globalMaxConcurrency ?? SUBAGENT_GLOBAL_MAX_CONCURRENCY);
    this.perRunMaxConcurrency = options.perRunMaxConcurrency ?? SUBAGENT_PER_RUN_MAX_CONCURRENCY;
  }

  /**
   * 占用一个子 agent 并发槽位：进程 / 单 run 并发满时排队等待（受 signal 中断）。
   * 不限制累计派生次数，slot.release() 只释放本次并发占用。
   */
  async acquire(parentRunId: string, signal?: AbortSignal): Promise<SubagentSlot> {
    const entry = this.ensureRunEntry(parentRunId);
    await entry.semaphore.acquire(signal);
    try {
      await this.globalSemaphore.acquire(signal);
    } catch (err) {
      entry.semaphore.release();
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

  private ensureRunEntry(parentRunId: string): RunEntry {
    let entry = this.runs.get(parentRunId);
    if (!entry) {
      this.pruneIfNeeded();
      entry = { semaphore: new AsyncSemaphore(this.perRunMaxConcurrency) };
      this.runs.set(parentRunId, entry);
    }
    return entry;
  }

  /** 惰性回收无活跃占用的旧 run 信号量，防 Map 无界增长。 */
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
