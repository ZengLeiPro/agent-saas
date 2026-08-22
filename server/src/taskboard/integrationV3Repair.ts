import type { PoolClient } from 'pg';

import { integrationCandidateTableNames } from './integrationCandidateSchema.js';
import type { TaskboardIdentity } from './types.js';

export const INTEGRATION_V3_ACTIVE_EXECUTION_STATUSES = ['queued', 'running', 'waiting_user', 'waiting_approval'] as const;
export const INTEGRATION_V3_TERMINAL_TASK_STATUSES = ['done', 'canceled'] as const;
export const INTEGRATION_V3_TERMINAL_CANDIDATE_STATES = ['merged', 'canceled'] as const;

export interface IntegrationV3RepairTables {
  tasks: string;
  executions: string;
  lanes: string;
  candidates: string;
  providerOperations: string;
  requestsOutbox: string;
}

export type IntegrationV3RepairFindingType =
  | 'terminal_task_owns_lane'
  | 'active_lane_missing_candidate'
  | 'active_execution_epoch_mismatch'
  | 'unknown_provider_operation'
  | 'stale_cleanup_request'
  | 'stale_request_outbox';

export type IntegrationV3RepairDisposition = 'auto_repair' | 'needs_human';

export interface IntegrationV3RepairFinding {
  type: IntegrationV3RepairFindingType;
  disposition: IntegrationV3RepairDisposition;
  taskId?: string;
  candidateId?: string;
  repositoryId?: string;
  executionId?: string;
  operationId?: string;
  outboxId?: string;
  detail: Record<string, unknown>;
}

export interface IntegrationV3RepairScanOptions {
  unknownAfterMs?: number;
  staleOutboxAfterMs?: number;
  taskId?: string;
}

export interface IntegrationV3RepairApplyResult {
  finding: IntegrationV3RepairFinding;
  outcome: 'repaired' | 'needs_human' | 'no_longer_present';
}

export interface IntegrationV3RequeueResult {
  candidateId: string;
  taskId: string;
  previousError: string;
  recoveryKind: 'worker' | 'cleanup';
  outboxId?: string;
  status: 'idle';
}

type Queryable = Pick<PoolClient, 'query'>;

const DEFAULT_UNKNOWN_AFTER_MS = 5 * 60_000;
const DEFAULT_STALE_OUTBOX_AFTER_MS = 15 * 60_000;

/**
 * Scans only durable facts. No provider response is inferred from timestamps.
 * Every query is independently useful so a partially unavailable projection fails the scan,
 * rather than silently publishing an incomplete health result.
 */
