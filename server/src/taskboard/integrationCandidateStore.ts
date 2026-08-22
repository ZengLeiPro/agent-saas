import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import type {
  TaskBoardIntegrationCandidate,
  TaskBoardIntegrationCandidateRevision,
  TaskBoardIntegrationCandidateSourceSnapshot,
  TaskBoardIntegrationCandidateState,
  TaskBoardIntegrationMergeMethod,
} from '../../../shared/src/types/taskboard.js';
import {
  computeIntegrationCandidateSubjectDigest,
  computeIntegrationPolicySnapshotDigest,
  computeIntegrationRequirementDigest,
  computeIntegrationReviewReceiptDigest,
  computeIntegrationSourceSetDigest,
  INTEGRATION_CANDIDATE_DIGEST_VERSION,
} from './integrationCandidateDigest.js';
import {
  rowToIntegrationCandidate,
  rowToIntegrationCandidateRevision,
  rowToIntegrationCandidateSourceSnapshot,
} from './integrationCandidateMapper.js';
import { integrationCandidateTableNames } from './integrationCandidateSchema.js';
import { TaskboardNotFoundError, TaskboardValidationError } from './types.js';

interface CandidatePool {
  connect(): Promise<PoolClient>;
}

export interface IntegrationCandidateStoreOptions {
  pool: CandidatePool;
  tasksTable: string;
  executionsTable: string;
  integrationSourcesTable: string;
  blockEpisodesTable: string;
}

export interface CreateIntegrationCandidateInput {
  id?: string;
  integrationTaskId: string;
  repositoryId: string;
  baseBranch: string;
  branch: string;
  providerPullRequestId?: string;
  workflowEpoch: string;
  laneEpoch: string;
  policyRevision: string;
  mergeMethod: TaskBoardIntegrationMergeMethod;
  policySnapshot: Record<string, unknown>;
}

export type CandidateSourceSnapshotInput = Omit<
  TaskBoardIntegrationCandidateSourceSnapshot,
  'candidateId' | 'revision' | 'createdAt'
>;

export interface AppendCandidateRevisionInput {
  expectedVersion: number;
  expectedCurrentRevision: number;
  baseOid: string;
  headOid: string;
  treeOid: string;
  compositionComplete?: boolean;
  workExecutionId?: string;
  reviewExecutionId?: string;
  sources: CandidateSourceSnapshotInput[];
  /** Optional atomic state convergence used by v3 engine after persisting the new subject. */
  nextState?: 'needs_work' | 'waiting_checks' | 'in_review';
  lastError?: string;
}

export interface TransitionCandidateInput {
  expectedVersion: number;
  expectedRevision: number;
  to: TaskBoardIntegrationCandidateState;
  approvedReviewExecutionId?: string;
  mergedCommitOid?: string;
  lastError?: string;
}

const transitions: Readonly<Record<TaskBoardIntegrationCandidateState, readonly TaskBoardIntegrationCandidateState[]>> = {
  preparing: ['composing', 'blocked', 'needs_human', 'canceled'],
  composing: ['waiting_checks', 'needs_work', 'blocked', 'needs_human', 'canceled'],
  waiting_checks: ['needs_work', 'in_review', 'blocked', 'needs_human', 'canceled'],
  needs_work: ['working', 'blocked', 'needs_human', 'canceled'],
  working: ['waiting_checks', 'in_review', 'blocked', 'needs_human', 'canceled'],
  in_review: ['approved', 'needs_work', 'blocked', 'needs_human', 'canceled'],
  approved: ['composing', 'merging', 'needs_human', 'canceled'],
  merging: ['composing', 'merged', 'needs_human'],
  blocked: ['preparing', 'composing', 'needs_work', 'in_review', 'needs_human', 'canceled'],
  needs_human: ['blocked', 'composing', 'canceled'],
  merged: [],
  canceled: [],
};

export class IntegrationCandidateStore {
  readonly candidatesTable: string;
  readonly revisionsTable: string;
  readonly sourceSnapshotsTable: string;

