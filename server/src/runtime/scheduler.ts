import { randomUUID } from 'crypto';
import { buildApprovalRecordsFromEvents } from './approvalStore.js';
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
  approvalTimeoutMs?: number;
  autoWake?: boolean;
  wake?: (record: RunRecord, lease: RunLease) => Promise<void>;
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
  private readonly approvalTimeoutMs: number;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private ticking = false;
  private tickAgainRequested = false;
  private immediateTickScheduled = false;
  private readonly inFlightRuns = new Map<string, Promise<void>>();
  private readonly inFlightSessions = new Set<string>();

  constructor(private readonly options: RuntimeSchedulerOptions) {
    this.workerId = options.workerId ?? `worker-${process.pid}-${randomUUID()}`;
    this.pollIntervalMs = options.pollIntervalMs ?? 10_000;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.maxConcurrentRuns = Math.max(1, Math.floor(options.maxConcurrentRuns ?? 4));
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
      const availableSlots = this.maxConcurrentRuns - this.inFlightRuns.size;
      if (availableSlots <= 0) return;

      const recoverable = await this.options.runStore.listRecoverable();
      const selected: RunRecord[] = [];
      const selectedSessions = new Set<string>();
      for (const record of recoverable) {
        if (selected.length >= availableSlots) break;
        if (this.inFlightSessions.has(record.sessionId)) continue;
        if (selectedSessions.has(record.sessionId)) continue;
        selected.push(record);
        selectedSessions.add(record.sessionId);
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
    const task = this.tryHandle(record)
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.options.logger?.error(`Runtime scheduler failed before wake for ${record.runId}: ${message}`);
      })
      .finally(() => {
        this.inFlightRuns.delete(record.runId);
        this.inFlightSessions.delete(record.sessionId);
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
