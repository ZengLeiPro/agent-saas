import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import type { TaskBoardRepositoryConfig } from '../../../shared/src/types/taskboard.js';
import { rowToIntegrationCandidate, rowToIntegrationCandidateRevision, rowToIntegrationCandidateSourceSnapshot } from './integrationCandidateMapper.js';
import type { IntegrationV3ComposeContext, IntegrationV3ComposeHost } from './integrationV3ComposeExecutor.js';
import type {
  IntegrationV3CandidateLease,
  IntegrationV3RequestLease,
  IntegrationV3WorkerCurrent,
  IntegrationV3WorkerHost,
} from './integrationV3Worker.js';
import type { RepositoryWorkspaceGitCommand, RepositoryWorkspaceGitResult, RepositoryWorkspaceSyncLock } from './repositoryWorkspaceSync.js';

export interface IntegrationV3WorkerPostgresOptions {
  pool: {
    connect(): Promise<PoolClient>;
    query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  };
  candidatesTable: string;
  revisionsTable: string;
  sourceSnapshotsTable: string;
  providerOperationsTable: string;
  requestsOutboxTable: string;
  tasksTable: string;
  boardsTable: string;
  executionsTable: string;
  dispatchAgent(input: {
    identity: { tenantId: string; ownerUserId: string; username: string };
    taskId: string;
    expectedVersion: number;
    purpose: 'work' | 'review';
  }): Promise<void>;
  syncWorkspace(request: IntegrationV3RequestLease): Promise<void>;
  cleanup(request: IntegrationV3RequestLease): Promise<void>;
  logger?: IntegrationV3WorkerHost['logger'];
}

export class PostgresIntegrationV3WorkerHost implements IntegrationV3WorkerHost {
  readonly logger;
  constructor(private readonly options: IntegrationV3WorkerPostgresOptions) { this.logger = options.logger; }

  async claimCandidate(leaseMs: number): Promise<IntegrationV3CandidateLease | undefined> {
    const leaseId = randomUUID();
    const result = await this.options.pool.query(
      `WITH claim AS (
         SELECT id FROM ${this.options.candidatesTable}
          WHERE worker_status<>'failed'
            AND (worker_status='idle' OR worker_lease_expires_at<now())
            AND (state NOT IN ('merged','canceled') OR worker_checkpoint->>'status' IS DISTINCT FROM 'requested')
          ORDER BY updated_at,id FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE ${this.options.candidatesTable} c
          SET worker_status='processing',worker_lease_id=$1,
              worker_lease_expires_at=now()+($2::bigint*interval '1 millisecond'),worker_error=NULL
         FROM claim WHERE c.id=claim.id RETURNING c.id`,
      [leaseId, leaseMs],
    );
    return result.rows[0] ? { candidateId: String(result.rows[0].id), leaseId } : undefined;
  }