  constructor(private readonly options: IntegrationCandidateStoreOptions) {
    const tables = integrationCandidateTableNames(options.integrationSourcesTable);
    this.candidatesTable = tables.candidatesTable;
    this.revisionsTable = tables.revisionsTable;
    this.sourceSnapshotsTable = tables.sourceSnapshotsTable;
  }

  async create(input: CreateIntegrationCandidateInput): Promise<TaskBoardIntegrationCandidate> {
    return this.withTransaction(async (client) => {
      const task = await client.query(
        `SELECT kind, workflow_version FROM ${this.options.tasksTable} WHERE id=$1 FOR UPDATE`,
        [input.integrationTaskId],
      );
      if (!task.rows[0]) throw new TaskboardNotFoundError('Integration task not found');
      if (task.rows[0].kind !== 'integration' || Number(task.rows[0].workflow_version) !== 3) {
        throw new TaskboardValidationError(
          'Candidate requires an integration task created with workflow version 3',
          'TASKBOARD_CANDIDATE_WORKFLOW_VERSION_REQUIRED',
        );
      }
      const id = input.id ?? randomUUID();
      const result = await client.query(
        `INSERT INTO ${this.candidatesTable}
          (id,integration_task_id,repository_id,base_branch,branch,provider_pull_request_id,
           workflow_epoch,lane_epoch,policy_revision,merge_method,policy_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,$7::bigint,$8::bigint,$9,$10,$11::jsonb)
         RETURNING *`,
        [
          id,
          input.integrationTaskId,
          required(input.repositoryId, 'repositoryId'),
          required(input.baseBranch, 'baseBranch'),
          required(input.branch, 'branch'),
          input.providerPullRequestId ?? null,
          bigintText(input.workflowEpoch, 'workflowEpoch'),
          bigintText(input.laneEpoch, 'laneEpoch'),
          required(input.policyRevision, 'policyRevision'),
          input.mergeMethod,
          JSON.stringify(input.policySnapshot),
        ],
      );
      return rowToIntegrationCandidate(result.rows[0]);
    });
  }

  async getByIntegrationTask(integrationTaskId: string): Promise<TaskBoardIntegrationCandidate | undefined> {
    const client = await this.options.pool.connect();
    try {
      const result = await client.query(
        `SELECT * FROM ${this.candidatesTable} WHERE integration_task_id=$1`,
        [integrationTaskId],
      );
      return result.rows[0] ? rowToIntegrationCandidate(result.rows[0]) : undefined;
    } finally {
      client.release();
    }
  }

  async listRevisions(candidateId: string): Promise<Array<{
    revision: TaskBoardIntegrationCandidateRevision;
    sources: TaskBoardIntegrationCandidateSourceSnapshot[];
  }>> {
    const client = await this.options.pool.connect();
    try {
      const [revisions, sources] = await Promise.all([
        client.query(`SELECT * FROM ${this.revisionsTable} WHERE candidate_id=$1 ORDER BY revision`, [candidateId]),
        client.query(
          `SELECT * FROM ${this.sourceSnapshotsTable}
            WHERE candidate_id=$1 ORDER BY revision, source_order`,
          [candidateId],
        ),
      ]);
      return revisions.rows.map((row) => {
        const revision = rowToIntegrationCandidateRevision(row);
        return {
          revision,
          sources: sources.rows
            .filter((source) => Number(source.revision) === revision.revision)
            .map(rowToIntegrationCandidateSourceSnapshot),
        };
      });
    } finally {
      client.release();
    }
  }

