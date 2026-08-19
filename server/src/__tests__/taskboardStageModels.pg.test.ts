import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgTaskboardStore } from '../taskboard/store.js';
import type { TaskboardIdentity } from '../taskboard/types.js';

const { Pool } = pg;
const connectionString = process.env.TEST_DATABASE_URL?.trim();
const describePg = connectionString ? describe : describe.skip;

describePg('PgTaskboardStore stage model contract', () => {
  const prefix = `tb_${randomUUID().replaceAll('-', '').slice(0, 18)}`;
  let pool: InstanceType<typeof Pool>;
  let store: PgTaskboardStore;
  const alice: TaskboardIdentity = { tenantId: 'tenant-a', ownerUserId: 'alice-id', username: 'alice' };

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, connectionTimeoutMillis: 5_000, max: 4 });
    store = new PgTaskboardStore({ pool, tablePrefix: prefix });
    await store.init();
  }, 30_000);

  afterAll(async () => {
    if (!pool || !store) return;
    try {
      await pool.query(`DROP TABLE IF EXISTS
        ${store.integrationTriggerOutboxTable}, ${store.blockEpisodesTable}, ${store.cancellationOutboxTable},
        ${store.resolutionsTable}, ${store.remediationAttemptsTable}, ${store.mergeOperationsTable},
        ${store.mergeAuthorizationsTable}, ${store.integrationSourcesTable}, ${store.integrationLanesTable},
        ${store.attemptsTable}, ${store.changesTable}, ${store.membersTable}, ${store.continuationOutboxTable},
        ${store.executionOutboxTable}, ${store.executionsTable}, ${store.commentsTable}, ${store.tasksTable},
        ${store.boardsTable} CASCADE`);
    } finally {
      await pool.end();
    }
  }, 30_000);

  it('clears the legacy task model when stage model overrides are edited', async () => {
    const board = await store.createBoard(alice, { name: `旧模型迁移-${randomUUID()}` });
    const legacy = await store.createTask(alice, board.id, { title: '旧模型任务', model: 'legacy/model' });
    const migrated = await store.updateTask(alice, legacy.id, {
      expectedVersion: legacy.version,
      stageModels: { review: 'stage/review' },
    });
    expect(migrated).toMatchObject({ stageModels: { review: 'stage/review' } });
    expect(migrated.model).toBeUndefined();

    const cleared = await store.updateTask(alice, migrated.id, {
      expectedVersion: migrated.version,
      stageModels: {},
    });
    expect(cleared.model).toBeUndefined();
    expect(cleared.stageModels).toBeUndefined();
  });
});
