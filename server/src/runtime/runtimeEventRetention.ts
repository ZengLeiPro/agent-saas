import { randomUUID } from 'node:crypto';

import type pg from 'pg';

export type RuntimeEventRetentionState =
  | 'never_run'
  | 'scheduled'
  | 'running'
  | 'dry_run_succeeded'
  | 'execute_succeeded'
  | 'blocked'
  | 'failed';

export interface RuntimeEventRetentionStatusSnapshot {
  schemaVersion: 1;
  state: RuntimeEventRetentionState;
  mode: 'dry-run' | 'execute';
  sweepIntervalMinutes: number;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastSuccessAt: string | null;
  durationMs: number | null;
  errorCategory: string | null;
  nextScheduledAt: string | null;
  watermarks: {
    legal: string;
    billing: string | null;
    effectiveDeleteThrough: string | null;
  };
  maxGlobalSequence: string | null;
  categories: Record<string, { eligible: number; deleted: number }>;
  /** Store 内部跨进程 fencing；System Admin 响应不会暴露。 */
  authority?: { writerId: string; claim: boolean };
}

export interface RuntimeEventRetentionOptions {
  pool: pg.Pool;
  eventsTable: string;
  toolInvocationsTable: string;
  billingProjectionStateTable: string;
  enabled?: boolean;
  /** 默认 dry-run；execute 必须同时提供 legal watermark 与授权单号。 */
  executionMode?: 'dry-run' | 'execute';
  /** 法务/合规已授权删除到（含）此 global_sequence；缺省为 0，阻断删除。 */
  legalDeleteThroughGlobalSequence?: string;
  /** execute 模式必填的变更/审批单号，只用于门禁和日志，不写入事件。 */
  authorizationRef?: string;
  sweepIntervalMinutes?: number;
  batchLimit?: number;
  /** 每个类别每轮最多删除批数；默认 10，避免单轮长时间追赶。 */
  maxBatchesPerCategory?: number;
  terminalDeltaGraceMinutes?: number;
  successfulSummaryRetentionHours?: number;
  failedSummaryRetentionDays?: number;
  modelDiagnosticRetentionDays?: number;
  modelRequestFinishedRetentionDays?: number;
  handEventRetentionDays?: number;
  billingCatchupBatchLimit?: number;
  billingCatchupMaxBatches?: number;
  projectBillingRuntimeEvents?: (limit: number) => Promise<{ lastProjectedSequence: number }>;
  /** 持久化稳定、脱敏的运行快照；首次未运行状态由只读投影在无记录时派生。 */
  statusRecorder?: (snapshot: RuntimeEventRetentionStatusSnapshot) => Promise<void> | void;
  /** execute projection/DELETE 复用状态单例行做跨进程事务 fencing。 */
  statusAuthorityTable?: string;
  /** 专用 worker 启动失败时退出；兼容 all 角色仅重试状态写入。 */
  startupFailureMode?: 'none' | 'throw' | 'retry';
  logger?: {
    info?: (message: string, ...args: unknown[]) => void;
    warn?: (message: string, ...args: unknown[]) => void;
    error?: (message: string, ...args: unknown[]) => void;
  };
}

export interface RuntimeEventRetentionResult {
  mode: 'dry-run' | 'execute';
  deleted: number;
  deletedByCategory: Record<string, number>;
  eligibleByCategory: Record<string, number>;
  legalWatermark: string;
  billingWatermark: string;
  effectiveDeleteThrough: string;
  maxGlobalSequence: string;
}

interface RetentionCategory {
  name: string;
  deleteSql: string;
  params: unknown[];
}

const TOOL_DELTA_TYPES = ['tool_output_delta', 'tool_progress'] as const;
const MODEL_DIAGNOSTIC_TYPES = ['model_request_started', 'model_request_checkpoint'] as const;
const HAND_RETENTION_TYPES = ['hand_provisioning_log', 'hand_health_changed', 'hand_failure'] as const;

