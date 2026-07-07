import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import type pg from 'pg';

export interface RuntimeEventRetentionOptions {
  pool: pg.Pool;
  eventsTable: string;
  billingProjectionStateTable: string;
  archiveDir: string;
  enabled?: boolean;
  dailyAtHour?: number;
  dailyAtMinute?: number;
  batchLimit?: number;
  toolDeltaRetentionDays?: number;
  failedInvocationRetentionDays?: number;
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
  archived: number;
  deleted: number;
  archiveFiles: string[];
  billingWatermark: string;
  maxGlobalSequence: string;
  vacuumed: boolean;
}

type RuntimeEventArchiveRow = {
  global_sequence: string;
  event_id: string;
  session_id: string;
  session_sequence: string;
  run_id: string | null;
  tenant_id: string;
  event_type: string;
  timestamp: string | Date;
  event_json: unknown;
};

interface RetentionCategory {
  name: string;
  selectSql: string;
  params: unknown[];
}

const TOOL_DELTA_TYPES = ['tool_output_delta', 'tool_progress'] as const;
const HAND_RETENTION_TYPES = ['hand_provisioning_log', 'hand_health_changed', 'hand_failure'] as const;
const ARCHIVE_HEADERS = [
  'global_sequence',
  'event_id',
  'session_id',
  'session_sequence',
  'run_id',
  'tenant_id',
  'event_type',
  'timestamp',
  'event_json',
];

export class RuntimeEventRetention {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private inFlight = false;
  private readonly eventsTable: string;
  private readonly billingProjectionStateTable: string;
  private readonly archiveDir: string;
  private readonly batchLimit: number;
  private readonly toolDeltaRetentionDays: number;
  private readonly failedInvocationRetentionDays: number;
  private readonly handEventRetentionDays: number;
  private readonly billingCatchupBatchLimit: number;
  private readonly billingCatchupMaxBatches: number;
  private readonly dailyAtHour: number;
  private readonly dailyAtMinute: number;

  constructor(private readonly options: RuntimeEventRetentionOptions) {
    this.eventsTable = sanitizeIdentifier(options.eventsTable);
    this.billingProjectionStateTable = sanitizeIdentifier(options.billingProjectionStateTable);
    this.archiveDir = options.archiveDir;
    this.batchLimit = clampInt(options.batchLimit ?? 10_000, 1, 100_000);
    this.toolDeltaRetentionDays = clampInt(options.toolDeltaRetentionDays ?? 7, 1, 3650);
    this.failedInvocationRetentionDays = clampInt(options.failedInvocationRetentionDays ?? 30, this.toolDeltaRetentionDays, 3650);
    this.handEventRetentionDays = clampInt(options.handEventRetentionDays ?? 30, 1, 3650);
    this.billingCatchupBatchLimit = clampInt(options.billingCatchupBatchLimit ?? 10_000, 1, 100_000);
    this.billingCatchupMaxBatches = clampInt(options.billingCatchupMaxBatches ?? 100, 1, 10_000);
    this.dailyAtHour = clampInt(options.dailyAtHour ?? 3, 0, 23);
    this.dailyAtMinute = clampInt(options.dailyAtMinute ?? 10, 0, 59);
  }

