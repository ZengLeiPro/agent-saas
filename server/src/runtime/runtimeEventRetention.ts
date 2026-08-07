import type pg from 'pg';

export interface RuntimeEventRetentionOptions {
  pool: pg.Pool;
  eventsTable: string;
  toolInvocationsTable: string;
  billingProjectionStateTable: string;
  enabled?: boolean;
  sweepIntervalMinutes?: number;
  batchLimit?: number;
  terminalDeltaGraceMinutes?: number;
  successfulSummaryRetentionHours?: number;
  failedSummaryRetentionDays?: number;
  modelDiagnosticRetentionDays?: number;
  modelRequestFinishedRetentionDays?: number;
  handEventRetentionDays?: number;
  billingCatchupBatchLimit?: number;
  billingCatchupMaxBatches?: number;
  projectBillingRuntimeEvents?: (limit: number) => Promise<{ lastProjectedSequence: number }>;
  logger?: {
    info?: (message: string, ...args: unknown[]) => void;
    warn?: (message: string, ...args: unknown[]) => void;
    error?: (message: string, ...args: unknown[]) => void;
  };
}

export interface RuntimeEventRetentionResult {
  deleted: number;
  deletedByCategory: Record<string, number>;
  billingWatermark: string;
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
 * 所有 DELETE 都受 billing projection 水位约束，并以单条 CTE 原子锁定、删除，
 * 避免蓝绿实例并发清理同一批记录。
 */
export class RuntimeEventRetention {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private inFlight = false;
  private readonly eventsTable: string;
  private readonly toolInvocationsTable: string;
  private readonly billingProjectionStateTable: string;
  private readonly sweepIntervalMinutes: number;
  private readonly batchLimit: number;
  private readonly terminalDeltaGraceMinutes: number;
  private readonly successfulSummaryRetentionHours: number;
  private readonly failedSummaryRetentionDays: number;
  private readonly modelDiagnosticRetentionDays: number;
  private readonly modelRequestFinishedRetentionDays: number;
  private readonly handEventRetentionDays: number;
  private readonly billingCatchupBatchLimit: number;
  private readonly billingCatchupMaxBatches: number;

  constructor(private readonly options: RuntimeEventRetentionOptions) {
    this.eventsTable = sanitizeIdentifier(options.eventsTable);
    this.toolInvocationsTable = sanitizeIdentifier(options.toolInvocationsTable);
    this.billingProjectionStateTable = sanitizeIdentifier(options.billingProjectionStateTable);
    this.sweepIntervalMinutes = clampInt(options.sweepIntervalMinutes ?? 10, 1, 24 * 60);
    this.batchLimit = clampInt(options.batchLimit ?? 10_000, 1, 100_000);
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

  start(): void {
    if (this.options.enabled !== true || !this.stopped) return;
    this.stopped = false;
    this.scheduleNext();
    this.options.logger?.info?.(
      `RuntimeEventRetention started: interval=${this.sweepIntervalMinutes}m batchLimit=${this.batchLimit}`,
    );
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  async runOnce(): Promise<RuntimeEventRetentionResult> {
    if (this.inFlight) {
      throw new Error('RuntimeEventRetention is already running');
    }
    this.inFlight = true;
    try {
      const projection = await this.advanceBillingProjection();
      const deletedByCategory: Record<string, number> = {};
      let deleted = 0;

      for (const category of this.buildCategories(projection.billingWatermark)) {
        const categoryDeleted = await this.deleteCategory(category);
        deletedByCategory[category.name] = categoryDeleted;
        deleted += categoryDeleted;
      }

      const result: RuntimeEventRetentionResult = {
        deleted,
        deletedByCategory,
        billingWatermark: projection.billingWatermark.toString(),
        maxGlobalSequence: projection.maxGlobalSequence.toString(),
      };
      this.options.logger?.info?.(
        `RuntimeEventRetention finished: deleted=${deleted} categories=${JSON.stringify(deletedByCategory)} `
        + `billingWatermark=${result.billingWatermark} maxGlobalSequence=${result.maxGlobalSequence}`,
      );
      return result;
    } finally {
      this.inFlight = false;
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runOnce()
        .catch((err) => {
          this.options.logger?.warn?.(`RuntimeEventRetention failed: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => this.scheduleNext());
    }, this.sweepIntervalMinutes * 60_000);
    this.timer.unref?.();
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
              ON invocation.invocation_id = e.event_json->>'invocationId'
            WHERE e.event_type = ANY($1::text[])
              AND e.global_sequence <= $2::bigint
              AND invocation.status IN ('completed', 'failed', 'cancelled')
              AND invocation.completed_at IS NOT NULL
              AND invocation.completed_at < NOW() - ($3::int * INTERVAL '1 minute')
              AND EXISTS (
                SELECT 1
                FROM ${this.eventsTable} result
                WHERE result.session_id = e.session_id
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
                WHERE terminal.session_id = e.session_id
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

  private async deleteCategory(category: RetentionCategory): Promise<number> {
    let deleted = 0;
    while (true) {
      const batch = await this.options.pool.query(category.deleteSql, category.params);
      const batchDeleted = batch.rowCount ?? 0;
      deleted += batchDeleted;
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

function sanitizeIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`非法 PG identifier: ${value}`);
  }
  return value;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}