  async loadCurrent(candidateId: string): Promise<IntegrationV3WorkerCurrent> {
    const result = await this.options.pool.query(
      `SELECT c.*,r.candidate_id AS r_candidate_id,r.revision AS r_revision,r.digest_version AS r_digest_version,
              r.base_oid AS r_base_oid,r.head_oid AS r_head_oid,r.tree_oid AS r_tree_oid,
              r.source_set_digest AS r_source_set_digest,r.subject_digest AS r_subject_digest,
              r.policy_snapshot_digest AS r_policy_snapshot_digest,r.policy_revision AS r_policy_revision,
              r.merge_method AS r_merge_method,r.work_round AS r_work_round,r.work_execution_id AS r_work_execution_id,
              r.review_execution_id AS r_review_execution_id,r.created_at AS r_created_at
         FROM ${this.options.candidatesTable} c LEFT JOIN ${this.options.revisionsTable} r
           ON r.candidate_id=c.id AND r.revision=c.current_revision WHERE c.id=$1`,
      [candidateId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Integration candidate not found');
    return {
      candidate: rowToIntegrationCandidate(row),
      ...(row.r_candidate_id ? { revision: rowToIntegrationCandidateRevision({
        candidate_id: row.r_candidate_id, revision: row.r_revision, digest_version: row.r_digest_version,
        base_oid: row.r_base_oid, head_oid: row.r_head_oid, tree_oid: row.r_tree_oid,
        source_set_digest: row.r_source_set_digest, subject_digest: row.r_subject_digest,
        policy_snapshot_digest: row.r_policy_snapshot_digest, policy_revision: row.r_policy_revision,
        merge_method: row.r_merge_method, work_round: row.r_work_round, work_execution_id: row.r_work_execution_id,
        review_execution_id: row.r_review_execution_id, created_at: row.r_created_at,
      }) } : {}),
    };
  }

  async checkpointCandidate(lease: IntegrationV3CandidateLease, checkpoint: Record<string, unknown>): Promise<void> {
    await this.options.pool.query(
      `UPDATE ${this.options.candidatesTable} SET worker_checkpoint=$3::jsonb,updated_at=updated_at
        WHERE id=$1 AND worker_lease_id=$2 AND worker_status='processing'`,
      [lease.candidateId, lease.leaseId, JSON.stringify(checkpoint)],
    );
  }

  async releaseCandidate(lease: IntegrationV3CandidateLease, error?: string): Promise<void> {
    await this.options.pool.query(
      `UPDATE ${this.options.candidatesTable}
          SET worker_status=CASE WHEN $3::text IS NULL THEN 'idle' ELSE 'failed' END,
              worker_lease_id=NULL,worker_lease_expires_at=NULL,worker_error=$3
        WHERE id=$1 AND worker_lease_id=$2`,
      [lease.candidateId, lease.leaseId, error ?? null],
    );
  }

  async claimRequest(leaseMs: number): Promise<IntegrationV3RequestLease | undefined> {
    const leaseId = randomUUID();
    const result = await this.options.pool.query(
      `WITH claim AS (
         SELECT o.id FROM ${this.options.requestsOutboxTable} o
         JOIN ${this.options.candidatesTable} c ON c.id=o.candidate_id
        WHERE o.status IN ('pending','processing') AND o.available_at<=now()
          AND (o.status='pending' OR o.lease_expires_at<now())
          AND o.candidate_revision=c.current_revision
          AND o.workflow_epoch=c.workflow_epoch AND o.lane_epoch=c.lane_epoch
          AND ((o.kind='work' AND c.state='working') OR (o.kind='review' AND c.state='in_review')
            OR o.kind='workspace_sync' OR (o.kind='cleanup' AND c.state IN ('merged','canceled')))
        ORDER BY o.created_at,o.id FOR UPDATE OF o SKIP LOCKED LIMIT 1
       )
       UPDATE ${this.options.requestsOutboxTable} o
          SET status='processing',lease_id=$1,lease_expires_at=now()+($2::bigint*interval '1 millisecond'),
              attempts=attempts+1,updated_at=now()
         FROM claim WHERE o.id=claim.id RETURNING o.*`,
      [leaseId, leaseMs],
    );
    const row = result.rows[0];
    return row ? {
      id: String(row.id), leaseId, kind: String(row.kind) as IntegrationV3RequestLease['kind'],
      candidateId: String(row.candidate_id), candidateRevision: Number(row.candidate_revision),
      payload: record(row.payload),
    } : undefined;
  }

  async dispatchAgent(request: IntegrationV3RequestLease): Promise<void> {
    const result = await this.options.pool.query(
      `SELECT t.id,t.version,b.tenant_id,b.owner_user_id
         FROM ${this.options.candidatesTable} c JOIN ${this.options.tasksTable} t ON t.id=c.integration_task_id
         JOIN ${this.options.boardsTable} b ON b.id=t.board_id
        WHERE c.id=$1 AND c.current_revision=$2`, [request.candidateId, request.candidateRevision]);
    const row = result.rows[0];
    if (!row) throw new Error('Candidate execution dispatch fence is stale');
    await this.options.dispatchAgent({
      identity: { tenantId: String(row.tenant_id), ownerUserId: String(row.owner_user_id), username: 'board-owner' },
      taskId: String(row.id), expectedVersion: Number(row.version), purpose: request.kind as 'work'|'review',
    });
  }
  syncWorkspace(request: IntegrationV3RequestLease) { return this.options.syncWorkspace(request); }
  cleanup(request: IntegrationV3RequestLease) { return this.options.cleanup(request); }

  async completeRequest(request: IntegrationV3RequestLease): Promise<void> {
    await this.options.pool.query(
      `UPDATE ${this.options.requestsOutboxTable}
          SET status='completed',lease_id=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=now()
        WHERE id=$1 AND lease_id=$2 AND status='processing'`, [request.id, request.leaseId]);
  }

  async releaseRequest(request: IntegrationV3RequestLease, error: string, retryable: boolean): Promise<void> {
    await this.options.pool.query(
      `UPDATE ${this.options.requestsOutboxTable}
          SET status=CASE WHEN $4::boolean AND attempts<5 THEN 'pending' ELSE 'failed' END,
              available_at=CASE WHEN $4::boolean THEN now()+(LEAST(attempts,5)*interval '5 seconds') ELSE available_at END,
              lease_id=NULL,lease_expires_at=NULL,last_error=$3,updated_at=now()
        WHERE id=$1 AND lease_id=$2`, [request.id, request.leaseId, error, retryable]);
  }

  async resolveEngineContext(candidateId: string): Promise<{ repository: TaskBoardRepositoryConfig; credentialOwnerId: string }> {
    const result = await this.options.pool.query(
      `SELECT b.repository,b.owner_user_id FROM ${this.options.candidatesTable} c
        JOIN ${this.options.tasksTable} t ON t.id=c.integration_task_id
        JOIN ${this.options.boardsTable} b ON b.id=t.board_id WHERE c.id=$1`, [candidateId]);
    const row = result.rows[0];
    const repository = record(row?.repository) as unknown as TaskBoardRepositoryConfig;
    if (!row || repository.provider !== 'github') throw new Error('Repository provider is unsupported or unknown');
    return { repository, credentialOwnerId: String(row.owner_user_id) };
  }

  async findUnknownMergeOperation(candidateId: string, revision: number): Promise<string | undefined> {
    const result = await this.options.pool.query(
      `SELECT operation_key FROM ${this.options.providerOperationsTable}
        WHERE candidate_id=$1 AND candidate_revision=$2 AND kind='merge_pull_request'
          AND state IN ('executing','unknown') ORDER BY updated_at DESC LIMIT 1`, [candidateId, revision]);
    return result.rows[0] ? String(result.rows[0].operation_key) : undefined;
  }
}

export interface PostgresIntegrationV3ComposeHostOptions {
  pool: IntegrationV3WorkerPostgresOptions['pool'];
  candidatesTable: string;
  sourceSnapshotsTable: string;
  tasksTable: string;
  boardsTable: string;
  executionsTable: string;
  resolvePaths(repository: TaskBoardRepositoryConfig, candidateId: string): Promise<{ repositoryPath: string; worktreePath: string } | undefined>;
  runGit(command: RepositoryWorkspaceGitCommand): Promise<RepositoryWorkspaceGitResult>;
  pushIntegrationHead?: IntegrationV3ComposeHost['pushIntegrationHead'];
}

export class PostgresIntegrationV3ComposeHost implements IntegrationV3ComposeHost {
  readonly pushIntegrationHead;
  constructor(private readonly options: PostgresIntegrationV3ComposeHostOptions) { this.pushIntegrationHead = options.pushIntegrationHead; }

  async resolveContext(current: Required<IntegrationV3WorkerCurrent>): Promise<IntegrationV3ComposeContext> {
    const result = await this.options.pool.query(
      `SELECT b.repository,b.owner_user_id,
              (SELECT e.id FROM ${this.options.executionsTable} e WHERE e.task_id=c.integration_task_id
                AND e.purpose='work' AND e.status='succeeded' ORDER BY e.finished_at DESC NULLS LAST LIMIT 1) AS work_execution_id
         FROM ${this.options.candidatesTable} c JOIN ${this.options.tasksTable} t ON t.id=c.integration_task_id
         JOIN ${this.options.boardsTable} b ON b.id=t.board_id WHERE c.id=$1`, [current.candidate.id]);
    const row = result.rows[0];
    const repository = record(row?.repository) as unknown as TaskBoardRepositoryConfig;
    if (!row || repository.provider !== 'github' || repository.repositoryId !== current.candidate.repositoryId) throw new Error('Repository provider is unsupported or unknown');
    const paths = await this.options.resolvePaths(repository, current.candidate.id);
    if (!paths) throw new Error('Local repository workspace is unavailable');
    const snapshots = await this.options.pool.query(
      `SELECT * FROM ${this.options.sourceSnapshotsTable} WHERE candidate_id=$1 AND revision=$2 ORDER BY source_order`,
      [current.candidate.id, current.candidate.currentRevision]);
    return {
      repository, credentialOwnerId: String(row.owner_user_id), ...paths,
      sources: snapshots.rows.map(rowToIntegrationCandidateSourceSnapshot),
      ...(row.work_execution_id ? { workExecutionId: String(row.work_execution_id) } : {}),
    };
  }

  async bindPullRequest(candidateId: string, expectedVersion: number, providerPullRequestId: string): Promise<void> {
    const result = await this.options.pool.query(
      `UPDATE ${this.options.candidatesTable} SET provider_pull_request_id=$3,version=version+1,updated_at=now()
        WHERE id=$1 AND version=$2 AND provider_pull_request_id IS NULL RETURNING id`,
      [candidateId, expectedVersion, providerPullRequestId]);
    if (!result.rows[0]) throw new Error('Candidate changed before pull request binding');
  }

  async withRepositoryBranchLock<T>(lock: RepositoryWorkspaceSyncLock, operation: () => Promise<T>): Promise<T> {
    const client = await this.options.pool.connect();
    const key = `${lock.repositoryPath}\u0000${lock.branch}`;
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [key]);
      return await operation();
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]).catch(() => undefined);
      client.release();
    }
  }
  runGit(command: RepositoryWorkspaceGitCommand) { return this.options.runGit(command); }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') return JSON.parse(value) as Record<string, unknown>;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