export async function scanIntegrationV3Invariants(
  db: Queryable,
  tables: IntegrationV3RepairTables,
  options: IntegrationV3RepairScanOptions = {},
): Promise<IntegrationV3RepairFinding[]> {
  const taskId = options.taskId ?? null;
  const unknownBefore = new Date(Date.now() - Math.max(0, options.unknownAfterMs ?? DEFAULT_UNKNOWN_AFTER_MS));
  const outboxBefore = new Date(Date.now() - Math.max(0, options.staleOutboxAfterMs ?? DEFAULT_STALE_OUTBOX_AFTER_MS));
  const findings: IntegrationV3RepairFinding[] = [];

  const terminalLanes = await db.query(
    `SELECT l.repository_id,l.active_integration_task_id AS task_id,l.epoch,c.id AS candidate_id,
            c.state AS candidate_state,
            EXISTS (SELECT 1 FROM ${tables.providerOperations} o
              WHERE o.candidate_id=c.id AND o.state IN ('executing','unknown')) AS uncertain_operation
       FROM ${tables.lanes} l
       JOIN ${tables.tasks} t ON t.id=l.active_integration_task_id
       LEFT JOIN ${tables.candidates} c ON c.integration_task_id=t.id
      WHERE t.workflow_version=3 AND t.status IN ('done','canceled')
        AND ($1::text IS NULL OR t.id=$1)`,
    [taskId],
  );
  for (const row of terminalLanes.rows) {
    const safe = row.uncertain_operation !== true
      && (!row.candidate_id || INTEGRATION_V3_TERMINAL_CANDIDATE_STATES.includes(String(row.candidate_state) as never));
    findings.push({
      type: 'terminal_task_owns_lane', disposition: safe ? 'auto_repair' : 'needs_human',
      taskId: String(row.task_id), repositoryId: String(row.repository_id),
      ...(row.candidate_id ? { candidateId: String(row.candidate_id) } : {}),
      detail: { laneEpoch: String(row.epoch), candidateState: row.candidate_state ?? null, uncertainOperation: row.uncertain_operation === true },
    });
  }

  const missingCandidates = await db.query(
    `SELECT l.repository_id,l.active_integration_task_id AS task_id,l.epoch,t.status AS task_status
       FROM ${tables.lanes} l
       JOIN ${tables.tasks} t ON t.id=l.active_integration_task_id
       LEFT JOIN ${tables.candidates} c ON c.integration_task_id=t.id
      WHERE t.workflow_version=3 AND c.id IS NULL
        AND ($1::text IS NULL OR t.id=$1)`,
    [taskId],
  );
  for (const row of missingCandidates.rows) {
    const safe = INTEGRATION_V3_TERMINAL_TASK_STATUSES.includes(String(row.task_status) as never);
    findings.push({
      type: 'active_lane_missing_candidate', disposition: safe ? 'auto_repair' : 'needs_human',
      taskId: String(row.task_id), repositoryId: String(row.repository_id),
      detail: { laneEpoch: String(row.epoch), taskStatus: String(row.task_status) },
    });
  }

  const epochMismatches = await db.query(
    `SELECT e.id AS execution_id,e.task_id,e.run_id,e.candidate_id,e.candidate_workflow_epoch,
            e.candidate_lane_epoch,c.workflow_epoch,c.lane_epoch,l.epoch AS current_lane_epoch,
            l.repository_id
       FROM ${tables.executions} e
       JOIN ${tables.candidates} c ON c.id=e.candidate_id
       JOIN ${tables.lanes} l ON l.repository_id=c.repository_id
      WHERE e.status IN ('queued','running','waiting_user','waiting_approval')
        AND e.transitioned_at IS NULL AND e.superseded_at IS NULL
        AND (e.candidate_workflow_epoch IS DISTINCT FROM c.workflow_epoch
          OR e.candidate_lane_epoch IS DISTINCT FROM c.lane_epoch
          OR e.candidate_lane_epoch IS DISTINCT FROM l.epoch
          OR l.active_integration_task_id IS DISTINCT FROM e.task_id)
        AND ($1::text IS NULL OR e.task_id=$1)`,
    [taskId],
  );
  for (const row of epochMismatches.rows) {
    findings.push({
      type: 'active_execution_epoch_mismatch', disposition: 'auto_repair',
      taskId: String(row.task_id), candidateId: String(row.candidate_id), executionId: String(row.execution_id),
      repositoryId: String(row.repository_id),
      detail: {
        runId: String(row.run_id), executionWorkflowEpoch: String(row.candidate_workflow_epoch),
        candidateWorkflowEpoch: String(row.workflow_epoch), executionLaneEpoch: String(row.candidate_lane_epoch),
        candidateLaneEpoch: String(row.lane_epoch), currentLaneEpoch: String(row.current_lane_epoch),
      },
    });
  }

  const unknownOperations = await db.query(
    `SELECT o.id,o.kind,o.state,o.candidate_id,o.updated_at,c.integration_task_id,c.repository_id
       FROM ${tables.providerOperations} o
       JOIN ${tables.candidates} c ON c.id=o.candidate_id
      WHERE (o.state='unknown' OR (o.state='executing' AND o.updated_at <= $1))
        AND ($2::text IS NULL OR c.integration_task_id=$2)`,
    [unknownBefore, taskId],
  );
  for (const row of unknownOperations.rows) {
    findings.push({
      type: 'unknown_provider_operation', disposition: 'needs_human', operationId: String(row.id),
      candidateId: String(row.candidate_id), taskId: String(row.integration_task_id), repositoryId: String(row.repository_id),
      detail: { kind: String(row.kind), state: String(row.state), updatedAt: new Date(row.updated_at as string | Date).toISOString() },
    });
  }

  const staleOutbox = await db.query(
    `SELECT o.id,o.kind,o.status,o.candidate_id,o.candidate_revision,o.workflow_epoch,o.lane_epoch,
            o.lease_expires_at,o.updated_at,c.integration_task_id,c.repository_id,c.current_revision,
            c.workflow_epoch AS current_workflow_epoch,c.lane_epoch AS current_candidate_lane_epoch,
            c.state AS candidate_state,l.epoch AS current_lane_epoch,l.active_integration_task_id
       FROM ${tables.requestsOutbox} o
       JOIN ${tables.candidates} c ON c.id=o.candidate_id
       JOIN ${tables.lanes} l ON l.repository_id=c.repository_id
      WHERE o.status IN ('pending','processing','failed')
        AND o.updated_at <= $1
        AND ($2::text IS NULL OR c.integration_task_id=$2)`,
    [outboxBefore, taskId],
  );
  for (const row of staleOutbox.rows) {
    const cleanup = row.kind === 'cleanup';
    const current = Number(row.candidate_revision) === Number(row.current_revision)
      && String(row.workflow_epoch) === String(row.current_workflow_epoch)
      && String(row.lane_epoch) === String(row.current_candidate_lane_epoch)
      && String(row.lane_epoch) === String(row.current_lane_epoch)
      && String(row.active_integration_task_id ?? '') === String(row.integration_task_id)
      && !INTEGRATION_V3_TERMINAL_CANDIDATE_STATES.includes(String(row.candidate_state) as never);
    const leaseExpired = row.status === 'processing' && row.lease_expires_at
      && new Date(row.lease_expires_at as string | Date).getTime() <= Date.now();
    findings.push({
      type: cleanup ? 'stale_cleanup_request' : 'stale_request_outbox',
      disposition: cleanup ? 'needs_human' : (!current || leaseExpired ? 'auto_repair' : 'needs_human'),
      outboxId: String(row.id), candidateId: String(row.candidate_id), taskId: String(row.integration_task_id),
      repositoryId: String(row.repository_id),
      detail: { kind: String(row.kind), status: String(row.status), current, leaseExpired: Boolean(leaseExpired), updatedAt: new Date(row.updated_at as string | Date).toISOString() },
    });
  }
  return deduplicate(findings);
}

