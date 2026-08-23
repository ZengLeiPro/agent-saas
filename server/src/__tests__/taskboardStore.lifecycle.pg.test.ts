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
      await pool.query(`DROP TABLE IF EXISTS
        ${store.integrationTriggerOutboxTable}, ${store.blockEpisodesTable}, ${store.cancellationOutboxTable},
        ${store.remediationAttemptsTable}, ${store.mergeOperationsTable},
        ${store.mergeAuthorizationsTable}, ${store.integrationSourcesTable}, ${store.integrationLanesTable},
        ${store.attemptsTable}, ${store.changesTable}, ${store.membersTable}, ${store.continuationOutboxTable},
        ${store.executionOutboxTable}, ${store.executionsTable}, ${store.commentsTable}, ${store.tasksTable},
        ${store.boardsTable}, ${runStore.steeringInputsTable}, ${runStore.runsTable} CASCADE`);
    } finally {
      await pool.end();
    }
  }, 30_000);

  it('tracks the task creator and protects workflow-owned completion state', async () => {
    const board = await store.createBoard(alice, { name: '任务生命周期' });
    const creator = { ...alice, displayName: '爱丽丝 @alice' };
    const task = await store.createTask(creator, board.id, { title: '补充卡片信息', status: 'todo' });

    expect(task).toMatchObject({
      creatorUserId: alice.ownerUserId,
      creatorName: '爱丽丝 @alice',
    });
    expect(task.completedAt).toBeUndefined();

    await expect(store.moveTask(alice, task.id, {
      status: 'done',
      expectedVersion: task.version,
    })).rejects.toMatchObject({ code: 'TASKBOARD_PROTECTED_TRANSITION' });
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
      status: 'backlog',
      expectedVersion: between.version,
    });
    const appended = await store.createTask(alice, board.id, { title: 'D', status: 'backlog' });
    expect(appended.sortOrder).toBeGreaterThan(movedToEmpty.sortOrder);

    await store.moveTask(alice, second.id, {
      status: 'backlog',
      previousTaskId: appended.id,
      expectedVersion: todo[2]!.version,
    });
    const backlog = await store.listTasks(alice, board.id, { statuses: ['backlog'] });
    expect(backlog.map((task) => task.id)).toEqual([third.id, appended.id, second.id]);
  });

  it('soft-deletes a task, hides it from listings and requires maintainer', async () => {
    const board = await store.createBoard(alice, { name: '删除任务', visibility: 'organization' });
    await store.upsertMember(alice, board.id, { userId: bob.ownerUserId, role: 'editor' });
    const task = await store.createTask(alice, board.id, { title: '待删除', status: 'todo' });

    const deleted = await store.deleteTask(alice, task.id, { expectedVersion: task.version });
    expect(deleted).toMatchObject({ id: task.id, version: task.version + 1 });
    expect(deleted.deletedAt).toBeDefined();

    const tasks = await store.listTasks(alice, board.id);
    expect(tasks.map((item) => item.id)).not.toContain(task.id);

    await expect(store.getTask(alice, task.id)).rejects.toMatchObject({ code: 'TASKBOARD_NOT_FOUND' });

    const second = await store.createTask(alice, board.id, { title: '待删除2', status: 'todo' });
    await expect(store.deleteTask(bob, second.id, { expectedVersion: second.version }))
      .rejects.toMatchObject({ code: 'TASKBOARD_PERMISSION_DENIED' });
  });
});