/**
 * 清理 runtime_events 中只服务于短期重放/排障的过程事件。
 *
 * 永久事件（消息、tool_result、工具生命周期、审计、计费事实）不在任何类别中。
 * 所有 DELETE 都受 billing projection 与法务授权双水位约束，并以单条 CTE
 * 原子锁定、删除，避免蓝绿实例并发清理同一批记录。缺省模式严格只读 dry-run。
 */
export class RuntimeEventRetention {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private startupRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private inFlight = false;
  private inFlightCompletion: Promise<void> = Promise.resolve();
  private statusWriteTail: Promise<void> = Promise.resolve();
  private readonly eventsTable: string;
  private readonly toolInvocationsTable: string;
  private readonly billingProjectionStateTable: string;
  private readonly statusAuthorityTable: string | undefined;
  private readonly executionMode: 'dry-run' | 'execute';
  private readonly legalDeleteThroughGlobalSequence: bigint;
  private readonly authorizationRef: string | undefined;
  private readonly sweepIntervalMinutes: number;
  private readonly batchLimit: number;
  private readonly maxBatchesPerCategory: number;
  private readonly terminalDeltaGraceMinutes: number;
  private readonly successfulSummaryRetentionHours: number;
  private readonly failedSummaryRetentionDays: number;
  private readonly modelDiagnosticRetentionDays: number;
  private readonly modelRequestFinishedRetentionDays: number;
  private readonly handEventRetentionDays: number;
  private readonly billingCatchupBatchLimit: number;
  private readonly billingCatchupMaxBatches: number;
  private lastStartedAt: string | null = null;
  private lastCompletedAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private nextScheduledAt: string | null = null;
  private startGeneration = 0;
  private statusPersistenceAvailable = true;
  // 只随逻辑状态转换更新；authority refresh 不覆盖并发产生的更新末态。
  private lastObservedStatus: RuntimeEventRetentionStatusSnapshot | undefined;
  private readonly statusAuthority = { writerId: randomUUID() };

  constructor(private readonly options: RuntimeEventRetentionOptions) {
    this.eventsTable = sanitizeIdentifier(options.eventsTable);
    this.toolInvocationsTable = sanitizeIdentifier(options.toolInvocationsTable);
    this.billingProjectionStateTable = sanitizeIdentifier(options.billingProjectionStateTable);
    this.statusAuthorityTable = options.statusAuthorityTable
      ? sanitizeIdentifier(options.statusAuthorityTable)
      : undefined;
    this.executionMode = options.executionMode ?? 'dry-run';
    this.legalDeleteThroughGlobalSequence = parseWatermark(options.legalDeleteThroughGlobalSequence);
    this.authorizationRef = options.authorizationRef?.trim() || undefined;
    this.sweepIntervalMinutes = clampInt(options.sweepIntervalMinutes ?? 10, 1, 24 * 60);
    this.batchLimit = clampInt(options.batchLimit ?? 10_000, 1, 100_000);
    this.maxBatchesPerCategory = clampInt(options.maxBatchesPerCategory ?? 10, 1, 1000);
    this.terminalDeltaGraceMinutes = clampInt(options.terminalDeltaGraceMinutes ?? 10, 1, 24 * 60);
    this.successfulSummaryRetentionHours = clampInt(options.successfulSummaryRetentionHours ?? 24, 1, 365 * 24);
    this.failedSummaryRetentionDays = clampInt(options.failedSummaryRetentionDays ?? 7, 1, 3650);
    this.modelDiagnosticRetentionDays = clampInt(options.modelDiagnosticRetentionDays ?? 7, 1, 3650);
    this.modelRequestFinishedRetentionDays = clampInt(
      options.modelRequestFinishedRetentionDays ?? 30,
      this.modelDiagnosticRetentionDays,
      3650,
    );
    this.handEventRetentionDays = clampInt(options.handEventRetentionDays ?? 30, 1, 3650);
    this.billingCatchupBatchLimit = clampInt(options.billingCatchupBatchLimit ?? 10_000, 1, 100_000);
    this.billingCatchupMaxBatches = clampInt(options.billingCatchupMaxBatches ?? 100, 1, 10_000);
  }

