/**
 * Cron 服务主类
 */
import { randomUUID } from "crypto";
import os from "os";
import type {
  CronJob,
  CronJobCreate,
  CronJobPatch,
  CronServiceStatus,
  CronEvent,
  CronRunLogEntry,
  CronPayload,
  CronPayloadPatch,
} from "./types.js";
import { computeJobNextRunAtMs, computeNextWakeAtMs, findDueJobs } from "./scheduler.js";
import { cronLogger } from "../utils/logger.js";
import { createCronSessionGrouper } from "./sessionGrouping.js";
import { cloneJob, isProcessAlive, pTimeout, ServiceTimeoutError, toFiniteInt, transferCronJobOwner, updatedAtAfterEdit } from "./serviceUtils.js";
import { claimCronJob, markCronClaimRunning, recoverCronClaim,
  type ClaimedJob, type CronRunLease, type CronRunRequest, type ExecutionInvocation,
} from "./executionClaim.js";
export type { CronRunLease } from "./executionClaim.js";
import { cancelCronRun, cancelLinkedRuntime, isRuntimeTerminal, recoverOrphanCronClaims, runtimeResult,
  settleExplicitCancellation, waitForRuntimeTerminal, type CronLinkedRuntimeRun,
  type CronRuntimeLinkDeps,
} from "./runtimeLink.js";

const MAX_TIMEOUT_MS = 2147483647;
const STORE_RELOAD_INTERVAL_MS = 1_500;
const WATCHDOG_INTERVAL_MS = 60_000;
const WATCHDOG_OVERTIME_MS = 180_000;  // 超过硬超时后的额外容忍时间
const WATCHDOG_FALLBACK_TIMEOUT_MS = 6 * 3600_000;  // 无超时任务的兜底: 6h

/** CronSchedule 内容等价判断（applySystemJobs drift 检测用）。 */
function isSameCronSchedule(a: CronJob['schedule'], b: CronJob['schedule']): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'cron' && b.kind === 'cron') return a.expr === b.expr && (a.tz ?? '') === (b.tz ?? '');
  if (a.kind === 'every' && b.kind === 'every') return a.everyMs === b.everyMs && (a.anchorMs ?? 0) === (b.anchorMs ?? 0);
  if (a.kind === 'at' && b.kind === 'at') return a.atMs === b.atMs;
  return false;
}

function mergeCronPayload(current: CronPayload, patch: CronPayloadPatch): CronPayload {
  if (patch.kind === "agentTurn" && patch.message !== undefined) {
    return {
      kind: "agentTurn",
      message: patch.message.trim(),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.maxTurns !== undefined ? { maxTurns: patch.maxTurns } : {}),
      ...(patch.timeoutSeconds !== undefined ? { timeoutSeconds: patch.timeoutSeconds } : {}),
      ...(patch.context !== undefined ? { context: patch.context } : {}),
    };
  }

  if (patch.kind === "systemEvent" && patch.text !== undefined) {
    return {
      kind: "systemEvent",
      text: patch.text.trim(),
    };
  }

  const targetKind = patch.kind ?? current.kind;
  if (targetKind !== current.kind) {
    throw new Error("Partial payload update cannot change payload.kind; provide a complete payload");
  }

  if (current.kind === "agentTurn") {
    const next = patch as Extract<CronPayloadPatch, { kind?: "agentTurn" }>;
    return {
      ...current,
      ...next,
      kind: "agentTurn",
      ...(next.message !== undefined ? { message: next.message.trim() } : {}),
    };
  }

  const next = patch as Extract<CronPayloadPatch, { kind?: "systemEvent" }>;
  if ("model" in next || "message" in next || "maxTurns" in next || "timeoutSeconds" in next || "context" in next) {
    throw new Error("systemEvent payload only supports text updates");
  }
  return {
    ...current,
    ...next,
    kind: "systemEvent",
    ...(next.text !== undefined ? { text: next.text.trim() } : {}),
  };
}

function normalizeEverySchedule(job: Pick<CronJob, "enabled" | "schedule" | "state">, nowMs: number): boolean {
  if (job.schedule.kind !== "every") return false;

  const everyMs = Math.max(1, Math.floor(job.schedule.everyMs));
  let changed = false;

  if (job.schedule.everyMs !== everyMs) {
    job.schedule.everyMs = everyMs;
    changed = true;
  }

  if (job.schedule.anchorMs === undefined) {
    if (!job.enabled) return changed;

    const nextRunAtMs = toFiniteInt(job.state.nextRunAtMs);
    const fallbackAnchor = nextRunAtMs !== undefined ? Math.max(0, nextRunAtMs - everyMs) : nowMs;
    job.schedule.anchorMs = fallbackAnchor;
    changed = true;
  }

  return changed;
}

