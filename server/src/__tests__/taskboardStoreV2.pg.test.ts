import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgTaskboardStore } from '../taskboard/store.js';
import type { TaskboardIdentity } from '../taskboard/types.js';

const { Pool } = pg;
const connectionString = process.env.TEST_DATABASE_URL?.trim();
const describePg = connectionString ? describe : describe.skip;

describePg('PgTaskboardStore V2 integration contract', () => {
  const prefix = `tbv2_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  let pool: InstanceType<typeof Pool>;
  let store: PgTaskboardStore;
  const alice: TaskboardIdentity = {
    tenantId: 'tenant-a', ownerUserId: 'alice-id', username: 'alice',
  };
  const bob: TaskboardIdentity = {
    tenantId: 'tenant-a', ownerUserId: 'bob-id', username: 'bob',
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, connectionTimeoutMillis: 5_000 });
    store = new PgTaskboardStore({ pool, tablePrefix: prefix });
    await store.init();
  }, 30_000);

  afterAll(async () => {
    if (!pool || !store) return;
    try {
      await pool.query(`DROP TABLE IF EXISTS ${store.integrationTriggerOutboxTable} CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS ${store.blockEpisodesTable} CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS ${store.mergeOperationsTable} CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS ${store.mergeAuthorizationsTable} CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS ${store.integrationSourcesTable} CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS ${store.integrationLanesTable} CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS ${store.attemptsTable} CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS ${store.changesTable} CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS ${store.membersTable} CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS ${store.continuationOutboxTable} CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS ${store.executionOutboxTable} CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS ${store.executionsTable} CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS ${store.commentsTable} CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS ${store.tasksTable} CASCADE`);
      await pool.query(`DROP TABLE IF EXISTS ${store.boardsTable} CASCADE`);
    } finally {
      await pool.end();
    }
  }, 30_000);

  it('enforces V2 RBAC, freezes integration sources, and rejects duplicate active sources', async () => {
    const board = await store.createBoard(alice, {
      name: 'V2 集成闭环',
      visibility: 'organization',
      repository: {
        provider: 'github',
        repositoryId: 'github:acme/app',
        owner: 'acme',
        name: 'app',
        baseBranch: 'main',
        allowForkPullRequest: false,
      },
      integrationPolicy: {
        schemaVersion: 1,
        enabled: true,
        revision: 'client-value-is-replaced',
        trigger: { mode: 'manual', allowedRoles: ['maintainer', 'owner'] },
        batch: { maxTasks: 20, selection: 'priority_then_ready_at' },
        execution: {
          mergeMethod: 'squash',
          continueIndependentSources: true,
          autoResolveConflicts: true,
          maxAutomaticRemediationRounds: 3,
          maxTransientRetries: 3,
          requireGreenChecks: true,
          deleteRemoteBranch: false,
          deploy: false,
        },
      },
    });
    expect((await store.getBoard(bob, board.id))).toMatchObject({
      role: 'viewer',
      allowedActions: ['board.read'],
    });
    await expect(store.createTask(bob, board.id, { title: 'viewer 不可写' }))
      .rejects.toMatchObject({ code: 'TASKBOARD_PERMISSION_DENIED' });

    await store.upsertMember!(alice, board.id, { userId: bob.ownerUserId, role: 'maintainer' });
    expect((await store.getBoard(bob, board.id)).allowedActions).toContain('integration.create');
    const first = await store.createTask(bob, board.id, { title: '来源 A', status: 'todo' });
    const second = await store.createTask(bob, board.id, { title: '来源 B', status: 'todo' });
    await pool.query(
      `UPDATE ${store.tasksTable}
          SET status='ready_to_merge', provider_pull_request_id=identifier,
              pull_request_number=CASE id WHEN $1 THEN 101 ELSE 102 END,
              head_oid='head-'||id,base_oid='base-main', version=version+1
        WHERE id=ANY($2::text[])`,
      [first.id, [first.id, second.id]],
    );
    store.setRepositoryProvider({
      getPullRequest: async (_repository, providerPullRequestId) => {
        const source = providerPullRequestId === first.identifier ? first : second;
        return {
          providerPullRequestId, number: source.id === first.id ? 101 : 102,
          state: 'open', draft: false, headRef: `feature/${source.identifier}`,
          headOid: `head-${source.id}`, baseRef: 'main', baseOid: 'base-main', mergeable: true,
          requiredChecks: [{ name: 'ci', status: 'success' }], requiredChecksKnown: true,
          subjectDigest: `digest-${source.id}`,
        };
      },
      mergePullRequest: async () => { throw new Error('not used'); },
    });
    const freshBoard = await store.getBoard(bob, board.id);
    const integration = await store.createIntegrationBatch!(bob, board.id, {
      deliveryTaskIds: [first.id, second.id],
      expectedBoardVersion: freshBoard.version,
    }, 'manual_batch');
    expect(integration).toMatchObject({ kind: 'integration', status: 'in_progress' });
    expect(await store.listIntegrationSources!(bob, integration.id)).toHaveLength(2);
    const boardAfterIntegration = await store.getBoard(bob, board.id);
    await expect(store.createIntegrationBatch!(bob, board.id, {
      deliveryTaskIds: [first.id],
      expectedBoardVersion: boardAfterIntegration.version,
    }, 'manual_batch')).rejects.toMatchObject({ code: 'TASKBOARD_INTEGRATION_SOURCE_DUPLICATE' });

    const change = await pool.query(
      `SELECT seq,payload FROM ${store.changesTable} WHERE task_id=$1 ORDER BY seq LIMIT 1`,
      [first.id],
    );
    expect(change.rows[0]).toBeTruthy();
    await pool.query(`UPDATE ${store.changesTable} SET payload='{"tampered":true}'::jsonb WHERE seq=$1`, [change.rows[0].seq]);
    const unchanged = await pool.query(`SELECT payload FROM ${store.changesTable} WHERE seq=$1`, [change.rows[0].seq]);
    expect(unchanged.rows[0].payload).not.toEqual({ tampered: true });
  });
});