  async appendRevision(
    candidateId: string,
    input: AppendCandidateRevisionInput,
  ): Promise<TaskBoardIntegrationCandidate> {
    return this.withTransaction(async (client) => {
      const candidate = await this.loadForUpdate(client, candidateId);
      assertCandidateCas(candidate, input.expectedVersion, input.expectedCurrentRevision);
      if (!['preparing', 'composing', 'working', 'waiting_checks'].includes(candidate.state)) {
        throw new TaskboardValidationError(
          `Cannot append a revision while candidate is ${candidate.state}`,
          'TASKBOARD_CANDIDATE_REVISION_STATE_INVALID',
        );
      }
      if (input.nextState && !transitions[candidate.state].includes(input.nextState)) {
        throw new TaskboardValidationError(
          `Cannot append a revision and transition ${candidate.state} -> ${input.nextState}`,
          'TASKBOARD_CANDIDATE_TRANSITION_INVALID',
        );
      }
      for (const source of input.sources) {
        if (source.repositoryId !== candidate.repositoryId) {
          throw new TaskboardValidationError(
            'Every source snapshot must belong to the candidate repository',
            'TASKBOARD_CANDIDATE_SOURCE_REPOSITORY_MISMATCH',
          );
        }
        const ownership = await client.query(
          `SELECT s.integration_task_id,s.delivery_task_id,s.repository_id,s.provider_pull_request_id,
                  s.reviewed_subject_digest,d.version AS delivery_task_version,d.board_id,d.title,d.description,
                  d.head_oid,d.base_oid,it.board_id AS integration_board_id,
                  re.id AS review_execution_id,re.task_id AS review_task_id,
                  re.purpose AS review_purpose,re.status AS review_status
             FROM ${this.options.integrationSourcesTable} s
             JOIN ${this.options.tasksTable} d ON d.id=s.delivery_task_id
             JOIN ${this.options.tasksTable} it ON it.id=s.integration_task_id
             JOIN ${this.options.executionsTable} re ON re.id=$2
            WHERE s.id=$1 FOR UPDATE OF s,d,re`,
          [source.integrationSourceId, source.reviewExecutionId],
        );
        const row = ownership.rows[0];
        const authoritativeReviewReceiptDigest = row
          ? computeIntegrationReviewReceiptDigest(String(row.review_execution_id), String(row.reviewed_subject_digest))
          : '';
        const authoritativeRequirementDigest = row
          ? computeIntegrationRequirementDigest(String(row.title), String(row.description ?? ''))
          : '';
        if (!row
          || String(row.integration_task_id) !== candidate.integrationTaskId
          || String(row.delivery_task_id) !== source.deliveryTaskId
          || String(row.repository_id) !== candidate.repositoryId
          || String(row.provider_pull_request_id) !== source.providerPullRequestId
          || String(row.reviewed_subject_digest) !== source.reviewedSubjectDigest
          || String(row.review_execution_id) !== source.reviewExecutionId
          || String(row.review_task_id) !== source.deliveryTaskId
          || String(row.review_purpose) !== 'review'
          || String(row.review_status) !== 'succeeded'
          || authoritativeReviewReceiptDigest !== source.reviewReceiptDigest
          || authoritativeRequirementDigest !== source.requirementDigest
          || Number(row.delivery_task_version) !== source.deliveryTaskVersion
          || String(row.board_id) !== String(row.integration_board_id)
          || String(row.head_oid) !== source.frozenHeadOid
          || String(row.base_oid) !== source.frozenBaseOid) {
          throw new TaskboardValidationError(
            'Source snapshot does not belong to this candidate or no longer matches its frozen delivery source',
            'TASKBOARD_CANDIDATE_SOURCE_OWNERSHIP_MISMATCH',
          );
        }
      }
      const revision = candidate.currentRevision + 1;
      const sourceSetDigest = computeIntegrationSourceSetDigest(input.sources);
      const policySnapshotDigest = computeIntegrationPolicySnapshotDigest(candidate.policySnapshot);
      const subjectDigest = computeIntegrationCandidateSubjectDigest({
        repository: { repositoryId: candidate.repositoryId, baseBranch: candidate.baseBranch },
        baseOid: input.baseOid,
        headOid: input.headOid,
        treeOid: input.treeOid,
        sourceSetDigest,
        mergeMethod: candidate.mergeMethod,
        policyRevision: candidate.policyRevision,
        policySnapshot: candidate.policySnapshot,
      });
      await client.query(
        `INSERT INTO ${this.revisionsTable}
          (candidate_id,revision,digest_version,base_oid,head_oid,subject_kind,tree_oid,composition_complete,
           source_set_digest,subject_digest,policy_snapshot_digest,policy_revision,merge_method,work_round,
           work_execution_id,review_execution_id)
         VALUES ($1,$2,$3,$4,$5,'provider_subject',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          candidate.id, revision, INTEGRATION_CANDIDATE_DIGEST_VERSION,
          required(input.baseOid, 'baseOid'), required(input.headOid, 'headOid'), required(input.treeOid, 'treeOid'),
          input.compositionComplete ?? true, sourceSetDigest, subjectDigest, policySnapshotDigest,
          candidate.policyRevision, candidate.mergeMethod, candidate.workRound,
          input.workExecutionId ?? null, input.reviewExecutionId ?? null,
        ],
      );
      for (const source of input.sources) {
        await client.query(
          `INSERT INTO ${this.sourceSnapshotsTable}
            (candidate_id,revision,source_order,integration_source_id,delivery_task_id,delivery_task_version,
             repository_id,provider_pull_request_id,frozen_head_oid,frozen_base_oid,reviewed_subject_digest,
             review_execution_id,review_receipt_digest,requirement_digest)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [
            candidate.id, revision, source.order, source.integrationSourceId, source.deliveryTaskId,
            source.deliveryTaskVersion, source.repositoryId, source.providerPullRequestId,
            source.frozenHeadOid, source.frozenBaseOid, source.reviewedSubjectDigest,
            source.reviewExecutionId, source.reviewReceiptDigest, source.requirementDigest,
          ],
        );
      }
      const updated = await client.query(
        `UPDATE ${this.candidatesTable}
            SET current_revision=$4,source_set_digest=$5,state=COALESCE($6,state),approved_revision=NULL,
                approved_review_execution_id=NULL,last_error=$8,version=version+1,updated_at=now()
          WHERE id=$1 AND version=$2 AND current_revision=$3 AND state=$7
          RETURNING *`,
        [candidate.id, input.expectedVersion, input.expectedCurrentRevision, revision, sourceSetDigest,
          input.nextState ?? null, candidate.state, input.lastError ?? null],
      );
      if (!updated.rows[0]) throw staleCandidate();
      return rowToIntegrationCandidate(updated.rows[0]);
    });
  }

  async beginNextWorkRound(
    candidateId: string,
    expectedVersion: number,
    expectedRevision: number,
  ): Promise<TaskBoardIntegrationCandidate> {
    return this.withTransaction(async (client) => {
      const candidate = await this.loadForUpdate(client, candidateId);
      assertCandidateCas(candidate, expectedVersion, expectedRevision);
      if (candidate.state !== 'needs_work') {
        throw new TaskboardValidationError('Candidate is not awaiting work', 'TASKBOARD_CANDIDATE_WORK_STATE_INVALID');
      }
      const result = await client.query(
        `UPDATE ${this.candidatesTable}
            SET state='working',work_round=work_round+1,version=version+1,updated_at=now()
          WHERE id=$1 AND version=$2 AND current_revision=$3 AND state='needs_work'
          RETURNING *`,
        [candidateId, expectedVersion, expectedRevision],
      );
      if (!result.rows[0]) throw staleCandidate();
      return rowToIntegrationCandidate(result.rows[0]);
    });
  }

  async transition(candidateId: string, input: TransitionCandidateInput): Promise<TaskBoardIntegrationCandidate> {
    return this.withTransaction(async (client) => {
      const candidate = await this.loadForUpdate(client, candidateId);
      assertCandidateCas(candidate, input.expectedVersion, input.expectedRevision);
      assertCandidateTransition(candidate, input);
      const approved = input.to === 'approved';
      const result = await client.query(
        `UPDATE ${this.candidatesTable}
            SET state=$4,
                approved_revision=CASE WHEN $5::boolean THEN current_revision
                  WHEN $4 IN ('composing','needs_work','canceled') THEN NULL ELSE approved_revision END,
                approved_review_execution_id=CASE WHEN $5::boolean THEN $6
                  WHEN $4 IN ('composing','needs_work','canceled') THEN NULL ELSE approved_review_execution_id END,
                merged_commit_oid=COALESCE($7,merged_commit_oid),last_error=$8,
                version=version+1,updated_at=now()
          WHERE id=$1 AND version=$2 AND current_revision=$3 AND state=$9
          RETURNING *`,
        [
          candidateId, input.expectedVersion, input.expectedRevision, input.to, approved,
          input.approvedReviewExecutionId ?? null, input.mergedCommitOid ?? null,
          input.lastError ?? null, candidate.state,
        ],
      );
      if (!result.rows[0]) throw staleCandidate();
      if (['approved', 'merging'].includes(candidate.state) && input.to === 'composing') {
        await client.query(
          `UPDATE ${this.options.tasksTable}
              SET status='in_progress',completed_at=NULL,version=version+1,updated_at=now()
            WHERE id=$1 AND status NOT IN ('done','canceled')`,
          [candidate.integrationTaskId],
        );
      }
      if (input.to === 'blocked' || input.to === 'needs_human') {
        const projected = await client.query(
          `UPDATE ${this.options.tasksTable}
              SET status='blocked',completed_at=NULL,version=version+1,updated_at=now()
            WHERE id=$1 AND status NOT IN ('done','canceled') RETURNING id`,
          [candidate.integrationTaskId],
        );
        if (projected.rows[0] && input.lastError) {
          const purpose = candidate.state === 'in_review'
            ? 'review'
            : candidate.state === 'approved' || candidate.state === 'merging' ? 'merge' : 'work';
          await client.query(
            `INSERT INTO ${this.options.blockEpisodesTable}
               (id,task_id,purpose,reason_code,reason)
             SELECT $1,$2,$3,$4,$5
              WHERE NOT EXISTS (
                SELECT 1 FROM ${this.options.blockEpisodesTable}
                 WHERE task_id=$2 AND closed_at IS NULL
              )`,
            [randomUUID(), candidate.integrationTaskId, purpose, `integration_candidate_${input.to}`, input.lastError],
          );
        }
      }
      return rowToIntegrationCandidate(result.rows[0]);
    });
  }

  private async loadForUpdate(client: PoolClient, candidateId: string): Promise<TaskBoardIntegrationCandidate> {
    const result = await client.query(`SELECT * FROM ${this.candidatesTable} WHERE id=$1 FOR UPDATE`, [candidateId]);
    if (!result.rows[0]) throw new TaskboardNotFoundError('Integration candidate not found');
    return rowToIntegrationCandidate(result.rows[0]);
  }

  private async withTransaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export function assertCandidateTransition(
  candidate: TaskBoardIntegrationCandidate,
  input: TransitionCandidateInput,
): void {
  if (!transitions[candidate.state].includes(input.to)) {
    throw new TaskboardValidationError(
      `Invalid candidate transition: ${candidate.state} -> ${input.to}`,
      'TASKBOARD_CANDIDATE_TRANSITION_INVALID',
    );
  }
  if (input.to === 'approved') {
    if (candidate.currentRevision < 1 || !input.approvedReviewExecutionId) {
      throw new TaskboardValidationError(
        'Approval must bind the current revision and review execution',
        'TASKBOARD_CANDIDATE_APPROVAL_INCOMPLETE',
      );
    }
  }
  if (input.to === 'merging'
    && (candidate.approvedRevision !== candidate.currentRevision || !candidate.approvedReviewExecutionId)) {
    throw new TaskboardValidationError(
      'Only the currently approved revision may enter merging',
      'TASKBOARD_CANDIDATE_APPROVAL_STALE',
    );
  }
  if (input.to === 'merged' && !input.mergedCommitOid) {
    throw new TaskboardValidationError('Merged transition requires provider commit OID', 'TASKBOARD_CANDIDATE_MERGE_RECEIPT_REQUIRED');
  }
}

function assertCandidateCas(
  candidate: TaskBoardIntegrationCandidate,
  expectedVersion: number,
  expectedRevision: number,
): void {
  if (candidate.version !== expectedVersion || candidate.currentRevision !== expectedRevision) throw staleCandidate();
}

function staleCandidate(): TaskboardValidationError {
  return new TaskboardValidationError('Candidate changed; reload before retrying', 'TASKBOARD_CANDIDATE_CAS_MISMATCH');
}

function required(value: string, field: string): string {
  if (!value.trim()) throw new TaskboardValidationError(`${field} is required`);
  return value;
}

function bigintText(value: string, field: string): string {
  if (!/^\d+$/.test(value)) throw new TaskboardValidationError(`${field} must be an unsigned bigint`);
  return value;
}
