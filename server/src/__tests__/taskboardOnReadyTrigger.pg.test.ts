import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  TaskBoardIntegrationPolicy,
  TaskBoardRepositoryConfig,
} from '../../../shared/src/types/taskboard.js';
import { integrationAgentTableNames } from '../taskboard/integrationAgentSchema.js';
import { RepositoryProviderUnavailableError } from '../taskboard/repositoryProvider.js';
import { PgTaskboardStore } from '../taskboard/store.js';
import type { TaskboardIdentity } from '../taskboard/types.js';

const { Pool } = pg;
const connectionString = process.env.TEST_DATABASE_URL?.trim();
const describePg = connectionString ? describe : describe.skip;

describePg('Taskboard on_ready trigger schema contract', () => {
  const prefix = `tb_ready_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const identity: TaskboardIdentity = {
    tenantId: 'tenant-on-ready',
    ownerUserId: 'owner-on-ready',
    username: 'owner',
  };
  const repository: TaskBoardRepositoryConfig = {
    provider: 'github',
    repositoryId: 'github:tenant-on-ready:acme/app',
    owner: 'acme',
    name: 'app',
    baseBranch: 'main',
    allowForkPullRequest: false,
  };
  const policy = (): TaskBoardIntegrationPolicy => ({
    schemaVersion: 1,
    enabled: true,
    revision: 'replaced-by-server',
    trigger: { mode: 'on_ready', debounceMs: 0 },
    batch: { maxTasks: 20, selection: 'priority_then_ready_at' },
    execution: {
      mergeMethod: 'squash',
      continueIndependentSources: true,
      autoResolveConflicts: true,
      maxAutomaticRemediationRounds: 3,
      maxTransientRetries: 3,
      deleteRemoteBranch: false,
      deploy: false,
    },
  });
  let pool: InstanceType<typeof Pool>;
  let store: PgTaskboardStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, connectionTimeoutMillis: 5_000 });
    store = new PgTaskboardStore({ pool, tablePrefix: prefix });
    await store.init();
  }, 30_000);

  afterAll(async () => {
    if (!pool || !store) return;
    const { agentsTable } = integrationAgentTableNames(store.integrationSourcesTable);
    try {
      await pool.query(`DROP TABLE IF EXISTS
        ${agentsTable}, ${store.statusNotificationOutboxTable}, ${store.watchersTable},
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

  it('scans existing ready deliveries when on_ready policy is enabled', async () => {
    const board = await store.createBoard(identity, {
      name: 'Existing ready delivery',
      repository,
    });
    const delivery = await store.createTask(identity, board.id, {
      title: 'Ready before policy activation',
      status: 'todo',
    });
    await pool.query(
      `UPDATE ${store.tasksTable}
          SET status='ready_to_merge',provider_pull_request_id='101',pull_request_number=101,
              head_oid='head-101',base_oid='base-main',version=version+1
        WHERE id=$1`,
      [delivery.id],
    );

    await expect(
      store.updateBoard(identity, board.id, {
        integrationPolicy: policy(),
        expectedVersion: board.version,
      }),
    ).resolves.toMatchObject({ integrationPolicy: { trigger: { mode: 'on_ready' } } });

    const outbox = await pool.query(
      `SELECT board_id,task_id,trigger_mode,status
         FROM ${store.integrationTriggerOutboxTable}
        WHERE board_id=$1`,
      [board.id],
    );
    expect(outbox.rows).toEqual([
      {
        board_id: board.id,
        task_id: null,
        trigger_mode: 'on_ready',
        status: 'pending',
      },
    ]);
  });

  it('enqueues the concrete delivery after a review transition', async () => {
    const board = await store.createBoard(identity, {
      name: 'Review transition',
      repository: { ...repository, repositoryId: `${repository.repositoryId}:review` },
      integrationPolicy: policy(),
    });
    const delivery = await store.createTask(identity, board.id, {
      title: 'Review approved delivery',
      status: 'todo',
    });
    await pool.query(
      `UPDATE ${store.tasksTable}
          SET status='in_review',provider_pull_request_id='202',pull_request_number=202,
              head_oid='head-202',base_oid='base-main',next_action='review',version=version+1
        WHERE id=$1`,
      [delivery.id],
    );
    const executionId = randomUUID();
    const runId = randomUUID();
    await pool.query(
      `INSERT INTO ${store.executionsTable}
         (id,task_id,run_id,session_id,status,purpose,trigger,protocol_version,requested_by)
       VALUES ($1,$2,$3,$4,'running','review','initial',2,$5)`,
      [executionId, delivery.id, runId, randomUUID(), identity.ownerUserId],
    );
    store.setRepositoryProvider({
      getPullRequest: async () => {
        throw new RepositoryProviderUnavailableError('test provider unavailable');
      },
      mergePullRequest: async () => {
        throw new Error('not used');
      },
    });

    await expect(
      store.finishExecutionV2(identity, runId, {
        targetStatus: 'ready_to_merge',
        body: 'Independent review approved the delivery.',
      }),
    ).resolves.toMatchObject({ id: delivery.id, status: 'ready_to_merge' });

    const outbox = await pool.query(
      `SELECT board_id,task_id,trigger_mode,status
         FROM ${store.integrationTriggerOutboxTable}
        WHERE board_id=$1`,
      [board.id],
    );
    expect(outbox.rows).toEqual([
      {
        board_id: board.id,
        task_id: delivery.id,
        trigger_mode: 'on_ready',
        status: 'pending',
      },
    ]);
  });
});
