import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgTaskboardStore } from '../taskboard/store.js';
import type { TaskboardContinuationDispatchPayload, TaskboardIdentity } from '../taskboard/types.js';

const { Pool } = pg;
const connectionString = process.env.TEST_DATABASE_URL?.trim();
const describePg = connectionString ? describe : describe.skip;

describePg('PgTaskboardStore continuation contract', () => {
  const prefix = `tb_cont_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const alice: TaskboardIdentity = {
    tenantId: 'tenant-a', ownerUserId: 'alice-id', username: 'alice',
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
    pool = new Pool({ connectionString: connectionString!, connectionTimeoutMillis: 5_000, max: 8 });
    store = new PgTaskboardStore({ pool, tablePrefix: prefix });
    await store.init();
  }, 30_000);

  afterAll(async () => {
    if (!pool || !store) return;
    try {
      await pool.query(`DROP TABLE IF EXISTS ${store.continuationOutboxTable}`);
      await pool.query(`DROP TABLE IF EXISTS ${store.executionOutboxTable}`);
      await pool.query(`DROP TABLE IF EXISTS ${store.executionsTable}`);
      await pool.query(`DROP TABLE IF EXISTS ${store.commentsTable}`);
      await pool.query(`DROP TABLE IF EXISTS ${store.tasksTable}`);
      await pool.query(`DROP TABLE IF EXISTS ${store.boardsTable}`);
    } finally {
      await pool.end();
    }
  }, 30_000);

  it('keeps historical comments out of continuation and preserves waiting-state results through outbox', async () => {
    const board = await store.createBoard(alice, { name: '评论续跑持久化' });
    const task = await store.createTask(alice, board.id, { title: '等待态续跑', status: 'todo' });
    await store.claimExecution(alice, task.id, {
      expectedVersion: task.version,
      executionId: 'execution-waiting',
      runId: 'run-waiting',
      sessionId: 'session-continuation',
      executionOwnerUserId: alice.ownerUserId,
      dispatch: dispatch('execution-waiting', 'run-waiting', 'session-continuation'),
    });
    await store.setExecutionStatus('run-waiting', 'waiting_user');
    const historicalCommentId = randomUUID();
    await pool.query(
      `INSERT INTO ${store.commentsTable}
         (id, task_id, body, author_type, author_id, author_name, continuation_eligible)
       VALUES ($1,$2,'历史评论','user',$3,'Alice',false)`,
      [historicalCommentId, task.id, alice.ownerUserId],
    );
    const first = await store.createComment(alice, task.id, { body: '第一条新评论' });
    const second = await store.createComment(alice, task.id, { body: '第二条新评论' });
    const context = await store.getContinuationContext(alice, task.id, second.id);
    expect(context.pendingComments.map((item) => item.id)).toEqual(expect.arrayContaining([first.id, second.id]));
    expect(context.pendingComments.map((item) => item.id)).not.toContain(historicalCommentId);

    const payload: TaskboardContinuationDispatchPayload = dispatch(
      'continuation-placeholder',
      'run-continuation',
      'session-continuation',
    );
    payload.run.idempotencyKey = `taskboard-comment:${second.id}`;
    payload.run.metadata = {
      taskboardContinuation: true,
      taskboardTaskId: task.id,
      taskboardCommentId: second.id,
    };
    expect(await store.enqueueContinuation(
      task.id,
      [first.id, second.id],
      'run-continuation',
      second.id,
      payload,
    )).toBe(true);
    const claimed = await store.claimContinuationDispatch('run-continuation', 'continuation-lease');
    expect(claimed).toMatchObject({
      runId: 'run-continuation',
      taskId: task.id,
      commentId: second.id,
      attemptCount: 1,
    });
    await store.markContinuationDispatchSucceeded('run-continuation', 'continuation-lease');
    const completed = await store.completeContinuation(task.id, 'run-continuation', {
      status: 'succeeded',
      commentBody: 'Agent 交付\n\n等待态结果已保留',
    });

    expect(completed?.status).toBe('in_progress');
    expect((await store.listComments(alice, task.id)).at(-1)?.body).toContain('等待态结果已保留');
    expect(await store.claimContinuationReconcileCandidates(
      new Date(Date.now() + 1_000),
      10,
      'post-completion-reconcile',
    )).toEqual([]);
  });

  it('续跑先成功、原 Execution 后取消的并发顺序最终保持复核中', async () => {
    const board = await store.createBoard(alice, { name: '续跑取消竞态' });
    const task = await store.createTask(alice, board.id, { title: '并发释放续跑', status: 'todo' });
    await store.claimExecution(alice, task.id, {
      expectedVersion: task.version, executionId: 'execution-race', runId: 'run-race-original',
      sessionId: 'session-race', executionOwnerUserId: alice.ownerUserId,
      dispatch: dispatch('execution-race', 'run-race-original', 'session-race'),
    });
    await store.setExecutionStatus('run-race-original', 'running');
    const comment = await store.createComment(alice, task.id, { body: '释放后独立续跑' });
    const payload: TaskboardContinuationDispatchPayload = dispatch(
      'continuation-race-placeholder',
      'run-race-continuation',
      'session-race',
    );
    payload.run.idempotencyKey = `taskboard-comment:${comment.id}`;
    payload.run.metadata = {
      taskboardContinuation: true, taskboardTaskId: task.id, taskboardCommentId: comment.id,
    };
    await store.enqueueContinuation(
      task.id, [comment.id], 'run-race-continuation', comment.id, payload,
    );
    await store.claimContinuationDispatch('run-race-continuation', 'race-dispatch-lease');
    await store.markContinuationDispatchSucceeded('run-race-continuation', 'race-dispatch-lease');

    const blocker = await pool.connect();
    let blockerOpen = false;
    try {
      await blocker.query('BEGIN');
      blockerOpen = true;
      await blocker.query(
        `SELECT run_id FROM ${store.continuationOutboxTable} WHERE run_id=$1 FOR UPDATE`,
        ['run-race-continuation'],
      );
      const continuationCompletion = store.completeContinuation(task.id, 'run-race-continuation', {
        status: 'succeeded',
        commentBody: 'Agent 交付\n\n续跑已成功',
      });
      await waitForBlockedQueries(pool, store.continuationOutboxTable, 1);
      const originalCancellation = store.completeExecution('run-race-original', {
        status: 'cancelled',
        error: '原执行已取消',
        commentBody: 'Agent 执行已取消\n\n原执行已取消',
      });
      await waitForBlockedQueries(pool, store.boardsTable, 1);
      await blocker.query('COMMIT');
      blockerOpen = false;
      await Promise.all([continuationCompletion, originalCancellation]);
    } finally {
      if (blockerOpen) await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }

    expect(await store.getTask(alice, task.id)).toMatchObject({ status: 'in_review' });
    expect(await store.listComments(alice, task.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ authorId: 'run-race-continuation', authorType: 'agent' }),
      expect.objectContaining({ authorId: 'run-race-original', authorType: 'system' }),
    ]));
  });

  it('backfills legacy continuation rows once and blocks archive while continuation is active', async () => {
    const board = await store.createBoard(alice, { name: '续跑迁移补偿' });
    const task = await store.createTask(alice, board.id, { title: '迁移旧续跑', status: 'todo' });
    await store.claimExecution(alice, task.id, {
      expectedVersion: task.version,
      executionId: 'legacy-base-execution',
      runId: 'legacy-base-run',
      sessionId: 'legacy-session',
      executionOwnerUserId: alice.ownerUserId,
      dispatch: dispatch('legacy-base-execution', 'legacy-base-run', 'legacy-session'),
    });
    await store.completeExecution('legacy-base-run', { status: 'succeeded', commentBody: '基础执行完成' });
    const current = await store.getTask(alice, task.id);
    const commentId = randomUUID();
    await pool.query(
      `INSERT INTO ${store.commentsTable}
         (id, task_id, body, author_type, author_id, author_name,
          continuation_eligible, continuation_run_id)
       VALUES ($1,$2,'迁移期间评论','user',$3,'Alice',false,'legacy-continuation-run')`,
      [commentId, task.id, alice.ownerUserId],
    );
    const archivedTask = await store.createTask(alice, board.id, { title: '历史归档执行', status: 'todo' });
    await store.claimExecution(alice, archivedTask.id, {
      expectedVersion: archivedTask.version,
      executionId: 'archived-legacy-execution',
      runId: 'archived-legacy-run',
      sessionId: 'archived-legacy-session',
      executionOwnerUserId: alice.ownerUserId,
      dispatch: dispatch('archived-legacy-execution', 'archived-legacy-run', 'archived-legacy-session'),
    });
    await pool.query(`UPDATE ${store.tasksTable} SET archived_at=now() WHERE id=$1`, [archivedTask.id]);

    await store.init();
    await store.init();

    const migratedComment = await pool.query(
      `SELECT continuation_eligible FROM ${store.commentsTable} WHERE id=$1`, [commentId],
    );
    const migratedOutbox = await pool.query(
      `SELECT run_id, task_id, comment_id, session_id, status
         FROM ${store.continuationOutboxTable} WHERE run_id='legacy-continuation-run'`,
    );
    expect(migratedComment.rows[0]?.continuation_eligible).toBe(true);
    expect(migratedOutbox.rows).toEqual([expect.objectContaining({
      task_id: task.id,
      comment_id: commentId,
      session_id: 'legacy-session',
      status: 'dispatched',
    })]);
    const archivedExecution = await pool.query(
      `SELECT e.status, o.status AS outbox_status
         FROM ${store.executionsTable} e JOIN ${store.executionOutboxTable} o ON o.run_id=e.run_id
        WHERE e.run_id='archived-legacy-run'`,
    );
    expect(archivedExecution.rows[0]).toMatchObject({ status: 'cancelled', outbox_status: 'dispatched' });
    await expect(store.archiveTask(alice, task.id, { expectedVersion: current.version }))
      .rejects.toMatchObject({ code: 'TASKBOARD_EXECUTION_ACTIVE' });
    await expect(store.archiveBoard(alice, board.id, { expectedVersion: board.version }))
      .rejects.toMatchObject({ code: 'TASKBOARD_EXECUTION_ACTIVE' });
    await expect(store.claimExecution(alice, task.id, {
      expectedVersion: current.version,
      executionId: 'must-not-race-continuation',
      runId: 'must-not-race-continuation',
      sessionId: 'legacy-session',
      executionOwnerUserId: alice.ownerUserId,
      dispatch: dispatch('must-not-race-continuation', 'must-not-race-continuation', 'legacy-session'),
      allowWorkFromCurrentStatus: true,
    })).rejects.toMatchObject({ code: 'TASKBOARD_EXECUTION_ACTIVE' });
  });

});

async function waitForBlockedQueries(
  pool: InstanceType<typeof Pool>, table: string, count: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query(
      `SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1`,
      [`%${table}%`],
    );
    if (Number(result.rows[0]?.count ?? 0) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待数据库锁竞争超时：${table}`);
}
