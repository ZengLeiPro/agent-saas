import { randomUUID } from 'crypto';
import { buildApprovalRecordsFromEvents } from './approvalStore.js';
import {
  isBackgroundAgentTaskRun,
  isBackgroundCommandTaskRun,
  isBackgroundTaskReady,
  isBackgroundTaskRun,
} from './background/backgroundTaskRuntime.js';
import type { MessageDeliveryMode, RunRecord, RunStatus, RunStore } from './runStore.js';
import type { RuntimeAdmissionGuard } from './memoryPressureGuard.js';
import type { EventStore, PlatformEvent } from './types.js';

const DEFAULT_APPROVAL_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const STALE_APPROVAL_REASON = 'stale_waiting_approval_timeout';
const STALE_APPROVAL_BATCH_SIZE = 50;
const STAGED_INTERACTION_RECOVERY_BATCH_SIZE = 50;
const BACKGROUND_COMMAND_START_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_MAX_CONCURRENT_RUNS = 16;
export const SCHEDULER_STATE_METADATA_KEY = 'schedulerState';
export const SCHEDULER_STATE_STAGED = 'staged';
export const SCHEDULER_STATE_READY = 'ready';

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
  foregroundReservedRuns?: number;
  executionEnabled?: boolean;
  /** 从共享配置源刷新顶层并发；失败时保留当前值，不阻断调度。 */
  resolveMaxConcurrentRuns?: () => Promise<number>;
  resolveExecutionEnabled?: () => Promise<boolean>;
  /** 仅按真实资源压力暂停领取新 run；不区分用户、租户或任务类型。 */
  admissionGuard?: RuntimeAdmissionGuard;
  approvalTimeoutMs?: number;
  autoWake?: boolean;
  /** acquire run lease 前先确认目标 session 当前没有被其他 brain 持有。 */
  canWake?: (record: RunRecord) => Promise<boolean>;
  wake?: (record: RunRecord, lease: RunLease) => Promise<void>;
  /** 每轮恢复扫描前执行 durable outbox 等轻量协调工作。 */
  beforeTick?: () => Promise<void>;
  /** expired running 后台任务禁止重放，由调用方冻结失败并生成完成通知。 */
  failInterruptedBackgroundTask?: (record: RunRecord) => Promise<void>;
  /** 后台任务在 wake 前置闸门失败时冻结结果并生成完成通知。 */
  failBackgroundTask?: (record: RunRecord, message: string) => Promise<void>;
  /** Server drain 时只交接后台命令监控，不终止 ACS 中的真实进程。 */
  handoffBackgroundCommand?: (record: RunRecord) => void | Promise<void>;
  logger?: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
}

export interface RuntimeSchedulerPerformanceSnapshot {
  maxConcurrentRuns: number;
  foregroundReservedRuns: number;
  executionEnabled: boolean;
  inFlightRuns: number;
  inFlightBackgroundRuns: number;
  oldestInFlightAgeMs: number;
  byRunClass: Record<string, number>;
  byChannel: Record<string, number>;
  byExecutionTarget: Record<string, number>;
  byModel: Record<string, number>;
}

export class RuntimeScheduler {
  private readonly workerId: string;
  private readonly pollIntervalMs: number;
  private readonly leaseMs: number;
  private maxConcurrentRuns: number;
  private readonly foregroundReservedRuns: number;
  private executionEnabled: boolean;
  private readonly approvalTimeoutMs: number;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private ticking = false;
  private tickAgainRequested = false;
  private immediateTickScheduled = false;
  private readonly inFlightRuns = new Map<string, Promise<void>>();
  private readonly inFlightRunRecords = new Map<string, RunRecord>();
  private readonly inFlightSessions = new Set<string>();
  private readonly deferredUntilByRun = new Map<string, number>();

