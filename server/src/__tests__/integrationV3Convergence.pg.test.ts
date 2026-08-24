import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  computeIntegrationRequirementDigest,
  computeIntegrationReviewReceiptDigest,
} from '../taskboard/integrationCandidateDigest.js';
import { integrationCandidateTableNames, runIntegrationCandidateSchema } from '../taskboard/integrationCandidateSchema.js';
import { IntegrationEngineV3 } from '../taskboard/integrationEngineV3.js';
import {
  PostgresIntegrationEngineV3CandidateHost,
  PostgresIntegrationEngineV3FeatureHost,
  PostgresIntegrationEngineV3RequestHost,
} from '../taskboard/integrationEngineV3Postgres.js';
import { requeueFailedIntegrationV3Candidate } from '../taskboard/integrationV3Repair.js';
import { expectedSubject, IntegrationV3Worker } from '../taskboard/integrationV3Worker.js';
import { PostgresIntegrationV3WorkerHost } from '../taskboard/integrationV3WorkerPostgres.js';
import { PgTaskboardStore } from '../taskboard/store.js';
import type { TaskboardIdentity } from '../taskboard/types.js';

const { Pool } = pg;
const connectionString = process.env.TEST_DATABASE_URL?.trim();
const describePg = connectionString ? describe : describe.skip;
const identity: TaskboardIdentity = {
  tenantId: 'tenant-v3-convergence', ownerUserId: 'v3-convergence-owner', username: 'v3-convergence-owner',
};

