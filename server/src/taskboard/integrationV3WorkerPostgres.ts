import { randomUUID } from 'node:crypto';
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import type { PoolClient } from 'pg';

import type { TaskBoardRepositoryConfig } from '../../../shared/src/types/taskboard.js';
import { rowToIntegrationCandidate, rowToIntegrationCandidateRevision, rowToIntegrationCandidateSourceSnapshot } from './integrationCandidateMapper.js';
import type { IntegrationV3ComposeContext, IntegrationV3ComposeHost } from './integrationV3ComposeExecutor.js';
import type {
  IntegrationV3CandidateLease,
  IntegrationV3CleanupReceipt,
  IntegrationV3RequestLease,
  IntegrationV3WorkerCurrent,
  IntegrationV3WorkerHost,
} from './integrationV3Worker.js';
import type { RepositoryWorkspaceGitCommand, RepositoryWorkspaceGitResult, RepositoryWorkspaceSyncLock } from './repositoryWorkspaceSync.js';

export interface IntegrationV3CleanupExecutorOptions {
  candidateId: string;
  repositoryPath: string;
  worktreePath: string;
  controlledWorktreeRoot: string;
  branch: string;
  sourcePullRequests: Array<{ id: string; action: 'close' | 'comment' | 'skip'; policyReason?: string }>;
  withRepositoryBranchLock<T>(lock: RepositoryWorkspaceSyncLock, operation: () => Promise<T>): Promise<T>;
  runGit(command: RepositoryWorkspaceGitCommand): Promise<RepositoryWorkspaceGitResult>;
  revokeCapabilities(): Promise<void>;
  fenceCapabilities(): Promise<void>;
  applySourcePullRequest(input: { id: string; action: 'close' | 'comment' }): Promise<void>;
}

/** Fail-closed cleanup orchestration. Every attempted or policy-skipped action is receipted. */
export async function executeIntegrationV3Cleanup(options: IntegrationV3CleanupExecutorOptions): Promise<IntegrationV3CleanupReceipt> {
  const actions: IntegrationV3CleanupReceipt['actions'] = [];
  const perform = async (action: IntegrationV3CleanupReceipt['actions'][number]['action'], operation: () => Promise<void>, target?: string) => {
    try { await operation(); actions.push({ action, status: 'succeeded', ...(target ? { target } : {}) }); }
    catch (error) { actions.push({ action, status: 'failed', error: error instanceof Error ? error.message : String(error), ...(target ? { target } : {}) }); }
  };
  await perform('revoke_capabilities', options.revokeCapabilities);
  await perform('fence_capabilities', options.fenceCapabilities);
  await perform('remove_candidate_worktree', async () => {
    assertServerOwnedWorktree(options.controlledWorktreeRoot, options.worktreePath, options.candidateId);
    await options.withRepositoryBranchLock({ repositoryPath: options.repositoryPath, branch: options.branch }, async () => {
      const status = await options.runGit({ cwd: options.worktreePath, args: ['status', '--porcelain=v1', '--untracked-files=all'] });
      if (status.exitCode !== 0) throw new Error(`Cannot inspect candidate worktree: ${status.stderr || status.stdout}`);
      if (status.stdout.trim()) throw new Error('Candidate worktree is dirty; refusing cleanup');
      const removed = await options.runGit({ cwd: options.repositoryPath, args: ['worktree', 'remove', '--', options.worktreePath] });
      if (removed.exitCode !== 0) throw new Error(`Cannot remove candidate worktree: ${removed.stderr || removed.stdout}`);
    });
  }, options.worktreePath);
  for (const source of options.sourcePullRequests) {
    if (source.action === 'skip') {
      actions.push({ action: 'source_pull_request', status: 'skipped', target: source.id, reason: source.policyReason ?? 'policy explicitly disabled source PR cleanup' });
    } else {
      const sourceAction = source.action;
      await perform('source_pull_request', () => options.applySourcePullRequest({ id: source.id, action: sourceAction }), source.id);
    }
  }
  return { version: 1, outcome: actions.some((action) => action.status === 'failed') ? 'failed' : 'succeeded', actions, completedAt: new Date().toISOString() };
}

function assertServerOwnedWorktree(root: string, worktreePath: string, candidateId: string): void {
  if (![root, worktreePath].every(isAbsolute) || normalize(worktreePath) !== worktreePath) throw new Error('Candidate worktree path is not absolute and normalized');
  const ownedRoot = resolve(root);
  const candidatePath = resolve(worktreePath);
  const child = relative(ownedRoot, candidatePath);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || child.split(sep).every((part) => part !== candidateId)) {
    throw new Error('Candidate worktree is outside the server-owned candidate root');
  }
}

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
  cleanup(request: IntegrationV3RequestLease): Promise<IntegrationV3CleanupReceipt | void>;
  logger?: IntegrationV3WorkerHost['logger'];
}