  constructor(private readonly options: RuntimeSchedulerOptions) {
    this.workerId = options.workerId ?? `worker-${process.pid}-${randomUUID()}`;
    this.pollIntervalMs = options.pollIntervalMs ?? 10_000;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.maxConcurrentRuns = Math.max(
      1,
      Math.floor(options.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS),
    );
    this.foregroundReservedRuns = Math.max(0, Math.floor(options.foregroundReservedRuns ?? 10));
    this.executionEnabled = options.executionEnabled ?? true;
    this.approvalTimeoutMs = Math.max(0, Math.floor(options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS));
  }

  getCapacitySnapshot(): {
    maxConcurrentRuns: number;
    foregroundReservedRuns: number;
    executionEnabled: boolean;
    inFlightRuns: number;
    inFlightBackgroundRuns: number;
  } {
    return {
      maxConcurrentRuns: this.maxConcurrentRuns,
      foregroundReservedRuns: Math.min(this.foregroundReservedRuns, Math.max(0, this.maxConcurrentRuns - 1)),
      executionEnabled: this.executionEnabled,
      inFlightRuns: this.inFlightRuns.size,
      inFlightBackgroundRuns: [...this.inFlightRunRecords.values()]
        .filter((record) => isBackgroundTaskRun(record)).length,
    };
  }

  getPerformanceSnapshot(nowMs = Date.now()): RuntimeSchedulerPerformanceSnapshot {
    const records = [...this.inFlightRunRecords.values()];
    const ages = records.map((record) => {
      const startedAtMs = Date.parse(record.startedAt ?? record.requestedAt);
      return Number.isFinite(startedAtMs) ? Math.max(0, nowMs - startedAtMs) : 0;
    });
    return {
      maxConcurrentRuns: this.maxConcurrentRuns,
      foregroundReservedRuns: Math.min(this.foregroundReservedRuns, Math.max(0, this.maxConcurrentRuns - 1)),
      executionEnabled: this.executionEnabled,
      inFlightRuns: this.inFlightRuns.size,
      inFlightBackgroundRuns: records.filter((record) => isBackgroundTaskRun(record)).length,
      oldestInFlightAgeMs: ages.length > 0 ? Math.max(...ages) : 0,
      byRunClass: countRecords(records, classifyRun),
      byChannel: countRecords(records, (record) => record.channel || 'unknown'),
      byExecutionTarget: countRecords(records, (record) => record.executionTarget || 'unknown'),
      byModel: countRecords(records, (record) => record.model || 'unknown'),
    };
  }

