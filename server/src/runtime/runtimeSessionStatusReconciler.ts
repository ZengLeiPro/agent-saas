import { updateSessionMeta } from '../data/transcripts/meta.js';
import {
  PgSessionLock,
  type PgSessionLockMode,
  type PgSessionLockOptions,
} from './pgSessionLock.js';
import type { RunStatus } from './runStore.js';
import type { PgPool } from './runStoreTypes.js';
import type { RuntimeSessionStatus, SessionCatalog } from './sessionCatalog.js';

const ACTIVE_RUN_STATUSES = [
  'pending',
  'running',
  'waiting_approval',
  'waiting_user',
  'waiting_hand',
] as const;
const ACTIVE_SESSION_STATUSES = ['running', 'waiting_approval'] as const;
const TERMINAL_RUN_STATUSES = ['completed', 'failed', 'cancelled', 'orphaned'] as const;

export interface RuntimeSessionStatusCandidate {
  sessionId: string;
  tenantId: string;
  transcriptPath?: string;
  username?: string;
  title?: string;
  kind: 'user' | 'subagent';
  projectionStatus?: string;
  metaStatus?: string;
  latestRunId: string;
  latestRunStatus: Extract<RunStatus, 'completed' | 'failed' | 'cancelled' | 'orphaned'>;
  latestRunUpdatedAt: string;
}

export interface RuntimeSessionStatusInspection {
  projectionStatus?: string;
  metaStatus?: string;
  latestRunId?: string;
  latestRunStatus?: RunStatus;
  activeRunStatus?: RunStatus;
}

export interface RuntimeSessionStatusReconciliationStore {
  listCandidates(limit: number): Promise<RuntimeSessionStatusCandidate[]>;
  inspect(sessionId: string): Promise<RuntimeSessionStatusInspection | null>;
  closeProjectionIfStillStale(
    candidate: RuntimeSessionStatusCandidate,
    target: RuntimeSessionStatus,
  ): Promise<boolean>;
}

export interface RuntimeSessionStatusReconciliationOutcome {
  sessionId: string;
  latestRunId: string;
  latestRunStatus: RuntimeSessionStatusCandidate['latestRunStatus'];
  target: RuntimeSessionStatus;
  result: 'planned' | 'repaired' | 'repaired_without_meta' | 'locked' | 'changed' | 'failed';
  error?: string;
}

export interface RuntimeSessionStatusReconciliationSummary {
  scanned: number;
  repaired: number;
  missingMeta: number;
  skippedLocked: number;
  skippedChanged: number;
  failed: number;
  outcomes: RuntimeSessionStatusReconciliationOutcome[];
}

interface RuntimeSessionStatusReconcilerOptions {
  store: RuntimeSessionStatusReconciliationStore;
  /** Tenant-scoped mutual exclusion for status repair. */
  sessionLock: Pick<PgSessionLock, 'tryAcquire'>;
  updateMetaStatus: (
    sessionId: string,
    status: RuntimeSessionStatus,
    transcriptPath?: string,
  ) => Promise<boolean>;
  logger?: { info(message: string): void; warn(message: string): void };
  batchSize?: number;
  scanIntervalMs?: number;
  now?: () => number;
}

export class RuntimeSessionStatusReconciler {
  private readonly batchSize: number;
  private readonly scanIntervalMs: number;
  private readonly now: () => number;
  private nextScanAt = 0;
  private scanning = false;

  constructor(private readonly options: RuntimeSessionStatusReconcilerOptions) {
    this.batchSize = Math.max(1, Math.min(500, Math.trunc(options.batchSize ?? 100)));
    this.scanIntervalMs = Math.max(1_000, options.scanIntervalMs ?? 10_000);
    this.now = options.now ?? Date.now;
  }

  async runOnce(
    input: { execute?: boolean; limit?: number } = {},
  ): Promise<RuntimeSessionStatusReconciliationSummary> {
    const execute = input.execute ?? true;
    const limit = Math.max(1, Math.min(10_000, Math.trunc(input.limit ?? this.batchSize)));
    const candidates = await this.options.store.listCandidates(limit);
    const outcomes: RuntimeSessionStatusReconciliationOutcome[] = [];
    for (const candidate of candidates) {
      const target = runtimeSessionStatusForTerminalRun(candidate.kind, candidate.latestRunStatus);
      if (!execute) {
        outcomes.push(candidateOutcome(candidate, target, 'planned'));
        continue;
      }
      outcomes.push(await this.repairCandidate(candidate, target));
    }
    return summarize(outcomes);
  }

