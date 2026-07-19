import { randomUUID } from 'crypto';
import { buildApprovalRecordsFromEvents } from './approvalStore.js';
import { isBackgroundTaskRun, isBackgroundTaskWakeRun } from './background/backgroundTaskRuntime.js';
import type { RunRecord, RunStatus, RunStore } from './runStore.js';
import type { EventStore } from './types.js';

const DEFAULT_APPROVAL_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const STALE_APPROVAL_REASON = 'stale_waiting_approval_timeout';
const STALE_APPROVAL_BATCH_SIZE = 50;

export interface RunLease {
  runId: string;
  workerId: string;
  expiresAt: string;
  renew(): Promise<void>;
  release(finalStatus?: RunStatus, reason?: string): Promise<void>;
}

export interface RuntimeSchedulerOptions {
  runStore: RunStore;
  eventStore: EventStore;
  workerId?: string;
  pollIntervalMs?: number;
  leaseMs?: number;
  maxConcurrentRuns?: number;
  /** 后台 Agent 独占上限；默认 2，始终不超过 maxConcurrentRuns。 */
  maxConcurrentBackgroundRuns?: number;
  approvalTimeoutMs?: number;
  autoWake?: boolean;
  wake?: (record: RunRecord, lease: RunLease) => Promise<void>;
  /** 每轮恢复扫描前执行 durable outbox 等轻量协调工作。 */
  beforeTick?: () => Promise<void>;
  /** expired running 后台任务禁止重放，由调用方冻结失败并生成完成通知。 */
  failInterruptedBackgroundTask?: (record: RunRecord) => Promise<void>;
  /** 后台任务在 wake 前置闸门失败时冻结结果并生成完成通知。 */
  failBackgroundTask?: (record: RunRecord, message: string) => Promise<void>;
  logger?: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
}

export class RuntimeScheduler {
  private readonly workerId: string;
  private readonly pollIntervalMs: number;
  private readonly leaseMs: number;
  private readonly maxConcurrentRuns: number;
  private readonly maxConcurrentBackgroundRuns: number;
  private readonly approvalTimeoutMs: number;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private ticking = false;
  private tickAgainRequested = false;
  private immediateTickScheduled = false;
  private readonly inFlightRuns = new Map<string, Promise<void>>();
  private readonly inFlightRunRecords = new Map<string, RunRecord>();
  private readonly inFlightSessions = new Set<string>();

  constructor(private readonly options: RuntimeSchedulerOptions) {
    this.workerId = options.workerId ?? `worker-${process.pid}-${randomUUID()}`;
    this.pollIntervalMs = options.pollIntervalMs ?? 10_000;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.maxConcurrentRuns = Math.max(1, Math.floor(options.maxConcurrentRuns ?? 4));
    this.maxConcurrentBackgroundRuns = Math.min(
      this.maxConcurrentRuns,
      Math.max(1, Math.floor(options.maxConcurrentBackgroundRuns ?? 2)),
    );
    this.approvalTimeoutMs = Math.max(0, Math.floor(options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS));
  }

  async enqueue(input: Parameters<RunStore['upsertPending']>[0]): Promise<RunRecord> {
    const record = await this.options.runStore.upsertPending(input);
    this.scheduleImmediateTick('enqueue');
    return record;
  }

  async start(): Promise<void> {
    if (this.timer) return;
    this.stopped = false;
    await this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Drain in-flight tick so caller can safely close shared PG pools
    // (pgEventStore / pgRunStore) without racing tryHandle()'s lease.release()
    // → releaseLease() chain. Without this, shutdown produces:
    //   "Cannot use a pool after calling end on the pool" unhandled rejection.
    while (this.ticking) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    while (this.inFlightRuns.size > 0) {
      await Promise.allSettled([...this.inFlightRuns.values()]);
    }
  }

  async tick(): Promise<void> {
    if (this.ticking) {
      this.tickAgainRequested = true;
      return;
    }
    this.ticking = true;
    try {
      do {
        this.tickAgainRequested = false;
        await this.tickOnce();
      } while (this.tickAgainRequested && !this.stopped);
    } finally {
      this.ticking = false;
    }
  }

