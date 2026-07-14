/**
 * Cron 服务主类
 */
import { randomUUID } from "crypto";
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
import {
  computeJobNextRunAtMs,
  computeNextWakeAtMs,
  findDueJobs,
} from "./scheduler.js";
import { cronLogger } from "../utils/logger.js";

const MAX_TIMEOUT_MS = 2147483647;
const WATCHDOG_INTERVAL_MS = 60_000;
const WATCHDOG_OVERTIME_MS = 180_000;  // 超过硬超时后的额外容忍时间
const WATCHDOG_FALLBACK_TIMEOUT_MS = 6 * 3600_000;  // 无超时任务的兜底: 6h

function pTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

function toFiniteInt(n: unknown): number | undefined {
  if (typeof n !== "number") return undefined;
  if (!Number.isFinite(n)) return undefined;
  return Math.floor(n);
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

export interface CronServiceDeps {
  nowMs: () => number;
  loadJobs: () => Promise<CronJob[]>;
  saveJobs: (jobs: CronJob[]) => Promise<void>;
  executeJob: (
    job: CronJob,
    hooks?: { onSessionId?: (sessionId: string, transcriptPath?: string) => void },
  ) => Promise<{
    status: "ok" | "error" | "skipped";
    error?: string;
    output?: string;
    sessionId?: string;
    transcriptPath?: string;
    modelRef?: string;
  }>;
  appendRunLog: (entry: CronRunLogEntry) => Promise<void>;
  notify?: (args: { job: CronJob; run: CronRunLogEntry; output?: string; error?: string }) => Promise<void>;
  onSessionCreated?: (jobId: string, jobName: string, sessionId: string, owner?: string) => Promise<void>;
  onEvent?: (event: CronEvent) => void;
  defaultTimeoutSeconds?: number;
}

export class CronService {
  private deps: CronServiceDeps;
  private jobs: CronJob[] = [];
  private loaded = false;
  private enabled = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(deps: CronServiceDeps) {
    this.deps = deps;
  }

  async start(): Promise<void> {
    await this.ensureLoaded();
    this.armTimer();
    this.startWatchdog();
    this.emit({ type: "statusChanged", status: this.getStatus() });
    cronLogger.info("Service started");
  }

  stop(): void {
    this.enabled = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.stopWatchdog();
    this.emit({ type: "statusChanged", status: this.getStatus() });
    cronLogger.info("Service stopped");
  }

  getStatus(): CronServiceStatus {
    const enabledJobs = this.jobs.filter((j) => j.enabled);
    const runningJobs = this.jobs.filter((j) => j.state.runningAtMs);

    return {
      enabled: this.enabled,
      jobCount: this.jobs.length,
      enabledJobCount: enabledJobs.length,
      nextWakeAtMs: computeNextWakeAtMs(this.jobs),
      runningJobId: runningJobs[0]?.id,
      runningJobIds: runningJobs.length > 0 ? runningJobs.map((j) => j.id) : undefined,
    };
  }

  async list(opts?: { includeDisabled?: boolean }): Promise<CronJob[]> {
    await this.ensureLoaded();
    if (opts?.includeDisabled) return [...this.jobs];
    return this.jobs.filter((j) => j.enabled);
  }

  async get(id: string): Promise<CronJob | undefined> {
    await this.ensureLoaded();
    return this.jobs.find((j) => j.id === id);
  }

  /**
   * 平台内部通道：注入/更新系统任务（memory_poll reconcile 用；2026-07-14 批次）。
   * 不走用户 API 的 CronJobCreate 校验——只有平台装配层能调用，携带完整
   * CronJob（含 systemKind）。toUpdate 只应用 enabled/updatedAtMs（reconcile
   * 的唯一诉求是开/关），不覆盖 payload/schedule，避免误伤运行态字段。
   */
  async applySystemJobs(plan: { toCreate: CronJob[]; toUpdate: CronJob[] }): Promise<void> {
    await this.ensureLoaded();
    let changed = false;
    const nowMs = this.deps.nowMs();
    for (const job of plan.toCreate) {
      if (!job.systemKind) continue; // 本通道只接受系统任务
      if (this.jobs.some((j) => j.id === job.id)) continue;
      const next: CronJob = { ...job, state: { ...job.state } };
      if (next.enabled) next.state.nextRunAtMs = computeJobNextRunAtMs(next, nowMs);
      this.jobs.push(next);
      changed = true;
      cronLogger.info(`System job created: ${next.name} (${next.id}) owner=${next.owner}`);
    }
    for (const update of plan.toUpdate) {
      const job = this.jobs.find((j) => j.id === update.id);
      if (!job || !job.systemKind) continue;
      if (job.enabled === update.enabled) continue;
      job.enabled = update.enabled;
      job.updatedAtMs = update.updatedAtMs ?? nowMs;
      if (job.enabled) {
        job.state.nextRunAtMs = computeJobNextRunAtMs(job, nowMs);
      } else {
        delete job.state.nextRunAtMs;
      }
      changed = true;
      cronLogger.info(`System job ${job.enabled ? 'enabled' : 'disabled'}: ${job.name} (${job.id}) owner=${job.owner}`);
    }
    if (changed) {
      await this.persist();
      this.armTimer();
      this.emit({ type: "statusChanged", status: this.getStatus() });
    }
  }

  async add(create: CronJobCreate, context?: { owner?: string; ownerName?: string }): Promise<CronJob> {
    await this.ensureLoaded();

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
      ownerName: context?.ownerName,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      state: {},
    };

    if (job.enabled) {
      job.state.nextRunAtMs = computeJobNextRunAtMs(job, nowMs);
    }

    this.jobs.push(job);
    await this.persist();
    this.armTimer();
    this.emit({ type: "statusChanged", status: this.getStatus() });

    cronLogger.info(`Job added: ${job.name} (${job.id})`);
    return job;
  }

  async update(id: string, patch: CronJobPatch): Promise<CronJob | undefined> {
    await this.ensureLoaded();

    const job = this.jobs.find((j) => j.id === id);
    if (!job) return undefined;
    if (job.systemKind) {
      // 平台系统任务只能经 applySystemJobs（reconcile）变更——REST API 与
      // CronManage 工具路径都会命中本 guard。
      throw new Error("系统任务由平台管理，不能修改");
    }

    const nowMs = this.deps.nowMs();
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
      // Enabling a legacy kind=every job without anchor: start the interval "from now" to match prior semantics.
      job.schedule.anchorMs = job.schedule.anchorMs ?? nowMs;
    }
    if (patch.payload !== undefined) job.payload = mergeCronPayload(job.payload, patch.payload);
    if (patch.notify !== undefined) job.notify = patch.notify;

    job.updatedAtMs = nowMs;

    if (job.enabled) {
      job.state.nextRunAtMs = computeJobNextRunAtMs(job, nowMs);
    } else {
      job.state.nextRunAtMs = undefined;
    }

    await this.persist();
    this.armTimer();
    this.emit({ type: "statusChanged", status: this.getStatus() });

    cronLogger.info(`Job updated: ${job.name} (${job.id})`);
    return job;
  }

  async remove(id: string): Promise<boolean> {
    await this.ensureLoaded();

    const index = this.jobs.findIndex((j) => j.id === id);
    if (index === -1) return false;

    const job = this.jobs[index];
    if (job.systemKind) {
      throw new Error("系统任务由平台管理，不能删除");
    }
    this.jobs.splice(index, 1);
    await this.persist();
    this.armTimer();
    this.emit({ type: "statusChanged", status: this.getStatus() });

    cronLogger.info(`Job removed: ${job.name} (${job.id})`);
    return true;
  }

  async removeByOwners(ownerIds: Iterable<string>): Promise<number> {
    await this.ensureLoaded();

    const targets = new Set(ownerIds);
    if (targets.size === 0) return 0;

    const before = this.jobs.length;
    this.jobs = this.jobs.filter((job) => !job.owner || !targets.has(job.owner));
    const removed = before - this.jobs.length;
    if (removed === 0) return 0;

    await this.persist();
    this.armTimer();
    this.emit({ type: "statusChanged", status: this.getStatus() });
    cronLogger.info(`Removed ${removed} job(s) by owner cleanup`);
    return removed;
  }

  async runNow(id: string): Promise<{ ran: boolean; error?: string }> {
    await this.ensureLoaded();

    const job = this.jobs.find((j) => j.id === id);
    if (!job) return { ran: false, error: "Job not found" };
    if (job.state.runningAtMs) return { ran: false, error: "Job is already running" };

    // 立即标记为运行中，防止重复触发（executeJobInternal 内会覆盖为精确时间戳）
    job.state.runningAtMs = this.deps.nowMs();
    await this.persist();
    this.emit({ type: "statusChanged", status: this.getStatus() });

    // 后台执行，不阻塞 HTTP 响应
    this.executeJobInternal(job, { forced: true })
      .then(() => this.persist())
      .then(() => {
        this.armTimer();
        this.emit({ type: "statusChanged", status: this.getStatus() });
      })
      .catch((err) => cronLogger.error("runNow background execution failed:", err));

    return { ran: true };
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;

    this.jobs = await this.deps.loadJobs();

    const nowMs = this.deps.nowMs();
    let dirty = false;
    for (const job of this.jobs) {
      if (normalizeEverySchedule(job, nowMs)) {
        dirty = true;
      }
      // 清理陈旧的 runningAtMs：服务重启时不可能有任务还在运行
      if (job.state.runningAtMs != null) {
        job.state.runningAtMs = undefined;
        if (job.enabled && job.state.nextRunAtMs === undefined) {
          job.state.nextRunAtMs = computeJobNextRunAtMs(job, nowMs);
        }
        dirty = true;
      }
      if (job.enabled && job.state.nextRunAtMs === undefined) {
        job.state.nextRunAtMs = computeJobNextRunAtMs(job, nowMs);
      }
    }

    if (dirty) {
      await this.persist();
    }

    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await this.deps.saveJobs(this.jobs);
  }

  private armTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (!this.enabled) return;

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
    if (this.running) return;
    this.running = true;

    try {
      await this.ensureLoaded();

      const nowMs = this.deps.nowMs();
      const dueJobs = findDueJobs(this.jobs, nowMs);

      await Promise.allSettled(
        dueJobs.map((job) => this.executeJobInternal(job, { forced: false }))
      );

      await this.persist();
    } finally {
      this.running = false;
      this.armTimer();
      this.emit({ type: "statusChanged", status: this.getStatus() });
    }
  }

  private getJobTimeoutSeconds(job: CronJob): number {
    if (job.payload.kind === "agentTurn" && job.payload.timeoutSeconds != null) {
      return Math.max(0, Math.floor(job.payload.timeoutSeconds));
    }
    return this.deps.defaultTimeoutSeconds ?? 1800;
  }

  private async executeJobInternal(
    job: CronJob,
    opts: { forced: boolean }
  ): Promise<void> {
    const startedAt = this.deps.nowMs();
    const runId = `${startedAt}-${randomUUID()}`;
    job.state.runningAtMs = startedAt;
    this.emit({ type: "started", jobId: job.id, jobName: job.name });

    let status: "ok" | "error" | "skipped" = "ok";
    let error: string | undefined;
    let output: string | undefined;
    let sessionId: string | undefined;
    let transcriptPath: string | undefined;
    let model: string | undefined;

    // 通过回调提前捕获 sessionId，确保 pTimeout 打断 promise 后仍可归组
    const onSessionId = (sid: string, tp?: string) => {
      sessionId = sid;
      if (tp) transcriptPath = tp;
    };

    try {
      // 硬超时 = executor 超时 + 60s 安全余量
      const jobTimeoutSec = this.getJobTimeoutSeconds(job);
      const hardTimeoutMs = jobTimeoutSec > 0 ? (jobTimeoutSec + 60) * 1000 : 0;

      const result = hardTimeoutMs > 0
        ? await pTimeout(this.deps.executeJob(job, { onSessionId }), hardTimeoutMs,
            `Service-level hard timeout after ${jobTimeoutSec + 60}s`)
        : await this.deps.executeJob(job, { onSessionId });
      status = result.status;
      error = result.error;
      output = result.output;
      sessionId = result.sessionId;
      transcriptPath = result.transcriptPath;
      model = result.modelRef;
    } catch (err) {
      status = "error";
      error = String(err);
    }

    const endedAt = this.deps.nowMs();
    const durationMs = Math.max(0, endedAt - startedAt);

    job.state.runningAtMs = undefined;
    job.state.lastRunAtMs = startedAt;
    job.state.lastStatus = status;
    job.state.lastError = error;
    job.state.lastDurationMs = durationMs;
    job.state.lastOutput = output?.substring(0, 500);

    if (job.schedule.kind === "at") {
      // 一次性任务：执行后不应再自动调度下一次（避免失败后 nextRunAtMs 仍在过去导致反复触发）
      job.state.nextRunAtMs = undefined;
      if (status === "ok") {
        job.enabled = false;
      }
    } else if (!opts.forced && job.enabled) {
      job.state.nextRunAtMs = computeJobNextRunAtMs(job, endedAt);
    }

    model = model ?? (job.payload.kind === "agentTurn" ? job.payload.model : undefined);

    await this.deps.appendRunLog({
      runId,
      startedAtMs: startedAt,
      endedAtMs: endedAt,
      jobId: job.id,
      jobName: job.name,
      status,
      error,
      sessionId,
      transcriptPath,
      model,
      durationMs,
    });

    const run: CronRunLogEntry = {
      runId,
      startedAtMs: startedAt,
      endedAtMs: endedAt,
      jobId: job.id,
      jobName: job.name,
      status,
      error,
      sessionId,
      transcriptPath,
      model,
      durationMs,
    };

    if (this.deps.notify) {
      await this.deps.notify({ job, run, output, error }).catch((e) => {
        cronLogger.error("Failed to send notification:", e);
      });
    }

    if (sessionId && this.deps.onSessionCreated) {
      await this.deps.onSessionCreated(job.id, job.name, sessionId, job.owner).catch((e) => {
        cronLogger.error("Failed to handle onSessionCreated:", e);
      });
    }

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
    const nowMs = this.deps.nowMs();
    let cleaned = false;

    for (const job of this.jobs) {
      if (job.state.runningAtMs == null) continue;

      const elapsed = nowMs - job.state.runningAtMs;
      const jobTimeoutMs = this.getJobTimeoutSeconds(job) * 1000;
      const effectiveTimeoutMs = jobTimeoutMs > 0 ? jobTimeoutMs : WATCHDOG_FALLBACK_TIMEOUT_MS;
      const deadlineMs = effectiveTimeoutMs + WATCHDOG_OVERTIME_MS;

      if (elapsed <= deadlineMs) continue;

      const deadlineSec = Math.round(deadlineMs / 1000);
      cronLogger.warn(
        `Watchdog: job "${job.name}" (${job.id}) exceeded ${deadlineSec}s deadline, force-cleaning`
      );

      const startedAt = job.state.runningAtMs;
      job.state.runningAtMs = undefined;
      job.state.lastStatus = "error";
      job.state.lastError = `Watchdog: exceeded ${deadlineSec}s deadline`;
      job.state.lastDurationMs = elapsed;

      if (job.enabled) {
        job.state.nextRunAtMs = computeJobNextRunAtMs(job, nowMs);
      }

      const runId = `${startedAt}-watchdog`;
      await this.deps.appendRunLog({
        runId,
        startedAtMs: startedAt,
        endedAtMs: nowMs,
        jobId: job.id,
        jobName: job.name,
        status: "error",
        error: job.state.lastError,
        durationMs: elapsed,
      }).catch((e) => {
        cronLogger.error("Watchdog: failed to append run log:", e);
      });

      if (this.deps.notify) {
        const run: CronRunLogEntry = {
          runId,
          startedAtMs: startedAt,
          endedAtMs: nowMs,
          jobId: job.id,
          jobName: job.name,
          status: "error",
          error: job.state.lastError,
          durationMs: elapsed,
        };
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

      cleaned = true;
    }

    if (cleaned) {
      await this.persist();
      this.armTimer();
      this.emit({ type: "statusChanged", status: this.getStatus() });
    }
  }

  private emit(event: CronEvent): void {
    this.deps.onEvent?.(event);
  }
}