function normalizeStoredJob(job: CronJob, nowMs: number): boolean {
  let changed = normalizeEverySchedule(job, nowMs);

  const ownerPid = job.state.runningOwnerPid;
  const activeExecution = job.state.executionLedger?.find((record) =>
    record.runId === job.state.runningRunId);
  if (
    job.state.runningAtMs != null
    && !activeExecution
    && job.state.runningOwnerHostname === os.hostname()
    && Number.isInteger(ownerPid)
    && ownerPid! > 0
    && !isProcessAlive(ownerPid!)
  ) {
    delete job.state.runningAtMs;
    delete job.state.runningRunId;
    delete job.state.runningLeaseId;
    delete job.state.runningDeadlineAtMs;
    delete job.state.runningTimedOutAtMs;
    delete job.state.runningOwnerPid;
    delete job.state.runningOwnerHostname;
    changed = true;
  }

  // During the one-time mixed-version rollout an old process may clear the
  // known runningAtMs field while preserving the new token fields. Such an
  // orphan is not a live claim and must not block the task forever.
  if (job.state.runningAtMs == null) {
    if (job.state.runningRunId !== undefined) {
      delete job.state.runningRunId;
      changed = true;
    }
    if (job.state.runningLeaseId !== undefined) {
      delete job.state.runningLeaseId;
      changed = true;
    }
    if (job.state.runningDeadlineAtMs !== undefined) {
      delete job.state.runningDeadlineAtMs;
      changed = true;
    }
    if (job.state.runningTimedOutAtMs !== undefined) {
      delete job.state.runningTimedOutAtMs;
      changed = true;
    }
    if (job.state.runningOwnerPid !== undefined) {
      delete job.state.runningOwnerPid;
      changed = true;
    }
    if (job.state.runningOwnerHostname !== undefined) {
      delete job.state.runningOwnerHostname;
      changed = true;
    }
  }

  if (job.enabled && job.state.nextRunAtMs === undefined) {
    const nextRunAtMs = computeJobNextRunAtMs(job, nowMs);
    if (nextRunAtMs !== undefined) {
      job.state.nextRunAtMs = nextRunAtMs;
      changed = true;
    }
  }
  return changed;
}

interface MutationOutcome<T> {
  changed: boolean;
  value: T;
}

export interface CronServiceDeps extends CronRuntimeLinkDeps {
  nowMs: () => number;
  loadJobs: () => Promise<CronJob[]>;
  saveJobs: (jobs: CronJob[]) => Promise<void>;
  /**
   * 生产 Store 的跨进程 read-modify-write 事务。未提供时保留旧测试
   * harness 的单进程内存 + saveJobs 行为。
   */
  mutateJobs?: <T>(
    mutator: (jobs: CronJob[]) => T | Promise<T>,
  ) => Promise<{ jobs: CronJob[]; result: T }>;
  /** PG 模式下的任务级 session advisory lock；进程崩溃时自动释放。 */
  tryAcquireRunLease?: (jobId: string) => Promise<CronRunLease | null>;
  executeJob: (
    job: CronJob,
    hooks?: {
      onSessionId?: (sessionId: string, transcriptPath?: string) => void | Promise<void>;
      runtimeRunId?: string;
      runtimeSessionId?: string;
    },
  ) => Promise<{
    status: "ok" | "error" | "skipped";
    error?: string;
    output?: string;
    suppressNotification?: boolean;
    sessionId?: string;
    transcriptPath?: string;
    modelRef?: string;
  }>;
  appendRunLog: (entry: CronRunLogEntry) => Promise<void>;
  notify?: (args: { job: CronJob; run: CronRunLogEntry; output?: string; error?: string }) => Promise<void>;
  onSessionCreated?: (jobId: string, jobName: string, sessionId: string, owner?: string) => Promise<void>;
  onEvent?: (event: CronEvent) => void;
  defaultTimeoutSeconds?: number; resolveOwnerTenantId?: (ownerId: string) => string | undefined;
}

export class CronService {
  private deps: CronServiceDeps;
  private jobs: CronJob[] = [];
  private loaded = false;
  private loading: Promise<void> | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();
  private cacheGeneration = 0;
  private lifecycleGeneration = 0;
  private enabled = true;
  private started = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private reloadTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly executionOwnerId = `${os.hostname()}:${process.pid}:${randomUUID()}`;

  constructor(deps: CronServiceDeps) {
    this.deps = deps;
  }

  async start(): Promise<void> {
    // stop→start 可循环（cron leadership 失而复得时重启调度）：
    // stop() 置 enabled=false，armTimer 据此短路，必须先复位
    this.enabled = true;
    this.lifecycleGeneration += 1;
    await this.ensureLoaded();
    if (this.deps.mutateJobs) await this.refresh();
    await this.recoverOrphanClaims();
    this.started = true;
    this.armTimer();
    this.startHotReload();
    this.startWatchdog();
    this.emit({ type: "statusChanged", status: this.getStatus() });
    cronLogger.info("Service started");
  }

  stop(): void {
    this.enabled = false;
    this.started = false;
    this.lifecycleGeneration += 1;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.stopHotReload();
    this.stopWatchdog();
    this.emit({ type: "statusChanged", status: this.getStatus() });
    cronLogger.info("Service stopped");
  }

  getStatus(): CronServiceStatus {
    const enabledJobs = this.jobs.filter((j) => j.enabled);
    const runningJobs = this.jobs.filter((j) => j.state.runningAtMs != null);

    return {
      enabled: this.enabled,
      jobCount: this.jobs.length,
      enabledJobCount: enabledJobs.length,
      nextWakeAtMs: computeNextWakeAtMs(this.jobs),
      runningJobId: runningJobs[0]?.id,
      runningJobIds: runningJobs.length > 0 ? runningJobs.map((j) => j.id) : undefined,
    };
  }