  private async tickOnce(): Promise<void> {
    try {
      try {
        await this.cancelStaleWaitingApprovals();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.options.logger?.error(`Runtime scheduler stale approval cleanup failed: ${message}`);
      }
      try {
        await this.options.beforeTick?.();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.options.logger?.error(`Runtime scheduler beforeTick failed: ${message}`);
      }

      const recoverable = await this.options.runStore.listRecoverable();
      // 后台任务一旦进入 running 就可能已经产生外部副作用。lease 过期只冻结失败，
      // 不允许像普通主会话那样恢复重放；pending 后台任务仍可安全首跑。
      let interruptedFrozen = false;
      for (const record of recoverable) {
        if (record.status !== 'running' || !isBackgroundTaskRun(record)) continue;
        try {
          if (this.options.failInterruptedBackgroundTask) {
            await this.options.failInterruptedBackgroundTask(record);
          } else {
            await this.options.runStore.markStatus(
              record.runId,
              'failed',
              'background_task_interrupted_no_replay',
              { wakeState: 'pending' },
            );
          }
          interruptedFrozen = true;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.options.logger?.error(`Failed to freeze interrupted background task ${record.runId}: ${message}`);
        }
      }
      if (interruptedFrozen) this.tickAgainRequested = true;

      const availableSlots = this.maxConcurrentRuns - this.inFlightRuns.size;
      if (availableSlots <= 0) return;
      const pendingRecoverable = recoverable.filter((record) => (
        !(record.status === 'running' && isBackgroundTaskRun(record))
      ));
      // 普通/交互恢复优先；后台任务同时受总槽位和独立后台槽位约束。
      pendingRecoverable.sort((a, b) => Number(isBackgroundTaskRun(a)) - Number(isBackgroundTaskRun(b)));
      const selected: RunRecord[] = [];
      const selectedSessions = new Set<string>();
      const inFlightBackground = [...this.inFlightRunRecords.values()]
        .filter((record) => isBackgroundTaskRun(record)).length;
      let selectedBackground = 0;
      for (const record of pendingRecoverable) {
        if (selected.length >= availableSlots) break;
        if (this.inFlightSessions.has(record.sessionId)) continue;
        if (selectedSessions.has(record.sessionId)) continue;
        if (isBackgroundTaskRun(record)
          && inFlightBackground + selectedBackground >= this.maxConcurrentBackgroundRuns) continue;
        selected.push(record);
        selectedSessions.add(record.sessionId);
        if (isBackgroundTaskRun(record)) selectedBackground += 1;
      }

      for (const record of selected) {
        this.launch(record);
      }
    } finally {
      this.immediateTickScheduled = false;
    }
  }

