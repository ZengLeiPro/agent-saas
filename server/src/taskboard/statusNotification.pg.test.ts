import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgTaskboardStore } from './store.js';
import type { TaskboardIdentity } from './types.js';

const connectionString = process.env.TEST_DATABASE_URL?.trim();
const describePg = connectionString ? describe : describe.skip;
const { Pool } = pg;

describePg('任务状态通知 PostgreSQL 快照', () => {
  const prefix = `notify_${randomUUID().replaceAll('-', '').slice(0, 18)}`;
  const alice: TaskboardIdentity = { tenantId: 'tenant-a', ownerUserId: 'alice-id', username: 'alice' };
  const bob: TaskboardIdentity = { tenantId: 'tenant-a', ownerUserId: 'bob-id', username: 'bob' };
  let pool: InstanceType<typeof Pool>;
  let store: PgTaskboardStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, connectionTimeoutMillis: 5_000 });
    store = new PgTaskboardStore({ pool, tablePrefix: prefix });
    await store.init();
  }, 30_000);

  afterAll(async () => {
    if (!pool) return;
    const tables = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename LIKE $1`,
      [`${prefix}%`],
    );
    if (tables.rows.length > 0) {
      await pool.query(`DROP TABLE ${tables.rows.map(({ tablename }) => `"${tablename}"`).join(',')} CASCADE`);
    }
    await pool.query(`DROP FUNCTION IF EXISTS ${store.statusNotificationOutboxTable}_enqueue()`);
    await pool.end();
  }, 30_000);

  it('在状态事务提交时固化收件人与对应 Agent 摘要', async () => {
    const board = await store.createBoard(alice, { name: '状态通知快照', visibility: 'organization' });
    const task = await store.createTask(alice, board.id, { title: '等待依赖', status: 'todo' });
    await store.setTaskWatched(alice, task.id, true);
    await store.setTaskWatched(bob, task.id, true);
    await pool.query(
      `INSERT INTO ${store.executionsTable}(id,task_id,run_id,session_id,status,requested_by)
       VALUES ($1,$2,'run-snapshot','session-snapshot','running',$3)`,
      [randomUUID(), task.id, bob.ownerUserId],
    );

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE ${store.tasksTable} SET status='blocked',version=version+1,updated_at=now() WHERE id=$1`,
        [task.id],
      );
      await client.query(
        `INSERT INTO ${store.commentsTable}(id,task_id,body,author_type,author_id,author_name)
         VALUES ($1,$2,$3,'agent','run-snapshot','Agent')`,
        [randomUUID(), task.id, '依赖 A 尚未开通'],
      );
      await client.query('COMMIT');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }

    await store.setTaskWatched(bob, task.id, false);
    await pool.query(
      `INSERT INTO ${store.commentsTable}(id,task_id,body,author_type,author_id,author_name)
       VALUES ($1,$2,'后续无关评论','agent','run-later','Agent')`,
      [randomUUID(), task.id],
    );
    const outbox = await pool.query(
      `SELECT board_id,tenant_id,task_identifier,task_title,to_status,recipient_user_ids,event_summary
       FROM ${store.statusNotificationOutboxTable} WHERE task_id=$1`,
      [task.id],
    );

    expect(outbox.rows[0]).toMatchObject({
      board_id: board.id, tenant_id: alice.tenantId, task_identifier: task.identifier,
      task_title: task.title, to_status: 'blocked', event_summary: '依赖 A 尚未开通',
    });
    expect(outbox.rows[0].recipient_user_ids.sort()).toEqual([alice.ownerUserId, bob.ownerUserId].sort());
  });
});
