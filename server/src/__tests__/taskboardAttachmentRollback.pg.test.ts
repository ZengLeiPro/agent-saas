import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgTaskboardStore } from '../taskboard/store.js';
import {
  TaskboardPermissionError,
  type TaskboardIdentity,
} from '../taskboard/types.js';

const { Pool } = pg;
const connectionString = process.env.TEST_DATABASE_URL?.trim();
const describePg = connectionString ? describe : describe.skip;

describePg('PgTaskboardStore attachment rollback contract', () => {
  const prefix = `tb_${randomUUID().replaceAll('-', '').slice(0, 18)}`;
  let pool: InstanceType<typeof Pool>;
  let store: PgTaskboardStore;

  const alice: TaskboardIdentity = { tenantId: 'tenant-a', ownerUserId: 'alice-id', username: 'alice' };
  const bob: TaskboardIdentity = { tenantId: 'tenant-a', ownerUserId: 'bob-id', username: 'bob' };
  const repository = {
    provider: 'github' as const,
    repositoryId: `github:tenant-a:rollback-${randomUUID()}`,
    owner: 'acme',
    name: `rollback-${randomUUID()}`,
    baseBranch: 'main',
    allowForkPullRequest: false as const,
  };

  const dispatch = (executionId: string, runId: string, sessionId: string) => ({
    version: 1 as const,
    session: {
      sessionId,
      userId: alice.ownerUserId,
      username: alice.username,
      tenantId: alice.tenantId,
      channel: 'web',
      cwd: '/tmp/taskboard-rollback-test',
      transcriptPath: `/tmp/taskboard-rollback-test/${sessionId}.jsonl`,
      status: 'running' as const,
      createdAt: '2026-08-07T00:00:00.000Z',
      updatedAt: '2026-08-07T00:00:00.000Z',
    },
    run: {
      runId,
      sessionId,
      userId: alice.ownerUserId,
      tenantId: alice.tenantId,
      channel: 'web',
      idempotencyKey: `taskboard-rollback:${executionId}`,
      metadata: { taskboardExecution: true, taskboardExecutionId: executionId },
    },
  });

  beforeAll(async () => {
    pool = new Pool({
      connectionString: connectionString!,
      connectionTimeoutMillis: 5_000,
      max: 8,
    });
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

  it('allows editor-scoped rollback and retries both task create paths after a tombstone', async () => {
    const board = await store.createBoard(alice, {
      name: `附件回滚 ${randomUUID()}`,
      visibility: 'organization',
      repository,
    });
    await store.upsertMember(alice, board.id, { userId: bob.ownerUserId, role: 'editor' });

    const clientRequestId = `rollback-task-${randomUUID()}`;
    const created = await store.createTask(bob, board.id, {
      title: '普通创建回滚',
      status: 'todo',
      clientRequestId,
    });
    await expect(store.deleteTask(bob, created.id, { expectedVersion: created.version }))
      .rejects.toBeInstanceOf(TaskboardPermissionError);
    const rolledBack = await store.rollbackTaskCreation(bob, created.id, {
      expectedVersion: created.version,
    });
    expect(rolledBack.deletedAt).toBeDefined();
    const retried = await store.createTask(bob, board.id, {
      title: '普通创建重试',
      status: 'todo',
      clientRequestId,
    });
    expect(retried.id).not.toBe(created.id);

    const source = await store.createTask(alice, board.id, { title: '执行源任务', status: 'todo' });
    const executionId = randomUUID();
    const runId = randomUUID();
    const sessionId = randomUUID();
    await store.claimExecution(bob, source.id, {
      expectedVersion: source.version,
      executionId,
      runId,
      sessionId,
      executionOwnerUserId: alice.ownerUserId,
      dispatch: dispatch(executionId, runId, sessionId),
    });
    const executionInput = {
      title: '执行创建回滚',
      clientRequestId: `rollback-execution-${randomUUID()}`,
    };
    const executionCreated = await store.createTaskFromExecution(bob, runId, executionInput);
    await store.rollbackTaskCreation(bob, executionCreated.id, {
      expectedVersion: executionCreated.version,
    });
    const executionRetried = await store.createTaskFromExecution(bob, runId, executionInput);
    expect(executionRetried.id).not.toBe(executionCreated.id);
  });
});