  updateMaxConcurrentRuns(value: number): void {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error('maxConcurrentRuns 必须是正整数');
    }
    if (value === this.maxConcurrentRuns) return;
    this.maxConcurrentRuns = value;
    this.options.logger?.info(`Runtime scheduler concurrency updated: maxConcurrentRuns=${value}`);
    this.scheduleImmediateTick('capacity-updated');
  }

  updateExecutionEnabled(enabled: boolean): void {
    if (enabled === this.executionEnabled) return;
    this.executionEnabled = enabled;
    this.options.logger?.info(`Runtime scheduler execution updated: enabled=${enabled}`);
    if (enabled) this.scheduleImmediateTick('maintenance-ended');
  }

  async enqueue(
    input: Parameters<RunStore['upsertPending']>[0],
    options: { steeringAware?: boolean; deliveryMode?: MessageDeliveryMode } = {},
  ): Promise<RunRecord> {
    const deliveryMode = options.deliveryMode ?? (options.steeringAware ? 'steer' : undefined);
    const record = deliveryMode && this.options.runStore.enqueueUserMessage
      ? await this.options.runStore.enqueueUserMessage(input, deliveryMode)
      : options.steeringAware && this.options.runStore.enqueueSteeringAware
        ? await this.options.runStore.enqueueSteeringAware(input)
        : await this.options.runStore.upsertPending(input);
    this.scheduleImmediateTick('enqueue');
    return record;
  }

  async enqueueCreateOnly(input: Parameters<RunStore['upsertPending']>[0]): Promise<RunRecord> {
    const createPending = this.options.runStore.createPending?.bind(this.options.runStore);
    if (!createPending) throw new Error('RunStore create-only enqueue unavailable');
    const { record } = await createPending(input);
    this.scheduleImmediateTick('enqueue-create-only');
    return record;
  }

  /**
   * Makes a create-only staged pending run visible to recovery/lease scans.
   * The RunStore CAS must return the current record when another worker already advanced it.
   */
  async activateCreatedRun(
    runId: string,
    interactionClaim?: Record<string, unknown>,
    interactionMetadataPatch?: Record<string, unknown>,
  ): Promise<RunRecord | null> {
    let activated: RunRecord | null;
    if (interactionClaim) {
      const activate = this.options.runStore.activatePersistedInteractionResume?.bind(this.options.runStore);
      if (!activate) throw new Error('RunStore staged interaction activation unavailable');
      activated = await activate(runId, interactionClaim, interactionMetadataPatch);
    } else {
      const activate = this.options.runStore.activateStagedRun?.bind(this.options.runStore);
      if (!activate) throw new Error('RunStore staged activation unavailable');
      activated = await activate(runId);
    }
    // Interaction activation is strict: null means another claimant owns (or
    // rolled back) the staged record. Do not accidentally schedule a generic
    // Taskboard staged run in that case.
    if (!activated) {
      if (interactionClaim) return null;
      throw new Error(`Runtime Run not found during activation: ${runId}`);
    }
    if (
      activated.status === 'pending'
      && activated.metadata?.[SCHEDULER_STATE_METADATA_KEY] === SCHEDULER_STATE_READY
    ) {
      this.scheduleImmediateTick('activate-created-run');
    }
    return activated;
  }

  /** Quarantines a deploy-era legacy pending Taskboard Run before dispatch retry validation. */
  async stagePendingRun(runId: string): Promise<RunRecord> {
    const stagePendingRun = this.options.runStore.stagePendingRun?.bind(this.options.runStore);
    if (!stagePendingRun) throw new Error('RunStore pending staging unavailable');
    const staged = await stagePendingRun(runId);
    if (!staged) throw new Error(`Runtime Run not found during staging: ${runId}`);
    return staged;
  }

  /** Stops a poison dispatch from leaving a pending Taskboard Run executable. */
  async cancelPendingTaskboardRun(runId: string, reason: string): Promise<RunRecord | null> {
    const cancelPendingTaskboardRun = this.options.runStore.cancelPendingTaskboardRun?.bind(this.options.runStore);
    if (!cancelPendingTaskboardRun) throw new Error('RunStore pending Taskboard cancellation unavailable');
    return cancelPendingTaskboardRun(runId, reason);
  }

  async start(): Promise<void> {
    if (this.timer) return;
    this.stopped = false;
    await this.options.admissionGuard?.start();
    await this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.options.admissionGuard?.stop();
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
      for (const record of this.inFlightRunRecords.values()) {
        if (!isBackgroundCommandTaskRun(record)) continue;
        await this.options.handoffBackgroundCommand?.(record);
      }
      await Promise.race([
        Promise.allSettled([...this.inFlightRuns.values()]),
        new Promise<void>((resolve) => setTimeout(resolve, 25)),
      ]);
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
      try {
        await this.recoverStagedPersistedInteractions();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.options.logger?.error(`Runtime scheduler staged interaction recovery failed: ${message}`);
      }
      try {
        const nextMaxConcurrentRuns = await this.options.resolveMaxConcurrentRuns?.();
        if (nextMaxConcurrentRuns !== undefined) this.updateMaxConcurrentRuns(nextMaxConcurrentRuns);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.options.logger?.warn(`Runtime scheduler capacity refresh failed; keeping current value: ${message}`);
      }

      try {
        const executionEnabled = await this.options.resolveExecutionEnabled?.();
        if (executionEnabled !== undefined) this.executionEnabled = executionEnabled;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.options.logger?.warn(`Runtime scheduler maintenance refresh failed; keeping current value: ${message}`);
      }

      if (!this.executionEnabled) return;

      if (this.options.admissionGuard && !this.options.admissionGuard.canAcquire()) return;

      const recoverable = await this.options.runStore.listRecoverable();
      const recoverableRunIds = new Set(recoverable.map((record) => record.runId));
      for (const runId of this.deferredUntilByRun.keys()) {
        if (!recoverableRunIds.has(runId)) this.deferredUntilByRun.delete(runId);
      }
      let backgroundStateChanged = false;
      for (const record of recoverable) {
        if (
          record.status !== 'pending'
          || !isBackgroundCommandTaskRun(record)
          || isBackgroundTaskReady(record)
          || Date.parse(record.requestedAt) > Date.now() - BACKGROUND_COMMAND_START_TIMEOUT_MS
        ) continue;
        const message = '后台命令启动确认超时；已尝试终止可能存在的 ACS 进程';
        try {
          if (this.options.failBackgroundTask) {
            await this.options.failBackgroundTask(record, message);
          } else {
            await this.options.runStore.markStatus(record.runId, 'failed', 'background_command_start_timeout', {
              wakeState: 'pending',
            });
          }
          backgroundStateChanged = true;
        } catch (err) {
          this.options.logger?.error(
            `Failed to freeze stale background command reservation ${record.runId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      // 后台任务一旦进入 running 就可能已经产生外部副作用。lease 过期只冻结失败，
      // 不允许像普通主会话那样恢复重放；pending 后台任务仍可安全首跑。
      for (const record of recoverable) {
        if (record.status !== 'running' || !isBackgroundAgentTaskRun(record)) continue;
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
          backgroundStateChanged = true;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.options.logger?.error(`Failed to freeze interrupted background task ${record.runId}: ${message}`);
        }
      }
      if (backgroundStateChanged) this.tickAgainRequested = true;

      const availableSlots = this.maxConcurrentRuns - this.inFlightRuns.size;
      if (availableSlots <= 0) return;
      const now = Date.now();
      const pendingRecoverable = recoverable.filter((record) => {
        const deferredUntil = this.deferredUntilByRun.get(record.runId);
        if (deferredUntil !== undefined) {
          if (deferredUntil > now) return false;
          this.deferredUntilByRun.delete(record.runId);
        }
        return (
          !(record.status === 'running' && isBackgroundAgentTaskRun(record))
          && isBackgroundTaskReady(record)
        );
      });
      const selected: RunRecord[] = [];
      const selectedSessions = new Set<string>();
      for (const record of pendingRecoverable) {
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

  private async recoverStagedPersistedInteractions(): Promise<void> {
    const listStaged = this.options.runStore.listStagedPersistedInteractionResumes?.bind(this.options.runStore);
    const activate = this.options.runStore.activatePersistedInteractionResume?.bind(this.options.runStore);
    if (!listStaged || !activate) return;

    const staged = await listStaged(STAGED_INTERACTION_RECOVERY_BATCH_SIZE);
    for (const record of staged) {
      const claim = record.metadata?.persistedInteractionResumeClaim;
      if (!isPersistedInteractionResumeClaim(claim, record.sessionId)) continue;
      try {
        const events = await this.options.eventStore.list(requireTenantId(record.tenantId), record.sessionId, {
          includeTypes: ['interaction_resolved'],
        });
        const resolved = events.find((event): event is Extract<PlatformEvent, { type: 'interaction_resolved' }> => (
          event.type === 'interaction_resolved'
          && event.runId === record.runId
          && event.interactionId === claim.interactionId
          && event.interactionType === claim.interactionType
        ));
        if (!resolved) continue;
        const metadataPatch = claim.interactionType === 'approval'
          ? { resumeApproval: { approvalId: claim.interactionId, response: resolved.response } }
          : { resumeInteraction: { interactionId: claim.interactionId, response: resolved.response } };
        const activated = await activate(record.runId, claim, metadataPatch);
        if (activated?.metadata?.[SCHEDULER_STATE_METADATA_KEY] === SCHEDULER_STATE_READY) {
          this.tickAgainRequested = true;
          this.options.logger?.info(`Recovered staged interaction activation for run ${record.runId}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.options.logger?.warn(`Failed staged interaction recovery for ${record.runId}: ${message}`);
      }
    }
  }

  private async cancelStaleWaitingApprovals(): Promise<void> {
    if (this.approvalTimeoutMs <= 0) return;
    const listStale = this.options.runStore.listStaleWaitingApproval?.bind(this.options.runStore);
    const cancelStale = this.options.runStore.cancelStaleWaitingApproval?.bind(this.options.runStore);
    if (!listStale || !cancelStale) return;

    const cutoff = new Date(Date.now() - this.approvalTimeoutMs);
    const staleRuns = await listStale(cutoff, STALE_APPROVAL_BATCH_SIZE);
    for (const record of staleRuns) {
      const events = await this.options.eventStore.list(requireTenantId(record.tenantId), record.sessionId, {
        includeTypes: ['approval_requested', 'approval_resolved'],
      });
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
        }, { tenantId: requireTenantId(record.tenantId) });
      }
      await this.options.eventStore.append({
        type: 'run_cancel_requested',
        sessionId: record.sessionId,
        runId: record.runId,
        ...(record.userId ? { userId: record.userId } : {}),
        reason: STALE_APPROVAL_REASON,
      }, { tenantId: requireTenantId(record.tenantId) });
      await this.options.eventStore.append({
        type: 'run_state_changed',
        runId: record.runId,
        sessionId: record.sessionId,
        status: 'cancelled',
        previousStatus: record.status,
        reason: STALE_APPROVAL_REASON,
      }, { tenantId: requireTenantId(record.tenantId) });
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
    if (!this.executionEnabled) {
      this.deferRun(record.runId);
      return;
    }
    if (this.options.admissionGuard && !this.options.admissionGuard.canAcquire()) {
      this.deferRun(record.runId);
      return;
    }
    if (this.options.canWake && !(await this.options.canWake(record))) {
      this.deferRun(record.runId);
      this.options.logger?.info(`Deferred recoverable run ${record.runId}: session busy`);
      return;
    }
    if (this.options.admissionGuard && !this.options.admissionGuard.canAcquire()) {
      this.deferRun(record.runId);
      return;
    }

    const acquired = await this.options.runStore.acquireLease?.(
      record.runId,
      this.workerId,
      this.leaseMs,
      new Date(),
      this.maxConcurrentRuns,
      {
        foreground: classifyRun(record) === 'foreground',
        foregroundReservedRuns: this.foregroundReservedRuns,
      },
    );
    if (!acquired) {
      this.deferRun(record.runId);
      return;
    }
    const lease = this.createLease(acquired);
    await this.options.eventStore.append({
      type: 'run_lease_acquired',
      runId: acquired.runId,
      sessionId: acquired.sessionId,
      workerId: this.workerId,
      leaseExpiresAt: lease.expiresAt,
    }, { tenantId: requireTenantId(acquired.tenantId) });

    if (!this.options.autoWake || !this.options.wake) {
      await lease.release('orphaned', 'scheduler_recovery_scan');
      await this.options.eventStore.append({
        type: 'run_state_changed',
        runId: acquired.runId,
        sessionId: acquired.sessionId,
        status: 'orphaned',
        previousStatus: acquired.status,
        reason: 'scheduler_recovery_scan',
      }, { tenantId: requireTenantId(acquired.tenantId) });
      this.options.logger?.warn(`Marked recoverable run ${acquired.runId} as orphaned`);
      return;
    }

    try {
      await this.options.wake(acquired, lease);
      this.deferredUntilByRun.delete(acquired.runId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('已被另一个 brain 持有')) {
        // 蓝绿交接期间旧实例可能仍在收尾同一会话。此时只释放 run lease，
        // 保持 run 可恢复，并在本实例本地退避；不能把正常交接写成永久失败。
        await lease.release(undefined, 'session_busy');
        this.deferRun(acquired.runId);
        this.options.logger?.info(`Deferred recoverable run ${acquired.runId}: session became busy`);
        return;
      }
      if (isBackgroundTaskRun(acquired) && this.options.failBackgroundTask) {
        await this.options.failBackgroundTask(acquired, message).catch((freezeErr) => {
          const freezeMessage = freezeErr instanceof Error ? freezeErr.message : String(freezeErr);
          this.options.logger?.error(`Failed to freeze background task ${acquired.runId}: ${freezeMessage}`);
        });
      }
      await lease.release('failed', message);
      const terminalized = await this.options.runStore.get(acquired.runId);
      if (terminalized?.status !== 'failed') {
        if (terminalized && !['completed', 'cancelled', 'orphaned'].includes(terminalized.status)) {
          this.deferRun(acquired.runId, Math.max(30_000, this.pollIntervalMs * 5));
        }
        this.options.logger?.error(
          `Runtime scheduler wake terminalization failed for ${acquired.runId}: current=${terminalized?.status ?? 'missing'} reason=${message}`,
        );
        return;
      }
      await this.options.eventStore.append({
        type: 'run_state_changed',
        runId: acquired.runId,
        sessionId: acquired.sessionId,
        status: 'failed',
        previousStatus: acquired.status,
        reason: message,
      }, { tenantId: requireTenantId(acquired.tenantId) });
      this.deferredUntilByRun.delete(acquired.runId);
      this.options.logger?.error(`Runtime scheduler wake failed for ${acquired.runId}: ${message}`);
    }
  }

  private deferRun(runId: string, delayMs = this.pollIntervalMs): void {
    this.deferredUntilByRun.set(runId, Date.now() + Math.max(1_000, delayMs));
  }

  private createLease(record: RunRecord): RunLease {
    let expiresAt = record.leaseExpiresAt ?? new Date(Date.now() + this.leaseMs).toISOString();
    let renewInFlight: Promise<void> | undefined;
    return {
      runId: record.runId,
      workerId: this.workerId,
      get expiresAt() {
        return expiresAt;
      },
      renew: () => {
        if (renewInFlight) return renewInFlight;
        renewInFlight = (async () => {
          const renewed = await this.options.runStore.renewLease?.(record.runId, this.workerId, this.leaseMs);
          if (!renewed) throw new Error(`failed to renew run lease: ${record.runId}`);
          expiresAt = renewed.leaseExpiresAt ?? expiresAt;
        })().finally(() => {
          renewInFlight = undefined;
        });
        return renewInFlight;
      },
      release: async (finalStatus?: RunStatus, reason?: string) => {
        await this.options.runStore.releaseLease?.(record.runId, this.workerId, finalStatus, reason);
      },
    };
  }
}