  /** 刷新生产 Store 快照；供同步路由在读取 getStatus() 前显式冷读。 */
  async refresh(): Promise<void> {
    await this.ensureLoaded();
    if (!this.deps.mutateJobs) return;

    const generation = this.cacheGeneration;
    const jobs = await this.deps.loadJobs();
    // A refresh started before a local transaction must not overwrite that
    // transaction's newer committed snapshot when its read finishes late.
    if (generation !== this.cacheGeneration) return;

    const nowMs = this.deps.nowMs();
    if (jobs.some((job) => normalizeStoredJob(job, nowMs))) {
      const repair = await this.mutate((currentJobs): MutationOutcome<boolean> => {
        let changed = false;
        for (const job of currentJobs) {
          if (normalizeStoredJob(job, nowMs)) changed = true;
        }
        return { changed, value: changed };
      });
      if (repair.changed) this.afterJobsChanged();
      return;
    }

    const before = this.statusFingerprint();
    this.replaceJobs(jobs);
    this.armTimer();
    if (before !== this.statusFingerprint()) {
      this.emit({ type: "statusChanged", status: this.getStatus() });
    }
  }

  async list(opts?: { includeDisabled?: boolean }): Promise<CronJob[]> {
    await this.ensureLoaded();
    if (this.deps.mutateJobs) await this.refresh();
    if (opts?.includeDisabled) return [...this.jobs];
    return this.jobs.filter((j) => j.enabled);
  }

  async get(id: string): Promise<CronJob | undefined> {
    await this.ensureLoaded();
    if (this.deps.mutateJobs) await this.refresh();
    return this.jobs.find((j) => j.id === id);
  }

  /**
   * 平台内部通道：注入/更新系统任务（memory_poll reconcile 用；2026-07-14 批次）。
   * 不走用户 API 的 CronJobCreate 校验——只有平台装配层能调用，携带完整
   * CronJob（含 systemKind）。toUpdate 支持三类变更：
   *   - enabled 切换（启/停）
   *   - schedule/timezone 迁移（配置变更后的重排，07-14 扩窗口批次）
   *   - name/description 元数据更新（本期未用；预留）
   * 保留 job.id、owner、payload、state（除 nextRunAtMs），不覆盖运行态数据。
   */
  async applySystemJobs(
    plan: { toCreate: CronJob[]; toUpdate: CronJob[] },
    options?: { fence?: () => boolean },
  ): Promise<void> {
    const nowMs = this.deps.nowMs();
    const outcome = await this.mutate((jobs): MutationOutcome<string[]> => {
      if (options?.fence && !options.fence()) {
        return { changed: false, value: [] };
      }
      let changed = false;
      const messages: string[] = [];
      for (const job of plan.toCreate) {
        if (!job.systemKind) continue;
        if (jobs.some((existing) =>
          existing.id === job.id
          || (existing.systemKind === job.systemKind && existing.owner === job.owner)
        )) continue;
        const next = cloneJob(job);
        if (next.enabled) next.state.nextRunAtMs = computeJobNextRunAtMs(next, nowMs);
        jobs.push(next);
        changed = true;
        messages.push(`System job created: ${next.name} (${next.id}) owner=${next.owner}`);
      }
      for (const update of plan.toUpdate) {
        const job = jobs.find((j) => j.id === update.id);
        if (!job || !job.systemKind) continue;
        if (update.updatedAtMs <= job.updatedAtMs) continue;
        const scheduleChanged = !isSameCronSchedule(job.schedule, update.schedule);
        const enabledChanged = job.enabled !== update.enabled;
        if (!scheduleChanged && !enabledChanged) continue;
        if (scheduleChanged) job.schedule = cloneJob(update).schedule;
        if (enabledChanged) job.enabled = update.enabled;
        job.updatedAtMs = updatedAtAfterEdit(job, update.updatedAtMs ?? nowMs);
        if (job.enabled) {
          job.state.nextRunAtMs = computeJobNextRunAtMs(job, nowMs);
        } else {
          delete job.state.nextRunAtMs;
        }
        changed = true;
        if (scheduleChanged) {
          const expr = update.schedule.kind === 'cron' ? update.schedule.expr : `${update.schedule.kind}`;
          messages.push(`System job rescheduled: ${job.name} (${job.id}) owner=${job.owner} → ${expr}`);
        } else {
          messages.push(`System job ${job.enabled ? 'enabled' : 'disabled'}: ${job.name} (${job.id}) owner=${job.owner}`);
        }
      }
      return { changed, value: messages };
    });

    for (const message of outcome.value) cronLogger.info(message);
    if (outcome.changed) this.afterJobsChanged();
  }

  async add(create: CronJobCreate, context?: { owner?: string; ownerName?: string; orgAgentId?: string }): Promise<CronJob> {
    const nowMs = this.deps.nowMs();
    const createdEnabled = create.enabled ?? true;
    const schedule =
      create.schedule.kind === "every"
        ? {
            ...create.schedule,
            // For kind=every, anchor must be stable to avoid drift. If anchorMs is omitted:
            // - enabled jobs: anchor at creation time
            // - disabled jobs: keep it empty; will be set when enabling later
            anchorMs: create.schedule.anchorMs ?? (createdEnabled ? nowMs : undefined),
          }
        : create.schedule;
    const job: CronJob = {
      id: randomUUID(),
      name: create.name.trim(),
      description: create.description?.trim() || undefined,
      enabled: createdEnabled,
      schedule,
      payload: create.payload,
      notify: create.notify,
      owner: context?.owner,
      ownerName: context?.ownerName, orgAgentId: context?.orgAgentId,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      state: {},
    };

    if (job.enabled) {
      job.state.nextRunAtMs = computeJobNextRunAtMs(job, nowMs);
    }

    const outcome = await this.mutate((jobs): MutationOutcome<string> => {
      jobs.push(job);
      return { changed: true, value: job.id };
    });
    this.afterJobsChanged();

    const added = this.jobs.find((candidate) => candidate.id === outcome.value) ?? job;
    cronLogger.info(`Job added: ${added.name} (${added.id})`);
    return added;
  }