export class PostgresIntegrationV3WorkerHost implements IntegrationV3WorkerHost {
  readonly logger;
  constructor(private readonly options: IntegrationV3WorkerPostgresOptions) { this.logger = options.logger; }

  async claimCandidate(leaseMs: number): Promise<IntegrationV3CandidateLease | undefined> {
    const leaseId = randomUUID();
    const result = await this.options.pool.query(
      `WITH claim AS (
         SELECT c.id FROM ${this.options.candidatesTable} c
         JOIN ${this.options.tasksTable} t ON t.id=c.integration_task_id
         JOIN ${this.options.boardsTable} b ON b.id=t.board_id
          WHERE COALESCE(NULLIF(current_setting('agent_saas.integration_v3_enabled',true),'')::boolean,true)
            AND COALESCE((b.integration_policy->>'enabled')::boolean,false)
            AND COALESCE((b.integration_policy->>'workflowVersion')::int,2)=3
            AND COALESCE((b.integration_policy->'featureFlags'->>'engineV3')::boolean,false)
            AND c.worker_status<>'failed' AND c.worker_available_at<=now()
            AND (c.worker_status='idle' OR c.worker_lease_expires_at<now())
            AND (c.state NOT IN ('merged','canceled') OR c.worker_checkpoint->>'status' IS DISTINCT FROM 'requested')
          ORDER BY c.updated_at,c.id FOR UPDATE OF c SKIP LOCKED LIMIT 1
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

  async releaseCandidate(lease: IntegrationV3CandidateLease, error?: string, retryable = false): Promise<void> {
    await this.options.pool.query(
      `UPDATE ${this.options.candidatesTable}
          SET worker_status=CASE
                WHEN $3::text IS NULL THEN 'idle'
                WHEN $4::boolean AND worker_attempts<9 THEN 'idle'
                ELSE 'failed' END,
              worker_attempts=CASE WHEN $3::text IS NULL THEN 0 ELSE worker_attempts+1 END,
              worker_available_at=CASE
                WHEN $3::text IS NULL THEN now()
                WHEN $4::boolean THEN now()+(LEAST(worker_attempts+1,10)*interval '5 seconds')
                ELSE worker_available_at END,
              worker_lease_id=NULL,worker_lease_expires_at=NULL,worker_error=$3
        WHERE id=$1 AND worker_lease_id=$2`,
      [lease.candidateId, lease.leaseId, error ?? null, retryable],
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

  async completeRequest(request: IntegrationV3RequestLease, receipt?: IntegrationV3CleanupReceipt): Promise<void> {
    const failed = receipt?.outcome === 'failed';
    const failure = failed
      ? receipt.actions.filter((action) => action.status === 'failed').map((action) => `${action.action}: ${action.error}`).join('; ')
      : null;
    await this.options.pool.query(
      `UPDATE ${this.options.requestsOutboxTable}
          SET status=CASE WHEN $3::boolean THEN 'failed' ELSE 'completed' END,
              receipt=$4::jsonb,lease_id=NULL,lease_expires_at=NULL,last_error=$5,updated_at=now()
        WHERE id=$1 AND lease_id=$2 AND status='processing'`,
      [request.id, request.leaseId, failed, receipt ? JSON.stringify(receipt) : null, failure]);
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

  async findRecoverableMergeOperation(candidateId: string, revision: number): Promise<string | undefined> {
    const result = await this.options.pool.query(
      `SELECT operation_key FROM ${this.options.providerOperationsTable}
        WHERE candidate_id=$1 AND candidate_revision=$2 AND kind='merge_pull_request'
          AND state IN ('executing','unknown','succeeded')
        ORDER BY CASE state WHEN 'succeeded' THEN 0 ELSE 1 END,updated_at DESC LIMIT 1`, [candidateId, revision]);
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
  validateServerOwnedRepository(repositoryPath: string): Promise<void>;
  pushIntegrationHead?: IntegrationV3ComposeHost['pushIntegrationHead'];
}

export class PostgresIntegrationV3ComposeHost implements IntegrationV3ComposeHost {
  readonly pushIntegrationHead;
  constructor(private readonly options: PostgresIntegrationV3ComposeHostOptions) { this.pushIntegrationHead = options.pushIntegrationHead; }

  async resolveContext(current: Required<IntegrationV3WorkerCurrent>): Promise<IntegrationV3ComposeContext> {
    const result = await this.options.pool.query(
      `SELECT b.repository,b.owner_user_id,b.tenant_id,
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
      repository, credentialOwnerId: String(row.owner_user_id), tenantId: String(row.tenant_id), ...paths,
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
  validateServerOwnedRepository(repositoryPath: string) {
    return this.options.validateServerOwnedRepository(repositoryPath);
  }
  runGit(command: RepositoryWorkspaceGitCommand) { return this.options.runGit(command); }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') return JSON.parse(value) as Record<string, unknown>;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
