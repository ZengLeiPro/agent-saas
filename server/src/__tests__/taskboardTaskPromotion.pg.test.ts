import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgTaskboardStore } from '../taskboard/store.js';
import type { TaskboardIdentity } from '../taskboard/types.js';

const { Pool } = pg;
const connectionString = process.env.TEST_DATABASE_URL?.trim();
const describePg = connectionString ? describe : describe.skip;

describePg('Taskboard advisory promotion', () => {
  const prefix = `tb_promo_${randomUUID().replaceAll('-', '').slice(0, 14)}`;
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
        ${store.integrationTriggerOutboxTable}, ${store.blockEpisodesTable}, ${store.cancellationOutboxTable},
        ${store.remediationAttemptsTable}, ${store.mergeOperationsTable},
        ${store.mergeAuthorizationsTable}, ${store.integrationSourcesTable}, ${store.integrationLanesTable},
        ${store.attemptsTable}, ${store.changesTable}, ${store.membersTable}, ${store.continuationOutboxTable},
        ${store.executionOutboxTable}, ${store.executionsTable}, ${store.commentsTable}, ${store.tasksTable},
        ${store.boardsTable} CASCADE`);
    } finally {
      await pool.end();
    }
  }, 30_000);

  it('promotes advisory to delivery once, reopens it in todo, and records the audit change', async () => {
    const board = await store.createBoard(identity, { name: '任务升级' });
    const advisory = await store.createTask(identity, board.id, {
      title: '先分析后实施',
      kind: 'advisory',
      status: 'backlog',
    });

    const promoted = await store.updateTask(identity, advisory.id, {
      kind: 'delivery',
      expectedVersion: advisory.version,
    });

    expect(promoted).toMatchObject({ kind: 'delivery', status: 'todo' });
    expect(promoted).not.toHaveProperty('completedAt');
    const changes = await pool.query(
      `SELECT change_type AS type, payload FROM ${store.changesTable} WHERE task_id=$1 ORDER BY seq DESC LIMIT 1`,
      [advisory.id],
    );
    expect(changes.rows[0]).toMatchObject({
      type: 'task.promoted',
      payload: {
        fromKind: 'advisory',
        toKind: 'delivery',
        previousStatus: 'backlog',
        status: 'todo',
      },
    });

    await expect(store.updateTask(identity, promoted.id, {
      kind: 'delivery',
      expectedVersion: promoted.version,
    })).rejects.toMatchObject({ code: 'TASKBOARD_TASK_KIND_TRANSITION_FORBIDDEN' });
  });
});
