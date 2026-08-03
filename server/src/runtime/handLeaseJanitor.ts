import type { HandStore } from './handStore.js';

/**
 * 2026-08-03 CPU 治理 P1：server-remote hand 记录租约巡检器。
 *
 * 背景：hands 记录 per-session 累积（生产 900+ 条 / 仅 32 个 workspace，含 29
 * 条指向已拆除的旧 WireGuard 地址），既放大 HandHealthScanner 扫描量，也让表
 * 无限增长。治理三步全部委托 `HandStore.sweepLeases`（幂等）：
 *   ① 存量无租约 → 按最后活动时间补租约（老僵尸按真实闲置自然到期）；
 *   ② 租约过期 → 标 destroyed（软删；同 session 再 dispatch 会 upsert 复活）；
 *   ③ destroyed 超保留期 → 物理清除。
 * 不做一次性批量删除——存量在租约窗口内自然收敛。
 */
export interface HandLeaseJanitorOptions {
  handStore: HandStore;
  /** 巡检间隔。默认 6h。 */
  intervalMs?: number;
  /** 启动后首跑延迟。默认 5min（避开进程启动高峰）。 */
  initialDelayMs?: number;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
}

export class HandLeaseJanitor {
  private timer: ReturnType<typeof setInterval> | undefined;
  private initialTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;
  private inFlight = false;

  constructor(private readonly options: HandLeaseJanitorOptions) {
    this.intervalMs = options.intervalMs ?? 6 * 60 * 60_000;
    this.initialDelayMs = options.initialDelayMs ?? 5 * 60_000;
  }

  start(): void {
    if (this.timer || this.initialTimer) return;
    if (!this.options.handStore.sweepLeases) {
      this.options.logger?.warn('HandLeaseJanitor: HandStore.sweepLeases is missing; janitor is a no-op');
      return;
    }
    this.initialTimer = setTimeout(() => { void this.sweepOnce(); }, this.initialDelayMs);
    this.initialTimer.unref?.();
    this.timer = setInterval(() => { void this.sweepOnce(); }, this.intervalMs);
    this.timer.unref?.();
    this.options.logger?.info(
      `HandLeaseJanitor started: intervalMs=${this.intervalMs} initialDelayMs=${this.initialDelayMs}`,
    );
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    if (this.initialTimer) { clearTimeout(this.initialTimer); this.initialTimer = undefined; }
  }

  /** Exposed for tests and ad-hoc admin sweeps. */
  async sweepOnce(): Promise<{ backfilled: number; destroyed: number; purged: number } | null> {
    if (this.inFlight) return null;
    if (!this.options.handStore.sweepLeases) return null;
    this.inFlight = true;
    try {
      const result = await this.options.handStore.sweepLeases();
      if (result.backfilled || result.destroyed || result.purged) {
        this.options.logger?.info(
          `HandLeaseJanitor: backfilled=${result.backfilled} destroyed=${result.destroyed} purged=${result.purged}`,
        );
      }
      return result;
    } catch (err) {
      this.options.logger?.warn(
        `HandLeaseJanitor sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    } finally {
      this.inFlight = false;
    }
  }
}
