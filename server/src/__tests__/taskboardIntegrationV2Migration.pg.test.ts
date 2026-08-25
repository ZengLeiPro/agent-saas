import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { integrationAgentTableNames } from '../taskboard/integrationAgentSchema.js';
import { PgTaskboardStore } from '../taskboard/store.js';
import type { TaskboardIdentity } from '../taskboard/types.js';

const { Pool } = pg;
const connectionString = process.env.TEST_DATABASE_URL?.trim();
const describePg = connectionString ? describe : describe.skip;
const identity: TaskboardIdentity = {
  tenantId: 'tenant-integration-v2-migration',
  ownerUserId: 'integration-v2-migration-owner',
  username: 'integration-v2-migration-owner',
};

describePg('taskboard historical integration migration (PostgreSQL)', () => {
  const prefix = `tbim_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  let pool: InstanceType<typeof Pool>;
  let store: PgTaskboardStore;
  let agentsTable: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, connectionTimeoutMillis: 5_000 });
    store = new PgTaskboardStore({ pool, tablePrefix: prefix });
    await store.init();
    agentsTable = integrationAgentTableNames(store.integrationSourcesTable).agentsTable;
  }, 30_000);

  afterAll(async () => {
    if (!pool) return;
    try {
      const result = await pool.query(
        `SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename LIKE $1`,
        [`${prefix}%`],
      );
      for (const row of result.rows) await pool.query(`DROP TABLE IF EXISTS ${String(row.tablename)} CASCADE`);
    } finally {
      await pool.end();
    }
  }, 30_000);

  async function seedHistoricalIntegration(label: string, source: 'valid' | 'missing' | 'cross-repository' | 'malformed') {
    const repositoryId = `github:${identity.tenantId}:acme/${label}`;
    const board = await store.createBoard(identity, {
      name: `${label} board`,
      repository: {
        provider: 'github', repositoryId, owner: 'acme', name: label,
        baseBranch: 'main', allowForkPullRequest: false,
      },
    });
    const delivery = await store.createTask(identity, board.id, { title: `${label} delivery`, status: 'todo' });
    const integration = await store.createTask(identity, board.id, { title: `${label} integration`, status: 'todo' });
    await pool.query(`UPDATE ${store.tasksTable} SET kind='integration' WHERE id=$1`, [integration.id]);
    await pool.query(
      `UPDATE ${store.integrationLanesTable}
          SET active_integration_task_id=$1
        WHERE repository_id=$2 AND board_id=$3`,
      [integration.id, repositoryId, board.id],
    );
    if (source !== 'missing') {
      const sourceId = randomUUID();
      await pool.query(
        `INSERT INTO ${store.integrationSourcesTable}
           (id,integration_task_id,delivery_task_id,repository_id,provider_pull_request_id,
            reviewed_subject_digest,source_order,state)
         VALUES($1,$2,$3,$4,'17','sha256:reviewed',0,'pending')`,
        [sourceId, integration.id, delivery.id, repositoryId],
      );
      if (source === 'cross-repository') {
        const otherDelivery = await store.createTask(identity, board.id, { title: `${label} other delivery`, status: 'todo' });
        await pool.query(
          `INSERT INTO ${store.integrationSourcesTable}
             (id,integration_task_id,delivery_task_id,repository_id,provider_pull_request_id,
              reviewed_subject_digest,source_order,state)
           VALUES($1,$2,$3,$4,'18','sha256:reviewed',1,'pending')`,
          [randomUUID(), integration.id, otherDelivery.id, `${repositoryId}-other`],
        );
      } else if (source === 'malformed') {
        await pool.query(
          `INSERT INTO ${agentsTable}
             (integration_task_id,delivery_source_ids,repository_id,integration_branch,status)
           VALUES($1,$2::jsonb,$3,'wrong/branch','active')`,
          [integration.id, JSON.stringify([sourceId]), repositoryId],
        );
      }
    }
    return integration.id;
  }

  it('atomically creates the unique Agent rendezvous before the constrained 2 to 3 upgrade', async () => {
    const initialDefault = await pool.query(
      `SELECT column_default AS value
         FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name=$1 AND column_name='workflow_version'`,
      [store.tasksTable],
    );
    expect(initialDefault.rows[0]?.value).toContain('3');

    await pool.query(`ALTER TABLE ${store.tasksTable} ALTER COLUMN workflow_version SET DEFAULT 2`);
    let validIds: string[];
    let missingId: string;
    let crossRepositoryId: string;
    let malformedId: string;
    try {
      missingId = await seedHistoricalIntegration('missing', 'missing');
      crossRepositoryId = await seedHistoricalIntegration('cross-repository', 'cross-repository');
      malformedId = await seedHistoricalIntegration('malformed', 'malformed');
      validIds = [];
      for (const label of ['batch-a', 'batch-b', 'batch-c']) {
        validIds.push(await seedHistoricalIntegration(label, 'valid'));
      }
    } finally {
      await pool.query(`ALTER TABLE ${store.tasksTable} ALTER COLUMN workflow_version SET DEFAULT 3`);
    }

    await expect(pool.query(
      `UPDATE ${store.tasksTable} SET workflow_version=3 WHERE id=$1`,
      [missingId],
    )).rejects.toThrow(/TASKBOARD_WORKFLOW_VERSION_IMMUTABLE/u);
    // Permanently invalid historical rows are older than every valid row, but must
    // be filtered before the bounded migration batch is selected.
    for (const [index, id] of [missingId, crossRepositoryId, malformedId, ...validIds].entries()) {
      await pool.query(`UPDATE ${store.tasksTable} SET updated_at=$2 WHERE id=$1`, [
        id, new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      ]);
    }

    await store.claimIntegrationDispatchCandidatesV2(2);
    const firstRound = await pool.query(
      `SELECT count(*)::int AS migrated FROM ${store.tasksTable}
        WHERE id=ANY($1::text[]) AND workflow_version=3`, [validIds],
    );
    expect(firstRound.rows[0]?.migrated).toBe(2);

    await store.claimIntegrationDispatchCandidatesV2(2);
    const secondRound = await pool.query(
      `SELECT count(*)::int AS migrated FROM ${store.tasksTable}
        WHERE id=ANY($1::text[]) AND workflow_version=3`, [validIds],
    );
    expect(secondRound.rows[0]?.migrated).toBe(3);

    await store.claimIntegrationDispatchCandidatesV2(10);
    const migrated = await pool.query(
      `SELECT task.id,task.workflow_version,count(agent.integration_task_id)::int AS agent_count,
              min(agent.repository_id) AS repository_id,min(agent.integration_branch) AS integration_branch
         FROM ${store.tasksTable} task
         LEFT JOIN ${agentsTable} agent ON agent.integration_task_id=task.id
        WHERE task.id=ANY($1::text[])
        GROUP BY task.id,task.workflow_version`,
      [[...validIds, missingId, crossRepositoryId, malformedId]],
    );
    for (const validId of validIds) {
      expect(migrated.rows.find((row) => row.id === validId)).toMatchObject({
        workflow_version: 3, agent_count: 1, integration_branch: `integration/${validId}`,
      });
    }
    expect(migrated.rows.find((row) => row.id === missingId)).toMatchObject({ workflow_version: 2, agent_count: 0 });
    expect(migrated.rows.find((row) => row.id === crossRepositoryId)).toMatchObject({ workflow_version: 2, agent_count: 0 });
    expect(migrated.rows.find((row) => row.id === malformedId)).toMatchObject({ workflow_version: 2, agent_count: 1 });

    await store.claimIntegrationDispatchCandidatesV2(10);
    const replay = await pool.query(
      `SELECT task.workflow_version,count(agent.integration_task_id)::int AS agent_count
         FROM ${store.tasksTable} task
         LEFT JOIN ${agentsTable} agent ON agent.integration_task_id=task.id
        WHERE task.id=$1 GROUP BY task.workflow_version`,
      [validIds[0]],
    );
    expect(replay.rows[0]).toMatchObject({ workflow_version: 3, agent_count: 1 });

    await expect(pool.query(
      `UPDATE ${store.tasksTable} SET workflow_version=2 WHERE id=$1`,
      [validIds[0]],
    )).rejects.toThrow(/TASKBOARD_WORKFLOW_VERSION_IMMUTABLE/u);
  });
});
