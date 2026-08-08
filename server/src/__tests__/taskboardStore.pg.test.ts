import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TASKBOARD_DEFAULT_PROMPT } from '../../../shared/src/types/taskboard.js';
import { PgRunStore, RunCreateConflictError } from '../runtime/runStore.js';
import { PgTaskboardStore } from '../taskboard/store.js';
import {
  TaskboardConflictError,
  TaskboardNotFoundError,
  TaskboardValidationError,
  type TaskboardIdentity,
} from '../taskboard/types.js';

const { Pool } = pg;
const connectionString = process.env.TEST_DATABASE_URL?.trim();
const describePg = connectionString ? describe : describe.skip;

describePg('PgTaskboardStore contract', () => {
  const prefix = `tb_${randomUUID().replaceAll('-', '').slice(0, 18)}`;
  let pool: InstanceType<typeof Pool>;
  let store: PgTaskboardStore;
  let runStore: PgRunStore;

  const alice: TaskboardIdentity = { tenantId: 'tenant-a', ownerUserId: 'alice-id', username: 'alice' };
  const aliceOtherTenant: TaskboardIdentity = { tenantId: 'tenant-b', ownerUserId: 'alice-id', username: 'alice' };
  const admin: TaskboardIdentity = { tenantId: 'tenant-a', ownerUserId: 'admin-id', username: 'admin' };

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
      channel: 'taskboard',
      idempotencyKey: `taskboard-execution:${executionId}`,
      metadata: { taskboardExecution: true, taskboardExecutionId: executionId },
    },
  });

  beforeAll(async () => {
    pool = new Pool({
      connectionString: connectionString!,
      connectionTimeoutMillis: 5_000,
      max: 12,
    });
    store = new PgTaskboardStore({ pool, tablePrefix: prefix });
    runStore = new PgRunStore({ pool, tablePrefix: prefix });
    const peer = new PgTaskboardStore({ pool, tablePrefix: prefix });
    await Promise.all([store.init(), peer.init(), runStore.init()]);
  }, 30_000);

  afterAll(async () => {
    if (!pool || !store) return;
    try {
      await pool.query(`DROP TABLE IF EXISTS ${store.executionOutboxTable}`);
      await pool.query(`DROP TABLE IF EXISTS ${store.executionsTable}`);
      await pool.query(`DROP TABLE IF EXISTS ${store.commentsTable}`);
      await pool.query(`DROP TABLE IF EXISTS ${store.tasksTable}`);
      await pool.query(`DROP TABLE IF EXISTS ${store.boardsTable}`);
      await pool.query(`DROP TABLE IF EXISTS ${runStore.steeringInputsTable}`);
      await pool.query(`DROP TABLE IF EXISTS ${runStore.runsTable}`);
    } finally {
      await pool.end();
    }
  }, 30_000);

  it('isolates every access by tenant and owner, including administrators, and enforces active names', async () => {
    const board = await store.createBoard(alice, { name: '个人计划' });
    const adminBoard = await store.createBoard(admin, { name: '个人计划' });
    const crossTenantBoard = await store.createBoard(aliceOtherTenant, { name: '个人计划' });

    expect((await store.listBoards(alice)).map((item) => item.id)).toContain(board.id);
    expect((await store.listBoards(admin)).map((item) => item.id)).toContain(adminBoard.id);
    expect((await store.listBoards(aliceOtherTenant)).map((item) => item.id)).toContain(crossTenantBoard.id);
    expect((await store.listBoards(admin)).map((item) => item.id)).not.toContain(board.id);

    const task = await store.createTask(alice, board.id, { title: '私有任务' });
    await expect(store.getTask(admin, task.id)).rejects.toBeInstanceOf(TaskboardNotFoundError);
    await expect(store.getTask(aliceOtherTenant, task.id)).rejects.toBeInstanceOf(TaskboardNotFoundError);
    await expect(store.listTasks(admin, board.id)).rejects.toBeInstanceOf(TaskboardNotFoundError);

    await expect(store.createBoard(alice, { name: '个人计划' }))
      .rejects.toMatchObject({ code: 'TASKBOARD_BOARD_NAME_EXISTS' });
    const archived = await store.archiveBoard(alice, board.id, { expectedVersion: board.version });
    await store.createBoard(alice, { name: '个人计划' });
    await expect(store.restoreBoard(alice, board.id, { expectedVersion: archived.version }))
      .rejects.toMatchObject({ code: 'TASKBOARD_BOARD_NAME_EXISTS' });
  });

  it('stores the default board prompt and allows it to be customized', async () => {
    const withDefault = await store.createBoard(alice, { name: '默认提示语' });
    expect(withDefault.prompt).toBe(TASKBOARD_DEFAULT_PROMPT);

    const customized = await store.updateBoard(alice, withDefault.id, {
      prompt: '只处理当前任务，不修改无关文件。',
      expectedVersion: withDefault.version,
    });
    expect(customized).toMatchObject({
      prompt: '只处理当前任务，不修改无关文件。',
      version: withDefault.version + 1,
    });

    const empty = await store.updateBoard(alice, withDefault.id, {
      prompt: '',
      expectedVersion: customized.version,
    });
    expect(empty.prompt).toBe('');
  });

  it('allocates stable numbers, returns CAS current state, and makes archived boards/tasks read-only', async () => {
    const board = await store.createBoard(alice, { name: 'CAS 与归档' });
    const first = await store.createTask(alice, board.id, { title: '第一项' });
    const second = await store.createTask(alice, board.id, { title: '第二项' });
    expect([first.identifier, second.identifier]).toEqual(['TASK-1', 'TASK-2']);
    expect(second.sortOrder).toBeGreaterThan(first.sortOrder);

    const edited = await store.updateTask(alice, first.id, {
      priority: 'high',
      expectedVersion: first.version,
    });
    expect(edited.version).toBe(2);
    try {
      await store.updateTask(alice, first.id, { title: 'stale', expectedVersion: first.version });
      throw new Error('expected CAS conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(TaskboardConflictError);
      expect((error as TaskboardConflictError<typeof edited>).current).toMatchObject({
        id: first.id,
        version: edited.version,
        priority: 'high',
      });
    }

    const comment = await store.createComment(alice, first.id, { body: '人工评论' });
    expect(comment).toMatchObject({ authorId: alice.ownerUserId, authorName: alice.username, version: 1 });
    expect(await store.listComments(alice, first.id)).toHaveLength(1);
    expect((await store.getTask(alice, first.id)).commentCount).toBe(1);

    const archivedTask = await store.archiveTask(alice, first.id, { expectedVersion: edited.version });
    await expect(store.createComment(alice, first.id, { body: '禁止新增' }))
      .rejects.toMatchObject({ code: 'TASKBOARD_TASK_ARCHIVED' });
    await expect(store.updateTask(alice, first.id, { title: '禁止编辑', expectedVersion: archivedTask.version }))
      .rejects.toBeInstanceOf(TaskboardValidationError);
    const restoredTask = await store.restoreTask(alice, first.id, { expectedVersion: archivedTask.version });

    const archivedBoard = await store.archiveBoard(alice, board.id, { expectedVersion: board.version });
    await expect(store.createTask(alice, board.id, { title: '禁止新增' }))
      .rejects.toMatchObject({ code: 'TASKBOARD_BOARD_ARCHIVED' });
    await expect(store.createComment(alice, restoredTask.id, { body: '禁止评论' }))
      .rejects.toMatchObject({ code: 'TASKBOARD_BOARD_ARCHIVED' });
    await expect(store.updateBoard(alice, board.id, {
      description: '禁止编辑',
      expectedVersion: archivedBoard.version,
    })).rejects.toMatchObject({ code: 'TASKBOARD_BOARD_ARCHIVED' });

    const restoredBoard = await store.restoreBoard(alice, board.id, { expectedVersion: archivedBoard.version });
    expect(restoredBoard).not.toHaveProperty('archivedAt');
    await expect(store.createComment(alice, restoredTask.id, { body: '恢复后可评论' })).resolves.toMatchObject({
      body: '恢复后可评论',
    });
  });

  it('atomically claims one Agent execution, rereads comments, and finalizes idempotently', async () => {
    const board = await store.createBoard(alice, {
      name: 'Agent 执行闭环',
      prompt: '按本看板规范执行。',
    });
    const task = await store.createTask(alice, board.id, { title: '执行我', status: 'todo' });
    const claimed = await store.claimExecution(alice, task.id, {
      expectedVersion: task.version,
      executionId: 'execution-a',
      runId: 'run-a',
      sessionId: 'session-a',
      dispatch: dispatch('execution-a', 'run-a', 'session-a'),
    });
    expect(claimed.task).toMatchObject({ status: 'in_progress', version: task.version + 1 });
    expect(claimed.execution).toMatchObject({ status: 'queued', runId: 'run-a', sessionId: 'session-a' });
    expect(await store.listExecutions(alice, task.id)).toEqual([claimed.execution]);
    await expect(store.listExecutions(admin, task.id)).rejects.toBeInstanceOf(TaskboardNotFoundError);

    const firstLease = await store.claimExecutionDispatch('run-a', 'lease-a');
    expect(firstLease).toMatchObject({
      runId: 'run-a',
      executionId: 'execution-a',
      attemptCount: 1,
      leaseId: 'lease-a',
      payload: { run: { runId: 'run-a' }, session: { sessionId: 'session-a' } },
    });
    await expect(store.claimExecutionDispatch('run-a', 'lease-other')).resolves.toBeNull();
    await pool.query(
      `UPDATE ${store.executionOutboxTable} SET lease_expires_at=now() - interval '1 second' WHERE run_id='run-a'`,
    );
    const expiredLease = await store.claimExecutionDispatch('run-a', 'lease-expired');
    expect(expiredLease).toMatchObject({ attemptCount: 2, leaseId: 'lease-expired' });
    await expect(store.retryExecutionDispatch('run-a', 'lease-a', 'stale worker error', 0)).resolves.toBe(false);
    await expect(store.retryExecutionDispatch('run-a', 'lease-expired', 'temporary error', 0)).resolves.toBe(true);
    const finalLease = await store.claimExecutionDispatch('run-a', 'lease-b');
    expect(finalLease).toMatchObject({ attemptCount: 3, leaseId: 'lease-b' });
    await expect(store.markExecutionDispatchSucceeded('run-a', 'lease-expired')).resolves.toBe(false);
    await expect(store.markExecutionDispatchSucceeded('run-a', 'lease-b')).resolves.toBe(true);
    expect((await store.listExecutions(alice, task.id))[0]).not.toHaveProperty('error');

    const runtimeInput = {
      runId: 'runtime-create-only',
      sessionId: 'runtime-session',
      userId: alice.ownerUserId,
      tenantId: alice.tenantId,
      channel: 'taskboard',
      model: 'model-default',
      idempotencyKey: 'taskboard-execution:runtime-create-only',
      metadata: { taskboardExecution: true },
    };
    await expect(runStore.createPending(runtimeInput)).resolves.toMatchObject({ created: true });
    await runStore.markStatus(runtimeInput.runId, 'waiting_user');
    await expect(runStore.createPending(runtimeInput)).resolves.toMatchObject({
      created: false,
      record: { status: 'waiting_user' },
    });
    await expect(runStore.createPending({
      ...runtimeInput,
      runId: 'runtime-idempotency-conflict',
      sessionId: 'runtime-conflict-session',
    })).rejects.toBeInstanceOf(RunCreateConflictError);

    await store.createComment(alice, task.id, { body: '认领后补充的最新条件' });
    const context = await store.getExecutionContextByRunId('run-a');
    expect(context?.task.status).toBe('in_progress');
    expect(context?.boardPrompt).toBe('按本看板规范执行。');
    expect(context?.comments.at(-1)?.body).toBe('认领后补充的最新条件');
    await expect(store.setExecutionStatus('run-a', 'waiting_user')).resolves.toMatchObject({
      status: 'waiting_user',
      startedAt: expect.any(String),
    });

    const completed = await store.completeExecution('run-a', {
      status: 'succeeded',
      commentBody: 'Agent 交付\n\n实现完成',
    });
    expect(completed?.task.status).toBe('in_review');
    expect(completed?.execution).toMatchObject({ status: 'succeeded', finishedAt: expect.any(String) });
    expect((await store.listComments(alice, task.id)).at(-1)).toMatchObject({
      authorType: 'agent',
      authorName: 'Agent',
      body: 'Agent 交付\n\n实现完成',
    });

    const commentCount = (await store.listComments(alice, task.id)).length;
    const duplicate = await store.completeExecution('run-a', {
      status: 'failed',
      error: 'late duplicate',
      commentBody: '不应重复写入',
    });
    expect(duplicate?.execution.status).toBe('succeeded');
    expect(await store.listComments(alice, task.id)).toHaveLength(commentCount);

    const manuallyCorrected = await store.createTask(alice, board.id, { title: '人工纠正优先', status: 'todo' });
    const secondClaim = await store.claimExecution(alice, manuallyCorrected.id, {
      expectedVersion: manuallyCorrected.version,
      executionId: 'execution-b',
      runId: 'run-b',
      sessionId: 'session-b',
      dispatch: dispatch('execution-b', 'run-b', 'session-b'),
    });
    const reconcilePeer = await store.createTask(alice, board.id, { title: '对账轮转', status: 'todo' });
    await store.claimExecution(alice, reconcilePeer.id, {
      expectedVersion: reconcilePeer.version,
      executionId: 'execution-c',
      runId: 'run-c',
      sessionId: 'session-c',
      dispatch: dispatch('execution-c', 'run-c', 'session-c'),
    });
    const staleBefore = new Date(Date.now() + 1_000);
    const firstCandidate = await store.claimExecutionReconcileCandidates(staleBefore, 1, 'reconcile-a');
    const secondCandidate = await store.claimExecutionReconcileCandidates(staleBefore, 1, 'reconcile-b');
    expect(new Set([...firstCandidate, ...secondCandidate].map((candidate) => candidate.runId)))
      .toEqual(new Set(['run-b', 'run-c']));
    expect([...firstCandidate, ...secondCandidate]).toEqual(expect.arrayContaining([
      expect.objectContaining({ executionStatus: 'queued', dispatchStatus: 'pending' }),
    ]));
    const originalRunBLease = [...firstCandidate, ...secondCandidate]
      .find((candidate) => candidate.runId === 'run-b')!.leaseId;
    const runCLease = [...firstCandidate, ...secondCandidate]
      .find((candidate) => candidate.runId === 'run-c')!.leaseId;
    await expect(store.setExecutionStatusFromReconcile('run-b', 'running', 'wrong-lease'))
      .resolves.toBeNull();
    await pool.query(
      `UPDATE ${store.executionsTable}
          SET reconcile_lease_expires_at=now() - interval '1 second'
        WHERE run_id='run-b'`,
    );
    const reclaimed = await store.claimExecutionReconcileCandidates(staleBefore, 1, 'reconcile-c');
    expect(reclaimed).toEqual([expect.objectContaining({ runId: 'run-b', leaseId: 'reconcile-c' })]);
    await expect(store.setExecutionStatusFromReconcile('run-b', 'running', originalRunBLease))
      .resolves.toBeNull();
    await expect(store.setExecutionStatusFromReconcile('run-b', 'running', 'reconcile-c'))
      .resolves.toMatchObject({ status: 'running' });
    await expect(store.setExecutionStatus('run-b', 'waiting_user'))
      .resolves.toMatchObject({ status: 'waiting_user' });
    await expect(store.setExecutionStatusFromReconcile('run-b', 'running', 'reconcile-c'))
      .resolves.toBeNull();
    const canceled = await store.moveTask(alice, manuallyCorrected.id, {
      status: 'canceled',
      expectedVersion: secondClaim.task.version,
    });
    const failed = await store.completeExecution('run-b', {
      status: 'failed',
      error: 'runtime failed',
      commentBody: 'Agent 执行失败\n\nruntime failed',
    });
    expect(failed?.task).toMatchObject({ status: 'canceled', version: canceled.version });
    expect(failed?.execution.status).toBe('failed');
    const runCCancel = {
      status: 'cancelled' as const,
      error: 'test cleanup',
      commentBody: 'Agent 执行已取消\n\ntest cleanup',
    };
    await expect(store.completeExecutionFromReconcile('run-c', runCCancel, 'wrong-lease'))
      .resolves.toBeNull();
    await expect(store.completeExecutionFromReconcile('run-c', runCCancel, runCLease))
      .resolves.toMatchObject({ execution: { status: 'cancelled' } });
  });

  it('serializes concurrent writes on the same board without a task/board lock-order deadlock', async () => {
    const board = await store.createBoard(alice, { name: '并发锁顺序' });
    const first = await store.createTask(alice, board.id, { title: 'A', status: 'todo' });
    const second = await store.createTask(alice, board.id, { title: 'B', status: 'todo' });

    const [moved, edited] = await Promise.all([
      store.moveTask(alice, first.id, {
        status: 'todo',
        previousTaskId: second.id,
        expectedVersion: first.version,
      }),
      store.updateTask(alice, second.id, {
        title: 'B updated',
        expectedVersion: second.version,
      }),
    ]);

    expect(moved.id).toBe(first.id);
    expect(edited).toMatchObject({ id: second.id, title: 'B updated', version: 2 });
  });

  it('moves by adjacent neighbors, renumbers tight columns, and appends into target columns', async () => {
    const board = await store.createBoard(alice, { name: '排序移动' });
    const first = await store.createTask(alice, board.id, { title: 'A', status: 'todo' });
    const second = await store.createTask(alice, board.id, { title: 'B', status: 'todo' });
    const third = await store.createTask(alice, board.id, { title: 'C', status: 'todo' });

    await pool.query(
      `UPDATE ${store.tasksTable}
          SET sort_order=CASE id WHEN $1 THEN 1 WHEN $2 THEN 1.000000001 ELSE sort_order END
        WHERE board_id=$3 AND id=ANY($4::text[])`,
      [first.id, second.id, board.id, [first.id, second.id]],
    );
    const between = await store.moveTask(alice, third.id, {
      status: 'todo',
      previousTaskId: first.id,
      nextTaskId: second.id,
      expectedVersion: third.version,
    });
    const todo = await store.listTasks(alice, board.id, { statuses: ['todo'] });
    expect(todo.map((task) => task.id)).toEqual([first.id, third.id, second.id]);
    expect(between.sortOrder).toBeGreaterThan(todo[0]!.sortOrder);
    expect(between.sortOrder).toBeLessThan(todo[2]!.sortOrder);
    expect(todo[0]!.version).toBe(2);
    expect(todo[2]!.version).toBe(2);

    const movedToEmpty = await store.moveTask(alice, third.id, {
      status: 'in_progress',
      expectedVersion: between.version,
    });
    const appended = await store.createTask(alice, board.id, { title: 'D', status: 'in_progress' });
    expect(appended.sortOrder).toBeGreaterThan(movedToEmpty.sortOrder);

    await store.moveTask(alice, second.id, {
      status: 'in_progress',
      previousTaskId: appended.id,
      expectedVersion: todo[2]!.version,
    });
    const inProgress = await store.listTasks(alice, board.id, { statuses: ['in_progress'] });
    expect(inProgress.map((task) => task.id)).toEqual([third.id, appended.id, second.id]);
  });
});
