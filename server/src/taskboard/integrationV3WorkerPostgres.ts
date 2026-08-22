import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
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
  terminalizePreparedOperations(): Promise<number>;
  applySourcePullRequest(input: { id: string; action: 'close' | 'comment' }): Promise<void>;
}

export async function terminalizeIntegrationV3PreparedOperations(options: {
  pool: { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
  providerOperationsTable: string;
  candidateId: string;
  reason: string;
}): Promise<number> {
  const result = await options.pool.query(
    `WITH terminalized AS (
       UPDATE ${options.providerOperationsTable}
          SET state='failed',error=$2,
              receipt=jsonb_build_object('outcome','not_applied','evidence','attempt_count=0'),
              updated_at=now()
        WHERE candidate_id=$1 AND state='prepared' AND attempt_count=0
        RETURNING id
     )
     SELECT (SELECT count(*) FROM terminalized)::int AS terminalized_count,
            (SELECT count(*) FROM ${options.providerOperationsTable} o
              WHERE o.candidate_id=$1 AND o.state IN ('prepared','executing','unknown')
                AND NOT EXISTS (SELECT 1 FROM terminalized t WHERE t.id=o.id))::int AS remaining_count`,
    [options.candidateId, `Candidate cleanup terminalized unexecuted provider operation: ${options.reason}`],
  );
  const terminalizedCount = Number(result.rows[0]?.terminalized_count ?? 0);
  const remainingCount = Number(result.rows[0]?.remaining_count ?? 0);
  if (remainingCount > 0) throw new Error(`${remainingCount} active provider operation(s) require reconciliation`);
  return terminalizedCount;
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
  try {
    const count = await options.terminalizePreparedOperations();
    actions.push({ action: 'terminalize_prepared_operations', status: 'succeeded', target: String(count) });
  } catch (error) {
    actions.push({
      action: 'terminalize_prepared_operations', status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (actions.some((action) => action.status === 'failed')) {
    const reason = 'cleanup safety barrier failed before destructive actions';
    actions.push({ action: 'remove_candidate_worktree', status: 'skipped', target: options.worktreePath, reason });
    for (const source of options.sourcePullRequests) {
      actions.push({ action: 'source_pull_request', status: 'skipped', target: source.id, reason });
    }
    return { version: 1, outcome: 'failed', actions, completedAt: new Date().toISOString() };
  }
  try {
    assertServerOwnedWorktreePath(options.controlledWorktreeRoot, options.worktreePath, options.candidateId);
    let alreadyAbsent = false;
    await options.withRepositoryBranchLock({ repositoryPath: options.repositoryPath, branch: options.branch }, async () => {
      if (!existsSync(options.worktreePath)) { alreadyAbsent = true; return; }
      assertServerOwnedWorktree(options.controlledWorktreeRoot, options.worktreePath, options.candidateId);
      const status = await options.runGit({ cwd: options.worktreePath, args: ['status', '--porcelain=v1', '--untracked-files=all'] });
      if (status.exitCode !== 0) throw new Error(`Cannot inspect candidate worktree: ${status.stderr || status.stdout}`);
      if (status.stdout.trim()) throw new Error('Candidate worktree is dirty; refusing cleanup');
      const removed = await options.runGit({ cwd: options.repositoryPath, args: ['worktree', 'remove', '--', options.worktreePath] });
      if (removed.exitCode !== 0) throw new Error(`Cannot remove candidate worktree: ${removed.stderr || removed.stdout}`);
    });
    actions.push(alreadyAbsent
      ? { action: 'remove_candidate_worktree', status: 'skipped', target: options.worktreePath, reason: 'candidate worktree is already absent' }
      : { action: 'remove_candidate_worktree', status: 'succeeded', target: options.worktreePath });
  } catch (error) {
    actions.push({
      action: 'remove_candidate_worktree', status: 'failed', target: options.worktreePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
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

function assertServerOwnedWorktreePath(root: string, worktreePath: string, candidateId: string): void {
  if (![root, worktreePath].every(isAbsolute) || normalize(worktreePath) !== worktreePath) throw new Error('Candidate worktree path is not absolute and normalized');
  const ownedRoot = resolve(root);
  const candidatePath = resolve(worktreePath);
  if (candidatePath !== resolve(ownedRoot, candidateId)) {
    throw new Error('Candidate worktree is outside the server-owned candidate root');
  }
}

function assertServerOwnedWorktree(root: string, worktreePath: string, candidateId: string): void {
  assertServerOwnedWorktreePath(root, worktreePath, candidateId);
  if (lstatSync(worktreePath).isSymbolicLink()) throw new Error('Candidate worktree must not be a symbolic link');
  const ownedRoot = realpathSync(root);
  const candidatePath = realpathSync(worktreePath);
  const child = relative(ownedRoot, candidatePath);
  if (!child || child === '..' || child.startsWith(`..${sep}`)) throw new Error('Candidate worktree escapes the server-owned candidate root');
  for (const path of [ownedRoot, candidatePath]) {
    const info = statSync(path);
    if (!info.isDirectory()) throw new Error('Candidate worktree ownership boundary is not a directory');
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('Candidate worktree owner mismatch');
    if ((info.mode & 0o022) !== 0) throw new Error('Candidate worktree boundary is group/world writable');
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
  blockEpisodesTable: string;
  boardsTable: string;
  executionsTable: string;
  dispatchAgent(input: {
    identity: { tenantId: string; ownerUserId: string; username: string };
    taskId: string;
    expectedVersion: number;
    purpose: 'work' | 'review';
    executionId: string;
    candidateId: string;
    candidateRevision: number;
    assertCurrent(): Promise<void>;
  }): Promise<{ executionId: string }>;
  syncWorkspace(request: IntegrationV3RequestLease): Promise<void>;
  cleanup(request: IntegrationV3RequestLease): Promise<IntegrationV3CleanupReceipt | void>;
  releaseIdentity: string;
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
          WHERE COALESCE(NULLIF(current_setting('agent_saas.integration_v3_enabled',true),'')::boolean,true)
            AND COALESCE((c.policy_snapshot->>'workflowVersion')::int,2)=3
            AND COALESCE((c.policy_snapshot->'featureFlags'->>'engineV3')::boolean,false)
            AND (c.worker_status<>'failed' OR c.worker_checkpoint->>'releaseIdentity' IS DISTINCT FROM $3)
            AND c.worker_available_at<=now()
            AND (c.worker_status IN ('idle','failed') OR c.worker_lease_expires_at<now())
            AND (c.state IN ('preparing','composing','waiting_checks','needs_work','working','in_review','approved','merging')
              OR (c.state='needs_human'
                AND c.worker_checkpoint->>'releaseIdentity' IS DISTINCT FROM $3
                AND EXISTS (
                  SELECT 1 FROM ${this.options.providerOperationsTable} o
                   WHERE o.candidate_id=c.id AND o.candidate_revision=c.current_revision
                     AND o.kind='merge_pull_request' AND o.state='succeeded'
                     AND o.receipt->>'providerRequestId'=o.operation_key
                ))
              OR (c.state IN ('merged','canceled') AND c.worker_checkpoint->>'status' IS DISTINCT FROM 'requested'))
          ORDER BY c.updated_at,c.id FOR UPDATE OF c SKIP LOCKED LIMIT 1
       )
       UPDATE ${this.options.candidatesTable} c
          SET worker_status='processing',worker_lease_id=$1,
              worker_lease_expires_at=now()+($2::bigint*interval '1 millisecond'),worker_error=NULL,
              worker_attempts=CASE WHEN c.worker_checkpoint->>'releaseIdentity' IS DISTINCT FROM $3 THEN 0 ELSE c.worker_attempts END,
              worker_checkpoint=c.worker_checkpoint||jsonb_build_object('releaseIdentity',$3::text)
         FROM claim WHERE c.id=claim.id RETURNING c.id`,
      [leaseId, leaseMs, this.options.releaseIdentity],
    );
    return result.rows[0] ? { candidateId: String(result.rows[0].id), leaseId } : undefined;
  }

  async loadCurrent(candidateId: string): Promise<IntegrationV3WorkerCurrent> {
    const result = await this.options.pool.query(
      `SELECT c.*,r.candidate_id AS r_candidate_id,r.revision AS r_revision,r.digest_version AS r_digest_version,
              r.base_oid AS r_base_oid,r.head_oid AS r_head_oid,r.subject_kind AS r_subject_kind,r.tree_oid AS r_tree_oid,
              r.composition_complete AS r_composition_complete,
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
        base_oid: row.r_base_oid, head_oid: row.r_head_oid, subject_kind: row.r_subject_kind, tree_oid: row.r_tree_oid,
        composition_complete: row.r_composition_complete,
        source_set_digest: row.r_source_set_digest, subject_digest: row.r_subject_digest,
        policy_snapshot_digest: row.r_policy_snapshot_digest, policy_revision: row.r_policy_revision,
        merge_method: row.r_merge_method, work_round: row.r_work_round, work_execution_id: row.r_work_execution_id,
        review_execution_id: row.r_review_execution_id, created_at: row.r_created_at,
      }) } : {}),
    };
  }

  async checkpointCandidate(lease: IntegrationV3CandidateLease, checkpoint: Record<string, unknown>): Promise<void> {
    await this.options.pool.query(
      `UPDATE ${this.options.candidatesTable}
          SET worker_checkpoint=$3::jsonb||jsonb_build_object('releaseIdentity',$4::text),updated_at=updated_at
        WHERE id=$1 AND worker_lease_id=$2 AND worker_status='processing'`,
      [lease.candidateId, lease.leaseId, JSON.stringify(checkpoint), this.options.releaseIdentity],
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
         LEFT JOIN ${this.options.revisionsTable} r
           ON r.candidate_id=c.id AND r.revision=c.current_revision
        WHERE o.status IN ('pending','processing') AND o.available_at<=now()
          AND (o.status='pending' OR o.lease_expires_at<now())
          AND o.candidate_revision=c.current_revision
          AND o.workflow_epoch=c.workflow_epoch AND o.lane_epoch=c.lane_epoch
          AND COALESCE(o.payload->>'candidateId','')=c.id
          AND (o.kind='cleanup' OR COALESCE(o.payload->>'revision','')=c.current_revision::text)
          AND ((o.kind='work' AND c.state='working'
                AND o.work_round=c.work_round
                AND COALESCE(o.payload->>'workRound','')=c.work_round::text
                AND COALESCE(o.payload->>'subjectDigest','')=COALESCE(r.subject_digest,''))
            OR (o.kind='review' AND c.state='in_review'
                AND COALESCE(o.payload->>'subjectDigest','')=COALESCE(r.subject_digest,'')
                AND COALESCE(o.payload->>'sourceSetDigest','')=COALESCE(c.source_set_digest,''))
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
    if (typeof request.payload.executionId === 'string' && request.payload.executionId) return;
    const loadDispatchFence = () => this.options.pool.query(
      `SELECT t.id,t.version,b.tenant_id,b.owner_user_id
         FROM ${this.options.candidatesTable} c JOIN ${this.options.tasksTable} t ON t.id=c.integration_task_id
         JOIN ${this.options.boardsTable} b ON b.id=t.board_id
         JOIN ${this.options.requestsOutboxTable} o ON o.id=$3
        WHERE c.id=$1 AND c.current_revision=$2
          AND o.lease_id=$4 AND o.status='processing'
          AND o.candidate_id=c.id AND o.candidate_revision=c.current_revision
          AND o.workflow_epoch=c.workflow_epoch AND o.lane_epoch=c.lane_epoch`,
      [request.candidateId, request.candidateRevision, request.id, request.leaseId],
    );
    const result = await loadDispatchFence();
    const row = result.rows[0];
    if (!row) throw new Error('Candidate execution dispatch fence is stale');
    const renewed = await this.options.pool.query(
      `UPDATE ${this.options.requestsOutboxTable}
          SET lease_expires_at=now()+interval '5 minutes',updated_at=now()
        WHERE id=$1 AND lease_id=$2 AND status='processing' RETURNING id`,
      [request.id, request.leaseId],
    );
    if (!renewed.rows[0]) throw new Error('Candidate execution request lease changed before workspace preparation');
    const executionId = `integration-v3-request-${request.id}`;
    await this.options.dispatchAgent({
      identity: { tenantId: String(row.tenant_id), ownerUserId: String(row.owner_user_id), username: 'board-owner' },
      taskId: String(row.id), expectedVersion: Number(row.version), purpose: request.kind as 'work'|'review', executionId,
      candidateId: request.candidateId, candidateRevision: request.candidateRevision,
      assertCurrent: async () => {
        const verified = (await loadDispatchFence()).rows[0];
        if (!verified || Number(verified.version) !== Number(row.version)) {
          throw new Error('Candidate execution dispatch fence changed during workspace preparation');
        }
      },
    });
    const bound = await this.options.pool.query(
      `UPDATE ${this.options.requestsOutboxTable}
          SET payload=payload||jsonb_build_object('executionId',$3::text),updated_at=now()
        WHERE id=$1 AND lease_id=$2 AND status='processing' RETURNING id`,
      [request.id, request.leaseId, executionId],
    );
    if (!bound.rows[0]) throw new Error('Candidate execution request lease changed before binding');
  }
  async syncWorkspace(request: IntegrationV3RequestLease): Promise<void> {
    await this.options.syncWorkspace(request);
    if (request.payload.reason !== 'resume_reconcile') return;
    const resumeState = request.payload.resumeState;
    if (resumeState !== 'needs_work' && resumeState !== 'in_review') {
      throw new Error('Workspace resume state is invalid');
    }
    const result = await this.options.pool.query(
      `WITH resumed AS (
         UPDATE ${this.options.candidatesTable}
            SET state=$3,last_error=NULL,version=version+1,updated_at=now()
          WHERE id=$1 AND current_revision=$2
            AND workflow_epoch=$4::bigint AND lane_epoch=$5::bigint
            AND state IN ('blocked','needs_human')
          RETURNING integration_task_id
       ), task_resumed AS (
         UPDATE ${this.options.tasksTable} t
            SET status=CASE WHEN $3='in_review' THEN 'in_review' ELSE 'in_progress' END,
                version=version+1,updated_at=now()
           FROM resumed WHERE t.id=resumed.integration_task_id RETURNING t.id
       ), closed AS (
         UPDATE ${this.options.blockEpisodesTable} b SET closed_at=COALESCE(b.closed_at,now())
           FROM task_resumed WHERE b.task_id=task_resumed.id AND b.closed_at IS NULL RETURNING b.id
       )
       SELECT id FROM task_resumed`,
      [request.candidateId, request.candidateRevision, resumeState,
        String(request.payload.workflowEpoch ?? ''), String(request.payload.laneEpoch ?? '')],
    );
    if (!result.rows[0]) throw new Error('Workspace resume fence is stale');
  }
  cleanup(request: IntegrationV3RequestLease) { return this.options.cleanup(request); }

  async completeRequest(request: IntegrationV3RequestLease, receipt?: IntegrationV3CleanupReceipt): Promise<void> {
    const failed = receipt?.outcome === 'failed';
    const failure = failed
      ? receipt.actions.filter((action) => action.status === 'failed').map((action) => `${action.action}: ${action.error}`).join('; ')
      : null;
    await this.options.pool.query(
      `UPDATE ${this.options.requestsOutboxTable}
          SET status=CASE WHEN $3::boolean AND attempts<5 THEN 'pending' WHEN $3::boolean THEN 'failed' ELSE 'completed' END,
              available_at=CASE WHEN $3::boolean AND attempts<5 THEN now()+(LEAST(attempts,5)*interval '5 seconds') ELSE available_at END,
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

  async findRecoverableMergeOperation(candidateId: string, revision: number) {
    const result = await this.options.pool.query(
      `SELECT operation_key,state FROM ${this.options.providerOperationsTable}
        WHERE candidate_id=$1 AND candidate_revision=$2 AND kind='merge_pull_request'
          AND state IN ('prepared','executing','unknown','succeeded')
        ORDER BY CASE state WHEN 'succeeded' THEN 0 WHEN 'executing' THEN 1
          WHEN 'unknown' THEN 2 ELSE 3 END,updated_at DESC LIMIT 1`, [candidateId, revision]);
    return result.rows[0] ? {
      operationKey: String(result.rows[0].operation_key),
      state: String(result.rows[0].state) as 'prepared' | 'executing' | 'unknown' | 'succeeded',
    } : undefined;
  }
}

export interface PostgresIntegrationV3ComposeHostOptions {
  pool: IntegrationV3WorkerPostgresOptions['pool'];
  candidatesTable: string;
  sourceSnapshotsTable: string;
  tasksTable: string;
  boardsTable: string;
  executionsTable: string;
  resolutionsTable: string;
  requestsOutboxTable: string;
  providerOperationsTable: string;
  resolvePaths(
    repository: TaskBoardRepositoryConfig,
    candidateId: string,
    identity: { tenantId: string; ownerUserId: string },
  ): Promise<{ repositoryPath: string; worktreePath: string } | undefined>;
  runGit(command: RepositoryWorkspaceGitCommand): Promise<RepositoryWorkspaceGitResult>;
  validateServerOwnedRepository(repositoryPath: string): Promise<void>;
  withRepositoryFetchCredential?: IntegrationV3ComposeHost['withRepositoryFetchCredential'];
  pushIntegrationHead?: IntegrationV3ComposeHost['pushIntegrationHead'];
}

export class PostgresIntegrationV3ComposeHost implements IntegrationV3ComposeHost {
  readonly pushIntegrationHead;
  constructor(private readonly options: PostgresIntegrationV3ComposeHostOptions) { this.pushIntegrationHead = options.pushIntegrationHead; }

  withRepositoryFetchCredential<T>(
    context: IntegrationV3ComposeContext,
    action: (env: Readonly<Record<string, string>>) => Promise<T>,
  ): Promise<T> {
    return this.options.withRepositoryFetchCredential?.(context, action) ?? action({});
  }

  async resolveContext(current: Required<IntegrationV3WorkerCurrent>): Promise<IntegrationV3ComposeContext> {
    const result = await this.options.pool.query(
      `SELECT b.repository,b.owner_user_id,b.tenant_id,
              work.execution_id AS work_execution_id,
              push.execution_id AS push_execution_id,push.candidate_id AS push_candidate_id,
              push.candidate_revision AS push_candidate_revision,push.workflow_epoch AS push_workflow_epoch,
              push.lane_epoch AS push_lane_epoch,push.ref AS push_ref,
              push.old_oid AS push_old_oid,push.new_oid AS push_new_oid,
              trusted.old_oids AS trusted_integration_branch_oids
         FROM ${this.options.candidatesTable} c JOIN ${this.options.tasksTable} t ON t.id=c.integration_task_id
         JOIN ${this.options.boardsTable} b ON b.id=t.board_id
         LEFT JOIN LATERAL (
           SELECT e.id AS execution_id
             FROM ${this.options.requestsOutboxTable} o
             JOIN ${this.options.executionsTable} e ON e.id=o.payload->>'executionId'
             JOIN ${this.options.resolutionsTable} r ON r.execution_id=e.id
            WHERE o.candidate_id=c.id AND o.candidate_revision=c.current_revision
              AND o.kind='work' AND o.work_round=c.work_round
              AND o.workflow_epoch=c.workflow_epoch AND o.lane_epoch=c.lane_epoch
              AND COALESCE(o.payload->>'subjectDigest','')=$2
              AND e.task_id=c.integration_task_id AND e.purpose='work'
              AND e.status='succeeded' AND r.outcome='ready_for_review'
              AND r.historical=false AND r.applied=true
            ORDER BY r.resolved_at DESC,o.updated_at DESC LIMIT 1
         ) work ON true
         LEFT JOIN LATERAL (
           SELECT o.execution_id,o.candidate_id,o.candidate_revision,o.workflow_epoch,o.lane_epoch,
                  o.receipt->>'ref' AS ref,o.receipt->>'oldOid' AS old_oid,o.receipt->>'newOid' AS new_oid
             FROM ${this.options.providerOperationsTable} o
            WHERE work.execution_id IS NOT NULL AND o.kind='push_ref' AND o.state='succeeded'
              AND o.execution_id=work.execution_id AND o.candidate_id=c.id
              AND o.candidate_revision=c.current_revision
              AND o.workflow_epoch=c.workflow_epoch AND o.lane_epoch=c.lane_epoch
              AND o.expected->>'ref'=('refs/heads/'||c.branch)
              AND o.expected->>'oldOid'=$3
              AND o.receipt->>'ref'=o.expected->>'ref'
              AND o.receipt->>'oldOid'=o.expected->>'oldOid'
              AND o.receipt->>'newOid'=o.expected->>'newOid'
            ORDER BY o.updated_at DESC,o.id DESC LIMIT 1
         ) push ON true
         LEFT JOIN LATERAL (
           SELECT array_agg(DISTINCT oid.value) FILTER (
                    WHERE oid.value ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
                  ) AS old_oids
             FROM ${this.options.providerOperationsTable} o
             CROSS JOIN LATERAL (VALUES
               (o.expected->>'oldOid'),
               (CASE WHEN o.state IN ('executing','unknown','succeeded') THEN o.expected->>'newOid' END)
             ) oid(value)
            WHERE o.candidate_id=c.id AND o.candidate_revision=c.current_revision
              AND o.workflow_epoch=c.workflow_epoch AND o.lane_epoch=c.lane_epoch
              AND o.kind='push_ref' AND o.attempt_count>0
              AND o.state IN ('executing','unknown','failed','needs_human','succeeded')
              AND o.expected->>'ref'=('refs/heads/'||c.branch)
         ) trusted ON true
        WHERE c.id=$1`, [current.candidate.id, current.revision.subjectDigest, current.revision.headOid]);
    const row = result.rows[0];
    const repository = record(row?.repository) as unknown as TaskBoardRepositoryConfig;
    if (!row || repository.provider !== 'github' || repository.repositoryId !== current.candidate.repositoryId) throw new Error('Repository provider is unsupported or unknown');
    const paths = await this.options.resolvePaths(repository, current.candidate.id, {
      tenantId: String(row.tenant_id), ownerUserId: String(row.owner_user_id),
    });
    if (!paths) throw new Error('Local repository workspace is unavailable');
    const snapshots = await this.options.pool.query(
      `SELECT * FROM ${this.options.sourceSnapshotsTable} WHERE candidate_id=$1 AND revision=$2 ORDER BY source_order`,
      [current.candidate.id, current.candidate.currentRevision]);
    return {
      repository, credentialOwnerId: String(row.owner_user_id), tenantId: String(row.tenant_id), ...paths,
      sources: snapshots.rows.map(rowToIntegrationCandidateSourceSnapshot),
      trustedIntegrationBranchOids: Array.isArray(row.trusted_integration_branch_oids)
        ? row.trusted_integration_branch_oids.map(String)
        : [],
      ...(row.work_execution_id ? { workExecutionId: String(row.work_execution_id) } : {}),
      ...(row.push_execution_id ? { workPushReceipt: {
        executionId: String(row.push_execution_id),
        candidateId: String(row.push_candidate_id),
        candidateRevision: Number(row.push_candidate_revision),
        workflowEpoch: String(row.push_workflow_epoch),
        laneEpoch: String(row.push_lane_epoch),
        ref: String(row.push_ref),
        oldOid: String(row.push_old_oid),
        newOid: String(row.push_new_oid),
      } } : {}),
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
    const key = [lock.repositoryPath, lock.branch];
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1),hashtext($2))', key);
      return await operation();
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1),hashtext($2))', key).catch(() => undefined);
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