  start(): void {
    if (this.options.enabled === false || !this.stopped) return;
    this.stopped = false;
    this.scheduleNext();
    this.options.logger?.info?.(
      `RuntimeEventRetention started: dailyAt=${String(this.dailyAtHour).padStart(2, '0')}:${String(this.dailyAtMinute).padStart(2, '0')} batchLimit=${this.batchLimit}`,
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
      await mkdir(this.archiveDir, { recursive: true });
      const caughtUp = await this.ensureBillingProjectionCaughtUp();
      let archived = 0;
      let deleted = 0;
      const archiveFiles: string[] = [];

      for (const category of this.buildCategories()) {
        const result = await this.processCategory(category);
        archived += result.archived;
        deleted += result.deleted;
        archiveFiles.push(...result.archiveFiles);
      }

      let vacuumed = false;
      if (deleted > 0) {
        await this.options.pool.query(`VACUUM (ANALYZE) ${this.eventsTable}`);
        vacuumed = true;
      }

      const result: RuntimeEventRetentionResult = {
        archived,
        deleted,
        archiveFiles,
        billingWatermark: caughtUp.billingWatermark,
        maxGlobalSequence: caughtUp.maxGlobalSequence,
        vacuumed,
      };
      this.options.logger?.info?.(
        `RuntimeEventRetention finished: archived=${archived} deleted=${deleted} vacuumed=${vacuumed}`,
      );
      return result;
    } finally {
      this.inFlight = false;
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    const delayMs = msUntilNextLocalTime(this.dailyAtHour, this.dailyAtMinute);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runOnce()
        .catch((err) => {
          this.options.logger?.warn?.(`RuntimeEventRetention failed: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => this.scheduleNext());
    }, delayMs);
    this.timer.unref?.();
  }

  private buildCategories(): RetentionCategory[] {
    return [
      {
        name: 'tool-delta',
        selectSql: `
          SELECT global_sequence, event_id, session_id, session_sequence, run_id, tenant_id, event_type, timestamp, event_json
          FROM ${this.eventsTable} e
          WHERE event_type = ANY($1::text[])
            AND timestamp < NOW() - ($2::int * INTERVAL '1 day')
            AND (
              timestamp < NOW() - ($3::int * INTERVAL '1 day')
              OR NOT EXISTS (
                SELECT 1
                FROM ${this.eventsTable} completed
                WHERE completed.session_id = e.session_id
                  AND completed.event_type = 'tool_invocation_completed'
                  AND completed.event_json->>'invocationId' = e.event_json->>'invocationId'
                  AND completed.event_json->>'status' = 'error'
              )
            )
          ORDER BY timestamp ASC, global_sequence ASC
          LIMIT $4
        `,
        params: [[...TOOL_DELTA_TYPES], this.toolDeltaRetentionDays, this.failedInvocationRetentionDays, this.batchLimit],
      },
      {
        name: 'hand-events',
        selectSql: `
          SELECT global_sequence, event_id, session_id, session_sequence, run_id, tenant_id, event_type, timestamp, event_json
          FROM ${this.eventsTable}
          WHERE event_type = ANY($1::text[])
            AND timestamp < NOW() - ($2::int * INTERVAL '1 day')
          ORDER BY timestamp ASC, global_sequence ASC
          LIMIT $3
        `,
        params: [[...HAND_RETENTION_TYPES], this.handEventRetentionDays, this.batchLimit],
      },
    ];
  }

  private async processCategory(category: RetentionCategory): Promise<{ archived: number; deleted: number; archiveFiles: string[] }> {
    let writer: CsvGzipArchiveWriter | undefined;
    let archived = 0;
    let deleted = 0;
    const archiveFiles: string[] = [];
    try {
      while (true) {
        const batch = await this.options.pool.query<RuntimeEventArchiveRow>(category.selectSql, category.params);
        if (batch.rows.length === 0) break;
        if (!writer) {
          const filePath = join(this.archiveDir, `${formatTimestampForFile(new Date())}-${category.name}.csv.gz`);
          writer = new CsvGzipArchiveWriter(filePath);
          archiveFiles.push(filePath);
        }
        await writer.writeRows(batch.rows);
        archived += batch.rows.length;
        const sequences = batch.rows.map((row) => row.global_sequence);
        const deletedBatch = await this.options.pool.query(
          `DELETE FROM ${this.eventsTable}
           WHERE global_sequence = ANY($1::bigint[])`,
          [sequences],
        );
        deleted += deletedBatch.rowCount ?? 0;
        if ((deletedBatch.rowCount ?? 0) !== batch.rows.length) {
          this.options.logger?.warn?.(
            `RuntimeEventRetention delete count mismatch category=${category.name} selected=${batch.rows.length} deleted=${deletedBatch.rowCount ?? 0}`,
          );
        }
      }
    } finally {
      if (writer) await writer.close();
    }
    return { archived, deleted, archiveFiles };
  }

  private async ensureBillingProjectionCaughtUp(): Promise<{ billingWatermark: string; maxGlobalSequence: string }> {
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
      throw new Error(
        `billing projection is behind runtime_events: watermark=${lag.billingWatermark.toString()} max_global_sequence=${lag.maxGlobalSequence.toString()}; skip retention delete`,
      );
    }
    return {
      billingWatermark: lag.billingWatermark.toString(),
      maxGlobalSequence: lag.maxGlobalSequence.toString(),
    };
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

class CsvGzipArchiveWriter {
  private readonly gzip = createGzip();
  private readonly output: WriteStream;
  private wroteHeader = false;

  constructor(readonly filePath: string) {
    this.output = createWriteStream(filePath);
    this.gzip.pipe(this.output);
  }

  async writeRows(rows: RuntimeEventArchiveRow[]): Promise<void> {
    if (!this.wroteHeader) {
      await this.writeLine(ARCHIVE_HEADERS.join(','));
      this.wroteHeader = true;
    }
    for (const row of rows) {
      await this.writeLine([
        row.global_sequence,
        row.event_id,
        row.session_id,
        row.session_sequence,
        row.run_id ?? '',
        row.tenant_id,
        row.event_type,
        row.timestamp instanceof Date ? row.timestamp.toISOString() : row.timestamp,
        JSON.stringify(row.event_json) ?? '',
      ].map(csvField).join(','));
    }
  }

  async close(): Promise<void> {
    this.gzip.end();
    await Promise.all([finished(this.gzip), finished(this.output)]);
  }

  private async writeLine(line: string): Promise<void> {
    if (!this.gzip.write(`${line}\n`, 'utf-8')) {
      await once(this.gzip, 'drain');
    }
  }
}

export function csvField(value: string): string {
  if (!/[",\n\r]/.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
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

function msUntilNextLocalTime(hour: number, minute: number): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

function formatTimestampForFile(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
    '-',
    process.pid.toString(),
  ].join('');
}
