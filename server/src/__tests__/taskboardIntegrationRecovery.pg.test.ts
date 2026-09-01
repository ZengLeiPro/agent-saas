import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgTaskboardStore } from '../taskboard/store.js';
import type { RepositoryProvider } from '../taskboard/repositoryProvider.js';
import type { TaskboardExecutionClaimInput, TaskboardIdentity } from '../taskboard/types.js';

const { Pool } = pg;
const connectionString = process.env.TEST_DATABASE_URL?.trim();
const describePg = connectionString ? describe : describe.skip;

const identity: TaskboardIdentity = {
  tenantId: 'tenant-integration-recovery', ownerUserId: 'integration-recovery-owner',
  username: 'integration-recovery-owner',
};

function executionClaim(
  taskId: string,
  version: number,
  executionId: string,
  runId: string,
  purpose: 'work' | 'review' | 'merge',
): TaskboardExecutionClaimInput {
  const now = new Date().toISOString();
  const sessionId = `session-${executionId}`;
  return {
    expectedVersion: version, executionId, runId, sessionId, purpose, protocolVersion: 2,
    executionOwnerUserId: identity.ownerUserId,
    dispatch: {
      version: 1,
      session: {
        sessionId, userId: identity.ownerUserId, username: identity.username, tenantId: identity.tenantId,
        channel: 'web', cwd: '/tmp/taskboard-integration-recovery', transcriptPath: `/tmp/${sessionId}.jsonl`,
        status: 'running', createdAt: now, updatedAt: now,
      },
      run: {
        runId, sessionId, userId: identity.ownerUserId, tenantId: identity.tenantId,
        channel: 'web', idempotencyKey: `taskboard-execution:${executionId}`,
        metadata: { taskboardExecution: true, taskboardExecutionId: executionId, taskId },
      },
    },
  };
}

