import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgTaskboardStore } from '../taskboard/store.js';
import type { RepositoryProvider } from '../taskboard/repositoryProvider.js';
import type { TaskboardExecutionClaimInput, TaskboardIdentity } from '../taskboard/types.js';

const { Pool } = pg;
const execFileAsync = promisify(execFile);
const connectionString = process.env.TEST_DATABASE_URL?.trim();
const describePg = connectionString ? describe : describe.skip;

const identity: TaskboardIdentity = { tenantId: 'tenant-workflow', ownerUserId: 'workflow-owner', username: 'workflow-owner' };
function executionClaim(taskId: string, version: number, executionId: string, runId: string): TaskboardExecutionClaimInput {
  const now = new Date().toISOString();
  const sessionId = `session-${executionId}`;
  return {
    expectedVersion: version, executionId, runId, sessionId, purpose: 'work', protocolVersion: 2,
    executionOwnerUserId: identity.ownerUserId,
    dispatch: { version: 1,
      session: { sessionId, userId: identity.ownerUserId, username: identity.username,
        tenantId: identity.tenantId, channel: 'web', cwd: '/tmp/taskboard-workflow-pg',
        transcriptPath: `/tmp/${sessionId}.jsonl`, status: 'running', createdAt: now, updatedAt: now },
      run: { runId, sessionId, userId: identity.ownerUserId, tenantId: identity.tenantId, channel: 'web',
        idempotencyKey: `taskboard-execution:${executionId}`,
        metadata: { taskboardExecution: true, taskboardExecutionId: executionId, taskId } } },
  };
}