  async update(id: string, patch: CronJobPatch): Promise<CronJob | undefined> {
    const nowMs = this.deps.nowMs();
    const outcome = await this.mutate((jobs): MutationOutcome<string | undefined> => {
      const job = jobs.find((j) => j.id === id);
      if (!job) return { changed: false, value: undefined };
      if (job.systemKind) {
        throw new Error("系统任务由平台管理，不能修改");
      }

      const wasEnabled = job.enabled;
      if (patch.name !== undefined) job.name = patch.name.trim();
      if (patch.description !== undefined) {
        const nextDescription = patch.description.trim();
        job.description = nextDescription || undefined;
      }
      if (patch.enabled !== undefined) job.enabled = patch.enabled;
      if (patch.schedule !== undefined) {
        if (patch.schedule.kind === "every") {
          const incomingEveryMs = Math.max(1, Math.floor(patch.schedule.everyMs));
          const existingEveryMs =
            job.schedule.kind === "every" ? Math.max(1, Math.floor(job.schedule.everyMs)) : undefined;
          const existingAnchor = job.schedule.kind === "every" ? job.schedule.anchorMs : undefined;

          const enabling = patch.enabled === true && wasEnabled === false;
          const shouldPreserveAnchor =
            !enabling &&
            existingEveryMs !== undefined &&
            existingEveryMs === incomingEveryMs &&
            typeof existingAnchor === "number" &&
            Number.isFinite(existingAnchor);

          job.schedule = {
            ...patch.schedule,
            everyMs: incomingEveryMs,
            anchorMs:
              patch.schedule.anchorMs ??
              (shouldPreserveAnchor ? existingAnchor : job.enabled ? nowMs : undefined),
          };
        } else {
          job.schedule = patch.schedule;
        }
      } else if (patch.enabled === true && wasEnabled === false && job.schedule.kind === "every") {
        job.schedule.anchorMs = job.schedule.anchorMs ?? nowMs;
      }
      if (patch.payload !== undefined) { job.payload = mergeCronPayload(job.payload, patch.payload); if (job.payload.kind === 'systemEvent') delete job.orgAgentId; }
      if (patch.notify !== undefined) job.notify = patch.notify;

      job.updatedAtMs = updatedAtAfterEdit(job, nowMs);
      if (job.enabled) {
        job.state.nextRunAtMs = computeJobNextRunAtMs(job, nowMs);
      } else {
        job.state.nextRunAtMs = undefined;
      }
      return { changed: true, value: job.id };
    });

    if (!outcome.changed || !outcome.value) return undefined;
    this.afterJobsChanged();
    const updated = this.jobs.find((job) => job.id === outcome.value);
    if (updated) cronLogger.info(`Job updated: ${updated.name} (${updated.id})`);
    return updated;
  }

  async transferOwner(id: string, expectedOwner: string, owner: string, ownerName?: string): Promise<CronJob | undefined> {
    const outcome = await this.mutate(jobs => transferCronJobOwner(jobs, {
      id, expectedOwner, owner, ownerName, nowMs: this.deps.nowMs(),
    }));
    if (!outcome.changed || !outcome.value) return undefined;
    this.afterJobsChanged();
    return this.jobs.find(job => job.id === outcome.value);
  }

  async remove(id: string): Promise<boolean> {
    const outcome = await this.mutate((jobs): MutationOutcome<{ id: string; name: string } | undefined> => {
      const index = jobs.findIndex((j) => j.id === id);
      if (index === -1) return { changed: false, value: undefined };
      const job = jobs[index];
      if (job.systemKind) throw new Error("系统任务由平台管理，不能删除");
      jobs.splice(index, 1);
      return { changed: true, value: { id: job.id, name: job.name } };
    });

    if (!outcome.changed || !outcome.value) return false;
    this.afterJobsChanged();
    cronLogger.info(`Job removed: ${outcome.value.name} (${outcome.value.id})`);
    return true;
  }

  async removeByOwners(ownerIds: Iterable<string>): Promise<number> {
    const targets = new Set(ownerIds);
    if (targets.size === 0) return 0;

    const outcome = await this.mutate((jobs): MutationOutcome<number> => {
      const before = jobs.length;
      const remaining = jobs.filter((job) => !job.owner || !targets.has(job.owner));
      const removed = before - remaining.length;
      if (removed === 0) return { changed: false, value: 0 };
      jobs.splice(0, jobs.length, ...remaining);
      return { changed: true, value: removed };
    });

    if (!outcome.changed) return 0;
    this.afterJobsChanged();
    cronLogger.info(`Removed ${outcome.value} job(s) by owner cleanup`);
    return outcome.value;
  }