describePg('taskboard integration recovery workflow (PostgreSQL)', () => {
  const prefix = `tbir_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
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
      const result = await pool.query(
        `SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename LIKE $1`,
        [`${prefix}%`],
      );
      for (const row of result.rows) await pool.query(`DROP TABLE IF EXISTS ${String(row.tablename)} CASCADE`);
    } finally {
      await pool.end();
    }
  }, 30_000);

  it('reconciles a pull request merged outside the taskboard when review finishes', async () => {
    const board = await store.createBoard(identity, {
      name: 'External merge reconciliation',
      repository: {
        provider: 'github', repositoryId: 'github:acme/external', owner: 'acme', name: 'external',
        baseBranch: 'main', allowForkPullRequest: false,
      },
    });
    const delivery = await store.createTask(identity, board.id, { title: 'Externally merged delivery', status: 'todo' });
    const executionId = randomUUID();
    const runId = `run-${executionId}`;
    await pool.query(
      `UPDATE ${store.tasksTable}
          SET status='in_review',provider_pull_request_id='32',pull_request_number=32,
              head_oid='head-32',base_oid='base-32',version=version+1
        WHERE id=$1`,
      [delivery.id],
    );
    await pool.query(
      `INSERT INTO ${store.executionsTable}
         (id,task_id,run_id,session_id,status,purpose,trigger,protocol_version,attempt_id,requested_by)
       VALUES($1,$2,$3,$4,'running','review','initial',2,$5,$6)`,
      [executionId, delivery.id, runId, `session-${executionId}`, `attempt-${executionId}`, identity.ownerUserId],
    );
    store.setRepositoryProvider({
      getPullRequest: async () => ({
        providerPullRequestId: '32', number: 32, state: 'merged', draft: false,
        headRef: 'fix/task-32', headOid: 'head-32', baseRef: 'main', baseOid: 'base-32',
        mergeCommitOid: 'merge-32', mergeable: null, requiredChecks: [], subjectDigest: 'digest-32',
      }),
      mergePullRequest: async () => ({
        providerRequestId: 'unused', providerPullRequestId: '32', merged: true,
        mergedCommitOid: 'merge-32', raw: {},
      }),
    });

    await expect(store.finishExecutionV2(identity, runId, { targetStatus: 'ready_to_merge', body: 'Independent review completed; provider reports the PR already merged.' })).resolves.toMatchObject({
      status: 'done', mergedCommitOid: 'merge-32',
    });
    const execution = await pool.query(
      `SELECT status,superseded_at FROM ${store.executionsTable} WHERE id=$1`,
      [executionId],
    );
    expect(execution.rows[0]).toMatchObject({ status: 'cancelled' });
    expect(execution.rows[0].superseded_at).toBeTruthy();
    const cancellations = await pool.query(
      `SELECT count(*)::int AS count FROM ${store.cancellationOutboxTable} WHERE execution_id=$1`,
      [executionId],
    );
    expect(cancellations.rows[0].count).toBe(1);
    const comments = await pool.query(
      `SELECT body,author_type,author_id FROM ${store.commentsTable} WHERE task_id=$1`,
      [delivery.id],
    );
    expect(comments.rows).toEqual([{
      body: 'Independent review completed; provider reports the PR already merged.',
      author_type: 'agent',
      author_id: runId,
    }]);
    const commentEvents = await pool.query(
      `SELECT count(*)::int AS count FROM ${store.changesTable}
        WHERE task_id=$1 AND change_type='execution.comment' AND actor_id=$2`,
      [delivery.id, runId],
    );
    expect(commentEvents.rows[0].count).toBe(1);
    await expect(store.finishExecutionV2(identity, runId, {
      targetStatus: 'ready_to_merge', body: 'Duplicate handoff must not create another comment.',
    })).rejects.toBeTruthy();
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM ${store.commentsTable} WHERE task_id=$1`,
      [delivery.id],
    )).rows[0].count).toBe(1);
  });

  it('keeps one immutable Delivery PR binding under refresh, replacement, and concurrency', async () => {
    const board = await store.createBoard(identity, {
      name: 'Immutable delivery pull request',
      repository: {
        provider: 'github', repositoryId: 'github:acme/immutable-pr', owner: 'acme', name: 'immutable-pr',
        baseBranch: 'main', allowForkPullRequest: false,
      },
    });
    store.setRepositoryProvider({
      getPullRequest: async (_repository, providerPullRequestId) => ({
        providerPullRequestId,
        number: Number(providerPullRequestId),
        state: 'open',
        draft: false,
        headRef: `fix/task-${providerPullRequestId}`,
        headOid: `head-${providerPullRequestId}`,
        baseRef: 'main',
        baseOid: 'base-main',
        mergeable: true,
        requiredChecks: [],
        subjectDigest: `digest-${providerPullRequestId}`,
      }),
      mergePullRequest: async () => ({
        providerRequestId: 'unused', providerPullRequestId: '31', merged: false, raw: {},
      }),
    });

    const delivery = await store.createTask(identity, board.id, { title: 'Bound once', status: 'todo' });
    const executionId = randomUUID();
    const runId = `run-${executionId}`;
    await store.claimExecution(identity, delivery.id, executionClaim(delivery.id, delivery.version, executionId, runId, 'work'));
    await expect(store.attachExecutionPullRequestV2(identity, runId, '31'))
      .resolves.toMatchObject({ providerPullRequestId: '31' });
    await expect(store.attachExecutionPullRequestV2(identity, runId, '31'))
      .resolves.toMatchObject({ providerPullRequestId: '31' });
    expect((await pool.query(
      `SELECT head_oid,base_oid FROM ${store.tasksTable} WHERE id=$1`,
      [delivery.id],
    )).rows[0]).toEqual({ head_oid: 'head-31', base_oid: 'base-main' });
    await expect(store.attachExecutionPullRequestV2(identity, runId, '32'))
      .rejects.toMatchObject({ code: 'TASKBOARD_SUBJECT_STALE' });

    const concurrent = await store.createTask(identity, board.id, { title: 'Concurrent bind', status: 'todo' });
    const concurrentExecutionId = randomUUID();
    const concurrentRunId = `run-${concurrentExecutionId}`;
    await store.claimExecution(identity, concurrent.id, executionClaim(
      concurrent.id, concurrent.version, concurrentExecutionId, concurrentRunId, 'work',
    ));
    const outcomes = await Promise.allSettled([
      store.attachExecutionPullRequestV2(identity, concurrentRunId, '41'),
      store.attachExecutionPullRequestV2(identity, concurrentRunId, '42'),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const bound = await store.getTask(identity, concurrent.id);
    expect(['41', '42']).toContain(bound.providerPullRequestId);
  });

  it('returns unresolved protocol V2 executions to a dispatchable business state', async () => {
    const board = await store.createBoard(identity, {
      name: 'Cancelled execution recovery',
      repository: {
        provider: 'github', repositoryId: 'github:acme/recovery', owner: 'acme', name: 'recovery',
        baseBranch: 'main', allowForkPullRequest: false,
      },
    });
    const delivery = await store.createTask(identity, board.id, { title: 'Cancelled work', status: 'todo' });
    const executionId = randomUUID();
    const runId = `run-${executionId}`;
    await store.claimExecution(
      identity,
      delivery.id,
      executionClaim(delivery.id, delivery.version, executionId, runId, 'work'),
    );

    const completed = await store.completeExecution(runId, {
      status: 'cancelled', commentBody: 'Agent execution cancelled', error: 'aborted',
    });
    expect(completed?.task).toMatchObject({ status: 'todo' });
    expect(completed?.execution).toMatchObject({ status: 'cancelled' });
  });

  it('归档后的 in_review delivery 不再被重新调度：人工出口必须真的生效', async () => {
    const board = await store.createBoard(identity, {
      name: 'Archived delivery escape hatch',
      repository: {
        provider: 'github', repositoryId: 'github:acme/archived', owner: 'acme', name: 'archived',
        baseBranch: 'main', allowForkPullRequest: false,
      },
    });
    const delivery = await store.createTask(identity, board.id, { title: 'Stuck in review', status: 'todo' });
    await pool.query(
      `UPDATE ${store.tasksTable}
          SET status='in_review',provider_pull_request_id='87',pull_request_number=87,
              head_oid='head-87',base_oid='base-87',version=version+1
        WHERE id=$1`,
      [delivery.id],
    );

    // 卡在 in_review 且已绑定 PR 的 delivery 会被持续重新调度。
    expect((await store.claimIntegrationDispatchCandidatesV2(10))
      .filter((candidate) => candidate.task.id === delivery.id)).toHaveLength(1);

    // moveTask 对 in_review 硬拒，归档是唯一的人工出口——它必须真能叫停调度。
    const stuck = await store.getTask(identity, delivery.id);
    await store.archiveTask(identity, delivery.id, { expectedVersion: stuck.version });

    expect((await store.claimIntegrationDispatchCandidatesV2(10))
      .filter((candidate) => candidate.task.id === delivery.id)).toHaveLength(0);
  });
});