  async start(): Promise<void> {
    if (this.options.enabled !== true || !this.stopped) return;
    const requestedGeneration = this.startGeneration;
    await this.inFlightCompletion;
    await this.statusWriteTail;
    if (!this.stopped || requestedGeneration !== this.startGeneration) return;
    const generation = ++this.startGeneration;
    this.stopped = false;
    this.lastStartedAt = null;
    this.lastCompletedAt = null;
    this.prepareNextScheduledAt();
    const gateError = this.configurationGateError();
    let statusRecorded: boolean;
    if (gateError) {
      const now = new Date().toISOString();
      this.lastStartedAt = now;
      this.lastCompletedAt = now;
      statusRecorded = await this.recordStatus(
        this.snapshot('blocked', { durationMs: 0, errorCategory: gateError.category, authorityClaim: true }), generation,
      );
      this.options.logger?.warn?.(`RuntimeEventRetention configuration blocked: category=${gateError.category}`);
    } else {
      statusRecorded = await this.recordStatus(this.snapshot('scheduled', { authorityClaim: true }), generation);
    }
    if (generation !== this.startGeneration || this.stopped) return;
    if (!statusRecorded) {
      this.stopped = true;
      this.nextScheduledAt = null;
      this.options.logger?.warn?.('RuntimeEventRetention startup not scheduled: status persistence unavailable');
      if (this.options.startupFailureMode === 'throw') {
        throw new Error('runtime-worker failed to establish RuntimeEventRetention status authority');
      }
      if (this.options.startupFailureMode === 'retry') this.scheduleStartupRetry();
      return;
    }
    this.clearStartupRetry();
    this.scheduleNext();
    this.options.logger?.info?.(
      `RuntimeEventRetention started: mode=${this.executionMode} interval=${this.sweepIntervalMinutes}m `
      + `batchLimit=${this.batchLimit} maxBatchesPerCategory=${this.maxBatchesPerCategory} `
      + `legalWatermark=${this.legalDeleteThroughGlobalSequence.toString()}`,
    );
  }

  isStatusPersistenceAvailable(): boolean {
    return this.statusPersistenceAvailable;
  }

  async reassertStatusAuthority(claim = false): Promise<void> {
    if (this.options.enabled !== true) return;
    const write = async (): Promise<void> => {
      if (!this.options.statusRecorder || !this.lastObservedStatus) {
        throw new Error('RuntimeEventRetention has no observed status to reassert');
      }
      const snapshot = {
        ...this.lastObservedStatus,
        lastStartedAt: this.lastStartedAt,
        lastCompletedAt: this.lastCompletedAt,
        lastSuccessAt: this.lastSuccessAt,
        nextScheduledAt: this.stopped ? null : this.nextScheduledAt,
        authority: { ...this.statusAuthority, claim },
      };
      await this.options.statusRecorder(snapshot);
      this.statusPersistenceAvailable = true;
    };
    const completion = this.statusWriteTail.then(write, write);
    this.statusWriteTail = completion;
    try {
      await completion;
    } catch {
      this.statusPersistenceAvailable = false;
      this.options.logger?.warn?.('RuntimeEventRetention status authority reassertion failed');
      throw new Error('RuntimeEventRetention failed to reassert status authority');
    }
  }

  stop(): void {
    this.stopped = true;
    this.startGeneration += 1;
    if (this.options.enabled === true) this.statusPersistenceAvailable = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.clearStartupRetry();
    this.nextScheduledAt = null;
  }

  async quiesce(): Promise<void> {
    this.stop();
    await this.inFlightCompletion;
    await this.statusWriteTail;
  }

