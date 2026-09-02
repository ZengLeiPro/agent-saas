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

  it('普通编辑、非状态字段刷新和同状态 execution.claimed 不会推进最新动态时间', async () => {
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
          SET model='legacy-model',updated_at=now()+interval '1 day'
        WHERE id=$1`,
      [task.id],
    );
    await pool.query(
      `INSERT INTO ${store.changesTable}(task_id,change_type,actor_type,actor_id,payload,created_at)
       VALUES ($1,'execution.claimed','user',$2,$3::jsonb,'2040-01-01T00:00:00Z')`,
      [task.id, alice.ownerUserId, JSON.stringify({ from: 'backlog', to: 'backlog' })],
    );
    const afterNonStatusUpdate = await store.getTask(alice, task.id);
    expect(afterNonStatusUpdate.updatedAt).not.toBe(edited.updatedAt);
    expect(afterNonStatusUpdate.latestActivityAt).toBe(initialActivityAt);
  });

  it('真实状态迁移会推进列表和详情的最新动态时间', async () => {
    const board = await store.createBoard(alice, { name: '状态迁移' });
    const task = await store.createTask(alice, board.id, { title: '等待迁移', status: 'backlog' });
    const moved = await store.moveTask(alice, task.id, {
      status: 'todo',
      expectedVersion: task.version,
    });
    const statusClock = await pool.query(
      `SELECT status_changed_at FROM ${store.tasksTable} WHERE id=$1`,
      [task.id],
    );
    const transitionAt = new Date(statusClock.rows[0].status_changed_at).toISOString();

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

    const statusClock = await pool.query(
      `SELECT status_changed_at FROM ${store.tasksTable} WHERE id=$1`,
      [task.id],
    );
    expect((await store.getTask(alice, task.id)).latestActivityAt)
      .toBe(new Date(statusClock.rows[0].status_changed_at).toISOString());
  });

  it('advisory 晋级为 delivery 并回到 todo 会推进状态时间', async () => {
    const board = await store.createBoard(alice, { name: '任务晋级' });
    const advisory = await store.createTask(alice, board.id, {
      title: '咨询任务',
      kind: 'advisory',
      status: 'backlog',
    });
    await pool.query(
      `UPDATE ${store.tasksTable} SET status='done',version=version+1 WHERE id=$1`,
      [advisory.id],
    );
    await pool.query(
      `UPDATE ${store.tasksTable} SET status_changed_at='2020-01-01T00:00:00Z' WHERE id=$1`,
      [advisory.id],
    );
    const completed = await store.getTask(alice, advisory.id);
    const promoted = await store.updateTask(alice, advisory.id, {
      kind: 'delivery',
      expectedVersion: completed.version,
    });

    expect(promoted).toMatchObject({ kind: 'delivery', status: 'todo' });
    expect(Date.parse(promoted.latestActivityAt!)).toBeGreaterThan(Date.parse('2020-01-01T00:00:00Z'));
  });

  it('数据库状态时钟覆盖 integration v2/v3 取消及三类任务合并完成', async () => {
    const board = await store.createBoard(alice, { name: '终态迁移' });
    const integrationV2Id = randomUUID();
    const integrationV3Id = randomUUID();
    const integrationDoneId = randomUUID();
    const remediationId = randomUUID();
    await pool.query(
      `INSERT INTO ${store.tasksTable}
         (id,board_id,identifier,kind,title,status,sort_order,workflow_version)
       VALUES ($1,$2,'INT-V2','integration','Integration V2','in_progress',1024,2),
              ($3,$2,'INT-V3','integration','Integration V3','in_progress',2048,3),
              ($4,$2,'INT-DONE','integration','Integration 合并','in_progress',3072,3),
              ($5,$2,'REM-DONE','remediation','Remediation 合并','in_progress',4096,3)`,
      [integrationV2Id, board.id, integrationV3Id, integrationDoneId, remediationId],
    );
    const delivery = await store.createTask(alice, board.id, {
      title: 'Delivery 合并', kind: 'delivery', status: 'todo',
    });
    await pool.query(
      `UPDATE ${store.tasksTable} SET status='ready_to_merge',version=version+1 WHERE id=$1`,
      [delivery.id],
    );
    const allIds = [integrationV2Id, integrationV3Id, delivery.id, integrationDoneId, remediationId];
    await pool.query(
      `UPDATE ${store.tasksTable} SET status_changed_at='2020-01-01T00:00:00Z'
        WHERE id=ANY($1::text[])`,
      [allIds],
    );
    await pool.query(
      `UPDATE ${store.tasksTable} SET status='canceled',version=version+1
        WHERE id=ANY($1::text[])`,
      [[integrationV2Id, integrationV3Id]],
    );
    await pool.query(
      `UPDATE ${store.tasksTable} SET status='done',version=version+1
        WHERE id=ANY($1::text[])`,
      [[delivery.id, integrationDoneId, remediationId]],
    );

    for (const id of allIds) {
      const latest = await store.getTask(alice, id);
      expect(Date.parse(latest.latestActivityAt!)).toBeGreaterThan(Date.parse('2020-01-01T00:00:00Z'));
    }
  });
});
