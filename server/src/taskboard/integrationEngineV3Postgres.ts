import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

import type { TaskBoardIntegrationCandidate } from '../../../shared/src/types/taskboard.js';
import { rowToIntegrationCandidate, rowToIntegrationCandidateRevision } from './integrationCandidateMapper.js';
import { IntegrationCandidateStore } from './integrationCandidateStore.js';
import type { IntegrationEngineV3CandidateHost, IntegrationEngineV3Current, IntegrationEngineV3FeatureHost, IntegrationEngineV3RequestHost } from './integrationEngineV3.js';
import { TaskboardNotFoundError, TaskboardValidationError } from './types.js';
import type {
  IntegrationProviderOperationRecord,
  IntegrationProviderOperationState,
  IntegrationProviderOperationStorageHost,
} from './integrationProviderOperations.js';

export interface IntegrationEngineV3PostgresOptions {
  pool: Pick<Pool, 'query'>;
  providerOperationsTable: string;
}

/** Durable PostgreSQL implementation of the v3 provider operation ledger. */
export class PostgresIntegrationProviderOperationStorage implements IntegrationProviderOperationStorageHost {
  constructor(private readonly options: IntegrationEngineV3PostgresOptions) {}

  async getByOperationKey(operationKey: string): Promise<IntegrationProviderOperationRecord | undefined> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.options.providerOperationsTable} WHERE operation_key=$1`,
      [operationKey],
    );
    return result.rows[0] ? rowToProviderOperation(result.rows[0]) : undefined;
  }

  async insertPrepared(record: IntegrationProviderOperationRecord): Promise<IntegrationProviderOperationRecord> {
    const result = await this.options.pool.query(
      `INSERT INTO ${this.options.providerOperationsTable}
        (id,operation_key,intent_digest,kind,repository_id,candidate_id,candidate_revision,
         workflow_epoch,lane_epoch,execution_id,expected,command,state,attempt_count,receipt,error,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15::jsonb,$16,$17,$18)
       ON CONFLICT (operation_key) DO NOTHING RETURNING *`,
      [record.id, record.operationKey, record.intentDigest, record.kind, record.repositoryId,
        record.fence.candidateId, record.fence.candidateRevision, record.fence.workflowEpoch,
        record.fence.laneEpoch, record.fence.executionId, JSON.stringify(record.expected),
        JSON.stringify(record.command), record.state, record.attemptCount,
        record.receipt ? JSON.stringify(record.receipt) : null, record.error ?? null,
        record.createdAt, record.updatedAt],
    );
    if (result.rows[0]) return rowToProviderOperation(result.rows[0]);
    const winner = await this.getByOperationKey(record.operationKey);
    if (!winner) throw new Error('Provider operation insert race produced no winning row');
    return winner;
  }

  async compareAndSet(input: {
    id: string;
    expectedState: IntegrationProviderOperationState;
    nextState: IntegrationProviderOperationState;
    patch: Pick<IntegrationProviderOperationRecord, 'attemptCount' | 'updatedAt'> & {
      receipt?: Record<string, unknown>;
      error?: string;
    };
  }): Promise<IntegrationProviderOperationRecord | undefined> {
    const result = await this.options.pool.query(
      `UPDATE ${this.options.providerOperationsTable}
          SET state=$3,attempt_count=$4,updated_at=$5,
              receipt=CASE WHEN $6::boolean THEN $7::jsonb ELSE receipt END,
              error=CASE WHEN $8::boolean THEN $9 ELSE error END
        WHERE id=$1 AND state=$2 RETURNING *`,
      [input.id, input.expectedState, input.nextState, input.patch.attemptCount, input.patch.updatedAt,
        input.patch.receipt !== undefined, input.patch.receipt === undefined ? null : JSON.stringify(input.patch.receipt),
        input.patch.error !== undefined, input.patch.error ?? null],
    );
    return result.rows[0] ? rowToProviderOperation(result.rows[0]) : undefined;
  }
}

export function rowToProviderOperation(row: Record<string, unknown>): IntegrationProviderOperationRecord {
  return {
    id: String(row.id),
    operationKey: String(row.operation_key),
    intentDigest: String(row.intent_digest),
    kind: String(row.kind) as IntegrationProviderOperationRecord['kind'],
    repositoryId: String(row.repository_id),
    fence: {
      candidateId: String(row.candidate_id),
      candidateRevision: Number(row.candidate_revision),
      workflowEpoch: Number(row.workflow_epoch),
      laneEpoch: Number(row.lane_epoch),
      executionId: String(row.execution_id),
    },
    expected: asRecord(row.expected),
    command: asRecord(row.command),
    state: String(row.state) as IntegrationProviderOperationState,
    attemptCount: Number(row.attempt_count),
    ...(row.receipt == null ? {} : { receipt: asRecord(row.receipt) }),
    ...(row.error == null ? {} : { error: String(row.error) }),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') return JSON.parse(value) as Record<string, unknown>;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function toIso(value: unknown): string { return value instanceof Date ? value.toISOString() : String(value); }

export interface PostgresIntegrationEngineV3HostOptions {
  pool: { connect(): Promise<PoolClient>; query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
  tasksTable: string;
  boardsTable: string;
  executionsTable: string;
  integrationSourcesTable: string;
  integrationLanesTable: string;
  candidatesTable: string;
  revisionsTable: string;
  providerOperationsTable: string;
  requestsOutboxTable: string;
}

/** Candidate host used by the real taskboard flow. The merge commit is one DB transaction. */
export class PostgresIntegrationEngineV3CandidateHost implements IntegrationEngineV3CandidateHost {
  private readonly candidates: IntegrationCandidateStore;
  constructor(private readonly options: PostgresIntegrationEngineV3HostOptions) {
    this.candidates = new IntegrationCandidateStore(options);
  }

  async getCurrent(candidateId: string): Promise<IntegrationEngineV3Current> {
    const result = await this.options.pool.query(
      `SELECT c.*,r.candidate_id AS r_candidate_id,r.revision AS r_revision,r.digest_version AS r_digest_version,
              r.base_oid AS r_base_oid,r.head_oid AS r_head_oid,r.tree_oid AS r_tree_oid,
              r.source_set_digest AS r_source_set_digest,r.subject_digest AS r_subject_digest,
              r.policy_snapshot_digest AS r_policy_snapshot_digest,r.policy_revision AS r_policy_revision,
              r.merge_method AS r_merge_method,r.work_round AS r_work_round,
              r.work_execution_id AS r_work_execution_id,r.review_execution_id AS r_review_execution_id,
              r.created_at AS r_created_at
         FROM ${this.options.candidatesTable} c
         LEFT JOIN ${this.options.revisionsTable} r
           ON r.candidate_id=c.id AND r.revision=c.current_revision
        WHERE c.id=$1`, [candidateId]);
    const row = result.rows[0];
    if (!row) throw new TaskboardNotFoundError('Integration candidate not found');
    return {
      candidate: rowToIntegrationCandidate(row),
      ...(Number(row.r_revision ?? 0) > 0 ? { revision: rowToIntegrationCandidateRevision({
        candidate_id: row.r_candidate_id, revision: row.r_revision, digest_version: row.r_digest_version,
        base_oid: row.r_base_oid, head_oid: row.r_head_oid, tree_oid: row.r_tree_oid,
        source_set_digest: row.r_source_set_digest, subject_digest: row.r_subject_digest,
        policy_snapshot_digest: row.r_policy_snapshot_digest, policy_revision: row.r_policy_revision,
        merge_method: row.r_merge_method, work_round: row.r_work_round,
        work_execution_id: row.r_work_execution_id, review_execution_id: row.r_review_execution_id,
        created_at: row.r_created_at,
      }) } : {}),
    };
  }

  appendRevision(candidateId: string, input: Parameters<IntegrationCandidateStore['appendRevision']>[1]) {
    return this.candidates.appendRevision(candidateId, input);
  }
  beginNextWorkRound(candidateId: string, expectedVersion: number, expectedRevision: number) {
    return this.candidates.beginNextWorkRound(candidateId, expectedVersion, expectedRevision);
  }
  transition(candidateId: string, input: Parameters<IntegrationCandidateStore['transition']>[1]) {
    return this.candidates.transition(candidateId, input);
  }

  async commitMerged(input: { candidateId: string; expectedVersion: number; expectedRevision: number; mergedCommitOid: string; providerOperationId: string }): Promise<TaskBoardIntegrationCandidate> {
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(`SELECT * FROM ${this.options.candidatesTable} WHERE id=$1 FOR UPDATE`, [input.candidateId]);
      const row = current.rows[0];
      if (!row) throw new TaskboardNotFoundError('Integration candidate not found');
      const candidate = rowToIntegrationCandidate(row);
      if (candidate.version !== input.expectedVersion || candidate.currentRevision !== input.expectedRevision || candidate.state !== 'merging') {
        throw new TaskboardValidationError('Candidate changed; reload before retrying', 'TASKBOARD_CANDIDATE_CAS_MISMATCH');
      }
      const operation = await client.query(
        `SELECT * FROM ${this.options.providerOperationsTable}
          WHERE id=$1 AND candidate_id=$2 AND candidate_revision=$3 AND workflow_epoch=$4::bigint
            AND lane_epoch=$5::bigint AND kind='merge_pull_request' AND state='succeeded' FOR UPDATE`,
        [input.providerOperationId, candidate.id, candidate.currentRevision, candidate.workflowEpoch, candidate.laneEpoch]);
      const operationRow = operation.rows[0];
      if (!operationRow) throw new TaskboardValidationError('Provider merge operation receipt is absent or fenced', 'TASKBOARD_PROVIDER_OPERATION_FENCE_MISMATCH');
      const revision = await client.query(
        `SELECT subject_digest,head_oid,tree_oid FROM ${this.options.revisionsTable}
          WHERE candidate_id=$1 AND revision=$2 FOR UPDATE`,
        [candidate.id, candidate.currentRevision],
      );
      const revisionRow = revision.rows[0];
      const expected = asRecord(operationRow.expected);
      const command = asRecord(operationRow.command);
      const receipt = asRecord(operationRow.receipt);
      if (!revisionRow
        || String(operationRow.repository_id) !== candidate.repositoryId
        || String(command.providerPullRequestId ?? '') !== String(candidate.providerPullRequestId ?? '')
        || String(command.expectedHeadOid ?? '') !== String(revisionRow.head_oid)
        || String(expected.subjectDigest ?? '') !== String(revisionRow.subject_digest)
        || String(expected.treeOid ?? '') !== String(revisionRow.tree_oid)
        || String(receipt.providerPullRequestId ?? '') !== String(candidate.providerPullRequestId ?? '')
        || String(receipt.mergedCommitOid ?? '') !== input.mergedCommitOid) {
        throw new TaskboardValidationError('Provider merge operation target or receipt does not match the approved revision', 'TASKBOARD_PROVIDER_OPERATION_RECEIPT_MISMATCH');
      }
      const task = await client.query(`SELECT id,workflow_version,workflow_epoch FROM ${this.options.tasksTable} WHERE id=$1 FOR UPDATE`, [candidate.integrationTaskId]);
      if (Number(task.rows[0]?.workflow_version ?? 2) !== 3 || String(task.rows[0]?.workflow_epoch) !== candidate.workflowEpoch) {
        throw new TaskboardValidationError('Integration task workflow fence changed', 'TASKBOARD_INTEGRATION_WORKFLOW_FENCE_MISMATCH');
      }
      const lane = await client.query(
        `SELECT repository_id,active_integration_task_id,epoch FROM ${this.options.integrationLanesTable}
          WHERE repository_id=$1 FOR UPDATE`, [candidate.repositoryId]);
      if (String(lane.rows[0]?.active_integration_task_id ?? '') !== candidate.integrationTaskId
        || String(lane.rows[0]?.epoch) !== candidate.laneEpoch) {
        throw new TaskboardValidationError('Integration lane fence changed', 'TASKBOARD_INTEGRATION_LANE_FENCE_MISMATCH');
      }
      const updated = await client.query(
        `UPDATE ${this.options.candidatesTable}
            SET state='merged',merged_commit_oid=$4,last_error=NULL,version=version+1,updated_at=now()
          WHERE id=$1 AND version=$2 AND current_revision=$3 AND state='merging' RETURNING *`,
        [candidate.id, input.expectedVersion, input.expectedRevision, input.mergedCommitOid]);
      if (!updated.rows[0]) throw new TaskboardValidationError('Candidate changed; reload before retrying', 'TASKBOARD_CANDIDATE_CAS_MISMATCH');
      await client.query(
        `UPDATE ${this.options.integrationSourcesTable}
            SET state='merged',merged_commit_oid=$2,provider_receipt_id=$3,last_error=NULL,updated_at=now()
          WHERE integration_task_id=$1 AND state<>'merged'`,
        [candidate.integrationTaskId, input.mergedCommitOid, input.providerOperationId]);
      await client.query(
        `UPDATE ${this.options.tasksTable} d
            SET status='done',merged_commit_oid=$2,completed_at=COALESCE(completed_at,now()),
                workflow_epoch=workflow_epoch+1,next_action='none',next_action_revision=next_action_revision+1,
                version=version+1,updated_at=now()
          WHERE d.id IN (SELECT delivery_task_id FROM ${this.options.integrationSourcesTable} WHERE integration_task_id=$1)
            AND d.status<>'done'`, [candidate.integrationTaskId, input.mergedCommitOid]);
      await client.query(
        `UPDATE ${this.options.tasksTable}
            SET status='done',merged_commit_oid=$2,completed_at=COALESCE(completed_at,now()),
                workflow_epoch=workflow_epoch+1,next_action='none',next_action_revision=next_action_revision+1,
                version=version+1,updated_at=now()
          WHERE id=$1 AND workflow_version=3`, [candidate.integrationTaskId, input.mergedCommitOid]);
      await client.query(
        `UPDATE ${this.options.integrationLanesTable}
            SET active_integration_task_id=NULL,lease_id=NULL,epoch=epoch+1,updated_at=now()
          WHERE repository_id=$1 AND active_integration_task_id=$2 AND epoch=$3::bigint`,
        [candidate.repositoryId, candidate.integrationTaskId, candidate.laneEpoch]);
      await client.query('COMMIT');
      return rowToIntegrationCandidate(updated.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
}

/** Durable, idempotent system-request outbox. Consumers must re-check all candidate fences at claim time. */
export class PostgresIntegrationEngineV3RequestHost implements IntegrationEngineV3RequestHost {
  constructor(private readonly options: Pick<PostgresIntegrationEngineV3HostOptions, 'pool' | 'candidatesTable' | 'requestsOutboxTable'>) {}
  requestWork(input: { candidateId: string; revision: number; workRound: number; subjectDigest: string }) { return this.enqueue('work', input.candidateId, input.revision, input.workRound, input); }
  requestReview(input: { candidateId: string; revision: number; subjectDigest: string; sourceSetDigest: string }) { return this.enqueue('review', input.candidateId, input.revision, 0, input); }
  requestWorkspaceSync(input: { candidateId: string; revision: number; baseBranch: string; expectedBaseOid: string }) { return this.enqueue('workspace_sync', input.candidateId, input.revision, 0, input); }
  requestCleanup(input: { candidateId: string; branch: string; providerPullRequestId?: string; reason: string }) { return this.enqueue('cleanup', input.candidateId, undefined, 0, input); }

  private async enqueue(kind: 'work'|'review'|'cleanup'|'workspace_sync', candidateId: string, revision: number | undefined, workRound: number, payload: object): Promise<{ requestId: string; status: string }> {
    const current = await this.options.pool.query(
      `SELECT id,current_revision,workflow_epoch,lane_epoch,state FROM ${this.options.candidatesTable} WHERE id=$1`, [candidateId]);
    const candidate = current.rows[0];
    if (!candidate) throw new TaskboardNotFoundError('Integration candidate not found');
    const boundRevision = revision ?? Number(candidate.current_revision);
    if (boundRevision < 1 || (revision !== undefined && boundRevision !== Number(candidate.current_revision))) {
      throw new TaskboardValidationError('System request is not bound to the current revision', 'TASKBOARD_CANDIDATE_REQUEST_STALE');
    }
    const requestKey = `v3:${kind}:${createHash('sha256').update(JSON.stringify(sortObject({ ...payload, candidateId, revision: boundRevision, workflowEpoch: String(candidate.workflow_epoch), laneEpoch: String(candidate.lane_epoch) }))).digest('hex')}`;
    const id = randomUUID();
    const inserted = await this.options.pool.query(
      `INSERT INTO ${this.options.requestsOutboxTable}
        (id,request_key,kind,candidate_id,candidate_revision,work_round,workflow_epoch,lane_epoch,payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7::bigint,$8::bigint,$9::jsonb)
       ON CONFLICT (request_key) DO UPDATE SET request_key=EXCLUDED.request_key
       RETURNING id,status`,
      [id, requestKey, kind, candidateId, boundRevision, workRound, String(candidate.workflow_epoch), String(candidate.lane_epoch), JSON.stringify(payload)]);
    return { requestId: String(inserted.rows[0]!.id), status: String(inserted.rows[0]!.status) };
  }
}

/** Durable fence used immediately before/after every provider operation. */
export class PostgresIntegrationProviderFenceHost {
  constructor(private readonly options: Pick<PostgresIntegrationEngineV3HostOptions, 'pool'|'boardsTable'|'tasksTable'|'integrationLanesTable'|'candidatesTable'>) {}
  async assertCurrent(operation: IntegrationProviderOperationRecord): Promise<void> {
    const result = await this.options.pool.query(
      `SELECT c.integration_task_id,c.current_revision,c.workflow_epoch,c.lane_epoch,c.state,t.workflow_version,t.workflow_epoch AS task_epoch,
              l.epoch AS current_lane_epoch,l.active_integration_task_id,
              COALESCE(NULLIF(current_setting('agent_saas.integration_v3_enabled',true),'')::boolean,true) AS global_enabled,
              COALESCE((b.integration_policy->>'enabled')::boolean,false) AS repository_enabled,
              COALESCE((b.integration_policy->'featureFlags'->>'engineV3')::boolean,false) AS engine_enabled,
              COALESCE((b.integration_policy->'featureFlags'->>'merge')::boolean,false) AS merge_enabled
         FROM ${this.options.candidatesTable} c
         JOIN ${this.options.tasksTable} t ON t.id=c.integration_task_id
         JOIN ${this.options.boardsTable} b ON b.id=t.board_id
         JOIN ${this.options.integrationLanesTable} l ON l.repository_id=c.repository_id
        WHERE c.id=$1`, [operation.fence.candidateId]);
    const row = result.rows[0];
    if (row && (row.global_enabled !== true || row.repository_enabled !== true || row.engine_enabled !== true
      || (operation.kind === 'merge_pull_request' && row.merge_enabled !== true))) {
      throw new TaskboardValidationError('Dynamic global or repository Integration v3 kill switch is active', 'TASKBOARD_INTEGRATION_KILL_SWITCH');
    }
    if (!row || Number(row.workflow_version) !== 3 || Number(row.current_revision) !== operation.fence.candidateRevision
      || String(row.workflow_epoch) !== String(operation.fence.workflowEpoch)
      || String(row.task_epoch) !== String(operation.fence.workflowEpoch)
      || String(row.lane_epoch) !== String(operation.fence.laneEpoch)
      || String(row.current_lane_epoch) !== String(operation.fence.laneEpoch)
      || String(row.active_integration_task_id ?? '') !== String(row.integration_task_id)
      || ['merged','canceled'].includes(String(row.state))) {
      throw new TaskboardValidationError('Provider operation fence is stale', 'TASKBOARD_PROVIDER_OPERATION_FENCE_MISMATCH');
    }
  }
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sortObject(child)]));
}

/** Feature flags are frozen in the candidate policy snapshot; repository lookup is fail-closed. */
export class PostgresIntegrationEngineV3FeatureHost implements IntegrationEngineV3FeatureHost {
  constructor(private readonly options: Pick<PostgresIntegrationEngineV3HostOptions, 'pool'|'candidatesTable'>) {}
  async getFlags(candidateId: string) {
    const result = await this.options.pool.query(
      `SELECT policy_snapshot FROM ${this.options.candidatesTable} WHERE id=$1`, [candidateId]);
    const policy = asRecord(result.rows[0]?.policy_snapshot);
    const flags = asRecord(policy.featureFlags);
    const enabled = Number(policy.workflowVersion) === 3 && flags.engineV3 === true;
    return {
      enabled,
      composeEnabled: enabled && flags.compose === true,
      reviewEnabled: enabled && flags.review === true,
      mergeEnabled: enabled && flags.merge === true,
      cleanupEnabled: enabled && flags.cleanup === true,
      workspaceSyncEnabled: enabled && flags.workspaceSync === true,
    };
  }
}