  async runOnce(): Promise<RuntimeEventRetentionResult> {
    if (this.inFlight) throw new Error('RuntimeEventRetention is already running');
    this.inFlight = true;
    let completeInFlight!: () => void;
    this.inFlightCompletion = new Promise<void>((resolve) => { completeInFlight = resolve; });
    const generation = this.startGeneration;
    const startedMs = Date.now();
    this.lastStartedAt = new Date(startedMs).toISOString();
    this.lastCompletedAt = null;
    const categories: Record<string, { eligible: number; deleted: number }> = {};
    let billingWatermark: string | null = null;
    let effectiveDeleteThrough: string | null = null;
    let maxGlobalSequence: string | null = null;
    try {
      const runningStatusRecorded = await this.recordStatus(this.snapshot('running', { categories }), generation);
      if (this.executionMode === 'execute' && this.options.enabled === true && !runningStatusRecorded) {
        throw new RetentionGateError('status_persistence_unavailable');
      }
      const gateError = this.configurationGateError();
      if (gateError) throw gateError;
      // dry-run 必须严格只读，不能为了预览推进 billing projection。
      const projection = this.executionMode === 'execute'
        ? await this.withExecutionAuthority(() => this.advanceBillingProjection())
        : await this.readBillingProjectionLag();
      billingWatermark = projection.billingWatermark.toString();
      maxGlobalSequence = projection.maxGlobalSequence.toString();
      const effective = minBigInt(projection.billingWatermark, this.legalDeleteThroughGlobalSequence);
      effectiveDeleteThrough = effective.toString();
      const deletedByCategory: Record<string, number> = {};
      const eligibleByCategory: Record<string, number> = {};
      let deleted = 0;

      for (const category of this.buildCategories(effective)) {
        if (this.executionMode === 'dry-run') {
          const eligible = await this.countCategory(category);
          eligibleByCategory[category.name] = eligible;
          deletedByCategory[category.name] = 0;
          categories[category.name] = { eligible, deleted: 0 };
          continue;
        }
        const categoryDeleted = await this.deleteCategory(category, (progress) => {
          categories[category.name] = { eligible: progress, deleted: progress };
        });
        deletedByCategory[category.name] = categoryDeleted;
        eligibleByCategory[category.name] = categoryDeleted;
        deleted += categoryDeleted;
      }

      const result: RuntimeEventRetentionResult = {
        mode: this.executionMode,
        deleted,
        deletedByCategory,
        eligibleByCategory,
        legalWatermark: this.legalDeleteThroughGlobalSequence.toString(),
        billingWatermark,
        effectiveDeleteThrough,
        maxGlobalSequence,
      };
      this.lastCompletedAt = new Date().toISOString();
      this.lastSuccessAt = this.lastCompletedAt;
      this.prepareNextScheduledAt();
      await this.recordStatus(this.snapshot(
        this.executionMode === 'dry-run' ? 'dry_run_succeeded' : 'execute_succeeded',
        { durationMs: Date.now() - startedMs, billingWatermark, effectiveDeleteThrough, maxGlobalSequence, categories },
      ), generation);
      this.options.logger?.info?.(
        `RuntimeEventRetention finished: mode=${result.mode} deleted=${deleted} `
        + `eligible=${JSON.stringify(eligibleByCategory)} authorizationRef=${this.authorizationRef ?? 'none'} `
        + `legalWatermark=${result.legalWatermark} billingWatermark=${result.billingWatermark} `
        + `effectiveDeleteThrough=${result.effectiveDeleteThrough} maxGlobalSequence=${result.maxGlobalSequence}`,
      );
      return result;
    } catch (err) {
      this.lastCompletedAt = new Date().toISOString();
      this.prepareNextScheduledAt();
      const blocked = err instanceof RetentionGateError;
      await this.recordStatus(this.snapshot(blocked ? 'blocked' : 'failed', {
        durationMs: Date.now() - startedMs,
        errorCategory: blocked ? err.category : inferErrorCategory(categories),
        billingWatermark,
        effectiveDeleteThrough,
        maxGlobalSequence,
        categories,
      }), generation);
      throw err;
    } finally {
      this.inFlight = false;
      completeInFlight();
    }
  }

