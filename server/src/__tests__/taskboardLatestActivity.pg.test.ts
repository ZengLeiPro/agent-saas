import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgTaskboardStore } from '../taskboard/store.js';
import type { TaskboardIdentity } from '../taskboard/types.js';

const { Pool } = pg;
const connectionString = process.env.TEST_DATABASE_URL?.trim();
const describePg = connectionString ? describe : describe.skip;

describePg('任务卡片最新动态时间', () => {
  const prefix = `tb_${randomUUID().replaceAll('-', '').slice(0, 18)}`;
  const alice: TaskboardIdentity = {
    tenantId: 'tenant-latest',
    ownerUserId: 'alice-latest',
    username: 'alice',
  };
  let pool: InstanceType<typeof Pool>;
  let store: PgTaskboardStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, connectionTimeoutMillis: 5_000 });
    store = new PgTaskboardStore({ pool, tablePrefix: prefix });
    await store.init();
  }, 30_000);

  afterAll(async () => {
    if (!pool || !store) return;
    try {
      await pool.query(`DROP TABLE IF EXISTS
        ${store.statusNotificationOutboxTable}, ${store.watchersTable}, ${store.integrationTriggerOutboxTable},
        ${store.blockEpisodesTable}, ${store.cancellationOutboxTable},
        ${store.remediationAttemptsTable}, ${store.mergeOperationsTable},
        ${store.mergeAuthorizationsTable}, ${store.integrationSourcesTable}, ${store.integrationLanesTable},
        ${store.attemptsTable}, ${store.changesTable}, ${store.membersTable}, ${store.continuationOutboxTable},
        ${store.executionOutboxTable}, ${store.executionsTable}, ${store.commentsTable}, ${store.tasksTable},
        ${store.boardsTable} CASCADE`);
    } finally {
      await pool.end();
    }
  }, 30_000);

  it('普通编辑和 CI 字段刷新不会推进最新动态时间', async () => {
    const board = await store.createBoard(alice, { name: '非状态更新' });
    const task = await store.createTask(alice, board.id, { title: '原始标题', status: 'backlog' });
    const initialActivityAt = task.latestActivityAt;

    const edited = await store.updateTask(alice, task.id, {
      title: '编辑后的标题',
      expectedVersion: task.version,
    });
    expect(edited.title).toBe('编辑后的标题');
    expect(edited.latestActivityAt).toBe(initialActivityAt);

    await pool.query(
      `UPDATE ${store.tasksTable}
          SET provider_ci_status='success',provider_ci_inspected_at=now(),updated_at=now()+interval '1 day'
        WHERE id=$1`,
      [task.id],
    );
    const afterCiInspection = await store.getTask(alice, task.id);
    expect(afterCiInspection.updatedAt).not.toBe(edited.updatedAt);
    expect(afterCiInspection.latestActivityAt).toBe(initialActivityAt);
  });

  it('真实状态迁移会推进列表和详情的最新动态时间', async () => {
    const board = await store.createBoard(alice, { name: '状态迁移' });
    const task = await store.createTask(alice, board.id, { title: '等待迁移', status: 'backlog' });
    const moved = await store.moveTask(alice, task.id, {
      status: 'todo',
      expectedVersion: task.version,
    });
    const event = await pool.query(
      `SELECT created_at FROM ${store.changesTable}
        WHERE task_id=$1 AND change_type='task.transitioned'
        ORDER BY created_at DESC LIMIT 1`,
      [task.id],
    );
    const transitionAt = new Date(event.rows[0].created_at).toISOString();

    expect(moved.latestActivityAt).toBe(transitionAt);
    expect((await store.listTasks(alice, board.id)).find((item) => item.id === task.id)?.latestActivityAt)
      .toBe(transitionAt);
  });

  it('删除最新评论后回退到上一条可见评论，再回退到状态时间', async () => {
    const board = await store.createBoard(alice, { name: '评论回退' });
    const task = await store.createTask(alice, board.id, { title: '评论任务', status: 'backlog' });
    await store.moveTask(alice, task.id, { status: 'todo', expectedVersion: task.version });
    const first = await store.createComment(alice, task.id, { body: '第一条评论' });
    const second = await store.createComment(alice, task.id, { body: '第二条评论' });
    await pool.query(
      `UPDATE ${store.commentsTable}
          SET created_at=CASE id WHEN $1 THEN '2030-01-01T00:00:01Z'::timestamptz
                                 WHEN $2 THEN '2030-01-01T00:00:02Z'::timestamptz END
        WHERE id=ANY($3::text[])`,
      [first.id, second.id, [first.id, second.id]],
    );

    expect((await store.getTask(alice, task.id)).latestActivityAt).toBe('2030-01-01T00:00:02.000Z');
    await store.deleteComment(alice, second.id, { expectedVersion: second.version });
    expect((await store.getTask(alice, task.id)).latestActivityAt).toBe('2030-01-01T00:00:01.000Z');
    await store.deleteComment(alice, first.id, { expectedVersion: first.version });

    const transition = await pool.query(
      `SELECT created_at FROM ${store.changesTable}
        WHERE task_id=$1 AND change_type='task.transitioned'
        ORDER BY created_at DESC LIMIT 1`,
      [task.id],
    );
    expect((await store.getTask(alice, task.id)).latestActivityAt)
      .toBe(new Date(transition.rows[0].created_at).toISOString());
  });
});
