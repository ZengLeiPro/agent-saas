import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgTaskboardStore } from '../taskboard/store.js';
import type { TaskboardIdentity } from '../taskboard/types.js';

const { Pool } = pg;
const connectionString = process.env.TEST_DATABASE_URL?.trim();
const describePg = connectionString ? describe : describe.skip;

describePg('Taskboard move active peers', () => {
  const prefix = `tb_move_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const identity: TaskboardIdentity = {
    tenantId: 'tenant-a',
    ownerUserId: 'owner-id',
    username: 'owner',
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

  it('ignores soft-deleted and incomplete tasks when moving into a visually empty column', async () => {
    const board = await store.createBoard(identity, { name: '移动任务' });
    const deleted = await store.createTask(identity, board.id, { title: '已删除', status: 'todo' });
    const incomplete = await store.createTask(identity, board.id, {
      title: '创建中',
      status: 'todo',
    });
    const candidate = await store.createTask(identity, board.id, {
      title: '待移动',
      status: 'backlog',
    });

    await store.deleteTask(identity, deleted.id, { expectedVersion: deleted.version });
    await pool.query(
      `UPDATE ${store.tasksTable}
          SET creation_state='pending', creation_lease_id=$2,
              creation_lease_expires_at=now()+interval '5 minutes'
        WHERE id=$1`,
      [incomplete.id, randomUUID()],
    );

    const databasePeers = await pool.query(
      `SELECT count(*)::int AS count FROM ${store.tasksTable}
        WHERE board_id=$1 AND status='todo' AND archived_at IS NULL`,
      [board.id],
    );
    expect(databasePeers.rows[0]?.count).toBe(2);
    expect(
      (await store.listTasks(identity, board.id)).filter((task) => task.status === 'todo'),
    ).toEqual([]);

    const moved = await store.moveTask(identity, candidate.id, {
      status: 'todo',
      expectedVersion: candidate.version,
    });

    expect(moved).toMatchObject({ id: candidate.id, status: 'todo' });
    expect(
      (await store.listTasks(identity, board.id)).filter((task) => task.status === 'todo'),
    ).toEqual([expect.objectContaining({ id: candidate.id })]);
  });
});