  private configurationGateError(): RetentionGateError | null {
    if (this.executionMode !== 'execute') return null;
    if (!this.authorizationRef) return new RetentionGateError('authorization_missing');
    if (this.legalDeleteThroughGlobalSequence <= 0n) return new RetentionGateError('legal_watermark_invalid');
    return null;
  }

  private scheduleNext(generation = this.startGeneration): void {
    if (this.stopped || generation !== this.startGeneration) return;
    this.prepareNextScheduledAt();
    const scheduledMs = Date.parse(this.nextScheduledAt!);
    const delayMs = Number.isFinite(scheduledMs)
      ? Math.max(0, scheduledMs - Date.now())
      : this.sweepIntervalMinutes * 60_000;
    this.timer = setTimeout(() => {
      if (this.stopped || generation !== this.startGeneration) return;
      this.timer = undefined;
      this.nextScheduledAt = null;
      void this.runOnce()
        .catch((err) => {
          this.options.logger?.warn?.(`RuntimeEventRetention failed: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => this.scheduleNext(generation));
    }, delayMs);
    this.timer.unref?.();
  }

  private scheduleStartupRetry(): void {
    if (this.startupRetryTimer) return;
    this.startupRetryTimer = setTimeout(() => {
      this.startupRetryTimer = undefined;
      void this.start().catch((err) => {
        this.options.logger?.warn?.(`RuntimeEventRetention startup retry failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, 30_000);
    this.startupRetryTimer.unref?.();
  }

  private clearStartupRetry(): void {
    if (!this.startupRetryTimer) return;
    clearTimeout(this.startupRetryTimer);
    this.startupRetryTimer = undefined;
  }

  private prepareNextScheduledAt(): void {
    if (!this.stopped && !this.nextScheduledAt) {
      this.nextScheduledAt = new Date(Date.now() + this.sweepIntervalMinutes * 60_000).toISOString();
    }
  }

  private snapshot(
    state: RuntimeEventRetentionState,
    patch: Partial<{
      durationMs: number;
      errorCategory: string;
      billingWatermark: string | null;
      effectiveDeleteThrough: string | null;
      maxGlobalSequence: string | null;
      categories: Record<string, { eligible: number; deleted: number }>;
      authorityClaim: boolean;
    }> = {},
  ): RuntimeEventRetentionStatusSnapshot {
    return {
      schemaVersion: 1,
      state,
      mode: this.executionMode,
      sweepIntervalMinutes: this.sweepIntervalMinutes,
      lastStartedAt: this.lastStartedAt,
      lastCompletedAt: this.lastCompletedAt,
      lastSuccessAt: this.lastSuccessAt,
      durationMs: patch.durationMs ?? null,
      errorCategory: patch.errorCategory ?? null,
      nextScheduledAt: this.stopped ? null : this.nextScheduledAt,
      watermarks: {
        legal: this.legalDeleteThroughGlobalSequence.toString(),
        billing: patch.billingWatermark ?? null,
        effectiveDeleteThrough: patch.effectiveDeleteThrough ?? null,
      },
      maxGlobalSequence: patch.maxGlobalSequence ?? null,
      categories: patch.categories ?? {},
      authority: { ...this.statusAuthority, claim: patch.authorityClaim === true },
    };
  }

  private async recordStatus(
    snapshot: RuntimeEventRetentionStatusSnapshot,
    generation?: number,
  ): Promise<boolean> {
    const isCurrent = () => generation === undefined || generation === this.startGeneration;
    if (!isCurrent()) return false;
    this.lastObservedStatus = snapshot;
    if (!this.options.statusRecorder) {
      this.statusPersistenceAvailable = this.executionMode !== 'execute';
      return this.statusPersistenceAvailable;
    }
    let recorded = false;
    const write = async (): Promise<void> => {
      if (!isCurrent()) return;
      try {
        await this.options.statusRecorder!(snapshot);
        if (!isCurrent()) return;
        this.statusPersistenceAvailable = true;
        recorded = true;
      } catch {
        if (!isCurrent()) return;
        this.statusPersistenceAvailable = false;
        this.options.logger?.warn?.('RuntimeEventRetention status persistence failed');
      }
    };
    const completion = this.statusWriteTail.then(write, write);
    this.statusWriteTail = completion;
    await completion;
    return recorded;
  }

  private buildCategories(billingWatermark: bigint): RetentionCategory[] {
    const watermark = billingWatermark.toString();
    return [
      {
        name: 'tool-delta',
        deleteSql: `
          /* retention:tool-delta */
          WITH candidates AS (
            SELECT e.global_sequence
            FROM ${this.eventsTable} e
            INNER JOIN ${this.toolInvocationsTable} invocation
              ON invocation.tenant_id = e.tenant_id
             AND invocation.invocation_id = e.event_json->>'invocationId'
            WHERE e.event_type = ANY($1::text[])
              AND e.global_sequence <= $2::bigint
              AND invocation.status IN ('completed', 'failed', 'cancelled')
              AND invocation.completed_at IS NOT NULL
              AND invocation.completed_at < NOW() - ($3::int * INTERVAL '1 minute')
              AND EXISTS (
                SELECT 1
                FROM ${this.eventsTable} result
                WHERE result.tenant_id = e.tenant_id
                  AND result.session_id = e.session_id
                  AND result.run_id IS NOT DISTINCT FROM e.run_id
                  AND result.event_type = 'tool_result'
                  AND result.event_json ? 'toolCallId'
                  AND result.event_json->>'toolCallId' = e.event_json->>'toolCallId'
                  AND result.timestamp < NOW() - ($3::int * INTERVAL '1 minute')
              )
            ORDER BY e.global_sequence ASC
            FOR UPDATE OF e SKIP LOCKED
            LIMIT $4
          )
          DELETE FROM ${this.eventsTable} e
          USING candidates
          WHERE e.global_sequence = candidates.global_sequence
        `,
        params: [[...TOOL_DELTA_TYPES], watermark, this.terminalDeltaGraceMinutes, this.batchLimit],
      },
      {
        name: 'assistant-stream',
        deleteSql: `
          /* retention:assistant-stream */
          WITH candidates AS (
            SELECT e.global_sequence
            FROM ${this.eventsTable} e
            WHERE e.event_type = 'assistant_stream_event'
              AND e.global_sequence <= $1::bigint
              AND e.timestamp < NOW() - ($2::int * INTERVAL '1 minute')
              AND EXISTS (
                SELECT 1
                FROM ${this.eventsTable} terminal
                WHERE terminal.tenant_id = e.tenant_id
                  AND terminal.session_id = e.session_id
                  AND terminal.run_id IS NOT DISTINCT FROM e.run_id
                  AND terminal.event_type = 'run_finished'
                  AND terminal.timestamp < NOW() - ($2::int * INTERVAL '1 minute')
              )
            ORDER BY e.global_sequence ASC
            FOR UPDATE OF e SKIP LOCKED
            LIMIT $3
          )
          DELETE FROM ${this.eventsTable} e
          USING candidates
          WHERE e.global_sequence = candidates.global_sequence
        `,
        params: [watermark, this.terminalDeltaGraceMinutes, this.batchLimit],
      },
      {
        name: 'tool-stream-summary',
        deleteSql: `
          /* retention:tool-stream-summary */
          WITH candidates AS (
            SELECT e.global_sequence
            FROM ${this.eventsTable} e
            WHERE e.event_type = 'tool_stream_summary'
              AND e.global_sequence <= $1::bigint
              AND (
                (
                  e.event_json->>'status' = 'success'
                  AND e.timestamp < NOW() - ($2::int * INTERVAL '1 hour')
                )
                OR (
                  COALESCE(e.event_json->>'status', '') <> 'success'
                  AND e.timestamp < NOW() - ($3::int * INTERVAL '1 day')
                )
              )
            ORDER BY e.global_sequence ASC
            FOR UPDATE OF e SKIP LOCKED
            LIMIT $4
          )
          DELETE FROM ${this.eventsTable} e
          USING candidates
          WHERE e.global_sequence = candidates.global_sequence
        `,
        params: [watermark, this.successfulSummaryRetentionHours, this.failedSummaryRetentionDays, this.batchLimit],
      },
      {
        name: 'model-diagnostics',
        deleteSql: `
          /* retention:model-diagnostics */
          WITH candidates AS (
            SELECT e.global_sequence
            FROM ${this.eventsTable} e
            WHERE e.event_type = ANY($1::text[])
              AND e.global_sequence <= $2::bigint
              AND e.timestamp < NOW() - ($3::int * INTERVAL '1 day')
            ORDER BY e.global_sequence ASC
            FOR UPDATE OF e SKIP LOCKED
            LIMIT $4
          )
          DELETE FROM ${this.eventsTable} e
          USING candidates
          WHERE e.global_sequence = candidates.global_sequence
        `,
        params: [[...MODEL_DIAGNOSTIC_TYPES], watermark, this.modelDiagnosticRetentionDays, this.batchLimit],
      },
      {
        name: 'model-request-finished',
        deleteSql: `
          /* retention:model-request-finished */
          WITH candidates AS (
            SELECT e.global_sequence
            FROM ${this.eventsTable} e
            WHERE e.event_type = 'model_request_finished'
              AND e.global_sequence <= $1::bigint
              AND e.timestamp < NOW() - ($2::int * INTERVAL '1 day')
            ORDER BY e.global_sequence ASC
            FOR UPDATE OF e SKIP LOCKED
            LIMIT $3
          )
          DELETE FROM ${this.eventsTable} e
          USING candidates
          WHERE e.global_sequence = candidates.global_sequence
        `,
        params: [watermark, this.modelRequestFinishedRetentionDays, this.batchLimit],
      },
      {
        name: 'hand-events',
        deleteSql: `
          /* retention:hand-events */
          WITH candidates AS (
            SELECT e.global_sequence
            FROM ${this.eventsTable} e
            WHERE e.event_type = ANY($1::text[])
              AND e.global_sequence <= $2::bigint
              AND e.timestamp < NOW() - ($3::int * INTERVAL '1 day')
            ORDER BY e.global_sequence ASC
            FOR UPDATE OF e SKIP LOCKED
            LIMIT $4
          )
          DELETE FROM ${this.eventsTable} e
          USING candidates
          WHERE e.global_sequence = candidates.global_sequence
        `,
        params: [[...HAND_RETENTION_TYPES], watermark, this.handEventRetentionDays, this.batchLimit],
      },
    ];
  }

  /** 只统计下一批候选；SQL 复用相同 CTE/水位/TTL，且不推进任何 projection。 */
  private async countCategory(category: RetentionCategory): Promise<number> {
    const marker = `\n          DELETE FROM ${this.eventsTable} e`;
    const markerAt = category.deleteSql.lastIndexOf(marker);
    if (markerAt < 0) throw new Error(`retention category ${category.name} 缺少 DELETE marker`);
    const candidateSql = category.deleteSql.slice(0, markerAt)
      .replace('FOR UPDATE OF e SKIP LOCKED', '');
    const countSql = `${candidateSql}\n          SELECT COUNT(*)::text AS eligible FROM candidates`;
    const result = await this.options.pool.query<{ eligible: string }>(countSql, category.params);
    return Number(result.rows[0]?.eligible ?? '0');
  }

  private async deleteCategory(category: RetentionCategory, onProgress: (deleted: number) => void): Promise<number> {
    let deleted = 0;
    for (let batchNo = 0; batchNo < this.maxBatchesPerCategory; batchNo++) {
      const batchDeleted = await this.withExecutionAuthority(async (query) => {
        const batch = await query(category.deleteSql, category.params);
        return batch.rowCount ?? 0;
      });
      deleted += batchDeleted;
      onProgress(deleted);
      if (batchDeleted < this.batchLimit) break;
    }
    return deleted;
  }

  /**
   * 尽力推进计费投影，但不要求追上一个持续增长的 moving target。
   * DELETE 只处理最终读取到的 watermark 以内事件；水位之后的记录留待下轮。
   */
  private async advanceBillingProjection(): Promise<{ billingWatermark: bigint; maxGlobalSequence: bigint }> {
    let lag = await this.readBillingProjectionLag();
    if (lag.billingWatermark < lag.maxGlobalSequence && this.options.projectBillingRuntimeEvents) {
      for (let i = 0; i < this.billingCatchupMaxBatches && lag.billingWatermark < lag.maxGlobalSequence; i++) {
        const projected = await this.options.projectBillingRuntimeEvents(this.billingCatchupBatchLimit);
        const projectedWatermark = BigInt(Math.trunc(projected.lastProjectedSequence));
        if (projectedWatermark <= lag.billingWatermark) break;
        lag = await this.readBillingProjectionLag();
      }
    }
    if (lag.billingWatermark < lag.maxGlobalSequence) {
      this.options.logger?.info?.(
        `RuntimeEventRetention billing projection remains behind: watermark=${lag.billingWatermark.toString()} `
        + `maxGlobalSequence=${lag.maxGlobalSequence.toString()}; cleanup is bounded by watermark`,
      );
    }
    return lag;
  }

  private async withExecutionAuthority<T>(
    operation: (query: pg.Pool['query']) => Promise<T>,
  ): Promise<T> {
    if (!this.statusAuthorityTable) {
      return operation(this.options.pool.query.bind(this.options.pool));
    }
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query<{ writer_id: string | null }>(
        `SELECT detail_json->'authority'->>'writerId' AS writer_id
         FROM ${this.statusAuthorityTable}
         WHERE metric = 'runtime_event_retention' AND label = 'status'
         ORDER BY id DESC
         LIMIT 1
         FOR UPDATE`,
      );
      if (current.rows[0]?.writer_id !== this.statusAuthority.writerId) {
        throw new RetentionAuthoritySupersededError();
      }
      const result = await operation(client.query.bind(client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      this.statusPersistenceAvailable = false;
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async readBillingProjectionLag(): Promise<{ billingWatermark: bigint; maxGlobalSequence: bigint }> {
    const [state, maxSeq] = await Promise.all([
      this.options.pool.query<{ last_global_sequence: string }>(
        `SELECT last_global_sequence
         FROM ${this.billingProjectionStateTable}
         WHERE key = $1`,
        ['runtime_events'],
      ),
      this.options.pool.query<{ max_global_sequence: string | null }>(
        `SELECT COALESCE(MAX(global_sequence), 0)::text AS max_global_sequence
         FROM ${this.eventsTable}`,
      ),
    ]);
    return {
      billingWatermark: BigInt(state.rows[0]?.last_global_sequence ?? '0'),
      maxGlobalSequence: BigInt(maxSeq.rows[0]?.max_global_sequence ?? '0'),
    };
  }
}

class RetentionAuthoritySupersededError extends Error {
  constructor() {
    super('RuntimeEventRetention execution authority superseded');
    this.name = 'RetentionAuthoritySupersededError';
  }
}

class RetentionGateError extends Error {
  constructor(readonly category: 'authorization_missing' | 'legal_watermark_invalid' | 'status_persistence_unavailable') {
    super(category === 'authorization_missing'
      ? 'RuntimeEventRetention execute 模式缺少授权'
      : category === 'legal_watermark_invalid'
        ? 'RuntimeEventRetention execute 模式 legal watermark 无效'
        : 'RuntimeEventRetention execute 模式状态持久化不可用');
    this.name = 'RetentionGateError';
  }
}

function inferErrorCategory(categories: Record<string, { eligible: number; deleted: number }>): string {
  return Object.values(categories).some((category) => category.deleted > 0)
    ? 'partial_failure'
    : 'execution_failed';
}

function sanitizeIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`非法 PG identifier: ${value}`);
  }
  return value;
}

function parseWatermark(value: string | undefined): bigint {
  const normalized = value?.trim() || '0';
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`非法 retention watermark: ${normalized}`);
  }
  return BigInt(normalized);
}

function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}