function requireTenantId(tenantId: string | undefined): string {
  if (!tenantId?.trim()) throw new Error('Runtime event tenantId is required');
  return tenantId;
}

function isPersistedInteractionResumeClaim(
  value: unknown,
  sessionId: string,
): value is Record<string, unknown> & {
  sessionId: string;
  interactionId: string;
  interactionType: 'ask_user' | 'approval';
} {
  if (!value || typeof value !== 'object') return false;
  const claim = value as Record<string, unknown>;
  return claim.sessionId === sessionId
    && typeof claim.interactionId === 'string'
    && (claim.interactionType === 'ask_user' || claim.interactionType === 'approval');
}

function classifyRun(record: RunRecord): string {
  if (isBackgroundCommandTaskRun(record)) return 'background_command';
  if (isBackgroundAgentTaskRun(record)) return 'background_agent';
  const toolProfile = record.metadata?.toolProfile;
  if (toolProfile === 'memory_poll' || toolProfile === 'memory_consolidate') return String(toolProfile);
  if (record.channel === 'cron') return 'cron';
  if (record.metadata?.taskboardExecution === true || record.metadata?.taskboardContinuation === true) return 'taskboard';
  return 'foreground';
}

function countRecords(
  records: RunRecord[],
  resolveKey: (record: RunRecord) => string,
): Record<string, number> {
  return records.reduce<Record<string, number>>((counts, record) => {
    const key = resolveKey(record);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}