/** Applies only monotonic fencing/release or removal from a retry queue. */
export async function applyIntegrationV3Repair(
  db: Queryable,
  tables: IntegrationV3RepairTables,
  finding: IntegrationV3RepairFinding,
): Promise<IntegrationV3RepairApplyResult> {
  if (finding.disposition === 'needs_human') {
    if (finding.type === 'unknown_provider_operation' && finding.operationId) {
      await db.query(
        `UPDATE ${tables.providerOperations}
            SET state='needs_human',error=COALESCE(error,'repair scan: provider result is ambiguous'),updated_at=now()
          WHERE id=$1 AND state IN ('unknown','executing')`,
        [finding.operationId],
      );
    }
    return { finding, outcome: 'needs_human' };
  }
  if ((finding.type === 'terminal_task_owns_lane' || finding.type === 'active_lane_missing_candidate')
    && finding.repositoryId && finding.taskId) {
    const result = await db.query(
      `UPDATE ${tables.lanes}
          SET active_integration_task_id=NULL,lease_id=NULL,epoch=epoch+1,updated_at=now()
        WHERE repository_id=$1 AND active_integration_task_id=$2 RETURNING repository_id`,
      [finding.repositoryId, finding.taskId],
    );
    return { finding, outcome: result.rows[0] ? 'repaired' : 'no_longer_present' };
  }
  if (finding.type === 'active_execution_epoch_mismatch' && finding.executionId) {
    const result = await db.query(
      `UPDATE ${tables.executions}
          SET status='cancelled',finished_at=COALESCE(finished_at,now()),superseded_at=COALESCE(superseded_at,now()),
              fence_epoch=fence_epoch+1,terminal_reason_code='integration_v3_epoch_mismatch',updated_at=now()
        WHERE id=$1 AND status IN ('queued','running','waiting_user','waiting_approval')
          AND transitioned_at IS NULL AND superseded_at IS NULL RETURNING id`,
      [finding.executionId],
    );
    return { finding, outcome: result.rows[0] ? 'repaired' : 'no_longer_present' };
  }
  if (finding.type === 'stale_request_outbox' && finding.outboxId) {
    const current = finding.detail.current === true;
    const leaseExpired = finding.detail.leaseExpired === true;
    const result = current && leaseExpired
      ? await db.query(
        `UPDATE ${tables.requestsOutbox}
            SET status='pending',lease_id=NULL,lease_expires_at=NULL,available_at=now(),
                last_error='repair scan: expired processing lease',updated_at=now()
          WHERE id=$1 AND status='processing' AND lease_expires_at <= now() RETURNING id`, [finding.outboxId])
      : await db.query(
        `UPDATE ${tables.requestsOutbox}
            SET status='failed',lease_id=NULL,lease_expires_at=NULL,
                last_error=COALESCE(last_error,'repair scan: stale candidate fence'),updated_at=now()
          WHERE id=$1 AND status IN ('pending','processing') RETURNING id`, [finding.outboxId]);
    return { finding, outcome: result.rows[0] ? 'repaired' : 'no_longer_present' };
  }
  return { finding, outcome: 'needs_human' };
}