  private scheduleImmediateTick(reason: string): void {
    if (this.stopped) return;
    if (this.ticking) {
      this.tickAgainRequested = true;
      return;
    }
    if (this.immediateTickScheduled) return;
    this.immediateTickScheduled = true;
    const timer = setTimeout(() => {
      if (this.stopped) {
        this.immediateTickScheduled = false;
        return;
      }
      void this.tick().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.options.logger?.error(`Runtime scheduler immediate tick failed (${reason}): ${message}`);
      });
    }, 0);
    timer.unref?.();
  }

  private async cancelStaleWaitingApprovals(): Promise<void> {
    if (this.approvalTimeoutMs <= 0) return;
    const listStale = this.options.runStore.listStaleWaitingApproval?.bind(this.options.runStore);
    const cancelStale = this.options.runStore.cancelStaleWaitingApproval?.bind(this.options.runStore);
    if (!listStale || !cancelStale) return;

    const cutoff = new Date(Date.now() - this.approvalTimeoutMs);
    const staleRuns = await listStale(cutoff, STALE_APPROVAL_BATCH_SIZE);
    for (const record of staleRuns) {
      const events = await this.options.eventStore.list(record.sessionId);
      const pendingApprovals = buildApprovalRecordsFromEvents(events, record.sessionId)
        .filter((approval) => approval.runId === record.runId && approval.status === 'pending');
      const cancelled = await cancelStale(record.runId, cutoff, STALE_APPROVAL_REASON, {
        staleApprovalTimeoutMs: this.approvalTimeoutMs,
        staleApprovalCancelledAt: new Date().toISOString(),
      });
      if (!cancelled) continue;

      for (const approval of pendingApprovals) {
        await this.options.eventStore.append({
          type: 'approval_resolved',
          runId: record.runId,
          sessionId: record.sessionId,
          approvalId: approval.id,
          decision: 'rejected',
          message: STALE_APPROVAL_REASON,
        }, { tenantId: record.tenantId });
      }
      await this.options.eventStore.append({
        type: 'run_cancel_requested',
        sessionId: record.sessionId,
        runId: record.runId,
        ...(record.userId ? { userId: record.userId } : {}),
        reason: STALE_APPROVAL_REASON,
      }, { tenantId: record.tenantId });
      await this.options.eventStore.append({
        type: 'run_state_changed',
        runId: record.runId,
        sessionId: record.sessionId,
        status: 'cancelled',
        previousStatus: record.status,
        reason: STALE_APPROVAL_REASON,
      }, { tenantId: record.tenantId });
      this.options.logger?.warn(`Cancelled stale waiting_approval run ${record.runId}`);
    }
  }

  private launch(record: RunRecord): void {
    this.inFlightSessions.add(record.sessionId);
    this.inFlightRunRecords.set(record.runId, record);
    const task = this.tryHandle(record)
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.options.logger?.error(`Runtime scheduler failed before wake for ${record.runId}: ${message}`);
      })
      .finally(() => {
        this.inFlightRuns.delete(record.runId);
        this.inFlightRunRecords.delete(record.runId);
        this.inFlightSessions.delete(record.sessionId);
        // 后台任务终态会生成 outbox；尽快再 tick 一轮完成父会话 wake 入队。
        this.scheduleImmediateTick('run-finished');
      });
    this.inFlightRuns.set(record.runId, task);
  }

  private async tryHandle(record: RunRecord): Promise<void> {
    const acquired = await this.options.runStore.acquireLease?.(record.runId, this.workerId, this.leaseMs);
    if (!acquired) return;
    const lease = this.createLease(acquired);
    await this.options.eventStore.append({
      type: 'run_lease_acquired',
      runId: acquired.runId,
      sessionId: acquired.sessionId,
      workerId: this.workerId,
      leaseExpiresAt: lease.expiresAt,
    }, { tenantId: acquired.tenantId });

    if (!this.options.autoWake || !this.options.wake) {
      await lease.release('orphaned', 'scheduler_recovery_scan');
      await this.options.eventStore.append({
        type: 'run_state_changed',
        runId: acquired.runId,
        sessionId: acquired.sessionId,
        status: 'orphaned',
        previousStatus: acquired.status,
        reason: 'scheduler_recovery_scan',
      }, { tenantId: acquired.tenantId });
      this.options.logger?.warn(`Marked recoverable run ${acquired.runId} as orphaned`);
      return;
    }

    try {
      await this.options.wake(acquired, lease);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isBackgroundTaskWakeRun(acquired) && message.includes('已被另一个 brain 持有')) {
        // 父会话仍在另一实例收尾时，不把 durable 完成通知打成永久失败。
        // 清 lease 后短退避，随后由正常恢复扫描重试同一 wake runId。
        await lease.release(undefined, 'background_wake_parent_busy');
        await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
        this.options.logger?.warn(`Deferred background wake ${acquired.runId}: parent session busy`);
        return;
      }
      if (isBackgroundTaskRun(acquired) && this.options.failBackgroundTask) {
        await this.options.failBackgroundTask(acquired, message).catch((freezeErr) => {
          const freezeMessage = freezeErr instanceof Error ? freezeErr.message : String(freezeErr);
          this.options.logger?.error(`Failed to freeze background task ${acquired.runId}: ${freezeMessage}`);
        });
      }
      await lease.release('failed', message);
      await this.options.eventStore.append({
        type: 'run_state_changed',
        runId: acquired.runId,
        sessionId: acquired.sessionId,
        status: 'failed',
        previousStatus: acquired.status,
        reason: message,
      }, { tenantId: acquired.tenantId });
      this.options.logger?.error(`Runtime scheduler wake failed for ${acquired.runId}: ${message}`);
    }
  }

  private createLease(record: RunRecord): RunLease {
    let expiresAt = record.leaseExpiresAt ?? new Date(Date.now() + this.leaseMs).toISOString();
    return {
      runId: record.runId,
      workerId: this.workerId,
      get expiresAt() {
        return expiresAt;
      },
      renew: async () => {
        const renewed = await this.options.runStore.renewLease?.(record.runId, this.workerId, this.leaseMs);
        if (!renewed) throw new Error(`failed to renew run lease: ${record.runId}`);
        expiresAt = renewed.leaseExpiresAt ?? expiresAt;
      },
      release: async (finalStatus?: RunStatus, reason?: string) => {
        await this.options.runStore.releaseLease?.(record.runId, this.workerId, finalStatus, reason);
      },
    };
  }
}