  async runNow(id: string, request: CronRunRequest = {}): Promise<{
    ran: boolean; error?: string; runId?: string; requestId?: string; deduplicated?: boolean;
  }> {
    const exposeIdentity = !!request.requestId;
    const requestId = request.requestId?.trim() || randomUUID();
    const claim = await this.claimJob(id, {
      trigger: request.retryOf ? "retry" : "manual", requestId, retryOf: request.retryOf,
      parentRunId: request.parentRunId, attempt: request.attempt,
    });
    if (claim.error) return exposeIdentity
      ? { ran: false, error: claim.error, requestId } : { ran: false, error: claim.error };
    if (claim.duplicate) return exposeIdentity
      ? { ran: true, runId: claim.duplicate.runId, requestId, deduplicated: true } : { ran: true };
    void this.executeClaimedJob(claim.value!).catch((err) => {
      cronLogger.error("runNow background execution failed:", err);
    });
    return exposeIdentity ? { ran: true, runId: claim.value!.runId, requestId } : { ran: true };
  }

  async cancelRun(id: string, runId: string, reason = "explicit_cancel"): Promise<{ cancelled: boolean; error?: string }> {
    await this.ensureLoaded(); if (this.deps.mutateJobs) await this.refresh();
    return cancelCronRun(this.runtimeSettlementContext(), this.jobs, this.deps.cancelRuntimeRun, id, runId, reason);
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      const nowMs = this.deps.nowMs();
      if (this.deps.mutateJobs) {
        const transaction = await this.deps.mutateJobs((jobs) => {
          let dirty = false;
          for (const job of jobs) {
            if (normalizeStoredJob(job, nowMs)) dirty = true;
          }
          return dirty;
        });
        this.replaceJobs(transaction.jobs);
      } else {
        const jobs = await this.deps.loadJobs();
        let dirty = false;
        for (const job of jobs) {
          if (normalizeStoredJob(job, nowMs)) dirty = true;
        }
        this.replaceJobs(jobs);
        if (dirty) await this.deps.saveJobs(this.jobs);
      }
      this.loaded = true;
    })();

    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }

  private async mutate<T>(
    mutator: (jobs: CronJob[]) => MutationOutcome<T> | Promise<MutationOutcome<T>>,
  ): Promise<MutationOutcome<T>> {
    await this.ensureLoaded();

    const previous = this.mutationQueue;
    let release!: () => void;
    this.mutationQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;

    try {
      if (this.deps.mutateJobs) {
        const transaction = await this.deps.mutateJobs(mutator);
        this.replaceJobs(transaction.jobs);
        return transaction.result;
      }

      const outcome = await mutator(this.jobs);
      if (outcome.changed) await this.deps.saveJobs(this.jobs);
      return outcome;
    } finally {
      release();
    }
  }

  private replaceJobs(jobs: CronJob[]): void {
    this.jobs = jobs;
    this.cacheGeneration += 1;
  }

  private afterJobsChanged(): void {
    this.armTimer();
    this.emit({ type: "statusChanged", status: this.getStatus() });
  }

  private statusFingerprint(): string {
    const status = this.getStatus();
    return JSON.stringify(status);
  }

  private armTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (!this.enabled || !this.started) return;

    const nextAt = computeNextWakeAtMs(this.jobs);
    if (nextAt === undefined) return;

    const nowMs = this.deps.nowMs();
    const delay = Math.max(0, nextAt - nowMs);
    const clampedDelay = Math.min(delay, MAX_TIMEOUT_MS);

    this.timer = setTimeout(() => {
      this.onTimer().catch((err) => {
        cronLogger.error("Timer tick failed:", err);
      });
    }, clampedDelay);

    this.timer.unref?.();
  }

  private async onTimer(): Promise<void> {
    if (this.running || !this.enabled || !this.started) return;
    this.running = true;
    const lifecycleGeneration = this.lifecycleGeneration;

    try {
      await this.ensureLoaded();
      if (this.deps.mutateJobs) await this.refresh();
      if (!this.enabled || !this.started || lifecycleGeneration !== this.lifecycleGeneration) return;

      const nowMs = this.deps.nowMs();
      const dueJobs = findDueJobs(this.jobs, nowMs).map((job) => ({
        id: job.id, scheduledAtMs: job.state.nextRunAtMs!,
      }));
      const claims = await Promise.allSettled(dueJobs.map(({ id, scheduledAtMs }) =>
        this.claimJob(id, { trigger: "schedule", scheduledAtMs })
      ));
      for (const result of claims) {
        if (result.status !== "fulfilled" || !result.value.value) continue;
        const claim = result.value.value;
        if (!this.enabled || !this.started || lifecycleGeneration !== this.lifecycleGeneration) {
          await this.releaseClaim(claim);
          continue;
        }
        // A hanging timeoutSeconds=0 job must not hold the scheduler tick open.
        // The persisted claim prevents duplicate execution; completion/watchdog
        // re-arm scheduling independently.
        void this.executeClaimedJob(claim).catch((err) => {
          cronLogger.error("Scheduled cron execution failed:", err);
        });
      }
    } finally {
      this.running = false;
      this.armTimer();
      this.emit({ type: "statusChanged", status: this.getStatus() });
    }
  }

  private async claimJob(id: string, invocation: ExecutionInvocation) {
    const outcome = await claimCronJob({
      id, invocation, nowMs: this.deps.nowMs, ownerId: this.executionOwnerId,
      schedulerActive: () => this.enabled && this.started,
      mutate: (mutator) => this.mutate(mutator),
      tryAcquireRunLease: this.deps.tryAcquireRunLease,
      getTimeoutSeconds: (job) => this.getJobTimeoutSeconds(job),
      watchdogFallbackTimeoutMs: WATCHDOG_FALLBACK_TIMEOUT_MS,
      watchdogOvertimeMs: WATCHDOG_OVERTIME_MS, resolveOwnerTenantId: this.deps.resolveOwnerTenantId,
    });
    if (outcome.value && invocation.trigger !== "schedule") this.afterJobsChanged();
    return outcome;
  }

  private clearRunningState(job: CronJob): void {
    delete job.state.runningAtMs; delete job.state.runningRunId; delete job.state.runningLeaseId;
    delete job.state.runningDeadlineAtMs; delete job.state.runningTimedOutAtMs;
    delete job.state.runningOwnerPid; delete job.state.runningOwnerHostname;
  }
  private async releaseClaim(claim: ClaimedJob): Promise<void> {
    try {
      const outcome = await this.mutate((jobs): MutationOutcome<boolean> => {
        const job = jobs.find((candidate) => candidate.id === claim.job.id);
        if (!job || job.state.runningRunId !== claim.runId
          || job.state.runningLeaseId !== claim.leaseId) return { changed: false, value: false };
        const ledger = job.state.executionLedger;
        const index = ledger?.findIndex((record) => record.runId === claim.runId) ?? -1;
        if (index >= 0 && ledger?.[index]?.status === "claimed") ledger.splice(index, 1);
        this.clearRunningState(job);
        return { changed: true, value: true };
      });
      if (outcome.changed) this.afterJobsChanged();
    } finally {
      await claim.runLease?.release().catch(() => {});
    }
  }

  private runtimeSettlementContext() {
    return { nowMs: this.deps.nowMs, mutate: <T>(fn: (jobs: CronJob[]) => MutationOutcome<T> | Promise<MutationOutcome<T>>) => this.mutate(fn),
      afterJobsChanged: () => this.afterJobsChanged(), appendRunLog: this.deps.appendRunLog, emit: (event: CronEvent) => this.emit(event) };
  }

  private async recoverOrphanClaims(): Promise<void> {
    const candidates = this.jobs.filter((job) => job.state.runningRunId != null).map((job) => ({ id: job.id, runId: job.state.runningRunId!,
      leaseId: job.state.runningLeaseId!, ownerPid: job.state.runningOwnerPid, ownerHostname: job.state.runningOwnerHostname }));
    await recoverOrphanCronClaims({ ...this.runtimeSettlementContext(), candidates, executionOwnerId: this.executionOwnerId,
      tryAcquireRunLease: this.deps.tryAcquireRunLease, inspectRuntimeRun: this.deps.inspectRuntimeRun,
      getTimeoutSeconds: (job) => this.getJobTimeoutSeconds(job), watchdogFallbackTimeoutMs: WATCHDOG_FALLBACK_TIMEOUT_MS,
      watchdogOvertimeMs: WATCHDOG_OVERTIME_MS, executeClaimedJob: (claim) => this.executeClaimedJob(claim) });
  }

  private getJobTimeoutSeconds(job: CronJob): number {
    if (job.payload.kind === "agentTurn" && job.payload.timeoutSeconds != null) {
      return Math.max(0, Math.floor(job.payload.timeoutSeconds));
    }
    return this.deps.defaultTimeoutSeconds ?? 1800;
  }

  private async executeClaimedJob(claim: ClaimedJob): Promise<void> {
    try { await this.executeClaimedJobInternal(claim); }
    finally { await claim.runLease?.release().catch(() => {}); }
  }

  private async executeClaimedJobInternal(claim: ClaimedJob): Promise<void> {
    const { job, runId, leaseId, startedAtMs, claimedUpdatedAtMs, forced, trigger,
      scheduledAtMs, requestId, attempt, parentRunId, retryOf } = claim;
    if (!claim.recovered) this.emit({ type: "started", jobId: job.id, jobName: job.name });
    const markedRunning = await markCronClaimRunning({
      claim, nowMs: this.deps.nowMs, mutate: (mutator) => this.mutate(mutator),
    });
    if (!markedRunning) return;

    let status: "ok" | "error" | "skipped" = "ok";
    let error: string | undefined;
    let executionTimedOut = false;
    let output: string | undefined;
    let suppressNotification = false;
    let sessionId: string | undefined;
    let transcriptPath: string | undefined;
    let model: string | undefined;
    let ongoingExecution: ReturnType<CronServiceDeps["executeJob"]> | undefined;

    // session 创建后立即归组；执行器会在消费首个事件前等待该 Promise。
    const groupSession = createCronSessionGrouper(this.deps, job);
    const onSessionId = (sid: string, tp?: string): Promise<void> | undefined => {
      sessionId = sid;
      if (tp) transcriptPath = tp;
      return groupSession(sid);
    };

    try {
      const jobTimeoutSec = this.getJobTimeoutSeconds(job);
      const hardTimeoutMs = jobTimeoutSec > 0 ? (jobTimeoutSec + 60) * 1000 : 0;
      ongoingExecution = (async () => {
        const linkedRun = claim.recovered && claim.runtimeRunId && this.deps.inspectRuntimeRun
          ? await this.deps.inspectRuntimeRun(claim.runtimeRunId)
          : null;
        let result = linkedRun
          ? await waitForRuntimeTerminal(linkedRun, this.deps.inspectRuntimeRun!, this.deps.runtimeRunPollMs)
          : await this.deps.executeJob(job, {
              onSessionId,
              runtimeRunId: claim.runtimeRunId,
              runtimeSessionId: claim.sessionId,
            });
        // inspect→dispatch 之间若另一个 Runtime owner 先创建了同一 run，
        // raw dispatch 会 create-only 退让；此处回到权威 RunStore 等待同一终态。
        if (claim.recovered && claim.runtimeRunId && this.deps.inspectRuntimeRun) {
          const authoritative = await this.deps.inspectRuntimeRun(claim.runtimeRunId);
          if (authoritative) {
            result = isRuntimeTerminal(authoritative.status)
              ? runtimeResult(authoritative)
              : await waitForRuntimeTerminal(authoritative, this.deps.inspectRuntimeRun!, this.deps.runtimeRunPollMs);
          }
        }
        return result;
      })();
      const result = hardTimeoutMs > 0
        ? await pTimeout(ongoingExecution, hardTimeoutMs,
            `Service-level hard timeout after ${jobTimeoutSec + 60}s`)
        : await ongoingExecution;
      status = result.status;
      error = result.error;
      output = result.output;
      suppressNotification = result.suppressNotification === true;
      sessionId = result.sessionId ?? sessionId ?? claim.sessionId;
      transcriptPath = result.transcriptPath;
      model = result.modelRef;
    } catch (err) {
      status = "error";
      executionTimedOut = err instanceof ServiceTimeoutError;
      error = String(err);
      if (executionTimedOut && claim.runtimeRunId && claim.sessionId) {
        try {
          await cancelLinkedRuntime(claim, `cron_timeout:${runId}`, this.deps.cancelRuntimeRun);
        } catch (cancelError) {
          cronLogger.error(`Cron timeout cancellation failed; claim retained: ${job.id} (${runId})`, cancelError);
          return;
        }
      }
    }

    const endedAtMs = this.deps.nowMs();
    const durationMs = Math.max(0, endedAtMs - startedAtMs);
    type CompletionResult = { job: CronJob | undefined; suppressFinalization: boolean };
    const completion = await this.mutate((jobs): MutationOutcome<CompletionResult> => {
      const current = jobs.find((candidate) => candidate.id === job.id);
      if (!current || current.state.runningRunId !== runId
        || current.state.runningLeaseId !== leaseId) {
        return { changed: false, value: { job: current ? cloneJob(current) : undefined, suppressFinalization: true } };
      }
      const execution = current.state.executionLedger?.find((record) => record.runId === runId);
      if (!execution || execution.leaseId !== leaseId) {
        return { changed: false, value: { job: cloneJob(current), suppressFinalization: true } };
      }
      if (execution.terminalStatus) {
        this.clearRunningState(current);
        return { changed: true, value: { job: cloneJob(current), suppressFinalization: true } };
      }

      if (current.state.runningTimedOutAtMs != null && !executionTimedOut) {
        // The watchdog already finalized this run as timed out. A late executor
        // result may only release its claim; it must not overwrite the error or
        // produce a second run log, notification, or finished event.
        this.clearRunningState(current);
        return {
          changed: true,
          value: { job: cloneJob(current), suppressFinalization: true },
        };
      }

      this.clearRunningState(current);
      execution.status = "terminal";
      execution.terminalStatus = status;
      execution.endedAtMs = endedAtMs;
      current.state.lastRunAtMs = startedAtMs;
      current.state.lastStatus = status;
      current.state.lastError = error;
      current.state.lastDurationMs = durationMs;
      current.state.lastOutput = output?.substring(0, 500);

      // A user/system edit during execution owns the new enabled/schedule and
      // nextRun state. Old completion may only release its matching claim.
      if (!executionTimedOut && current.updatedAtMs === claimedUpdatedAtMs) {
        if (current.schedule.kind === "at") {
          current.state.nextRunAtMs = undefined;
          if (status === "ok") current.enabled = false;
        } else if (!forced && current.enabled) {
          current.state.nextRunAtMs = computeJobNextRunAtMs(current, endedAtMs);
        }
      }
      return {
        changed: true,
        value: { job: cloneJob(current), suppressFinalization: false },
      };
    });
    if (completion.changed) this.afterJobsChanged();
    if (completion.value.suppressFinalization) {
      cronLogger.info(`Stale cron completion suppressed: ${job.name} (${job.id})`);
      return;
    }
    model = model ?? (job.payload.kind === "agentTurn" ? job.payload.model : undefined);
    const run: CronRunLogEntry = {
      runId, startedAtMs, endedAtMs, trigger, scheduledAtMs, requestId, attempt, parentRunId, retryOf,
      jobId: job.id,
      jobName: job.name,
      status,
      error,
      sessionId,
      transcriptPath,
      model,
      durationMs,
    };
    await this.deps.appendRunLog(run);

    const notificationJob = completion.value.job ?? job;
    if (this.deps.notify && !suppressNotification) {
      await this.deps.notify({ job: notificationJob, run, output, error }).catch((e) => {
        cronLogger.error("Failed to send notification:", e);
      });
    }

    if (sessionId) await onSessionId(sessionId, transcriptPath);

    this.emit({
      type: "finished",
      jobId: job.id,
      jobName: job.name,
      status,
      error,
      durationMs,
      sessionId,
      owner: job.owner,
      output: output?.substring(0, 200),
    });

    cronLogger.info(
      `Job ${status}: ${job.name} (${job.id}) in ${durationMs}ms` +
        (error ? ` - ${error}` : "")
    );
  }

  private startHotReload(): void {
    this.stopHotReload();
    if (!this.deps.mutateJobs) return;
    this.reloadTimer = setInterval(() => {
      this.refresh().catch((err) => {
        cronLogger.error("Cron store hot reload failed:", err);
      });
    }, STORE_RELOAD_INTERVAL_MS);
    this.reloadTimer.unref?.();
  }

  private stopHotReload(): void {
    if (this.reloadTimer) {
      clearInterval(this.reloadTimer);
      this.reloadTimer = null;
    }
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    this.watchdogTimer = setInterval(() => {
      this.checkStaleJobs().catch((err) => {
        cronLogger.error("Watchdog check failed:", err);
      });
    }, WATCHDOG_INTERVAL_MS);
    this.watchdogTimer.unref?.();
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private async checkStaleJobs(): Promise<void> {
    await this.ensureLoaded();
    if (this.deps.mutateJobs) await this.refresh();
    await this.recoverOrphanClaims();

    const nowMs = this.deps.nowMs();
    const candidates = this.jobs
      .filter((job) => job.state.runningAtMs != null && job.state.runningTimedOutAtMs == null)
      .map((job) => {
        const startedAtMs = job.state.runningAtMs!;
        const fallbackDurationMs = (this.getJobTimeoutSeconds(job) * 1000 || WATCHDOG_FALLBACK_TIMEOUT_MS)
          + WATCHDOG_OVERTIME_MS;
        return {
          id: job.id, owner: job.owner, runningRunId: job.state.runningRunId, runningLeaseId: job.state.runningLeaseId,
          execution: job.state.executionLedger?.find((record) => record.runId === job.state.runningRunId),
          startedAtMs, deadlineAtMs: job.state.runningDeadlineAtMs ?? startedAtMs + fallbackDurationMs,
        };
      })
      .filter((candidate) => nowMs > candidate.deadlineAtMs);

    for (const candidate of candidates) {
      const elapsed = nowMs - candidate.startedAtMs;
      const deadlineSec = Math.round((candidate.deadlineAtMs - candidate.startedAtMs) / 1000);
      if (candidate.execution?.runtimeRunId && candidate.execution.sessionId) {
        try {
          const runtime = await this.deps.cancelRuntimeRun?.({
            runtimeRunId: candidate.execution.runtimeRunId,
            sessionId: candidate.execution.sessionId,
            reason: `cron_watchdog_timeout:${candidate.runningRunId}`, tenantId: candidate.execution.runtimeTenantId, userId: candidate.owner,
          });
          if (!this.deps.cancelRuntimeRun || !runtime || !isRuntimeTerminal(runtime.status)) {
            throw new Error(`Runtime cancellation did not converge for ${candidate.execution.runtimeRunId}`);
          }
        } catch (error) {
          cronLogger.error(`Watchdog cancellation failed; parent claim retained: ${candidate.id}`, error);
          continue;
        }
      }
      const cleanup = await this.mutate((jobs): MutationOutcome<CronJob | undefined> => {
        const job = jobs.find((current) => current.id === candidate.id);
        if (
          !job ||
          job.state.runningAtMs !== candidate.startedAtMs ||
          job.state.runningRunId !== candidate.runningRunId ||
          job.state.runningLeaseId !== candidate.runningLeaseId || job.state.runningTimedOutAtMs != null
        ) return { changed: false, value: undefined };
        const execution = job.state.executionLedger?.find((record) => record.runId === candidate.runningRunId);
        if (!execution || execution.leaseId !== candidate.runningLeaseId
          || execution.terminalStatus) return { changed: false, value: undefined };

        this.clearRunningState(job);
        job.state.lastStatus = "error";
        job.state.lastError = `Watchdog: exceeded ${deadlineSec}s deadline; linked Runtime run cancelled`;
        if (job.schedule.kind !== "at" && job.enabled) {
          job.state.nextRunAtMs = computeJobNextRunAtMs(job, nowMs);
        }
        execution.status = "terminal";
        execution.terminalStatus = "error";
        execution.endedAtMs = nowMs;
        job.state.lastDurationMs = elapsed;
        return { changed: true, value: cloneJob(job) };
      });
      if (!cleanup.changed || !cleanup.value) continue;

      const job = cleanup.value;
      cronLogger.warn(
        `Watchdog: job "${job.name}" (${job.id}) exceeded ${deadlineSec}s deadline; linked Runtime run cancelled`
      );
      const runId = candidate.runningRunId || `${candidate.startedAtMs}-watchdog`;
      const execution = candidate.execution;
      const run: CronRunLogEntry = {
        runId, startedAtMs: candidate.startedAtMs, endedAtMs: nowMs,
        trigger: execution?.trigger, scheduledAtMs: execution?.scheduledAtMs,
        requestId: execution?.requestId, attempt: execution?.attempt,
        parentRunId: execution?.parentRunId, retryOf: execution?.retryOf,
        sessionId: execution?.sessionId,
        jobId: job.id,
        jobName: job.name,
        status: "error",
        error: job.state.lastError,
        durationMs: elapsed,
      };
      await this.deps.appendRunLog(run).catch((e) => {
        cronLogger.error("Watchdog: failed to append run log:", e);
      });

      if (this.deps.notify) {
        await this.deps.notify({ job, run, error: job.state.lastError }).catch((e) => {
          cronLogger.error("Watchdog: failed to send notification:", e);
        });
      }

      this.emit({
        type: "finished",
        jobId: job.id,
        jobName: job.name,
        status: "error",
        error: job.state.lastError,
        durationMs: elapsed,
      });
      this.afterJobsChanged();
    }
  }

  private emit(event: CronEvent): void {
    this.deps.onEvent?.(event);
  }
}
