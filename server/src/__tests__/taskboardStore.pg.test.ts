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
  type TaskboardContinuationDispatchPayload,
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
  const bob: TaskboardIdentity = { tenantId: 'tenant-a', ownerUserId: 'bob-id', username: 'bob' };

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
      await pool.query(`DROP TABLE IF EXISTS ${store.continuationOutboxTable}`);
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

  it('atomically stages legacy pending runs and never demotes an advanced run during activation', async () => {
    const runId = `run-cas-${randomUUID()}`;
    await runStore.createPending({
      runId,
      sessionId: `session-cas-${randomUUID()}`,
      metadata: { taskboardExecution: true },
    });

    await expect(runStore.stagePendingRun(runId)).resolves.toMatchObject({
      status: 'pending',
      metadata: { taskboardExecution: true, schedulerState: 'staged' },
    });

    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(`SELECT 1 FROM ${runStore.runsTable} WHERE run_id = $1 FOR UPDATE`, [runId]);
      const activation = runStore.activateStagedRun(runId);
      await blocker.query(`UPDATE ${runStore.runsTable} SET status = 'running' WHERE run_id = $1`, [runId]);
      await blocker.query('COMMIT');
      await expect(activation).resolves.toMatchObject({ status: 'running' });
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
    await expect(runStore.get(runId)).resolves.toMatchObject({ status: 'running' });
  });

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

  it('shares organization boards with all tenant members while keeping board ownership and execution owner stable', async () => {
    const board = await store.createBoard(alice, {
      name: '组织协作',
      visibility: 'organization',
    });
    expect(board).toMatchObject({
      visibility: 'organization',
      ownerUserId: alice.ownerUserId,
      canManage: true,
    });
    expect(await store.listBoards(admin)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: board.id, visibility: 'organization', canManage: false }),
    ]));
    expect((await store.listBoards(aliceOtherTenant)).map((item) => item.id)).not.toContain(board.id);
    await expect(store.updateBoard(admin, board.id, {
      name: '越权修改',
      expectedVersion: board.version,
    })).rejects.toBeInstanceOf(TaskboardNotFoundError);

    const task = await store.createTask(admin, board.id, { title: '组织成员创建', status: 'todo' });
    const updated = await store.updateTask(alice, task.id, {
      title: '创建者修改',
      expectedVersion: task.version,
    });
    await expect(store.createComment(admin, task.id, { body: '组织成员评论' }))
      .resolves.toMatchObject({ authorId: admin.ownerUserId });
    expect(await store.getExecutionModelContext(admin, task.id)).toMatchObject({
      boardOwnerUserId: alice.ownerUserId,
    });
    const archived = await store.archiveTask(admin, task.id, { expectedVersion: updated.version });
    const restored = await store.restoreTask(admin, task.id, { expectedVersion: archived.version });
    expect(restored).not.toHaveProperty('archivedAt');
    await expect(store.getTask(aliceOtherTenant, task.id)).rejects.toBeInstanceOf(TaskboardNotFoundError);

    await expect(store.createBoard(admin, {
      name: board.name,
      visibility: 'organization',
    })).rejects.toMatchObject({ code: 'TASKBOARD_BOARD_NAME_EXISTS' });
  });

  it('paginates board and cross-board task search without leaking tenants', async () => {
    const privateBoard = await store.createBoard(alice, { name: '搜索私有看板' });
    const organizationBoard = await store.createBoard(alice, {
      name: '搜索组织看板', visibility: 'organization',
    });
    const foreignBoard = await store.createBoard(aliceOtherTenant, {
      name: '搜索外租户看板', visibility: 'organization',
    });
    await store.createTask(alice, privateBoard.id, {
      title: '搜索目标 A', labels: ['backend'], priority: 'high', status: 'todo',
    });
    await store.createTask(admin, organizationBoard.id, {
      title: '搜索目标 B', labels: ['backend', 'shared'], priority: 'high', status: 'todo',
    });
    await store.createTask(aliceOtherTenant, foreignBoard.id, {
      title: '搜索目标 C', labels: ['backend'], priority: 'high', status: 'todo',
    });

    const firstPage = await store.searchBoards(alice, { search: '搜索', page: 1, pageSize: 1 });
    expect(firstPage).toMatchObject({ page: 1, pageSize: 1, total: 2, hasMore: true });
    expect(firstPage.items).toHaveLength(1);

    const aliceTasks = await store.searchTasks(alice, {
      search: '搜索目标', statuses: ['todo'], priorities: ['high'], labels: ['backend'],
      page: 1, pageSize: 10,
    });
    expect(aliceTasks.items.map((item) => item.title).sort()).toEqual(['搜索目标 A', '搜索目标 B']);
    expect(aliceTasks.total).toBe(2);

    const adminTasks = await store.searchTasks(admin, { search: '搜索目标', page: 1, pageSize: 10 });
    expect(adminTasks.items.map((item) => item.title)).toEqual(['搜索目标 B']);
    const foreignTasks = await store.searchTasks(aliceOtherTenant, { search: '搜索目标', page: 1, pageSize: 10 });
    expect(foreignTasks.items.map((item) => item.title)).toEqual(['搜索目标 C']);
  });

  it('allows only comment authors or board owners to edit/delete with CAS', async () => {
    const board = await store.createBoard(alice, {
      name: '评论权限', visibility: 'organization',
    });
    const task = await store.createTask(alice, board.id, { title: '评论任务' });
    const comment = await store.createComment(admin, task.id, { body: '管理员写的评论' });

    await expect(store.updateComment(bob, comment.id, {
      body: '越权修改', expectedVersion: comment.version,
    })).rejects.toMatchObject({ code: 'TASKBOARD_PERMISSION_DENIED' });
    await expect(store.updateComment(bob, comment.id, {
      body: '越权并猜旧版本', expectedVersion: comment.version + 99,
    })).rejects.toMatchObject({ code: 'TASKBOARD_PERMISSION_DENIED' });
    await expect(store.searchComments(alice, task.id, { page: 1, pageSize: 1 })).resolves.toMatchObject({
      items: [expect.objectContaining({ id: comment.id })], page: 1, pageSize: 1, total: 1, hasMore: false,
    });

    const edited = await store.updateComment(admin, comment.id, {
      body: '作者修改', expectedVersion: comment.version,
    });
    expect(edited).toMatchObject({ body: '作者修改', version: 2 });
    await expect(store.updateComment(admin, comment.id, {
      body: '旧版本覆盖', expectedVersion: comment.version,
    })).rejects.toBeInstanceOf(TaskboardConflictError);

    await expect(store.deleteComment(bob, comment.id, { expectedVersion: edited.version }))
      .rejects.toMatchObject({ code: 'TASKBOARD_PERMISSION_DENIED' });
    await expect(store.deleteComment(alice, comment.id, { expectedVersion: edited.version }))
      .resolves.toMatchObject({ id: comment.id });
    await expect(store.listComments(alice, task.id)).resolves.toEqual([]);
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

  it('stores board/task model overrides and exposes them through the execution model context', async () => {
    const board = await store.createBoard(alice, { name: '模型继承', model: 'group-a/model-board' });
    expect(board.model).toBe('group-a/model-board');

    const task = await store.createTask(alice, board.id, { title: '模型任务', status: 'todo' });
    expect(task.model).toBeUndefined();
    expect(await store.getExecutionModelContext(alice, task.id)).toEqual({
      boardModel: 'group-a/model-board',
    });

    const overridden = await store.updateTask(alice, task.id, {
      model: 'group-a/model-task',
      expectedVersion: task.version,
    });
    expect(overridden.model).toBe('group-a/model-task');
    expect(await store.getExecutionModelContext(alice, task.id)).toEqual({
      taskModel: 'group-a/model-task',
      boardModel: 'group-a/model-board',
    });

    const inherited = await store.updateTask(alice, task.id, {
      model: null,
      expectedVersion: overridden.version,
    });
    expect(inherited.model).toBeUndefined();
    expect(await store.getExecutionModelContext(alice, task.id)).toEqual({
      boardModel: 'group-a/model-board',
    });

    const cleared = await store.updateBoard(alice, board.id, {
      model: null,
      expectedVersion: board.version,
    });
    expect(cleared.model).toBeUndefined();
    expect(await store.getExecutionModelContext(alice, task.id)).toEqual({});

    const executionId = randomUUID();
    const runId = randomUUID();
    const sessionId = randomUUID();
    await expect(store.claimExecution(alice, task.id, {
      expectedVersion: inherited.version,
      executionId,
      runId,
      sessionId,
      configuredModelRef: 'group-a/model-board',
      executionOwnerUserId: alice.ownerUserId,
      dispatch: dispatch(executionId, runId, sessionId),
    })).rejects.toMatchObject({ code: 'TASKBOARD_EXECUTION_MODEL_CHANGED' });
  });

  it('allocates stable numbers, returns CAS current state, and makes archived boards/tasks read-only', async () => {
    const board = await store.createBoard(alice, { name: 'CAS 与归档' });
    const taskAttachment = {
      attachmentId: randomUUID(),
      originalName: '需求.png',
      relativePath: 'uploads/需求.png',
      size: 123,
      mimeType: 'image/png',
      isImage: true,
    };
    const first = await store.createTask(alice, board.id, {
      title: '第一项',
      branch: 'task/TASK-1-feature',
      attachments: [taskAttachment],
    });
    const second = await store.createTask(alice, board.id, { title: '第二项' });
    expect([first.identifier, second.identifier]).toEqual(['TASK-1', 'TASK-2']);
    expect(first.attachments).toEqual([taskAttachment]);
    expect(first.branch).toBe('task/TASK-1-feature');
    expect(second.sortOrder).toBeGreaterThan(first.sortOrder);
    const idempotentRequestId = randomUUID();
    const idempotent = await store.createTask(alice, board.id, {
      title: '幂等创建',
      clientRequestId: idempotentRequestId,
    });
    const retried = await store.createTask(alice, board.id, {
      title: '幂等创建',
      clientRequestId: idempotentRequestId,
    });
    expect(retried.id).toBe(idempotent.id);

    const edited = await store.updateTask(alice, first.id, {
      priority: 'high',
      branch: null,
      expectedVersion: first.version,
    });
    expect(edited.version).toBe(2);
    expect(edited.branch).toBeUndefined();
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

    const commentAttachment = { ...taskAttachment, attachmentId: randomUUID(), originalName: '验收.mp4', isImage: false };
    const comment = await store.createComment(alice, first.id, { body: '', attachments: [commentAttachment] });
    expect(comment).toMatchObject({
      body: '',
      attachments: [commentAttachment],
      authorId: alice.ownerUserId,
      authorName: alice.username,
      version: 1,
    });
    expect(await store.listComments(alice, first.id)).toHaveLength(1);
    expect(await store.listComments(
      { ...alice, displayName: '爱丽丝 @alice' },
      first.id,
    )).toEqual([expect.objectContaining({ authorName: '爱丽丝 @alice' })]);
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

  it('rejects repeated and concurrent execution claims without creating a second active Execution', async () => {
    const board = await store.createBoard(alice, { name: '重复派发隔离' });
    const sequentialTask = await store.createTask(alice, board.id, {
      title: '连续派发', status: 'todo',
    });
    const firstExecutionId = randomUUID();
    const firstRunId = randomUUID();
    const firstSessionId = randomUUID();
    const first = await store.claimExecution(alice, sequentialTask.id, {
      expectedVersion: sequentialTask.version,
      executionId: firstExecutionId,
      runId: firstRunId,
      sessionId: firstSessionId,
      executionOwnerUserId: alice.ownerUserId,
      dispatch: dispatch(firstExecutionId, firstRunId, firstSessionId),
    });
    const duplicateExecutionId = randomUUID();
    const duplicateRunId = randomUUID();
    const duplicateSessionId = randomUUID();
    await expect(store.claimExecution(alice, sequentialTask.id, {
      expectedVersion: first.task.version,
      executionId: duplicateExecutionId,
      runId: duplicateRunId,
      sessionId: duplicateSessionId,
      executionOwnerUserId: alice.ownerUserId,
      dispatch: dispatch(duplicateExecutionId, duplicateRunId, duplicateSessionId),
    })).rejects.toMatchObject({ code: 'TASKBOARD_EXECUTION_ACTIVE' });
    expect(await store.listExecutions(alice, sequentialTask.id)).toHaveLength(1);

    const concurrentTask = await store.createTask(alice, board.id, {
      title: '并发派发', status: 'todo',
    });
    const attempts = Array.from({ length: 2 }, () => {
      const executionId = randomUUID();
      const runId = randomUUID();
      const sessionId = randomUUID();
      return store.claimExecution(alice, concurrentTask.id, {
        expectedVersion: concurrentTask.version,
        executionId,
        runId,
        sessionId,
        executionOwnerUserId: alice.ownerUserId,
        dispatch: dispatch(executionId, runId, sessionId),
      });
    });
    const results = await Promise.allSettled(attempts);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ code: 'TASKBOARD_EXECUTION_ACTIVE' }),
      }),
    ]);
    expect(await store.listExecutions(alice, concurrentTask.id)).toHaveLength(1);
    const outbox = await pool.query(
      `SELECT count(*)::int AS count
         FROM ${store.executionOutboxTable} o
         JOIN ${store.executionsTable} e ON e.id=o.execution_id
        WHERE e.task_id=$1`,
      [concurrentTask.id],
    );
    expect(outbox.rows[0]?.count).toBe(1);
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
      executionOwnerUserId: alice.ownerUserId,
      dispatch: dispatch('execution-a', 'run-a', 'session-a'),
    });
    expect(claimed.task).toMatchObject({ status: 'in_progress', version: task.version + 1 });
    expect(claimed.execution).toMatchObject({
      status: 'queued', purpose: 'work', runId: 'run-a', sessionId: 'session-a',
    });
    await expect(store.moveTaskFromExecution(alice, 'run-a', 'ready_to_merge'))
      .rejects.toMatchObject({ code: 'TASKBOARD_REVIEW_EXECUTION_INACTIVE' });
    expect(await store.listExecutions(alice, task.id)).toEqual([claimed.execution]);
    await expect(store.searchExecutions(alice, task.id, { page: 1, pageSize: 1 })).resolves.toMatchObject({
      items: [claimed.execution], page: 1, pageSize: 1, total: 1, hasMore: false,
    });
    await expect(store.listExecutions(admin, task.id)).rejects.toBeInstanceOf(TaskboardNotFoundError);
    await expect(store.searchExecutions(admin, task.id)).rejects.toBeInstanceOf(TaskboardNotFoundError);

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
      channel: 'web',
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
    await expect(store.getExecutionContextBySessionId('session-a')).resolves.toMatchObject({
      execution: { id: 'execution-a', runId: 'run-a', sessionId: 'session-a' },
      identity: { tenantId: alice.tenantId, ownerUserId: alice.ownerUserId },
    });
    await expect(store.getExecutionContextBySessionId('missing-session')).resolves.toBeNull();
    await expect(store.setExecutionStatus('run-a', 'waiting_user')).resolves.toMatchObject({
      status: 'waiting_user',
      startedAt: expect.any(String),
    });

    const completed = await store.completeExecution('run-a', {
      status: 'succeeded',
      commentBody: 'Agent 交付\n\n实现完成',
      reviewExecution: {
        expectedVersion: claimed.task.version,
        purpose: 'review',
        executionId: 'execution-review',
        runId: 'run-review',
        sessionId: 'session-a',
        executionOwnerUserId: alice.ownerUserId,
        dispatch: dispatch('execution-review', 'run-review', 'session-a'),
      },
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
    expect((await store.listExecutions(alice, task.id))
      .filter((item) => item.purpose === 'review')).toHaveLength(1);

    expect(await store.listExecutions(alice, task.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'execution-review',
        runId: 'run-review',
        sessionId: 'session-a',
        purpose: 'review',
        status: 'queued',
      }),
    ]));
    expect(await store.claimExecutionDispatch('run-review', 'review-lease')).toMatchObject({
      executionId: 'execution-review',
      runId: 'run-review',
      sessionId: 'session-a',
    });
    const approved = await store.moveTaskFromExecution(alice, 'run-review', 'ready_to_merge');
    const reviewCompleted = await store.completeExecution('run-review', {
      status: 'succeeded',
      commentBody: '独立复核通过',
    });
    expect(approved.status).toBe('ready_to_merge');
    expect(reviewCompleted?.task.status).toBe('ready_to_merge');
    await expect(store.moveTaskFromExecution(alice, 'run-review', 'todo'))
      .rejects.toMatchObject({ code: 'TASKBOARD_REVIEW_EXECUTION_INACTIVE' });

    const prepareReviewTask = async (suffix: string) => {
      const reviewTask = await store.createTask(
        alice, board.id, { title: `复核分支-${suffix}`, status: 'todo' },
      );
      const workId = `execution-work-${suffix}`, workRunId = `run-work-${suffix}`;
      const reviewId = `execution-review-${suffix}`, reviewRunId = `run-review-${suffix}`;
      const sessionId = `session-${suffix}`;
      const work = await store.claimExecution(alice, reviewTask.id, {
        expectedVersion: reviewTask.version, executionId: workId, runId: workRunId, sessionId,
        executionOwnerUserId: alice.ownerUserId,
        dispatch: dispatch(workId, workRunId, sessionId),
      });
      await store.completeExecution(workRunId, {
        status: 'succeeded', commentBody: `实施完成-${suffix}`,
        reviewExecution: {
          expectedVersion: work.task.version, purpose: 'review', executionId: reviewId,
          runId: reviewRunId, sessionId, executionOwnerUserId: alice.ownerUserId,
          dispatch: dispatch(reviewId, reviewRunId, sessionId),
        },
      });
      return reviewRunId;
    };

    const rejectedReview = await prepareReviewTask('rejected');
    await store.moveTaskFromExecution(alice, rejectedReview, 'todo');
    expect((await store.completeExecution(rejectedReview, {
      status: 'succeeded', commentBody: '复核不通过并已列出返工项',
    }))?.task.status).toBe('todo');

    const inconclusiveReview = await prepareReviewTask('inconclusive');
    expect((await store.completeExecution(inconclusiveReview, {
      status: 'succeeded', commentBody: '证据不足，无法明确结论',
    }))?.task.status).toBe('in_review');

    const failedReview = await prepareReviewTask('failed');
    expect((await store.completeExecution(failedReview, {
      status: 'failed', error: 'review runtime failed', commentBody: '复核运行失败',
    }))?.task.status).toBe('blocked');

    const manuallyCorrected = await store.createTask(alice, board.id, { title: '人工纠正优先', status: 'todo' });
    const secondClaim = await store.claimExecution(alice, manuallyCorrected.id, {
      expectedVersion: manuallyCorrected.version,
      executionId: 'execution-b',
      runId: 'run-b',
      sessionId: 'session-b',
      executionOwnerUserId: alice.ownerUserId,
      dispatch: dispatch('execution-b', 'run-b', 'session-b'),
    });
    const reconcilePeer = await store.createTask(alice, board.id, { title: '对账轮转', status: 'todo' });
    await store.claimExecution(alice, reconcilePeer.id, {
      expectedVersion: reconcilePeer.version,
      executionId: 'execution-c',
      runId: 'run-c',
      sessionId: 'session-c',
      executionOwnerUserId: alice.ownerUserId,
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

  it('tracks the task creator and current completion time', async () => {
    const board = await store.createBoard(alice, { name: '任务生命周期' });
    const creator = { ...alice, displayName: '爱丽丝 @alice' };
    const task = await store.createTask(creator, board.id, { title: '补充卡片信息', status: 'todo' });

    expect(task).toMatchObject({
      creatorUserId: alice.ownerUserId,
      creatorName: '爱丽丝 @alice',
    });
    expect(task.completedAt).toBeUndefined();

    const completed = await store.moveTask(alice, task.id, {
      status: 'done',
      expectedVersion: task.version,
    });
    expect(completed.completedAt).toBeTruthy();

    const reordered = await store.moveTask(alice, task.id, {
      status: 'done',
      expectedVersion: completed.version,
    });
    expect(reordered.completedAt).toBe(completed.completedAt);

    const reopened = await store.moveTask(alice, task.id, {
      status: 'todo',
      expectedVersion: reordered.version,
    });
    expect(reopened.completedAt).toBeUndefined();
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
