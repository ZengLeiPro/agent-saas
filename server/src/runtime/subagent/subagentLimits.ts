/**
 * 子 agent 防失控限额（D6，2026-07-06）——全部硬机制，不靠 prompt 自觉。
 *
 * 两层闸门：
 *   - 单 run 并发 10：防单个任务独占容量；跨 run 总量统一由 Runtime Scheduler 的
 *     maxConcurrentRuns 治理，不再维护一套进程级子 Agent 上限。
 *   - 硬超时 120min + maxTurns 500：给复杂调研/执行任务充分空间；上下文阈值与
 *     工具失败熔断由 RawAgentLoop 独立治理，超时 = terminate + status:timeout。
 *
 * 不限制单 run 累计派生次数：累计次数与瞬时资源压力无关，长任务可以分批派生。
 */

export const SUBAGENT_PER_RUN_MAX_CONCURRENCY = 10;
export const SUBAGENT_PER_TENANT_MAX_ACTIVE = 500;
export const SUBAGENT_HARD_TIMEOUT_MS = 120 * 60 * 1000;
export const SUBAGENT_MAX_TURNS = 500;

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

/** 简单异步信号量：acquire 超额时 FIFO 排队，支持 AbortSignal 中断等待。 */
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
  perRunMaxConcurrency?: number;
}

/** 单父 run 限额器；跨 run 总量与父槽继承资格均由 PgRunStore 的统一容量锁治理。 */
export class SubagentLimiter {
  private readonly perRunMaxConcurrency: number;
  private readonly runs = new Map<string, RunEntry>();

  constructor(options: SubagentLimiterOptions = {}) {
    this.perRunMaxConcurrency = options.perRunMaxConcurrency ?? SUBAGENT_PER_RUN_MAX_CONCURRENCY;
  }

  /** 占用一个子 agent 并发槽位；单 run 满时排队，累计派生次数不限。 */
  async acquire(parentRunId: string, signal?: AbortSignal): Promise<SubagentSlot> {
    const entry = this.ensureRunEntry(parentRunId);
    await entry.semaphore.acquire(signal);

    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        entry.semaphore.release();
      },
    };
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

/** 进程级共享单父限额器（生产装配点唯一实例）。 */
export const sharedSubagentLimiter = new SubagentLimiter();