describePg('Workflow v3 convergence invariants (PostgreSQL)', () => {
  const prefix = `tbv3c_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  let pool: InstanceType<typeof Pool>;
  let store: PgTaskboardStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, connectionTimeoutMillis: 5_000 });
    store = new PgTaskboardStore({ pool, tablePrefix: prefix });
    await store.init();
  }, 30_000);

  afterAll(async () => {
    if (!pool) return;
    try {
      const tables = await pool.query(
        `SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename LIKE $1`, [`${prefix}%`],
      );
      for (const row of tables.rows) await pool.query(`DROP TABLE IF EXISTS ${String(row.tablename)} CASCADE`);
    } finally {
      await pool.end();
    }
  }, 30_000);

  async function seedCandidate(input: {
    state: 'preparing' | 'composing' | 'waiting_checks' | 'needs_work' | 'working' | 'in_review' | 'blocked';
    taskStatus: 'todo' | 'in_progress';
    checkpoint?: Record<string, unknown>;
    revision?: {
      subjectKind?: 'provider_subject' | 'source_seed';
      treeOid?: string | null;
      compositionComplete?: boolean;
      workRound?: number;
    };
  }) {
    const board = await store.createBoard(identity, { name: `V3 convergence ${randomUUID()}` });
    const taskId = randomUUID();
    const candidateId = randomUUID();
    const repositoryId = `repo-${candidateId}`;
    await pool.query(
      `INSERT INTO ${store.tasksTable}
         (id,board_id,identifier,kind,title,status,sort_order,workflow_version)
       VALUES($1,$2,$3,'integration','V3 convergence',$4,1,3)`,
      [taskId, board.id, `V3-${taskId.slice(0, 8)}`, input.taskStatus],
    );
    const tables = integrationCandidateTableNames(store.integrationSourcesTable);
    await pool.query(
      `INSERT INTO ${tables.candidatesTable}
         (id,integration_task_id,repository_id,base_branch,branch,state,current_revision,workflow_epoch,lane_epoch,
          policy_revision,merge_method,policy_snapshot,source_set_digest,worker_status,worker_checkpoint)
       VALUES($1,$2,$3,'main',$4,$5,1,1,1,'p1','squash',$6::jsonb,'sources','idle',$7::jsonb)`,
      [candidateId, taskId, repositoryId, `integration/${candidateId}`, input.state,
        JSON.stringify({ workflowVersion: 3, featureFlags: { engineV3: true, compose: true, review: true, merge: true, cleanup: true, workspaceSync: true } }),
        JSON.stringify(input.checkpoint ?? {})],
    );
    await pool.query(
      `INSERT INTO ${tables.revisionsTable}
         (candidate_id,revision,digest_version,base_oid,head_oid,subject_kind,tree_oid,composition_complete,
          source_set_digest,subject_digest,policy_snapshot_digest,policy_revision,merge_method,work_round)
       VALUES($1,1,1,'base-1','head-1',$2,$3,$4,'sources','subject-1','policy-1','p1','squash',$5)`,
      [candidateId, input.revision?.subjectKind ?? 'provider_subject',
        input.revision?.treeOid === undefined ? 'tree-1' : input.revision.treeOid,
        input.revision?.compositionComplete ?? true, input.revision?.workRound ?? 0],
    );
    await pool.query(
      `INSERT INTO ${store.integrationLanesTable}(repository_id,board_id,active_integration_task_id,epoch)
       VALUES($1,$2,$3,1)`, [repositoryId, board.id, taskId],
    );
    return { board, taskId, candidateId, repositoryId, tables };
  }

  function pgOptions(seed: Awaited<ReturnType<typeof seedCandidate>>) {
    return {
      pool, candidatesTable: seed.tables.candidatesTable, revisionsTable: seed.tables.revisionsTable,
      sourceSnapshotsTable: seed.tables.sourceSnapshotsTable, providerOperationsTable: seed.tables.providerOperationsTable,
      requestsOutboxTable: seed.tables.requestsOutboxTable, tasksTable: store.tasksTable,
      blockEpisodesTable: store.blockEpisodesTable, boardsTable: store.boardsTable,
      executionsTable: store.executionsTable, integrationSourcesTable: store.integrationSourcesTable,
      integrationLanesTable: store.integrationLanesTable,
    };
  }

  it('forces source_seed incomplete when an old writer omits the v6 column', async () => {
    const seed = await seedCandidate({ state: 'waiting_checks', taskStatus: 'todo' });
    await pool.query(
      `INSERT INTO ${seed.tables.revisionsTable}
         (candidate_id,revision,digest_version,base_oid,head_oid,subject_kind,tree_oid,source_set_digest,
          subject_digest,policy_snapshot_digest,policy_revision,merge_method,work_round)
       VALUES($1,2,1,'base-2','head-2','source_seed',NULL,'sources-2','subject-2','policy-2','p1','squash',0)`,
      [seed.candidateId],
    );
    const row = await pool.query(
      `SELECT composition_complete FROM ${seed.tables.revisionsTable} WHERE candidate_id=$1 AND revision=2`,
      [seed.candidateId],
    );
    expect(row.rows).toEqual([{ composition_complete: false }]);
  });

  it('recovers only the legacy incomplete source_seed by returning it to composing and preserving failed Work evidence', async () => {
    const seed = await seedCandidate({
      state: 'working', taskStatus: 'in_progress',
      revision: { subjectKind: 'source_seed', treeOid: null, compositionComplete: false },
    });
    const workerError = 'Work request exhausted retries and requires operator recovery';
    const requestError = 'Candidate execution workspace binding is stale';
    await pool.query(
      `UPDATE ${seed.tables.candidatesTable}
          SET worker_status='failed',worker_error=$2,worker_attempts=5,worker_lease_id=NULL
        WHERE id=$1`,
      [seed.candidateId, workerError],
    );
    await pool.query(
      `UPDATE ${store.tasksTable} SET status='blocked' WHERE id=$1`,
      [seed.taskId],
    );
    const blockEpisodeId = randomUUID();
    await pool.query(
      `INSERT INTO ${store.blockEpisodesTable}(id,task_id,purpose,reason_code,reason)
       VALUES($1,$2,'work','integration_candidate_worker_failed',$3)`,
      [blockEpisodeId, seed.taskId, workerError],
    );
    const outboxId = randomUUID();
    await pool.query(
      `INSERT INTO ${seed.tables.requestsOutboxTable}
         (id,request_key,kind,candidate_id,candidate_revision,work_round,workflow_epoch,lane_epoch,
          payload,status,attempts,last_error)
       VALUES($1,$2,'work',$3,1,0,1,1,'{}'::jsonb,'failed',5,$4)`,
      [outboxId, `legacy-${outboxId}`, seed.candidateId, requestError],
    );

    await expect(requeueFailedIntegrationV3Candidate(pool, {
      tasks: store.tasksTable, candidates: seed.tables.candidatesTable, revisions: seed.tables.revisionsTable,
      requestsOutbox: seed.tables.requestsOutboxTable, changes: store.changesTable,
      blockEpisodes: store.blockEpisodesTable,
    }, {
      taskId: seed.taskId, actorId: identity.ownerUserId, reason: 'partial composition support deployed',
    })).resolves.toEqual({
      candidateId: seed.candidateId, taskId: seed.taskId, previousError: workerError,
      recoveryKind: 'composition', outboxId, status: 'idle',
    });

    const candidate = await pool.query(
      `SELECT state,worker_status,worker_error,worker_attempts,provider_pull_request_id
         FROM ${seed.tables.candidatesTable} WHERE id=$1`, [seed.candidateId],
    );
    expect(candidate.rows).toEqual([{
      state: 'composing', worker_status: 'idle', worker_error: null, worker_attempts: 0,
      provider_pull_request_id: null,
    }]);
    const resumedTask = await pool.query(
      `SELECT status FROM ${store.tasksTable} WHERE id=$1`, [seed.taskId],
    );
    expect(resumedTask.rows).toEqual([{ status: 'in_progress' }]);
    const closedBlock = await pool.query(
      `SELECT closed_at IS NOT NULL AS closed FROM ${store.blockEpisodesTable} WHERE id=$1`, [blockEpisodeId],
    );
    expect(closedBlock.rows).toEqual([{ closed: true }]);
    const outbox = await pool.query(
      `SELECT status,attempts,last_error FROM ${seed.tables.requestsOutboxTable} WHERE id=$1`, [outboxId],
    );
    expect(outbox.rows).toEqual([{ status: 'failed', attempts: 5, last_error: requestError }]);
  });

  it('resumes a blocked pre-provider composition from its durable composing checkpoint', async () => {
    const seed = await seedCandidate({
      state: 'blocked', taskStatus: 'in_progress', checkpoint: { state: 'composing' },
      revision: { subjectKind: 'source_seed', treeOid: null, compositionComplete: false },
    });
    const workerError = 'safe Git inspection rejected';
    await pool.query(
      `UPDATE ${seed.tables.candidatesTable}
          SET worker_status='failed',worker_error=$2,worker_attempts=10,worker_lease_id=NULL
        WHERE id=$1`,
      [seed.candidateId, workerError],
    );
    await pool.query(`UPDATE ${store.tasksTable} SET status='blocked' WHERE id=$1`, [seed.taskId]);
    const blockEpisodeId = randomUUID();
    await pool.query(
      `INSERT INTO ${store.blockEpisodesTable}(id,task_id,purpose,reason_code,reason)
       VALUES($1,$2,'work','integration_candidate_worker_failed',$3)`,
      [blockEpisodeId, seed.taskId, workerError],
    );

    await expect(requeueFailedIntegrationV3Candidate(pool, {
      tasks: store.tasksTable, candidates: seed.tables.candidatesTable, revisions: seed.tables.revisionsTable,
      requestsOutbox: seed.tables.requestsOutboxTable, changes: store.changesTable,
      blockEpisodes: store.blockEpisodesTable,
    }, {
      taskId: seed.taskId, actorId: identity.ownerUserId, reason: 'safe inspection fix deployed',
    })).resolves.toEqual({
      candidateId: seed.candidateId, taskId: seed.taskId, previousError: workerError,
      recoveryKind: 'composition', status: 'idle',
    });

    const recovered = await pool.query(
      `SELECT c.state,c.worker_status,c.worker_error,c.worker_attempts,t.status,
              block.closed_at IS NOT NULL AS block_closed
         FROM ${seed.tables.candidatesTable} c
         JOIN ${store.tasksTable} t ON t.id=c.integration_task_id
         JOIN ${store.blockEpisodesTable} block ON block.task_id=t.id
        WHERE c.id=$1 AND block.id=$2`,
      [seed.candidateId, blockEpisodeId],
    );
    expect(recovered.rows).toEqual([{
      state: 'composing', worker_status: 'idle', worker_error: null, worker_attempts: 0,
      status: 'in_progress', block_closed: true,
    }]);
  });

  it('exposes the current candidate revision and complete frozen snapshots to Work context', async () => {
    const seed = await seedCandidate({ state: 'working', taskStatus: 'in_progress' });
    const deliveryTaskId = randomUUID();
    const integrationSourceId = randomUUID();
    const reviewExecutionId = randomUUID();
    await pool.query(
      `INSERT INTO ${store.tasksTable}
         (id,board_id,identifier,kind,title,status,sort_order)
       VALUES($1,$2,$3,'delivery','Frozen source','ready_to_merge',2)`,
      [deliveryTaskId, seed.board.id, `SRC-${deliveryTaskId.slice(0, 8)}`],
    );
    await pool.query(
      `INSERT INTO ${store.executionsTable}
         (id,task_id,run_id,session_id,status,purpose,trigger,protocol_version,attempt_id,requested_by,finished_at)
       VALUES($1,$2,$3,$4,'succeeded','review','initial',2,$5,$6,now())`,
      [reviewExecutionId, deliveryTaskId, `run-${reviewExecutionId}`, `session-${reviewExecutionId}`,
        `attempt-${reviewExecutionId}`, identity.ownerUserId],
    );
    await pool.query(
      `INSERT INTO ${store.integrationSourcesTable}
         (id,integration_task_id,delivery_task_id,repository_id,provider_pull_request_id,
          reviewed_subject_digest,source_order,state)
       VALUES($1,$2,$3,$4,'77','reviewed',0,'ready')`,
      [integrationSourceId, seed.taskId, deliveryTaskId, seed.repositoryId],
    );
    await pool.query(
      `INSERT INTO ${seed.tables.sourceSnapshotsTable}
         (candidate_id,revision,source_order,integration_source_id,delivery_task_id,delivery_task_version,
          repository_id,provider_pull_request_id,frozen_head_oid,frozen_base_oid,reviewed_subject_digest,
          review_execution_id,review_receipt_digest,requirement_digest)
       VALUES($1,1,0,$2,$3,1,$4,'77','frozen-head','frozen-base','reviewed',$5,'receipt','requirement')`,
      [seed.candidateId, integrationSourceId, deliveryTaskId, seed.repositoryId, reviewExecutionId],
    );
    const context = await store.getExecutionContextV2(identity, seed.taskId, { include: ['integrationSources'] });
    expect(context.integrationCandidate).toMatchObject({
      candidate: { id: seed.candidateId, state: 'working' },
      revision: { revision: 1, compositionComplete: true, sourceSetDigest: 'sources' },
      sourceSnapshots: [{ order: 0, frozenHeadOid: 'frozen-head', frozenBaseOid: 'frozen-base' }],
    });
  });

  it('projects blocked candidate states to the task and creates only one open episode', async () => {
    const seed = await seedCandidate({ state: 'waiting_checks', taskStatus: 'todo' });
    const host = new PostgresIntegrationEngineV3CandidateHost(pgOptions(seed));
    const current = await host.getCurrent(seed.candidateId);
    await host.transition(seed.candidateId, {
      expectedVersion: current.candidate.version, expectedRevision: 1,
      to: 'blocked', lastError: 'provider gates unavailable',
    });
    const blocked = await host.getCurrent(seed.candidateId);
    await host.transition(seed.candidateId, {
      expectedVersion: blocked.candidate.version, expectedRevision: 1,
      to: 'needs_human', lastError: 'operator decision required',
    });
    expect((await store.getTask(identity, seed.taskId)).status).toBe('blocked');
    const episodes = await pool.query(
      `SELECT purpose,reason FROM ${store.blockEpisodesTable} WHERE task_id=$1 AND closed_at IS NULL`, [seed.taskId],
    );
    expect(episodes.rows).toEqual([{ purpose: 'work', reason: 'provider gates unavailable' }]);
  });

  it('uses the locked candidate as v3 resume authority and closes the episode after workspace sync', async () => {
    const seed = await seedCandidate({ state: 'blocked', taskStatus: 'todo' });
    const episodeId = randomUUID();
    await pool.query(
      `INSERT INTO ${store.blockEpisodesTable}(id,task_id,purpose,reason_code,reason)
       VALUES($1,$2,'work','integration_candidate_blocked','workspace requires repair')`,
      [episodeId, seed.taskId],
    );
    const task = await store.getTask(identity, seed.taskId);
    await expect(store.resumeBlockedTask(identity, seed.taskId, {
      expectedVersion: task.version, decision: 'reconcile workspace',
    })).resolves.toMatchObject({ id: seed.taskId });
    const queued = await pool.query(
      `SELECT * FROM ${seed.tables.requestsOutboxTable} WHERE candidate_id=$1 AND kind='workspace_sync'`, [seed.candidateId],
    );
    const host = new PostgresIntegrationV3WorkerHost({
      ...pgOptions(seed), releaseIdentity: 'test-release', dispatchAgent: async () => ({ executionId: 'unused' }),
      syncWorkspace: async () => undefined, cleanup: async () => undefined,
    });
    const request = await host.claimRequest(30_000);
    expect(request).toMatchObject({
      id: String(queued.rows[0].id), kind: 'workspace_sync',
      candidateId: seed.candidateId, candidateRevision: 1,
    });
    await host.syncWorkspace(request!);
    expect((await store.getTask(identity, seed.taskId)).status).toBe('in_progress');
    expect((await pool.query(
      `SELECT closed_at FROM ${store.blockEpisodesTable} WHERE id=$1`, [episodeId],
    )).rows[0].closed_at).toBeInstanceOf(Date);
  });

  it.each([
    { label: 'non-retryable', attempts: 0, retryable: false },
    { label: 'tenth retryable', attempts: 9, retryable: true },
  ])('atomically blocks a $label Worker failure and requires explicit resume before a new release can claim', async ({ attempts, retryable }) => {
    const seed = await seedCandidate({ state: 'waiting_checks', taskStatus: 'todo' });
    await pool.query(
      `UPDATE ${seed.tables.candidatesTable}
          SET worker_status='failed'
        WHERE id<>$1`,
      [seed.candidateId],
    );
    await pool.query(
      `UPDATE ${seed.tables.candidatesTable}
          SET worker_status='processing',worker_attempts=$2,worker_lease_id='lease-old',
              worker_lease_epoch=7,worker_release_identity='release-old',
              worker_lease_expires_at=now()+interval '1 hour',worker_error=NULL
        WHERE id=$1`,
      [seed.candidateId, attempts],
    );
    const options = pgOptions(seed);
    const oldHost = new PostgresIntegrationV3WorkerHost({
      ...options, releaseIdentity: 'release-old', dispatchAgent: async () => ({ executionId: 'unused' }),
      syncWorkspace: async () => undefined, cleanup: async () => undefined,
    });
    const failure = retryable ? 'retry budget exhausted' : 'deterministic ownership failure';
    await oldHost.releaseCandidate({
      candidateId: seed.candidateId, leaseId: 'lease-old', leaseEpoch: '7', releaseIdentity: 'release-old',
    }, failure, retryable, { cause: retryable ? 'attempt_10' : 'non_retryable' });

    const blocked = (await pool.query(
      `SELECT state,worker_status,worker_attempts,worker_error,last_error,
              worker_checkpoint->'failureEvidence' AS failure_evidence
         FROM ${seed.tables.candidatesTable} WHERE id=$1`,
      [seed.candidateId],
    )).rows[0];
    expect(blocked).toMatchObject({
      state: 'blocked', worker_status: 'failed', worker_attempts: attempts + 1,
      worker_error: failure, last_error: failure,
      failure_evidence: { cause: retryable ? 'attempt_10' : 'non_retryable' },
    });
    expect((await store.getTask(identity, seed.taskId)).status).toBe('blocked');
    expect((await pool.query(
      `SELECT purpose,reason_code,reason,closed_at FROM ${store.blockEpisodesTable} WHERE task_id=$1`,
      [seed.taskId],
    )).rows).toEqual([{
      purpose: 'work', reason_code: 'integration_candidate_worker_failed', reason: failure, closed_at: null,
    }]);

    const newHost = new PostgresIntegrationV3WorkerHost({
      ...options, releaseIdentity: 'release-new', dispatchAgent: async () => ({ executionId: 'unused' }),
      syncWorkspace: async () => undefined, cleanup: async () => undefined,
    });
    await expect(newHost.claimCandidate(30_000)).resolves.toBeUndefined();

    const blockedTask = await store.getTask(identity, seed.taskId);
    await store.resumeBlockedTask(identity, seed.taskId, {
      expectedVersion: blockedTask.version, decision: 'retry after operator review',
    });
    const request = await newHost.claimRequest(30_000);
    expect(request).toMatchObject({
      kind: 'workspace_sync', candidateId: seed.candidateId, candidateRevision: 1,
      payload: { reason: 'resume_reconcile', resumeState: 'needs_work' },
    });
    await newHost.syncWorkspace(request!);
    const resumed = (await pool.query(
      `SELECT state,worker_status,worker_attempts,worker_error,worker_lease_id,
              worker_lease_expires_at,worker_release_identity
         FROM ${seed.tables.candidatesTable} WHERE id=$1`,
      [seed.candidateId],
    )).rows[0];
    expect(resumed).toEqual({
      state: 'needs_work', worker_status: 'idle', worker_attempts: 0, worker_error: null,
      worker_lease_id: null, worker_lease_expires_at: null, worker_release_identity: null,
    });
    expect((await store.getTask(identity, seed.taskId)).status).toBe('in_progress');
    expect((await pool.query(
      `SELECT closed_at FROM ${store.blockEpisodesTable} WHERE task_id=$1`, [seed.taskId],
    )).rows[0].closed_at).toBeInstanceOf(Date);
    await expect(newHost.claimCandidate(30_000)).resolves.toMatchObject({
      candidateId: seed.candidateId, releaseIdentity: 'release-new',
    });
  });

  it('rolls back compose_persisted when the Worker loses its lease after assertion but before Candidate SQL', async () => {
    const seed = await seedCandidate({
      state: 'composing', taskStatus: 'in_progress',
      revision: { subjectKind: 'source_seed', treeOid: null, compositionComplete: false },
    });
    const deliveryTaskId = randomUUID();
    const integrationSourceId = randomUUID();
    const reviewExecutionId = randomUUID();
    await pool.query(
      `INSERT INTO ${store.tasksTable}
         (id,board_id,identifier,kind,title,status,sort_order,head_oid,base_oid)
       VALUES($1,$2,$3,'delivery','Frozen source','ready_to_merge',2,'frozen-head','frozen-base')`,
      [deliveryTaskId, seed.board.id, `SRC-${deliveryTaskId.slice(0, 8)}`],
    );
    await pool.query(
      `INSERT INTO ${store.executionsTable}
         (id,task_id,run_id,session_id,status,purpose,trigger,protocol_version,attempt_id,requested_by,finished_at)
       VALUES($1,$2,$3,$4,'succeeded','review','initial',2,$5,$6,now())`,
      [reviewExecutionId, deliveryTaskId, `run-${reviewExecutionId}`, `session-${reviewExecutionId}`,
        `attempt-${reviewExecutionId}`, identity.ownerUserId],
    );
    await pool.query(
      `INSERT INTO ${store.integrationSourcesTable}
         (id,integration_task_id,delivery_task_id,repository_id,provider_pull_request_id,
          reviewed_subject_digest,source_order,state)
       VALUES($1,$2,$3,$4,'77','reviewed',0,'ready')`,
      [integrationSourceId, seed.taskId, deliveryTaskId, seed.repositoryId],
    );
    const source = {
      order: 0, integrationSourceId, deliveryTaskId, deliveryTaskVersion: 1,
      repositoryId: seed.repositoryId, providerPullRequestId: '77',
      frozenHeadOid: 'frozen-head', frozenBaseOid: 'frozen-base', reviewedSubjectDigest: 'reviewed',
      reviewExecutionId,
      reviewReceiptDigest: computeIntegrationReviewReceiptDigest(reviewExecutionId, 'reviewed'),
      requirementDigest: computeIntegrationRequirementDigest('Frozen source', ''),
    };
    await pool.query(
      `UPDATE ${seed.tables.candidatesTable}
          SET worker_status='processing',worker_lease_id='lease-old',worker_lease_epoch=11,
              worker_release_identity='release-old',worker_lease_expires_at=now()+interval '1 hour'
        WHERE id=$1`,
      [seed.candidateId],
    );
    const options = pgOptions(seed);
    const workerHost = new PostgresIntegrationV3WorkerHost({
      ...options, releaseIdentity: 'release-old', dispatchAgent: async () => ({ executionId: 'unused' }),
      syncWorkspace: async () => undefined, cleanup: async () => undefined,
    });
    const lease = {
      candidateId: seed.candidateId, leaseId: 'lease-old', leaseEpoch: '11', releaseIdentity: 'release-old',
    };
    await workerHost.assertCandidateLease(lease);
    const current = await workerHost.loadCurrent(seed.candidateId);
    await pool.query(
      `UPDATE ${seed.tables.candidatesTable}
          SET worker_lease_id='lease-new',worker_lease_epoch=12,worker_release_identity='release-new',
              worker_lease_expires_at=now()+interval '1 hour'
        WHERE id=$1`,
      [seed.candidateId],
    );
    const engine = new IntegrationEngineV3({
      candidates: new PostgresIntegrationEngineV3CandidateHost(options),
      features: new PostgresIntegrationEngineV3FeatureHost(options),
      requests: new PostgresIntegrationEngineV3RequestHost(options),
      providerOperations: {} as never, provider: {} as never,
      credentialOwnerId: identity.ownerUserId, resolveRepository: async () => undefined,
    });
    await expect(engine.execute({
      type: 'compose_persisted', candidateId: seed.candidateId, expected: expectedSubject(current),
      workerBinding: { mutationFence: lease, assertCurrent: () => workerHost.assertCandidateLease(lease) },
      revision: { baseOid: 'base-2', headOid: 'head-2', treeOid: 'tree-2', compositionComplete: true, sources: [source] },
    })).rejects.toMatchObject({ code: 'TASKBOARD_CANDIDATE_CAS_MISMATCH' });
    expect((await pool.query(
      `SELECT state,current_revision,version FROM ${seed.tables.candidatesTable} WHERE id=$1`, [seed.candidateId],
    )).rows[0]).toMatchObject({ state: 'composing', current_revision: 1 });
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM ${seed.tables.revisionsTable} WHERE candidate_id=$1`, [seed.candidateId],
    )).rows).toEqual([{ count: 1 }]);
  });

  it('terminalizes unexecuted operations on terminal transition, rejects late inserts, and permits archive', async () => {
    const seed = await seedCandidate({ state: 'waiting_checks', taskStatus: 'todo' });
    const insertOperation = (id: string) => pool.query(
      `INSERT INTO ${seed.tables.providerOperationsTable}
         (id,operation_key,intent_digest,kind,repository_id,candidate_id,candidate_revision,
          workflow_epoch,lane_epoch,execution_id,expected,command,state,attempt_count)
       VALUES($1,$2,'digest','push_ref',$3,$4,1,1,1,'execution-1','{}'::jsonb,'{}'::jsonb,'prepared',0)`,
      [id, `operation-${id}`, seed.repositoryId, seed.candidateId],
    );
    await insertOperation('before-terminal');

    await pool.query(
      `UPDATE ${seed.tables.candidatesTable} SET state='merged',merged_commit_oid='merged-1' WHERE id=$1`,
      [seed.candidateId],
    );

    const operation = (await pool.query(
      `SELECT state,attempt_count,receipt FROM ${seed.tables.providerOperationsTable} WHERE id='before-terminal'`,
    )).rows[0];
    expect(operation).toMatchObject({
      state: 'failed', attempt_count: 0,
      receipt: { outcome: 'not_applied', evidence: 'attempt_count=0' },
    });
    await expect(insertOperation('after-terminal')).rejects.toThrow('TASKBOARD_CANDIDATE_PROVIDER_OPERATION_TERMINAL');

    await pool.query(`UPDATE ${store.tasksTable} SET status='done',version=version+1 WHERE id=$1`, [seed.taskId]);
    const task = await store.getTask(identity, seed.taskId);
    await expect(store.archiveTask(identity, seed.taskId, { expectedVersion: task.version }))
      .resolves.toMatchObject({ id: seed.taskId, archivedAt: expect.any(String) });
  });

  it('resets requested cancellation state so terminal cleanup is claimable', async () => {
    const seed = await seedCandidate({
      state: 'working', taskStatus: 'in_progress', checkpoint: { state: 'working', status: 'requested' },
    });
    await pool.query(
      `UPDATE ${seed.tables.candidatesTable}
          SET worker_status='processing',worker_lease_id='stale-lease',
              worker_lease_expires_at=now()+interval '1 hour',worker_error='stale error'
        WHERE id=$1`, [seed.candidateId],
    );
    const task = await store.getTask(identity, seed.taskId);
    await store.cancelIntegrationTask(identity, seed.taskId, {
      expectedVersion: task.version, reason: 'operator canceled',
    });
    await pool.query(
      `UPDATE ${seed.tables.candidatesTable}
          SET worker_status='failed',
              worker_checkpoint=worker_checkpoint||jsonb_build_object('releaseIdentity','test-release')
        WHERE id<>$1`,
      [seed.candidateId],
    );
    const options = pgOptions(seed);
    const host = new PostgresIntegrationV3WorkerHost({
      ...options, releaseIdentity: 'test-release', dispatchAgent: async () => ({ executionId: 'unused' }), syncWorkspace: async () => undefined,
      cleanup: async () => undefined,
    });
    const engine = new IntegrationEngineV3({
      candidates: new PostgresIntegrationEngineV3CandidateHost(options),
      features: new PostgresIntegrationEngineV3FeatureHost(options),
      requests: new PostgresIntegrationEngineV3RequestHost(options),
      providerOperations: {} as never, provider: {} as never,
      credentialOwnerId: identity.ownerUserId, resolveRepository: async () => undefined,
    });
    const worker = new IntegrationV3Worker({
      host, engine, composer: { publish: vi.fn(), compose: vi.fn(), refreshAfterWork: vi.fn() },
    });
    await worker.runOnce();
    const candidate = (await pool.query(
      `SELECT state,worker_status,worker_checkpoint,worker_error,worker_lease_id
         FROM ${seed.tables.candidatesTable} WHERE id=$1`, [seed.candidateId],
    )).rows[0];
    expect(candidate).toMatchObject({
      state: 'canceled', worker_status: 'idle', worker_error: null, worker_lease_id: null,
    });
    expect(candidate.worker_checkpoint).toMatchObject({ state: 'canceled', status: 'requested' });
    const cleanup = await pool.query(
      `SELECT kind,status FROM ${seed.tables.requestsOutboxTable} WHERE candidate_id=$1 AND kind='cleanup'`,
      [seed.candidateId],
    );
    expect(cleanup.rows).toEqual([{ kind: 'cleanup', status: 'pending' }]);
  });

  it('upgrades an existing v7 candidate table with Worker lease fence columns', async () => {
    const seed = await seedCandidate({ state: 'waiting_checks', taskStatus: 'todo' });
    const root = store.integrationSourcesTable.slice(0, -'_sources'.length);
    const migrationsTable = `${root}_candidate_schema_migrations_v3`;
    const client = await pool.connect();
    try {
      await client.query(`ALTER TABLE ${seed.tables.candidatesTable}
        DROP COLUMN worker_release_identity,
        DROP COLUMN worker_lease_epoch`);
      await client.query(`DELETE FROM ${migrationsTable} WHERE version=8`);

      await runIntegrationCandidateSchema({
        tasksTable: store.tasksTable,
        executionsTable: store.executionsTable,
        integrationSourcesTable: store.integrationSourcesTable,
      }, client);

      expect((await client.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema=current_schema() AND table_name=$1
            AND column_name IN ('worker_lease_epoch','worker_release_identity') ORDER BY column_name`,
        [seed.tables.candidatesTable],
      )).rows).toEqual([
        { column_name: 'worker_lease_epoch' },
        { column_name: 'worker_release_identity' },
      ]);
      expect((await client.query(`SELECT version,name FROM ${migrationsTable} WHERE version=8`)).rows)
        .toEqual([{ version: 8, name: 'expand_candidate_worker_lease_fence' }]);
    } finally {
      client.release();
    }
  });

  it('upgrades existing v5 source seeds without weakening revision immutability', async () => {
    const seed = await seedCandidate({ state: 'waiting_checks', taskStatus: 'todo' });
    const root = store.integrationSourcesTable.slice(0, -'_sources'.length);
    const migrationsTable = `${root}_candidate_schema_migrations_v3`;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DROP TRIGGER tbv3_source_seed_incomplete ON ${seed.tables.revisionsTable}`);
      await client.query(`DROP TRIGGER tbv3_revision_immutable ON ${seed.tables.revisionsTable}`);
      await client.query(`ALTER TABLE ${seed.tables.revisionsTable} DROP COLUMN composition_complete`);
      await client.query(`CREATE TRIGGER ${seed.tables.revisionsTable}_immutable_update
        BEFORE UPDATE ON ${seed.tables.revisionsTable}
        FOR EACH ROW EXECUTE FUNCTION ${seed.tables.revisionsTable}_immutable_fn()`);
      await client.query(`DELETE FROM ${migrationsTable} WHERE version IN (6,7)`);
      await client.query('COMMIT');
      await client.query(
        `INSERT INTO ${seed.tables.revisionsTable}
           (candidate_id,revision,digest_version,base_oid,head_oid,subject_kind,tree_oid,source_set_digest,
            subject_digest,policy_snapshot_digest,policy_revision,merge_method,work_round)
         VALUES($1,2,1,'base-2','head-2','source_seed',NULL,'sources-2','subject-2','policy-2','p1','squash',0)`,
        [seed.candidateId],
      );

      await runIntegrationCandidateSchema({
        tasksTable: store.tasksTable,
        executionsTable: store.executionsTable,
        integrationSourcesTable: store.integrationSourcesTable,
      }, client);

      const revisions = await client.query(
        `SELECT revision,composition_complete FROM ${seed.tables.revisionsTable}
          WHERE candidate_id=$1 ORDER BY revision`,
        [seed.candidateId],
      );
      expect(revisions.rows).toEqual([
        { revision: 1, composition_complete: true },
        { revision: 2, composition_complete: false },
      ]);
      await expect(client.query(
        `UPDATE ${seed.tables.revisionsTable} SET composition_complete=FALSE WHERE candidate_id=$1 AND revision=1`,
        [seed.candidateId],
      )).rejects.toThrow('TASKBOARD_CANDIDATE_SNAPSHOT_IMMUTABLE');
      expect((await client.query(`SELECT version,name FROM ${migrationsTable} WHERE version IN (6,7) ORDER BY version`)).rows)
        .toEqual([
          { version: 6, name: 'track_incomplete_composition_subjects' },
          { version: 7, name: 'normalize_composition_guard_identifiers' },
        ]);
    } finally {
      client.release();
    }
  });
});
