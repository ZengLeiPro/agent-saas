import type pg from 'pg';

export type RuntimeEventRetentionState =
  | 'never_run'
  | 'running'
  | 'dry_run_succeeded'
  | 'execute_succeeded'
  | 'blocked'
  | 'failed';

export interface RuntimeEventRetentionStatusSnapshot {
  schemaVersion: 1;
  state: RuntimeEventRetentionState;
  mode: 'dry-run' | 'execute';
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
  private stopped = true;
  private inFlight = false;
  private readonly eventsTable: string;
  private readonly toolInvocationsTable: string;
  private readonly billingProjectionStateTable: string;
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

  constructor(private readonly options: RuntimeEventRetentionOptions) {
    this.eventsTable = sanitizeIdentifier(options.eventsTable);
    this.toolInvocationsTable = sanitizeIdentifier(options.toolInvocationsTable);
    this.billingProjectionStateTable = sanitizeIdentifier(options.billingProjectionStateTable);
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
    this.stopped = false;
    this.scheduleNext();
    const gateError = this.configurationGateError();
    if (gateError) {
      const now = new Date().toISOString();
      this.lastStartedAt = now;
      this.lastCompletedAt = now;
      await this.recordStatus(this.snapshot('blocked', { durationMs: 0, errorCategory: gateError.category }));
      this.options.logger?.warn?.(`RuntimeEventRetention configuration blocked: category=${gateError.category}`);
    }
    this.options.logger?.info?.(
      `RuntimeEventRetention started: mode=${this.executionMode} interval=${this.sweepIntervalMinutes}m `
      + `batchLimit=${this.batchLimit} maxBatchesPerCategory=${this.maxBatchesPerCategory} `
      + `legalWatermark=${this.legalDeleteThroughGlobalSequence.toString()}`,
    );
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.nextScheduledAt = null;
    }
  }

  async runOnce(): Promise<RuntimeEventRetentionResult> {
    if (this.inFlight) throw new Error('RuntimeEventRetention is already running');
    this.inFlight = true;
    const startedMs = Date.now();
    this.lastStartedAt = new Date(startedMs).toISOString();
    this.lastCompletedAt = null;
    const categories: Record<string, { eligible: number; deleted: number }> = {};
    let billingWatermark: string | null = null;
    let effectiveDeleteThrough: string | null = null;
    let maxGlobalSequence: string | null = null;
    await this.recordStatus(this.snapshot('running', { categories }));
    try {
      const gateError = this.configurationGateError();
      if (gateError) throw gateError;
      // dry-run 必须严格只读，不能为了预览推进 billing projection。
      const projection = this.executionMode === 'execute'
        ? await this.advanceBillingProjection()
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
      ));
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
      }));
      throw err;
    } finally {
      this.inFlight = false;
    }
  }

  private configurationGateError(): RetentionGateError | null {
    if (this.executionMode !== 'execute') return null;
    if (!this.authorizationRef) return new RetentionGateError('authorization_missing');
    if (this.legalDeleteThroughGlobalSequence <= 0n) return new RetentionGateError('legal_watermark_invalid');
    return null;
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    this.nextScheduledAt = new Date(Date.now() + this.sweepIntervalMinutes * 60_000).toISOString();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.nextScheduledAt = null;
      void this.runOnce()
        .catch((err) => {
          this.options.logger?.warn?.(`RuntimeEventRetention failed: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => this.scheduleNext());
    }, this.sweepIntervalMinutes * 60_000);
    this.timer.unref?.();
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
    }> = {},
  ): RuntimeEventRetentionStatusSnapshot {
    return {
      schemaVersion: 1,
      state,
      mode: this.executionMode,
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
    };
  }

  private async recordStatus(snapshot: RuntimeEventRetentionStatusSnapshot): Promise<void> {
    if (!this.options.statusRecorder) return;
    try {
      await this.options.statusRecorder(snapshot);
    } catch {
      this.options.logger?.warn?.('RuntimeEventRetention status persistence failed');
    }
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
      const batch = await this.options.pool.query(category.deleteSql, category.params);
      const batchDeleted = batch.rowCount ?? 0;
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

class RetentionGateError extends Error {
  constructor(readonly category: 'authorization_missing' | 'legal_watermark_invalid') {
    super(category === 'authorization_missing'
      ? 'RuntimeEventRetention execute 模式缺少授权'
      : 'RuntimeEventRetention execute 模式 legal watermark 无效');
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
