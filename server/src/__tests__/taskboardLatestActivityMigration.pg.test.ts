import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgTaskboardStore } from '../taskboard/store.js';
import type { TaskboardIdentity } from '../taskboard/types.js';

const { Pool } = pg;
const connectionString = process.env.TEST_DATABASE_URL?.trim();
const describePg = connectionString ? describe : describe.skip;

describePg('任务最新动态时间旧库迁移', () => {
  const prefix = `tm_${randomUUID().replaceAll('-', '').slice(0, 18)}`;
  const alice: TaskboardIdentity = {
    tenantId: 'tenant-migration', ownerUserId: 'alice-migration', username: 'alice',
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

  it('以兼容水位升级无 status_changed_at 的旧任务且不把 merge receipt 当状态变化', async () => {
    const board = await store.createBoard(alice, { name: '旧库迁移' });
    await pool.query(`
      DROP TRIGGER IF EXISTS ${store.tasksTable}_status_time ON ${store.tasksTable};
      DROP FUNCTION IF EXISTS ${store.tasksTable}_status_time_fn();
      ALTER TABLE ${store.tasksTable} DROP COLUMN status_changed_at
    `);
    const continuationId = randomUUID();
    const mergedId = randomUUID();
    await pool.query(
      `INSERT INTO ${store.tasksTable}
         (id,board_id,identifier,kind,title,status,sort_order,completed_at,merged_commit_oid,created_at,updated_at)
       VALUES ($1,$3,'LEGACY-CONT','delivery','Legacy continuation','in_review',1024,NULL,NULL,
               '2020-01-01T00:00:00Z','2021-02-03T04:05:06Z'),
              ($2,$3,'LEGACY-MERGE','integration','Merge receipt replay','done',2048,
               '2022-03-04T05:06:07Z','new-merge-oid','2020-01-01T00:00:00Z','2023-04-05T06:07:08Z')`,
      [continuationId, mergedId, board.id],
    );
    const continuationCommentId = randomUUID();
    await pool.query(
      `INSERT INTO ${store.commentsTable}
         (id,task_id,body,author_type,author_id,author_name,continuation_run_id,created_at,updated_at)
       VALUES ($1,$2,'继续执行','user',$3,'alice','legacy-continuation-run',
               '2021-02-03T04:00:00Z','2021-02-03T04:00:00Z')`,
      [continuationCommentId, continuationId, alice.ownerUserId],
    );
    await pool.query(
      `INSERT INTO ${store.continuationOutboxTable}
         (run_id,task_id,comment_id,session_id,payload,status,created_at,updated_at)
       VALUES ('legacy-continuation-run',$1,$2,'legacy-session','{}'::jsonb,'completed',
               '2021-02-03T04:00:00Z','2021-02-03T04:05:06Z')`,
      [continuationId, continuationCommentId],
    );
    await pool.query(
      `INSERT INTO ${store.changesTable}(task_id,change_type,actor_type,actor_id,payload,created_at)
       VALUES ($1,'task.created','user',$3,$4::jsonb,'2020-01-01T00:00:00Z'),
              ($2,'task.created','user',$3,$5::jsonb,'2020-01-01T00:00:00Z'),
              ($2,'integration.agent.merge.succeeded','agent','legacy-agent',$6::jsonb,
               '2023-04-05T06:07:08Z')`,
      [continuationId, mergedId, alice.ownerUserId,
        JSON.stringify({ status: 'backlog' }), JSON.stringify({ status: 'in_progress' }),
        JSON.stringify({ mergedCommitOid: 'new-merge-oid' })],
    );

    await store.init();

    const migrated = await pool.query(
      `SELECT id,status_changed_at FROM ${store.tasksTable} WHERE id=ANY($1::text[]) ORDER BY id`,
      [[continuationId, mergedId]],
    );
    const byId = new Map(migrated.rows.map((row) => [row.id, new Date(row.status_changed_at).toISOString()]));
    expect(byId.get(continuationId)).toBe('2021-02-03T04:05:06.000Z');
    expect(byId.get(continuationId)).not.toBe('2020-01-01T00:00:00.000Z');
    expect(byId.get(mergedId)).toBe('2022-03-04T05:06:07.000Z');
    expect(byId.get(mergedId)).not.toBe('2023-04-05T06:07:08.000Z');
    expect((await store.getTask(alice, continuationId)).latestActivityAt)
      .toBe('2021-02-03T04:05:06.000Z');
    expect((await store.getTask(alice, mergedId)).latestActivityAt)
      .toBe('2022-03-04T05:06:07.000Z');
  });
});
