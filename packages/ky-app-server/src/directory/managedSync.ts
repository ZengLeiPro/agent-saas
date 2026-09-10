import type { DirectoryClient, DirectorySyncResult } from './client.js';

/** 常驻服务的兜底周期。正常变更可由平台通知提前触发，轮询只负责自愈。 */
export const DIRECTORY_SYNC_INTERVAL_MS = 5 * 60 * 1000;
export const DIRECTORY_SYNC_RETRY_BASE_MS = 5_000;
export const DIRECTORY_SYNC_RETRY_MAX_MS = 5 * 60 * 1000;

export type DirectorySyncReason = 'startup' | 'notification' | 'interval' | 'retry' | 'manual';

export interface DirectorySyncCoordinator {
  /** 返回 false 表示另一实例持有租约，本实例不执行。 */
  runExclusive(run: () => Promise<void>): Promise<boolean>;
}

export interface ManagedDirectorySyncLogger {
  info?(message: string): void;
  warn?(message: string): void;
}

export interface ManagedDirectorySyncStatus {
  started: boolean;
  syncing: boolean;
  consecutiveFailures: number;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastResult: DirectorySyncResult | null;
  lastError: string | null;
}

export interface ManagedDirectorySyncOptions {
  client: Pick<DirectoryClient, 'sync'>;
  coordinator?: DirectorySyncCoordinator;
  intervalMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** 周期抖动比例，默认 10%；测试可设为 0。 */
  jitterRatio?: number;
  now?: () => number;
  random?: () => number;
  logger?: ManagedDirectorySyncLogger;
  schedule?: (run: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearSchedule?: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface ManagedDirectorySync {
  /** 非阻塞启动；首轮同步立即在后台执行，不拖慢业务服务监听。 */
  start(): void;
  /** 请求尽快同步；并发请求会合并为当前轮结束后的至多一轮补跑。 */
  trigger(reason?: DirectorySyncReason): void;
  /** 停止后不再调度新任务，并等待正在执行的一轮结束。 */
  stop(): Promise<void>;
  status(): ManagedDirectorySyncStatus;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createManagedDirectorySync(
  options: ManagedDirectorySyncOptions,
): ManagedDirectorySync {
  const intervalMs = options.intervalMs ?? DIRECTORY_SYNC_INTERVAL_MS;
  const retryBaseMs = options.retryBaseMs ?? DIRECTORY_SYNC_RETRY_BASE_MS;
  const retryMaxMs = options.retryMaxMs ?? DIRECTORY_SYNC_RETRY_MAX_MS;
  const jitterRatio = options.jitterRatio ?? 0.1;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('intervalMs 必须大于 0');
  if (!Number.isFinite(retryBaseMs) || retryBaseMs <= 0) throw new Error('retryBaseMs 必须大于 0');
  if (!Number.isFinite(retryMaxMs) || retryMaxMs < retryBaseMs)
    throw new Error('retryMaxMs 必须不小于 retryBaseMs');
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 0.5)
    throw new Error('jitterRatio 必须在 0 到 0.5 之间');

  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const schedule = options.schedule ?? ((run, delay) => setTimeout(run, delay));
  const clearSchedule = options.clearSchedule ?? clearTimeout;
  const coordinator: DirectorySyncCoordinator = options.coordinator ?? {
    runExclusive: async (run) => {
      await run();
      return true;
    },
  };

  let started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | null = null;
  let rerun = false;
  let consecutiveFailures = 0;
  let lastAttemptAt: number | null = null;
  let lastSuccessAt: number | null = null;
  let lastResult: DirectorySyncResult | null = null;
  let lastError: string | null = null;

  function clearTimer(): void {
    if (timer === undefined) return;
    clearSchedule(timer);
    timer = undefined;
  }

  function nextInterval(): number {
    const spread = intervalMs * jitterRatio;
    return Math.max(1, Math.round(intervalMs - spread + random() * spread * 2));
  }

  function retryDelay(): number {
    const exponent = Math.max(0, consecutiveFailures - 1);
    return Math.min(retryBaseMs * 2 ** Math.min(exponent, 16), retryMaxMs);
  }

  function arm(reason: 'interval' | 'retry', delayMs: number): void {
    if (!started) return;
    clearTimer();
    timer = schedule(() => {
      timer = undefined;
      trigger(reason);
    }, delayMs);
    timer.unref?.();
  }

  async function execute(reason: DirectorySyncReason): Promise<void> {
    lastAttemptAt = now();
    let ran = false;
    try {
      ran = await coordinator.runExclusive(async () => {
        lastResult = await options.client.sync();
      });
      if (ran) {
        consecutiveFailures = 0;
        lastSuccessAt = now();
        lastError = null;
        options.logger?.info?.(
          `KY App 目录同步完成（${reason}，${lastResult?.status ?? 'unknown'}）`,
        );
      }
    } catch (error) {
      consecutiveFailures += 1;
      lastError = errorMessage(error);
      options.logger?.warn?.(`KY App 目录同步失败（${reason}）：${lastError}`);
    }

    if (!started) return;
    if (rerun) return;
    arm(
      consecutiveFailures > 0 ? 'retry' : 'interval',
      consecutiveFailures > 0 ? retryDelay() : nextInterval(),
    );
  }

  function trigger(reason: DirectorySyncReason = 'notification'): void {
    if (!started) return;
    clearTimer();
    if (inFlight !== null) {
      rerun = true;
      return;
    }
    const task = execute(reason);
    inFlight = task;
    void task.finally(() => {
      if (inFlight !== task) return;
      inFlight = null;
      if (started && rerun) {
        rerun = false;
        trigger('notification');
      }
    });
  }

  return {
    start(): void {
      if (started) return;
      started = true;
      trigger('startup');
    },
    trigger,
    async stop(): Promise<void> {
      started = false;
      rerun = false;
      clearTimer();
      await inFlight;
    },
    status(): ManagedDirectorySyncStatus {
      return {
        started,
        syncing: inFlight !== null,
        consecutiveFailures,
        lastAttemptAt,
        lastSuccessAt,
        lastResult,
        lastError,
      };
    },
  };
}
