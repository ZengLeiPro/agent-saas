import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgTaskboardStore } from '../taskboard/store.js';
import type { TaskboardContinuationDispatchPayload, TaskboardIdentity } from '../taskboard/types.js';

const { Pool } = pg;
const connectionString = process.env.TEST_DATABASE_URL?.trim();
const describePg = connectionString ? describe : describe.skip;

describePg('Taskboard continuation PostgreSQL race contract', () => {
  const prefix = `tb_race_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const alice: TaskboardIdentity = { tenantId: 'tenant-a', ownerUserId: 'alice-id', username: 'alice' };
  const testRepository = {
    provider: 'github' as const,
    repositoryId: 'github:tenant-a:acme/app',
    owner: 'acme',
    name: 'app',
    baseBranch: 'main',
    allowForkPullRequest: false as const,
  };
  let pool: InstanceType<typeof Pool>;
  let store: PgTaskboardStore;

  const dispatch = (executionId: string, runId: string, sessionId: string) => ({
    version: 1 as const,
    session: {
      sessionId,
      userId: alice.ownerUserId,
      username: alice.username,
      tenantId: alice.tenantId,
      channel: 'web',
      cwd: '/tmp/taskboard-test',
      transcriptPath: `/tmp/taskboard-test/${sessionId}.jsonl`,
      status: 'running' as const,
      createdAt: '2026-08-07T00:00:00.000Z',
      updatedAt: '2026-08-07T00:00:00.000Z',
    },
    run: {
      runId,
      sessionId,
      userId: alice.ownerUserId,
      tenantId: alice.tenantId,
      channel: 'web',
      idempotencyKey: `taskboard-execution:${executionId}`,
      metadata: { taskboardExecution: true, taskboardExecutionId: executionId },
    },
  });

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, connectionTimeoutMillis: 5_000, max: 4 });
    store = new PgTaskboardStore({ pool, tablePrefix: prefix });
    await store.init();
  }, 30_000);

  afterAll(async () => {
    if (!pool || !store) return;
    try {
      await pool.query(`DROP TABLE IF EXISTS
        ${store.integrationTriggerOutboxTable}, ${store.blockEpisodesTable}, ${store.cancellationOutboxTable},
        ${store.resolutionsTable}, ${store.remediationAttemptsTable}, ${store.mergeOperationsTable},
        ${store.mergeAuthorizationsTable}, ${store.integrationSourcesTable}, ${store.integrationLanesTable},
        ${store.attemptsTable}, ${store.changesTable}, ${store.membersTable}, ${store.continuationOutboxTable},
        ${store.executionOutboxTable}, ${store.executionsTable}, ${store.commentsTable}, ${store.tasksTable},
        ${store.boardsTable} CASCADE`);
    } finally {
      await pool.end();
    }
  }, 30_000);

  it('原 Execution 先取消提交、续跑后成功时最终仍进入复核中', async () => {
    const board = await store.createBoard(alice, { name: '续跑取消反向竞态', repository: testRepository });
    const task = await store.createTask(alice, board.id, { title: '取消先提交', status: 'todo' });
    await store.claimExecution(alice, task.id, {
      expectedVersion: task.version, executionId: 'execution-cancel-first', runId: 'run-cancel-first-original',
      sessionId: 'session-cancel-first', executionOwnerUserId: alice.ownerUserId,
      dispatch: dispatch('execution-cancel-first', 'run-cancel-first-original', 'session-cancel-first'),
    });
    await store.setExecutionStatus('run-cancel-first-original', 'running');
    const comment = await store.createComment(alice, task.id, { body: '取消后仍需交付' });
    const payload: TaskboardContinuationDispatchPayload = dispatch(
      'continuation-cancel-first-placeholder', 'run-cancel-first-continuation', 'session-cancel-first',
    );
    payload.run.idempotencyKey = `taskboard-comment:${comment.id}`;
    payload.run.metadata = {
      taskboardContinuation: true, taskboardTaskId: task.id, taskboardCommentId: comment.id,
    };
    await store.enqueueContinuation(
      task.id, [comment.id], 'run-cancel-first-continuation', comment.id, payload,
    );
    await store.claimContinuationDispatch('run-cancel-first-continuation', 'cancel-first-dispatch-lease');
    await store.markContinuationDispatchSucceeded('run-cancel-first-continuation', 'cancel-first-dispatch-lease');

    const blocker = await pool.connect();
    let blockerOpen = false;
    try {
      await blocker.query('BEGIN');
      blockerOpen = true;
      await blocker.query(
        `SELECT run_id FROM ${store.executionsTable} WHERE run_id=$1 FOR UPDATE`,
        ['run-cancel-first-original'],
      );
      const originalCancellation = store.completeExecution('run-cancel-first-original', {
        status: 'cancelled', error: '原执行已取消', commentBody: 'Agent 执行已取消\n\n原执行已取消',
      });
      await waitForBlockedQueries(pool, store.executionsTable);
      const continuationCompletion = store.completeContinuation(task.id, 'run-cancel-first-continuation', {
        status: 'succeeded', commentBody: 'Agent 交付\n\n取消后续跑成功',
      });
      await waitForBlockedQueries(pool, store.boardsTable);
      await blocker.query('COMMIT');
      blockerOpen = false;
      await Promise.all([originalCancellation, continuationCompletion]);
    } finally {
      if (blockerOpen) await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }

    expect(await store.getTask(alice, task.id)).toMatchObject({ status: 'in_review' });
  });

  it('用户在原 Execution 失败后主动保持 blocked 时续跑成功不覆盖该状态', async () => {
    const board = await store.createBoard(alice, {
      name: '续跑尊重用户阻塞',
      repository: { ...testRepository, repositoryId: `${testRepository.repositoryId}-user-block`, name: 'app-user-block' },
    });
    const task = await store.createTask(alice, board.id, { title: '用户主动阻塞', status: 'todo' });
    await store.claimExecution(alice, task.id, {
      expectedVersion: task.version, executionId: 'execution-user-block', runId: 'run-user-block-original',
      sessionId: 'session-user-block', executionOwnerUserId: alice.ownerUserId, protocolVersion: 1,
      dispatch: dispatch('execution-user-block', 'run-user-block-original', 'session-user-block'),
    });
    await store.setExecutionStatus('run-user-block-original', 'running');
    const comment = await store.createComment(alice, task.id, { body: '完成后仍需人工确认' });
    const payload: TaskboardContinuationDispatchPayload = dispatch(
      'continuation-user-block-placeholder', 'run-user-block-continuation', 'session-user-block',
    );
    payload.run.idempotencyKey = `taskboard-comment:${comment.id}`;
    payload.run.metadata = {
      taskboardContinuation: true, taskboardTaskId: task.id, taskboardCommentId: comment.id,
    };
    await store.enqueueContinuation(
      task.id, [comment.id], 'run-user-block-continuation', comment.id, payload,
    );
    await store.completeExecution('run-user-block-original', {
      status: 'cancelled', error: '原执行已取消', commentBody: 'Agent 执行已取消\n\n原执行已取消',
    });
    const systemBlocked = await store.getTask(alice, task.id);
    expect(systemBlocked.status).toBe('blocked');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await pool.query(
      `UPDATE ${store.tasksTable} SET version=version+1, updated_at=now() WHERE id=$1`,
      [task.id],
    );

    await store.completeContinuation(task.id, 'run-user-block-continuation', {
      status: 'succeeded', commentBody: 'Agent 交付\n\n续跑成功',
    });

    expect(await store.getTask(alice, task.id)).toMatchObject({ status: 'blocked' });
  });
});

async function waitForBlockedQueries(pool: InstanceType<typeof Pool>, table: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query(
      `SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1`,
      [`%${table}%`],
    );
    if (Number(result.rows[0]?.count ?? 0) >= 1) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待数据库锁竞争超时：${table}`);
}