describePg('taskboard workflow incident playback (PostgreSQL)', () => {
  const prefix = `tbwf_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  let pool: InstanceType<typeof Pool>;
  let store: PgTaskboardStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, connectionTimeoutMillis: 5_000 });
    store = new PgTaskboardStore({ pool, tablePrefix: prefix });
    await store.init();
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

  it('TASK-84 advisory transitions back to todo and rejects replay', async () => {
    const board = await store.createBoard(identity, { name: 'Advisory board' });
    const advisory = await store.createTask(identity, board.id, {
      title: 'Only answer', kind: 'advisory', status: 'in_progress',
    });
    const executionId = randomUUID();
    const runId = `run-${executionId}`;
    await pool.query(
      `INSERT INTO ${store.executionsTable}
         (id,task_id,run_id,session_id,status,purpose,trigger,protocol_version,attempt_id,requested_by)
       VALUES($1,$2,$3,$4,'running','work','initial',2,$5,$6)`,
      [executionId, advisory.id, runId, `session-${executionId}`, `attempt-${executionId}`, identity.ownerUserId],
    );
    const input = { targetStatus: 'todo' as const, body: 'Protocol delivery' };
    await expect(store.finishExecutionV2(identity, runId, { ...input, body: ' ' }))
      .rejects.toMatchObject({ code: 'TASKBOARD_EXECUTION_COMMENT_REQUIRED' });
    const resolved = await store.finishExecutionV2(identity, runId, input);
    expect(resolved).toMatchObject({ kind: 'advisory', status: 'todo' });
    expect(resolved).not.toHaveProperty('providerPullRequestId');
    await expect(pool.query(
      `SELECT status,reason FROM ${store.cancellationOutboxTable} WHERE execution_id=$1`,
      [executionId],
    )).resolves.toMatchObject({ rows: [{ status: 'pending', reason: 'execution_transitioned' }] });
    await expect(store.finishExecutionV2(identity, runId, input)).rejects.toMatchObject({ code: 'TASKBOARD_EXECUTION_FENCED' });
    await store.completeExecution(runId, {
      status: 'succeeded',
      commentBody: '不应新增第二条评论',
      attachments: [{
        attachmentId: randomUUID(),
        originalName: '交付.txt',
        relativePath: 'assets/交付.txt', size: 7, mimeType: 'text/plain', isImage: false,
      }],
    });
    expect(await store.listComments(identity, advisory.id)).toEqual([
      expect.objectContaining({ body: input.body, attachments: [expect.objectContaining({ originalName: '交付.txt' })] }),
    ]);
    await expect(pool.query(
      `SELECT status FROM ${store.cancellationOutboxTable} WHERE execution_id=$1`,
      [executionId],
    )).resolves.toMatchObject({ rows: [{ status: 'completed' }] });
    await expect(store.finishExecutionV2(identity, runId, { ...input, }))
      .rejects.toMatchObject({ code: 'TASKBOARD_EXECUTION_FENCED' });
  });

  it('V2 Run 未 finish 时保持任务阶段且不写评论或创建续跑 Execution', async () => {
    const board = await store.createBoard(identity, { name: 'Unfinished stage board' });
    const advisory = await store.createTask(identity, board.id, {
      title: 'Continue until finished', kind: 'advisory', status: 'in_progress',
    });
    const executionId = randomUUID();
    const runId = `run-${executionId}`;
    await pool.query(
      `INSERT INTO ${store.executionsTable}
         (id,task_id,run_id,session_id,status,purpose,trigger,protocol_version,attempt_id,requested_by)
       VALUES($1,$2,$3,$4,'running','work','initial',2,$5,$6)`,
      [executionId, advisory.id, runId, `session-${executionId}`, `attempt-${executionId}`, identity.ownerUserId],
    );

    const completed = await store.completeExecution(runId, {
      status: 'succeeded',
      commentBody: '这条 Run 输出不应进入任务评论区',
    });

    expect(completed).toMatchObject({
      task: { status: 'in_progress' },
      execution: { status: 'succeeded' },
    });
    expect(await store.listComments(identity, advisory.id)).toHaveLength(0);
    expect(await store.listExecutions(identity, advisory.id)).toEqual([
      expect.objectContaining({ id: executionId, status: 'succeeded' }),
    ]);
  });

  it('claim replay is returned before terminal checks while new terminal claims remain forbidden', async () => {
    const board = await store.createBoard(identity, { name: 'Claim replay board' });
    const advisory = await store.createTask(identity, board.id, {
      title: 'Replayable advisory', kind: 'advisory', status: 'todo',
    });
    const executionId = randomUUID();
    const first = await store.claimExecution(identity, advisory.id,
      executionClaim(advisory.id, advisory.version, executionId, `run-${executionId}`));
    await pool.query(`UPDATE ${store.tasksTable} SET status='done',version=version+1 WHERE id=$1`, [advisory.id]);
    const replay = await store.claimExecution(identity, advisory.id,
      executionClaim(advisory.id, 999, executionId, `retry-run-${executionId}`));
    expect(replay.execution.id).toBe(first.execution.id);
    expect(replay.execution.runId).toBe(first.execution.runId);
    await expect(store.claimExecution(identity, advisory.id,
      executionClaim(advisory.id, 2, randomUUID(), `new-run-${randomUUID()}`)))
      .rejects.toMatchObject({ code: 'TASKBOARD_TERMINAL_EXECUTION_FORBIDDEN' });
  });

  it('provider-receipt-only merge fact blocks concurrent claim and absorbs continuation dispatch', async () => {
    const board = await store.createBoard(identity, { name: 'Online merge guard board' });
    const delivery = await store.createTask(identity, board.id, { title: 'Stale delivery projection', status: 'todo' });
    const integration = await store.createTask(identity, board.id, { title: 'Internal integration placeholder', status: 'todo' });
    await pool.query(`UPDATE ${store.tasksTable} SET kind='integration' WHERE id=$1`, [integration.id]);
    const sourceId = randomUUID();
    await pool.query(
      `INSERT INTO ${store.integrationSourcesTable}
         (id,integration_task_id,delivery_task_id,repository_id,provider_pull_request_id,
          reviewed_subject_digest,source_order,state,provider_receipt_id)
       VALUES($1,$2,$3,'repo-guard','501','digest-501',0,'pending','provider-receipt-501')`,
      [sourceId, integration.id, delivery.id],
    );
    const claims = await Promise.allSettled([1, 2].map((number) => store.claimExecution(
      identity, delivery.id, executionClaim(delivery.id, delivery.version, randomUUID(), `guard-run-${number}-${randomUUID()}`),
    )));
    expect(claims.every((claim) => claim.status === 'rejected'
      && (claim.reason as { code?: string }).code === 'TASKBOARD_TERMINAL_EXECUTION_FORBIDDEN')).toBe(true);
    expect(Number((await pool.query(`SELECT count(*)::int AS count FROM ${store.executionsTable} WHERE task_id=$1`, [delivery.id])).rows[0].count)).toBe(0);

    const comment = await store.createComment(identity, delivery.id, { body: 'continue after merge?' });
    const continuationRunId = `continuation-${randomUUID()}`;
    const payload = executionClaim(delivery.id, delivery.version, randomUUID(), continuationRunId).dispatch;
    await expect(store.enqueueContinuation(delivery.id, [comment.id], continuationRunId, comment.id, payload)).resolves.toBe(false);
    expect(Number((await pool.query(`SELECT count(*)::int AS count FROM ${store.continuationOutboxTable} WHERE run_id=$1`, [continuationRunId])).rows[0].count)).toBe(0);

    await pool.query(`UPDATE ${store.commentsTable} SET continuation_run_id=$2 WHERE id=$1`, [comment.id, continuationRunId]);
    await pool.query(
      `INSERT INTO ${store.continuationOutboxTable}(run_id,task_id,comment_id,session_id,payload,status)
       VALUES($1,$2,$3,$4,$5::jsonb,'dispatched')`,
      [continuationRunId, delivery.id, comment.id, payload.session.sessionId, JSON.stringify(payload)],
    );
    await store.markContinuationRunning(delivery.id, continuationRunId);
    expect((await pool.query(`SELECT status FROM ${store.continuationOutboxTable} WHERE run_id=$1`, [continuationRunId])).rows[0].status).toBe('completed');
  });

  it('blocked projection cannot be moved and only structured resume advances epoch', async () => {
    const board = await store.createBoard(identity, { name: 'Resume guard board' });
    const task = await store.createTask(identity, board.id, {
      title: 'Blocked task', kind: 'advisory', status: 'todo',
    });
    await pool.query(
      `UPDATE ${store.tasksTable} SET status='blocked',version=version+1 WHERE id=$1`,
      [task.id],
    );
    const blocked = await store.getTask(identity, task.id);
    await expect(store.moveTask(identity, task.id, {
      expectedVersion: blocked.version, status: 'backlog',
    })).rejects.toMatchObject({ code: 'TASKBOARD_PROTECTED_TRANSITION' });
    const before = await pool.query(`SELECT workflow_epoch FROM ${store.tasksTable} WHERE id=$1`, [task.id]);
    const resumed = await store.resumeBlockedTask(identity, task.id, {
      expectedVersion: blocked.version, decision: 'Dependency verified and released',
    });
    const after = await pool.query(`SELECT workflow_epoch FROM ${store.tasksTable} WHERE id=$1`, [task.id]);
    expect(resumed).toMatchObject({
      status: 'todo',
      resumeContext: {
        decision: 'Dependency verified and released', purpose: 'work', sourceIds: [],
        requestedBy: identity.ownerUserId,
      },
    });
    expect(resumed.resumeContext?.consumedAt).toBeUndefined();
    expect(BigInt(after.rows[0].workflow_epoch)).toBe(BigInt(before.rows[0].workflow_epoch) + 1n);

    const executionId = randomUUID();
    const runId = `resume-run-${executionId}`;
    const claim = executionClaim(task.id, resumed.version, executionId, runId);
    claim.trigger = 'resume';
    const claimed = await store.claimExecution(identity, task.id, claim);
    expect(claimed.task.resumeContext).toMatchObject({
      decision: 'Dependency verified and released', consumedExecutionId: executionId,
      consumedAt: expect.any(String),
    });
    const context = await store.getExecutionContextV2(identity, task.id, { runId });
    expect(context.task.resumeContext).toEqual(claimed.task.resumeContext);
    expect(context.board).not.toHaveProperty('prompt');
    expect(context.board).not.toHaveProperty('stagePrompts');
    expect((await store.getBoard(identity, board.id)).prompt).toEqual(expect.any(String));
  });

  it('canceled source remains navigable history but delivery is eligible again in get/list/search', async () => {
    const board = await store.createBoard(identity, { name: 'Canceled candidate board' });
    const delivery = await store.createTask(identity, board.id, { title: 'Retry delivery', status: 'todo' });
    const integration = await store.createTask(identity, board.id, { title: 'Canceled integration', status: 'todo' });
    await pool.query(`UPDATE ${store.tasksTable} SET kind='integration',status='canceled' WHERE id=$1`, [integration.id]);
    await pool.query(
      `UPDATE ${store.tasksTable}
          SET status='ready_to_merge',provider_pull_request_id='701',head_oid='head-701',base_oid='base-701'
        WHERE id=$1`,
      [delivery.id],
    );
    await pool.query(
      `INSERT INTO ${store.integrationSourcesTable}
         (id,integration_task_id,delivery_task_id,repository_id,provider_pull_request_id,reviewed_subject_digest,source_order,state)
       VALUES($1,$2,$3,'repo-canceled','701','digest-701',0,'canceled')`,
      [randomUUID(), integration.id, delivery.id],
    );
    const [getResult, listResult, searchResult] = await Promise.all([
      store.getTask(identity, delivery.id),
      store.listTasks(identity, board.id),
      store.searchTasks(identity, { search: 'Retry delivery' }),
    ]);
    expect(getResult).toMatchObject({ mergeEligibility: 'eligible', integrationState: 'canceled', integrationTaskId: integration.id });
    expect(listResult.find((task) => task.id === delivery.id)).toMatchObject({ mergeEligibility: 'eligible' });
    expect(searchResult.items.find((task) => task.id === delivery.id)).toMatchObject({ mergeEligibility: 'eligible' });
  });

  it('TASK-69 merge fact fences a late review transition', async () => {
    const board = await store.createBoard(identity, { name: 'TASK-69 playback' });
    const delivery = await store.createTask(identity, board.id, { title: 'Merged delivery', status: 'todo' });
    const executionId = randomUUID();
    const runId = `run-${executionId}`;
    await pool.query(
      `UPDATE ${store.tasksTable} SET status='in_review',provider_pull_request_id='24',version=version+1 WHERE id=$1`,
      [delivery.id],
    );
    await pool.query(
      `INSERT INTO ${store.executionsTable}
         (id,task_id,run_id,session_id,status,purpose,trigger,protocol_version,attempt_id,requested_by)
       VALUES($1,$2,$3,$4,'running','review','initial',2,$5,$6)`,
      [executionId, delivery.id, runId, `session-${executionId}`, `attempt-${executionId}`, identity.ownerUserId],
    );
    await pool.query(
      `UPDATE ${store.tasksTable} SET status='done',merged_commit_oid='merged-24',
              workflow_epoch=workflow_epoch+1,version=version+1 WHERE id=$1`,
      [delivery.id],
    );
    await pool.query(
      `UPDATE ${store.executionsTable} SET status='cancelled',superseded_at=now(),fence_epoch=fence_epoch+1 WHERE id=$1`,
      [executionId],
    );
    const late = { targetStatus: 'in_review' as const, body: 'Late review' };
    await expect(store.finishExecutionV2(identity, runId, late)).rejects.toMatchObject({ code: 'TASKBOARD_EXECUTION_FENCED' });
  });

  it('repair script defaults to dry-run, apply is idempotent, and emits before/after audit', async () => {
    const board = await store.createBoard(identity, {
      name: 'Repair board',
      repository: {
        provider: 'github', repositoryId: 'github:acme/repair', owner: 'acme', name: 'repair',
        baseBranch: 'main', allowForkPullRequest: false,
      },
      integrationPolicy: {
        schemaVersion: 1, enabled: true, revision: 'normalized-by-server',
        trigger: { mode: 'manual', allowedRoles: ['owner'] },
        batch: { maxTasks: 5, selection: 'priority_then_ready_at' },
        execution: {
          mergeMethod: 'merge', continueIndependentSources: true, autoResolveConflicts: true,
          maxAutomaticRemediationRounds: 1, maxTransientRetries: 1, requireGreenChecks: true,
          deleteRemoteBranch: false, deploy: false,
        },
      },
    });
    store.setRepositoryProvider({
      getPullRequest: async () => ({
        providerPullRequestId: '88', number: 88, state: 'open', draft: false,
        headRef: 'feature/88', headOid: 'head-88', baseRef: 'main', baseOid: 'base-88', mergeable: true,
        requiredChecks: [{ name: 'ci', status: 'success' }], requiredChecksKnown: true, subjectDigest: 'digest-88',
      }),
      mergePullRequest: async () => { throw new Error('not used'); },
    });
    const delivery = await store.createTask(identity, board.id, { title: 'repair target', status: 'todo' });
    await pool.query(
      `UPDATE ${store.tasksTable} SET status='ready_to_merge',provider_pull_request_id='88',
              head_oid='head-88',base_oid='base-88',version=version+1 WHERE id=$1`,
      [delivery.id],
    );
    const integration = await store.createIntegrationBatch(identity, board.id, {
      deliveryTaskIds: [delivery.id], expectedBoardVersion: (await store.getBoard(identity, board.id)).version,
    });
    const source = (await store.listIntegrationSources(identity, integration.id))[0]!;
    await pool.query(
      `UPDATE ${store.integrationSourcesTable}
          SET state='pending',merged_commit_oid=NULL,provider_receipt_id='repair-receipt' WHERE id=$1`,
      [source.id],
    );
    const remediation = await store.createTask(identity, board.id, { title: 'repair remediation scope', status: 'todo' });
    await pool.query(`UPDATE ${store.tasksTable} SET kind='remediation' WHERE id=$1`, [remediation.id]);
    await pool.query(
      `INSERT INTO ${store.remediationAttemptsTable}(id,integration_source_id,round,remediation_task_id,state)
       VALUES($1,$2,1,$3,'active')`,
      [randomUUID(), source.id, remediation.id],
    );
    const activeExecutionId = randomUUID();
    await pool.query(
      `INSERT INTO ${store.executionsTable}
         (id,task_id,run_id,session_id,status,purpose,trigger,protocol_version,attempt_id,requested_by)
       VALUES($1,$2,$3,$4,'running','work','initial',2,$5,$6)`,
      [activeExecutionId, delivery.id, `run-${activeExecutionId}`, `session-${activeExecutionId}`,
        `attempt-${activeExecutionId}`, identity.ownerUserId],
    );

    const outputBase = join(tmpdir(), `${prefix}-${randomUUID()}`);
    const run = async (mode: 'dry' | 'apply', suffix: string) => {
      await execFileAsync('pnpm', [
        'exec', 'tsx', 'scripts/repairTaskboardWorkflow.ts',
        ...(mode === 'apply' ? ['--apply'] : ['--dry-run']),
        `--table-prefix=${prefix}`,
        `--task-id=${delivery.id}`,
        `--output=${outputBase}-${suffix}`,
      ], {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: connectionString! },
        timeout: 30_000,
      });
      return JSON.parse(await readFile(`${outputBase}-${suffix}.json`, 'utf8')) as {
        mode: string; findings: number; applied: number;
        before: Record<string, number>; after: Record<string, number>;
      };
    };

    try {
      const dry = await run('dry', 'dry');
      expect(dry).toMatchObject({ mode: 'dry-run', applied: 0 });
      expect((await store.getTask(identity, delivery.id)).status).toBe('ready_to_merge');
      const first = await run('apply', 'apply-1');
      expect(first.applied).toBeGreaterThan(0);
      expect(first.after.mergedProjectionMismatch).toBe(0);
      expect(first.after.mergedActiveExecution).toBe(0);
      expect((await store.getTask(identity, delivery.id))).toMatchObject({ status: 'done' });
      expect((await store.getTask(identity, remediation.id))).toMatchObject({ status: 'done', completedAt: expect.any(String) });
      const repairedAttempt = await pool.query(
        `SELECT state,resolved_at FROM ${store.remediationAttemptsTable} WHERE remediation_task_id=$1`,
        [remediation.id],
      );
      expect(repairedAttempt.rows[0]).toMatchObject({ state: 'resolved', resolved_at: expect.anything() });
      const fenced = await pool.query(`SELECT status,superseded_at FROM ${store.executionsTable} WHERE id=$1`, [activeExecutionId]);
      expect(fenced.rows[0]).toMatchObject({ status: 'cancelled' });
      expect(fenced.rows[0].superseded_at).toBeTruthy();
      const cancellations = await pool.query(`SELECT count(*)::int AS count FROM ${store.cancellationOutboxTable} WHERE execution_id=$1`, [activeExecutionId]);
      expect(cancellations.rows[0].count).toBe(1);
      const second = await run('apply', 'apply-2');
      expect(second.applied).toBe(0);

      const unapprovedRemediation = await store.createTask(identity, board.id, {
        title: 'unapproved remediation', status: 'todo',
      });
      await pool.query(
        `UPDATE ${store.tasksTable} SET kind='remediation',status='ready_to_merge' WHERE id=$1`,
        [unapprovedRemediation.id],
      );
      await execFileAsync('pnpm', [
        'exec', 'tsx', 'scripts/repairTaskboardWorkflow.ts', '--apply', `--table-prefix=${prefix}`,
        `--task-id=${unapprovedRemediation.id}`, `--output=${outputBase}-unapproved`,
      ], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: connectionString! }, timeout: 30_000 });
      expect((await store.getTask(identity, unapprovedRemediation.id)).status).toBe('ready_to_merge');

      const duplicateDelivery = await store.createTask(identity, board.id, { title: 'duplicate PR target', status: 'todo' });
      const duplicateIntegration = await store.createTask(identity, board.id, { title: 'duplicate integration', status: 'todo' });
      await pool.query(`UPDATE ${store.tasksTable} SET kind='integration' WHERE id=$1`, [duplicateIntegration.id]);
      await pool.query(
        `UPDATE ${store.integrationSourcesTable}
            SET state='pending',provider_receipt_id=NULL,merged_commit_oid=NULL WHERE id=$1`,
        [source.id],
      );
      await pool.query(
        `INSERT INTO ${store.integrationSourcesTable}
           (id,integration_task_id,delivery_task_id,repository_id,provider_pull_request_id,reviewed_subject_digest,source_order,state)
         VALUES($1,$2,$3,$4,'88','duplicate-digest',0,'pending')`,
        [randomUUID(), duplicateIntegration.id, duplicateDelivery.id, source.repositoryId],
      );
      await expect(store.init()).resolves.toBeUndefined();
      const index = await pool.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [`${store.integrationSourcesTable}_repository_pr_idx`]);
      expect(index.rows[0].present).toBe(true);
    } finally {
      for (const suffix of ['dry', 'apply-1', 'apply-2', 'unapproved']) {
        await rm(`${outputBase}-${suffix}.json`, { force: true });
        await rm(`${outputBase}-${suffix}.md`, { force: true });
      }
    }
  }, 60_000);
});
