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
      `INSERT INTO ${store.integrationLanesTable}(repository_id,board_id,active_integration_task_id)
       VALUES($1,$2,$3)`,
      [repositoryId, board.id, integration.id],
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

  async function seedV2Integration(label: string): Promise<string> {
    await pool.query(`ALTER TABLE ${store.tasksTable} ALTER COLUMN workflow_version SET DEFAULT 2`);
    try {
      return await seedHistoricalIntegration(label, 'valid');
    } finally {
      await pool.query(`ALTER TABLE ${store.tasksTable} ALTER COLUMN workflow_version SET DEFAULT 3`);
    }
  }

  async function seedExecution(taskId: string, suffix: string): Promise<string> {
    const executionId = `execution-${suffix}`;
    const runId = `run-${suffix}`;
    const sessionId = `session-${suffix}`;
    await pool.query(
      `INSERT INTO ${store.executionsTable}
         (id,task_id,run_id,session_id,status,purpose,trigger,protocol_version,requested_by)
       VALUES($1,$2,$3,$4,'running','work','initial',2,$5)`,
      [executionId, taskId, runId, sessionId, identity.ownerUserId],
    );
    await pool.query(
      `INSERT INTO ${store.executionOutboxTable}(run_id,execution_id,payload)
       VALUES($1,$2,$3::jsonb)`,
      [runId, executionId, JSON.stringify({
        version: 1,
        session: {
          sessionId, userId: identity.ownerUserId, username: identity.username,
          tenantId: identity.tenantId, channel: 'web', cwd: '/tmp/taskboard-v2-guard',
          transcriptPath: `/tmp/${sessionId}.jsonl`, status: 'running',
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        },
        run: {
          runId, sessionId, userId: identity.ownerUserId, tenantId: identity.tenantId,
          channel: 'web', idempotencyKey: `taskboard-execution:${executionId}`,
          metadata: { taskboardExecution: true, taskboardExecutionId: executionId },
        },
      })],
    );
    return runId;
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

  it('absorbs v2 execution outbox before dispatch and releases the scanner migration', async () => {
    const taskId = await seedV2Integration('guarded-execution-outbox');
    const runId = await seedExecution(taskId, 'guarded-v2-outbox');
    const before = await store.getTask(identity, taskId);

    await expect(store.claimExecutionDispatch(runId, 'must-not-lease')).resolves.toBeNull();

    const state = await pool.query(
      `SELECT e.status AS execution_status,e.error,o.status AS outbox_status,
              o.lease_id,o.lease_expires_at,o.last_error
         FROM ${store.executionsTable} e
         JOIN ${store.executionOutboxTable} o ON o.run_id=e.run_id
        WHERE e.run_id=$1`, [runId],
    );
    expect(state.rows[0]).toMatchObject({
      execution_status: 'failed', outbox_status: 'dispatched', lease_id: null, lease_expires_at: null,
      error: expect.stringContaining('migration'), last_error: expect.stringContaining('migration'),
    });
    expect(await store.getTask(identity, taskId)).toMatchObject({
      status: before.status, version: before.version, commentCount: before.commentCount,
    });

    await store.claimIntegrationDispatchCandidatesV2(10);
    expect(await store.getTask(identity, taskId)).toMatchObject({ workflowVersion: 3 });
  });

  it('reconcile atomically absorbs stale dispatched v2 execution and still returns v3 candidates', async () => {
    const taskId = await seedV2Integration('guarded-execution-reconcile');
    const runId = await seedExecution(taskId, 'guarded-execution-reconcile');
    const v3TaskId = await seedHistoricalIntegration('guarded-execution-reconcile-v3', 'valid');
    const v3RunId = await seedExecution(v3TaskId, 'guarded-execution-reconcile-v3');
    const before = await store.getTask(identity, taskId);
    await pool.query(
      `UPDATE ${store.executionOutboxTable}
          SET status='dispatched',lease_id='stale-dispatch',lease_expires_at=now()-interval '1 minute'
        WHERE run_id=ANY($1::text[])`, [[runId, v3RunId]],
    );
    await pool.query(
      `UPDATE ${store.executionsTable} SET updated_at=now()-interval '2 minutes'
        WHERE run_id=ANY($1::text[])`, [[runId, v3RunId]],
    );

    const first = await store.claimExecutionReconcileCandidates(new Date(), 10, 'execution-reconcile');
    const replay = await store.claimExecutionReconcileCandidates(new Date(), 10, 'execution-reconcile-replay');
    expect(first.map((candidate) => candidate.runId)).toContain(v3RunId);
    expect(first.map((candidate) => candidate.runId)).not.toContain(runId);
    expect(replay.map((candidate) => candidate.runId)).not.toContain(runId);
    expect(await pool.query(
      `SELECT e.status,e.error,e.reconcile_lease_id,o.status AS outbox_status,
              o.lease_id,o.lease_expires_at,o.last_error
         FROM ${store.executionsTable} e JOIN ${store.executionOutboxTable} o ON o.run_id=e.run_id
        WHERE e.run_id=$1`, [runId],
    )).toMatchObject({ rows: [expect.objectContaining({
      status: 'failed', reconcile_lease_id: null, outbox_status: 'dispatched',
      lease_id: null, lease_expires_at: null,
      error: expect.stringContaining('migration'), last_error: expect.stringContaining('migration'),
    })] });
    expect(await store.getTask(identity, taskId)).toMatchObject({
      status: before.status, version: before.version, commentCount: before.commentCount,
    });
    await store.claimIntegrationDispatchCandidatesV2(10);
    expect(await store.getTask(identity, taskId)).toMatchObject({ workflowVersion: 3 });
  });

  it('reconcile atomically absorbs stale dispatched v2 continuation by task execution run', async () => {
    const taskId = await seedV2Integration('guarded-continuation-reconcile');
    const executionRunId = await seedExecution(taskId, 'guarded-continuation-reconcile-execution');
    const continuationRunId = 'run-guarded-continuation-reconcile-runtime';
    const comment = await store.createComment(identity, taskId, { body: 'legacy reconcile source' });
    const v3TaskId = await seedHistoricalIntegration('guarded-continuation-reconcile-v3', 'valid');
    const v3ExecutionRunId = await seedExecution(v3TaskId, 'guarded-continuation-reconcile-v3-execution');
    const v3ContinuationRunId = 'run-guarded-continuation-reconcile-v3-runtime';
    const v3Comment = await store.createComment(identity, v3TaskId, { body: 'v3 reconcile source' });
    await pool.query(
      `UPDATE ${store.commentsTable} SET continuation_run_id=$2,continuation_eligible=true WHERE id=$1`,
      [comment.id, continuationRunId],
    );
    await pool.query(
      `INSERT INTO ${store.continuationOutboxTable}
         (run_id,task_id,comment_id,session_id,payload,status,dispatched_at,updated_at,
          lease_id,lease_expires_at,reconcile_lease_id,reconcile_lease_expires_at)
       VALUES($1,$2,$3,$4,'{}'::jsonb,'dispatched',now()-interval '2 minutes',now()-interval '2 minutes',
              'stale-dispatch',now()-interval '1 minute','stale-reconcile',now()-interval '1 minute')`,
      [continuationRunId, taskId, comment.id, 'session-guarded-continuation-reconcile-execution'],
    );
    await pool.query(
      `UPDATE ${store.commentsTable} SET continuation_run_id=$2,continuation_eligible=true WHERE id=$1`,
      [v3Comment.id, v3ContinuationRunId],
    );
    await pool.query(
      `INSERT INTO ${store.continuationOutboxTable}
         (run_id,task_id,comment_id,session_id,payload,status,dispatched_at,updated_at)
       VALUES($1,$2,$3,$4,'{}'::jsonb,'dispatched',now()-interval '2 minutes',now()-interval '2 minutes')`,
      [v3ContinuationRunId, v3TaskId, v3Comment.id, 'session-guarded-continuation-reconcile-v3-execution'],
    );
    const before = await store.getTask(identity, taskId);
    const commentsBefore = await store.listComments(identity, taskId);
    const changesBefore = await pool.query(
      `SELECT count(*)::int AS count FROM ${store.changesTable} WHERE task_id=$1`, [taskId],
    );

    expect(continuationRunId).not.toBe(executionRunId);
    const first = await store.claimContinuationReconcileCandidates(new Date(), 10, 'continuation-reconcile');
    const replay = await store.claimContinuationReconcileCandidates(new Date(), 10, 'continuation-replay');
    expect(first.map((candidate) => candidate.runId)).toContain(v3ContinuationRunId);
    expect(first.map((candidate) => candidate.runId)).not.toContain(continuationRunId);
    expect(replay.map((candidate) => candidate.runId)).not.toContain(continuationRunId);
    expect(await pool.query(
      `SELECT status,lease_id,lease_expires_at,reconcile_lease_id,reconcile_lease_expires_at,last_error
         FROM ${store.continuationOutboxTable} WHERE run_id=$1`, [continuationRunId],
    )).toMatchObject({ rows: [expect.objectContaining({
      status: 'completed', lease_id: null, lease_expires_at: null,
      reconcile_lease_id: null, reconcile_lease_expires_at: null,
      last_error: expect.stringContaining('migration'),
    })] });
    expect(await pool.query(
      `SELECT status,error,reconcile_lease_id FROM ${store.executionsTable} WHERE run_id=$1`, [executionRunId],
    )).toMatchObject({ rows: [expect.objectContaining({
      status: 'failed', reconcile_lease_id: null, error: expect.stringContaining('migration'),
    })] });
    expect(await store.getTask(identity, taskId)).toMatchObject({
      status: before.status, version: before.version, commentCount: before.commentCount,
    });
    expect(await store.listComments(identity, taskId)).toEqual(commentsBefore);
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM ${store.changesTable} WHERE task_id=$1`, [taskId],
    )).rows[0]).toEqual(changesBefore.rows[0]);
    expect(await pool.query(
      `SELECT status FROM ${store.executionsTable} WHERE run_id=$1`, [v3ExecutionRunId],
    )).toMatchObject({ rows: [{ status: 'running' }] });
    expect(await store.getTask(identity, v3TaskId)).toMatchObject({ workflowVersion: 3 });
    await store.claimIntegrationDispatchCandidatesV2(10);
    expect(await store.getTask(identity, taskId)).toMatchObject({ workflowVersion: 3 });
  });

  it('run_started absorption is side-effect free and idempotent for a dispatched v2 continuation', async () => {
    const taskId = await seedV2Integration('guarded-continuation-started');
    const executionRunId = await seedExecution(taskId, 'guarded-continuation-started-execution');
    const continuationRunId = 'run-guarded-continuation-started-runtime';
    const comment = await store.createComment(identity, taskId, { body: 'legacy run_started source' });
    await pool.query(
      `UPDATE ${store.commentsTable} SET continuation_run_id=$2,continuation_eligible=true WHERE id=$1`,
      [comment.id, continuationRunId],
    );
    await pool.query(
      `INSERT INTO ${store.continuationOutboxTable}(run_id,task_id,comment_id,session_id,payload,status,dispatched_at)
       VALUES($1,$2,$3,$4,'{}'::jsonb,'dispatched',now())`,
      [continuationRunId, taskId, comment.id, 'session-guarded-continuation-started-execution'],
    );
    const before = await store.getTask(identity, taskId);
    const commentsBefore = await store.listComments(identity, taskId);
    const changesBefore = await pool.query(
      `SELECT count(*)::int AS count FROM ${store.changesTable} WHERE task_id=$1`, [taskId],
    );

    await expect(store.markContinuationRunning(taskId, continuationRunId)).resolves.toMatchObject({ id: taskId });
    await expect(store.markContinuationRunning(taskId, continuationRunId)).resolves.toMatchObject({ id: taskId });
    expect(await pool.query(
      `SELECT status,error,finished_at FROM ${store.executionsTable} WHERE run_id=$1`, [executionRunId],
    )).toMatchObject({ rows: [expect.objectContaining({ status: 'failed', error: expect.stringContaining('migration') })] });
    expect(await pool.query(
      `SELECT status,last_error FROM ${store.continuationOutboxTable} WHERE run_id=$1`, [continuationRunId],
    )).toMatchObject({ rows: [{ status: 'completed', last_error: expect.stringContaining('migration') }] });
    expect(await store.getTask(identity, taskId)).toMatchObject({
      status: before.status, version: before.version, commentCount: before.commentCount,
    });
    expect(await store.listComments(identity, taskId)).toEqual(commentsBefore);
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM ${store.changesTable} WHERE task_id=$1`, [taskId],
    )).rows[0]).toEqual(changesBefore.rows[0]);
  });

  it.each(['succeeded', 'failed'] as const)(
    'absorbs a v2 %s run completion without task delivery side effects',
    async (completionStatus) => {
      const taskId = await seedV2Integration(`guarded-completion-${completionStatus}`);
      const runId = await seedExecution(taskId, `guarded-completion-${completionStatus}`);
      const before = await store.getTask(identity, taskId);
      const changesBefore = await pool.query(
        `SELECT count(*)::int AS count FROM ${store.changesTable} WHERE task_id=$1`, [taskId],
      );

      const first = await store.completeExecution(runId, {
        status: completionStatus,
        ...(completionStatus === 'failed' ? { error: 'runtime failed' } : {}),
        commentBody: 'must not be delivered',
        attachments: [{
          attachmentId: randomUUID(), originalName: 'must-not-exist.txt',
          relativePath: 'assets/must-not-exist.txt', size: 1, mimeType: 'text/plain', isImage: false,
        }],
      });
      const duplicate = await store.completeExecution(runId, {
        status: 'succeeded', commentBody: 'duplicate must also be absorbed',
      });

      expect(first?.execution).toMatchObject({ status: 'failed', error: expect.stringContaining('migration') });
      expect(duplicate?.execution).toMatchObject({ status: 'failed', error: expect.stringContaining('migration') });
      expect(await store.getTask(identity, taskId)).toMatchObject({
        status: before.status, version: before.version, commentCount: before.commentCount,
      });
      const changesAfter = await pool.query(
        `SELECT count(*)::int AS count FROM ${store.changesTable} WHERE task_id=$1`, [taskId],
      );
      expect(changesAfter.rows[0].count).toBe(changesBefore.rows[0].count);
      expect(await store.listComments(identity, taskId)).toHaveLength(0);

      await store.claimIntegrationDispatchCandidatesV2(10);
      expect(await store.getTask(identity, taskId)).toMatchObject({ workflowVersion: 3 });
    },
  );

  it('claim absorbs a v2 continuation whose Runtime run differs from the active execution run', async () => {
    const taskId = await seedV2Integration('guarded-continuation-claim');
    const executionRunId = await seedExecution(taskId, 'guarded-continuation-claim-execution');
    const continuationRunId = 'run-guarded-continuation-claim-runtime';
    const comment = await store.createComment(identity, taskId, { body: 'legacy continuation source' });
    const before = await store.getTask(identity, taskId);
    await pool.query(
      `UPDATE ${store.commentsTable} SET continuation_run_id=$2,continuation_eligible=true WHERE id=$1`,
      [comment.id, continuationRunId],
    );
    await pool.query(
      `INSERT INTO ${store.continuationOutboxTable}(run_id,task_id,comment_id,session_id,payload)
       VALUES($1,$2,$3,$4,'{}'::jsonb)`,
      [continuationRunId, taskId, comment.id, 'session-guarded-continuation-claim-execution'],
    );

    const unrelatedTaskId = await seedHistoricalIntegration('guarded-continuation-unrelated-v3', 'valid');
    const unrelatedRunId = await seedExecution(unrelatedTaskId, 'guarded-continuation-unrelated-v3');

    expect(continuationRunId).not.toBe(executionRunId);
    await expect(store.claimContinuationDispatch(continuationRunId, 'must-not-lease')).resolves.toBeNull();
    await expect(store.claimContinuationDispatch(continuationRunId, 'idempotent-retry')).resolves.toBeNull();

    const executions = await pool.query(
      `SELECT run_id,status,error FROM ${store.executionsTable}
        WHERE run_id=$1 ORDER BY run_id`, [executionRunId],
    );
    const outbox = await pool.query(
      `SELECT status,lease_id,reconcile_lease_id,last_error
         FROM ${store.continuationOutboxTable} WHERE run_id=$1`, [continuationRunId],
    );
    expect(executions.rows).toEqual([expect.objectContaining({
      run_id: executionRunId, status: 'failed', error: expect.stringContaining('migration'),
    })]);
    expect(outbox.rows[0]).toMatchObject({
      status: 'completed', lease_id: null, reconcile_lease_id: null,
      last_error: expect.stringContaining('migration'),
    });
    expect(await pool.query(
      `SELECT status FROM ${store.executionsTable} WHERE run_id=$1`, [unrelatedRunId],
    )).toMatchObject({ rows: [{ status: 'running' }] });
    expect(await store.getTask(identity, unrelatedTaskId)).toMatchObject({ workflowVersion: 3 });
    expect(await store.getTask(identity, taskId)).toMatchObject({
      status: before.status, version: before.version, commentCount: before.commentCount,
    });

    await store.claimIntegrationDispatchCandidatesV2(10);
    expect(await store.getTask(identity, taskId)).toMatchObject({ workflowVersion: 3 });
  });

  it('completion absorbs a v2 continuation and terminates the task active execution, not only its Runtime run', async () => {
    const taskId = await seedV2Integration('guarded-continuation-completion');
    const executionRunId = await seedExecution(taskId, 'guarded-continuation-completion-execution');
    const continuationRunId = 'run-guarded-continuation-completion-runtime';
    const comment = await store.createComment(identity, taskId, { body: 'legacy completion source' });
    const before = await store.getTask(identity, taskId);
    await pool.query(
      `UPDATE ${store.commentsTable} SET continuation_run_id=$2,continuation_eligible=true WHERE id=$1`,
      [comment.id, continuationRunId],
    );
    await pool.query(
      `INSERT INTO ${store.continuationOutboxTable}(run_id,task_id,comment_id,session_id,payload)
       VALUES($1,$2,$3,$4,'{}'::jsonb)`,
      [continuationRunId, taskId, comment.id, 'session-guarded-continuation-completion-execution'],
    );

    expect(continuationRunId).not.toBe(executionRunId);
    await store.completeContinuation(taskId, continuationRunId, {
      status: 'succeeded', commentBody: 'must not advance task',
    });
    const firstExecutions = await pool.query(
      `SELECT run_id,status,error,finished_at FROM ${store.executionsTable}
        WHERE run_id=$1 ORDER BY run_id`, [executionRunId],
    );
    await store.completeContinuation(taskId, continuationRunId, {
      status: 'failed', error: 'duplicate', commentBody: 'must remain absorbed',
    });
    const replayExecutions = await pool.query(
      `SELECT run_id,status,error,finished_at FROM ${store.executionsTable}
        WHERE run_id=$1 ORDER BY run_id`, [executionRunId],
    );

    expect(firstExecutions.rows).toEqual([expect.objectContaining({
      run_id: executionRunId, status: 'failed', error: expect.stringContaining('migration'),
    })]);
    expect(replayExecutions.rows).toEqual(firstExecutions.rows);
    expect(await pool.query(
      `SELECT status,last_error FROM ${store.continuationOutboxTable} WHERE run_id=$1`, [continuationRunId],
    )).toMatchObject({ rows: [{ status: 'completed', last_error: expect.stringContaining('migration') }] });
    expect(await store.getTask(identity, taskId)).toMatchObject({
      status: before.status, version: before.version, commentCount: before.commentCount,
    });

    await store.claimIntegrationDispatchCandidatesV2(10);
    expect(await store.getTask(identity, taskId)).toMatchObject({ workflowVersion: 3 });
  });
});