/**
 * Explicit operator requeue for either a permanently failed nonterminal worker or the failed
 * cleanup request of a terminal candidate. Cleanup recovery is fenced to the candidate's current
 * revision and epochs, and only requeues the cleanup outbox row (never provider operations).
 * The caller owns the transaction and authorization; recovery and audit use the same client.
 */
export async function requeueFailedIntegrationV3Candidate(
  db: Queryable,
  tables: Pick<IntegrationV3RepairTables, 'candidates' | 'requestsOutbox'> & { changes: string },
  input: { taskId: string; actorId: string; reason: string },
): Promise<IntegrationV3RequeueResult | undefined> {
  const result = await db.query(
    `WITH current_candidate AS (
       SELECT id,integration_task_id,current_revision,work_round,workflow_epoch,lane_epoch,state,
              worker_status,worker_error,worker_lease_id
         FROM ${tables.candidates}
        WHERE integration_task_id=$1
        FOR UPDATE
     ), worker_requeued AS (
       UPDATE ${tables.candidates} c
          SET worker_status='idle',worker_error=NULL,worker_lease_id=NULL,worker_lease_expires_at=NULL,
              worker_checkpoint=COALESCE(c.worker_checkpoint,'{}'::jsonb)||jsonb_build_object(
                'requeuedAt',now(),'requeuedBy',$2::text,'requeueReason',$3::text),updated_at=now()
         FROM current_candidate current
        WHERE c.id=current.id AND current.worker_status='failed'
          AND current.worker_lease_id IS NULL AND current.state NOT IN ('merged','canceled')
        RETURNING c.id,c.integration_task_id,current.worker_error AS previous_error
     ), failed_request AS (
       SELECT o.id
         FROM ${tables.requestsOutbox} o
         JOIN current_candidate c ON c.id=o.candidate_id
        WHERE EXISTS (SELECT 1 FROM worker_requeued)
          AND o.status='failed' AND o.lease_id IS NULL
          AND o.candidate_revision=c.current_revision
          AND o.workflow_epoch=c.workflow_epoch AND o.lane_epoch=c.lane_epoch
          AND ((o.kind='work' AND c.state='working' AND o.work_round=c.work_round)
            OR (o.kind='review' AND c.state='in_review'))
        ORDER BY o.updated_at DESC,o.id
        FOR UPDATE OF o SKIP LOCKED LIMIT 1
     ), request_requeued AS (
       UPDATE ${tables.requestsOutbox} o
          SET status='pending',attempts=0,available_at=now(),lease_id=NULL,lease_expires_at=NULL,
              last_error=NULL,updated_at=now()
         FROM failed_request failed WHERE o.id=failed.id
        RETURNING o.id AS outbox_id
     ), failed_cleanup AS (
       SELECT o.id,o.candidate_id,o.last_error
         FROM ${tables.requestsOutbox} o
         JOIN current_candidate c ON c.id=o.candidate_id
        WHERE NOT EXISTS (SELECT 1 FROM worker_requeued)
          AND c.state IN ('merged','canceled')
          AND o.kind='cleanup' AND o.status='failed' AND o.lease_id IS NULL
          AND o.candidate_revision=c.current_revision
          AND o.workflow_epoch=c.workflow_epoch AND o.lane_epoch=c.lane_epoch
        ORDER BY o.updated_at DESC,o.id
        FOR UPDATE OF o SKIP LOCKED LIMIT 1
     ), cleanup_requeued AS (
       UPDATE ${tables.requestsOutbox} o
          SET status='pending',attempts=0,available_at=now(),lease_id=NULL,lease_expires_at=NULL,
              last_error=NULL,updated_at=now()
         FROM failed_cleanup failed
        WHERE o.id=failed.id
        RETURNING o.id AS outbox_id,o.candidate_id,failed.last_error AS previous_error
     )
     SELECT worker.id,worker.integration_task_id,worker.previous_error,
            'worker'::text AS recovery_kind,
            (SELECT request.outbox_id::text FROM request_requeued request) AS outbox_id,'idle'::text AS status
       FROM worker_requeued worker
     UNION ALL
     SELECT cleanup.candidate_id,c.integration_task_id,cleanup.previous_error,
            'cleanup'::text AS recovery_kind,cleanup.outbox_id,'idle'::text AS status
       FROM cleanup_requeued cleanup JOIN current_candidate c ON c.id=cleanup.candidate_id`,
    [input.taskId, input.actorId, input.reason],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  const recoveryKind = String(row.recovery_kind) as IntegrationV3RequeueResult['recoveryKind'];
  const previousError = String(row.previous_error ?? `unknown ${recoveryKind} failure`);
  const candidateId = String(row.id ?? row.candidate_id);
  const outboxId = row.outbox_id == null ? undefined : String(row.outbox_id);
  await db.query(
    `INSERT INTO ${tables.changes}(task_id,change_type,actor_type,actor_id,payload,tombstone)
     VALUES ($1,'integration.v3.worker_requeued','user',$2,$3::jsonb,false)`,
    [input.taskId, input.actorId, JSON.stringify({ candidateId, reason: input.reason, previousError, recoveryKind, ...(outboxId ? { outboxId } : {}) })],
  );
  return {
    candidateId, taskId: String(row.integration_task_id), previousError, recoveryKind,
    ...(outboxId ? { outboxId } : {}), status: String(row.status) as IntegrationV3RequeueResult['status'],
  };
}

export function createIntegrationV3RequeueHandler(store: {
  pool: { connect(): Promise<PoolClient> };
  integrationSourcesTable: string;
  changesTable: string;
}) {
  const { candidatesTable: candidates, requestsOutboxTable: requestsOutbox }
    = integrationCandidateTableNames(store.integrationSourcesTable);
  return async (input: { identity: TaskboardIdentity; taskId: string; reason: string }) => {
    const client = await store.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await requeueFailedIntegrationV3Candidate(client, { candidates, requestsOutbox, changes: store.changesTable }, {
        taskId: input.taskId, actorId: input.identity.ownerUserId, reason: input.reason,
      });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  };
}

/** Ownership changes are always fenced by a fresh epoch, for both acquire and release. */
export async function changeIntegrationLaneOwner(
  db: Queryable,
  lanesTable: string,
  input: { repositoryId: string; expectedOwnerTaskId: string | null; nextOwnerTaskId: string | null },
): Promise<{ epoch: string } | null> {
  const result = await db.query(
    `UPDATE ${lanesTable}
        SET active_integration_task_id=$3,lease_id=NULL,epoch=epoch+1,updated_at=now()
      WHERE repository_id=$1 AND active_integration_task_id IS NOT DISTINCT FROM $2
      RETURNING epoch`,
    [input.repositoryId, input.expectedOwnerTaskId, input.nextOwnerTaskId],
  );
  return result.rows[0] ? { epoch: String(result.rows[0].epoch) } : null;
}

function deduplicate(findings: IntegrationV3RepairFinding[]): IntegrationV3RepairFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.type}:${finding.executionId ?? finding.operationId ?? finding.outboxId ?? `${finding.repositoryId}:${finding.taskId}`}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