  /** RuntimeScheduler 每轮调用；内部限频且从不把对账失败扩散到调度主循环。 */
  async runIfDue(): Promise<void> {
    const now = this.now();
    if (this.scanning || now < this.nextScanAt) return;
    this.scanning = true;
    this.nextScanAt = now + this.scanIntervalMs;
    try {
      const summary = await this.runOnce();
      if (summary.repaired === this.batchSize) this.nextScanAt = 0;
      if (summary.scanned > 0 || summary.failed > 0) {
        this.options.logger?.info(
          `[runtime-session-status] scanned=${summary.scanned} repaired=${summary.repaired} missingMeta=${summary.missingMeta} locked=${summary.skippedLocked} changed=${summary.skippedChanged} failed=${summary.failed}`,
        );
      }
    } catch (error) {
      this.options.logger?.warn(
        `[runtime-session-status] scan failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.scanning = false;
    }
  }

  private async repairCandidate(
    candidate: RuntimeSessionStatusCandidate,
    target: RuntimeSessionStatus,
  ): Promise<RuntimeSessionStatusReconciliationOutcome> {
    let lock: Awaited<ReturnType<PgSessionLock['tryAcquire']>>;
    try {
      lock = await this.options.sessionLock.tryAcquire(candidate.tenantId, candidate.sessionId);
    } catch (error) {
      return candidateOutcome(candidate, target, 'failed', error);
    }
    if (!lock) return candidateOutcome(candidate, target, 'locked');
    try {
      const before = await this.options.store.inspect(candidate.sessionId);
      if (!matchesCandidate(before, candidate))
        return candidateOutcome(candidate, target, 'changed');
      const updatedMeta = await this.options.updateMetaStatus(
        candidate.sessionId,
        target,
        candidate.transcriptPath,
      );
      if (await this.options.store.closeProjectionIfStillStale(candidate, target)) {
        return candidateOutcome(
          candidate,
          target,
          updatedMeta ? 'repaired' : 'repaired_without_meta',
        );
      }
      const after = await this.options.store.inspect(candidate.sessionId);
      if (after?.activeRunStatus) {
        await this.options.updateMetaStatus(
          candidate.sessionId,
          sessionStatusForActiveRun(after.activeRunStatus),
          candidate.transcriptPath,
        );
        return candidateOutcome(candidate, target, 'changed');
      }
      if (after?.projectionStatus === target && after.metaStatus === target) {
        return candidateOutcome(candidate, target, 'repaired');
      }
      return candidateOutcome(candidate, target, 'changed');
    } catch (error) {
      return candidateOutcome(candidate, target, 'failed', error);
    } finally {
      await lock.release();
    }
  }
}

export class PgRuntimeSessionStatusReconciliationStore implements RuntimeSessionStatusReconciliationStore {
  private readonly sessionsTable: string;
  private readonly runsTable: string;

  constructor(
    private readonly options: {
      pool: PgPool;
      sessionsTable: string;
      runsTable: string;
    },
  ) {
    this.sessionsTable = trustedIdentifier(options.sessionsTable);
    this.runsTable = trustedIdentifier(options.runsTable);
  }

  async listCandidates(limit: number): Promise<RuntimeSessionStatusCandidate[]> {
    const result = await this.options.pool.query<CandidateRow>(
      `
      SELECT
        session.session_id,
        session.tenant_id,
        session.meta_json->>'transcriptPath' AS transcript_path,
        session.username,
        session.title,
        CASE WHEN session.kind = 'subagent' OR session.meta_json->>'kind' = 'subagent'
          THEN 'subagent' ELSE 'user' END AS kind,
        session.runtime_status,
        session.meta_json->>'runtimeStatus' AS meta_status,
        latest.run_id AS latest_run_id,
        latest.status AS latest_run_status,
        latest.updated_at AS latest_run_updated_at
      FROM ${this.sessionsTable} session
      JOIN LATERAL (
        SELECT run_id, status, updated_at
        FROM ${this.runsTable} run
        WHERE run.session_id = session.session_id
          AND COALESCE(run.metadata->>'sandboxCleanupCarrier', 'false') <> 'true'
        ORDER BY run.updated_at DESC, run.enqueue_seq DESC
        LIMIT 1
      ) latest ON latest.status = ANY($1::text[])
      WHERE session.deleted_at IS NULL
        AND (session.runtime_status = ANY($2::text[]) OR session.meta_json->>'runtimeStatus' = ANY($2::text[]))
        AND NOT EXISTS (
          SELECT 1 FROM ${this.runsTable} active
          WHERE active.session_id = session.session_id AND active.status = ANY($3::text[])
        )
      ORDER BY latest.updated_at ASC, session.session_id ASC
      LIMIT $4
    `,
      [TERMINAL_RUN_STATUSES, ACTIVE_SESSION_STATUSES, ACTIVE_RUN_STATUSES, limit],
    );
    return result.rows.map(rowToCandidate);
  }

  async inspect(sessionId: string): Promise<RuntimeSessionStatusInspection | null> {
    const result = await this.options.pool.query<InspectionRow>(
      `
      SELECT
        session.runtime_status,
        session.meta_json->>'runtimeStatus' AS meta_status,
        latest.run_id AS latest_run_id,
        latest.status AS latest_run_status,
        active.status AS active_run_status
      FROM ${this.sessionsTable} session
      LEFT JOIN LATERAL (
        SELECT run_id, status
        FROM ${this.runsTable} run
        WHERE run.session_id = session.session_id
          AND COALESCE(run.metadata->>'sandboxCleanupCarrier', 'false') <> 'true'
        ORDER BY run.updated_at DESC, run.enqueue_seq DESC
        LIMIT 1
      ) latest ON TRUE
      LEFT JOIN LATERAL (
        SELECT status
        FROM ${this.runsTable} run
        WHERE run.session_id = session.session_id AND run.status = ANY($2::text[])
        ORDER BY run.updated_at DESC, run.enqueue_seq DESC
        LIMIT 1
      ) active ON TRUE
      WHERE session.session_id = $1
    `,
      [sessionId, ACTIVE_RUN_STATUSES],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      ...(row.runtime_status ? { projectionStatus: row.runtime_status } : {}),
      ...(row.meta_status ? { metaStatus: row.meta_status } : {}),
      ...(row.latest_run_id ? { latestRunId: row.latest_run_id } : {}),
      ...(row.latest_run_status ? { latestRunStatus: row.latest_run_status } : {}),
      ...(row.active_run_status ? { activeRunStatus: row.active_run_status } : {}),
    };
  }

  async closeProjectionIfStillStale(
    candidate: RuntimeSessionStatusCandidate,
    target: RuntimeSessionStatus,
  ): Promise<boolean> {
    const result = await this.options.pool.query(
      `
      UPDATE ${this.sessionsTable} session
      SET runtime_status = $2,
          meta_json = jsonb_set(session.meta_json, '{runtimeStatus}', to_jsonb($2::text), true)
      WHERE session.session_id = $1
        AND (session.runtime_status = ANY($5::text[]) OR session.meta_json->>'runtimeStatus' = ANY($5::text[]))
        AND NOT EXISTS (
          SELECT 1 FROM ${this.runsTable} active
          WHERE active.session_id = session.session_id AND active.status = ANY($6::text[])
        )
        AND $3 = (
          SELECT latest.run_id FROM ${this.runsTable} latest
          WHERE latest.session_id = session.session_id
            AND COALESCE(latest.metadata->>'sandboxCleanupCarrier', 'false') <> 'true'
          ORDER BY latest.updated_at DESC, latest.enqueue_seq DESC LIMIT 1
        )
        AND $4 = (
          SELECT latest.status FROM ${this.runsTable} latest
          WHERE latest.session_id = session.session_id
            AND COALESCE(latest.metadata->>'sandboxCleanupCarrier', 'false') <> 'true'
          ORDER BY latest.updated_at DESC, latest.enqueue_seq DESC LIMIT 1
        )
    `,
      [
        candidate.sessionId,
        target,
        candidate.latestRunId,
        candidate.latestRunStatus,
        ACTIVE_SESSION_STATUSES,
        ACTIVE_RUN_STATUSES,
      ],
    );
    return (result.rowCount ?? 0) === 1;
  }
}

export function createSessionCatalogRuntimeStatusWriter(
  sessionCatalog: Pick<SessionCatalog, 'findTranscriptPath'>,
): RuntimeSessionStatusReconcilerOptions['updateMetaStatus'] {
  return async (sessionId, status, projectedTranscriptPath) => {
    if (projectedTranscriptPath) {
      const projected = await updateSessionMeta(projectedTranscriptPath, { runtimeStatus: status });
      if (projected) return true;
    }
    const transcriptPath = await sessionCatalog.findTranscriptPath(sessionId);
    if (!transcriptPath || transcriptPath === projectedTranscriptPath) return false;
    return (await updateSessionMeta(transcriptPath, { runtimeStatus: status })) !== null;
  };
}

export async function createRuntimeSessionLock(
  pool: PgPool,
  tablePrefix: string | undefined,
  mode: PgSessionLockMode,
  logger: PgSessionLockOptions['logger'],
): Promise<PgSessionLock> {
  const lock = new PgSessionLock({ pool, tablePrefix, mode, logger });
  await lock.init();
  return lock;
}

export function createPgRuntimeSessionStatusReconciler(
  pool: PgPool,
  sessionsTable: string,
  runsTable: string,
  sessionLock: PgSessionLock,
  sessionCatalog: Pick<SessionCatalog, 'findTranscriptPath'>,
  logger: RuntimeSessionStatusReconcilerOptions['logger'],
): RuntimeSessionStatusReconciler {
  return new RuntimeSessionStatusReconciler({
    store: new PgRuntimeSessionStatusReconciliationStore({ pool, sessionsTable, runsTable }),
    sessionLock,
    updateMetaStatus: createSessionCatalogRuntimeStatusWriter(sessionCatalog),
    logger,
  });
}

export function runtimeSessionStatusForTerminalRun(
  kind: RuntimeSessionStatusCandidate['kind'],
  status: RuntimeSessionStatusCandidate['latestRunStatus'],
): RuntimeSessionStatus {
  if (kind === 'subagent') return status === 'completed' ? 'finished' : 'error';
  if (status === 'completed' || status === 'cancelled') return 'idle';
  return 'error';
}

function sessionStatusForActiveRun(status: RunStatus): RuntimeSessionStatus {
  return status === 'waiting_approval' ? 'waiting_approval' : 'running';
}

function matchesCandidate(
  inspection: RuntimeSessionStatusInspection | null,
  candidate: RuntimeSessionStatusCandidate,
): boolean {
  return Boolean(
    inspection &&
    !inspection.activeRunStatus &&
    inspection.latestRunId === candidate.latestRunId &&
    inspection.latestRunStatus === candidate.latestRunStatus &&
    (isActiveSessionStatus(inspection.projectionStatus) ||
      isActiveSessionStatus(inspection.metaStatus)),
  );
}

function isActiveSessionStatus(status: string | undefined): boolean {
  return ACTIVE_SESSION_STATUSES.includes(status as (typeof ACTIVE_SESSION_STATUSES)[number]);
}

function candidateOutcome(
  candidate: RuntimeSessionStatusCandidate,
  target: RuntimeSessionStatus,
  result: RuntimeSessionStatusReconciliationOutcome['result'],
  error?: unknown,
): RuntimeSessionStatusReconciliationOutcome {
  return {
    sessionId: candidate.sessionId,
    latestRunId: candidate.latestRunId,
    latestRunStatus: candidate.latestRunStatus,
    target,
    result,
    ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
  };
}

function summarize(
  outcomes: RuntimeSessionStatusReconciliationOutcome[],
): RuntimeSessionStatusReconciliationSummary {
  const count = (result: RuntimeSessionStatusReconciliationOutcome['result']): number =>
    outcomes.filter((outcome) => outcome.result === result).length;
  return {
    scanned: outcomes.length,
    repaired: count('repaired') + count('repaired_without_meta'),
    missingMeta: count('repaired_without_meta'),
    skippedLocked: count('locked'),
    skippedChanged: count('changed'),
    failed: count('failed'),
    outcomes,
  };
}

function trustedIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error(`非法 PG identifier：${value}`);
  return value;
}

interface CandidateRow {
  session_id: string;
  tenant_id: string;
  transcript_path: string | null;
  username: string | null;
  title: string | null;
  kind: 'user' | 'subagent';
  runtime_status: string | null;
  meta_status: string | null;
  latest_run_id: string;
  latest_run_status: RuntimeSessionStatusCandidate['latestRunStatus'];
  latest_run_updated_at: Date | string;
}

interface InspectionRow {
  runtime_status: string | null;
  meta_status: string | null;
  latest_run_id: string | null;
  latest_run_status: RunStatus | null;
  active_run_status: RunStatus | null;
}

function rowToCandidate(row: CandidateRow): RuntimeSessionStatusCandidate {
  return {
    sessionId: row.session_id,
    tenantId: row.tenant_id,
    ...(row.transcript_path ? { transcriptPath: row.transcript_path } : {}),
    ...(row.username ? { username: row.username } : {}),
    ...(row.title ? { title: row.title } : {}),
    kind: row.kind,
    ...(row.runtime_status ? { projectionStatus: row.runtime_status } : {}),
    ...(row.meta_status ? { metaStatus: row.meta_status } : {}),
    latestRunId: row.latest_run_id,
    latestRunStatus: row.latest_run_status,
    latestRunUpdatedAt: new Date(row.latest_run_updated_at).toISOString(),
  };
}
