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
import { seedSuccessfulReviewCi } from './taskboardCiPgTestHelpers.js';

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

  it('TASK-84 advisory completes back in todo and Resolution replay is idempotent', async () => {
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
    const context = await store.getExecutionContextV2(identity, advisory.id, { runId });
    const input = {
      resolutionId: randomUUID(),
      outcome: 'completed', summary: 'Answer delivered', evidence: ['answer'], receipt: context.receipt,
    };
    const resolved = await store.resolveExecutionV2(identity, runId, input);
    expect(resolved).toMatchObject({ kind: 'advisory', status: 'todo' });
    expect(resolved).not.toHaveProperty('providerPullRequestId');
    await expect(store.resolveExecutionV2(identity, runId, input)).resolves.toMatchObject({ status: 'todo' });
    const resolutions = await pool.query(
      `SELECT count(*)::int AS count FROM ${store.resolutionsTable} WHERE execution_id=$1`,
      [executionId],
    );
    expect(resolutions.rows[0].count).toBe(1);
    expect(await store.listComments(identity, advisory.id)).toEqual([]);
    await expect(store.resolveExecutionV2(identity, runId, { ...input, resolutionId: randomUUID() }))
      .rejects.toMatchObject({ code: 'TASKBOARD_RESOLUTION_CONFLICT' });
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
  });

  it('canceled source remains navigable history but delivery is eligible again in get/list/search', async () => {
    const board = await store.createBoard(identity, { name: 'Canceled candidate board' });
    const delivery = await store.createTask(identity, board.id, { title: 'Retry delivery', status: 'todo' });
    const integration = await store.createTask(identity, board.id, { title: 'Canceled integration', status: 'todo' });
    await pool.query(`UPDATE ${store.tasksTable} SET kind='integration',status='canceled' WHERE id=$1`, [integration.id]);
    await pool.query(
      `UPDATE ${store.tasksTable}
          SET status='ready_to_merge',provider_pull_request_id='701',head_oid='head-701',base_oid='base-701',
              reviewed_subject_digest='digest-701' WHERE id=$1`,
      [delivery.id],
    );
    await seedSuccessfulReviewCi(pool, store, delivery.id, 'head-701');
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

  it('remediation attempt and source pointer stay atomic across replay and cross-source conflict', async () => {
    const board = await store.createBoard(identity, { name: 'Remediation atomic board' });
    const [deliveryA, deliveryB, integration, remediation] = await Promise.all([
      store.createTask(identity, board.id, { title: 'Delivery A', status: 'todo' }),
      store.createTask(identity, board.id, { title: 'Delivery B', status: 'todo' }),
      store.createTask(identity, board.id, { title: 'Integration', status: 'todo' }),
      store.createTask(identity, board.id, { title: 'Remediation', status: 'todo' }),
    ]);
    await pool.query(`UPDATE ${store.tasksTable} SET kind='integration',status='in_progress' WHERE id=$1`, [integration.id]);
    await pool.query(`UPDATE ${store.tasksTable} SET kind='remediation' WHERE id=$1`, [remediation.id]);
    const [sourceA, sourceB] = [randomUUID(), randomUUID()];
    await pool.query(
      `INSERT INTO ${store.integrationSourcesTable}
         (id,integration_task_id,delivery_task_id,repository_id,provider_pull_request_id,reviewed_subject_digest,source_order,state,remediation_count)
       VALUES($1,$3,$4,'repo-remediation','601','digest-601',0,'resolving_conflict',1),
             ($2,$3,$5,'repo-remediation','602','digest-602',1,'resolving_conflict',1)`,
      [sourceA, sourceB, integration.id, deliveryA.id, deliveryB.id],
    );
    const executionId = randomUUID();
    const runId = `run-${executionId}`;
    await pool.query(
      `INSERT INTO ${store.executionsTable}
         (id,task_id,run_id,session_id,status,purpose,trigger,protocol_version,attempt_id,requested_by)
       VALUES($1,$2,$3,$4,'running','merge','initial',2,$5,$6)`,
      [executionId, integration.id, runId, `session-${executionId}`, `attempt-${executionId}`, identity.ownerUserId],
    );
    await expect(store.linkIntegrationRemediationV2(identity, runId, sourceA, remediation.id))
      .resolves.toMatchObject({ remediationTaskId: remediation.id, state: 'waiting_remediation' });
    await expect(store.linkIntegrationRemediationV2(identity, runId, sourceA, remediation.id))
      .resolves.toMatchObject({ remediationTaskId: remediation.id });
    await expect(store.linkIntegrationRemediationV2(identity, runId, sourceB, remediation.id))
      .rejects.toMatchObject({ code: 'TASKBOARD_REMEDIATION_LINK_CONFLICT' });
    const pointers = await pool.query(`SELECT id,remediation_task_id FROM ${store.integrationSourcesTable} WHERE id=ANY($1::text[]) ORDER BY id`, [[sourceA, sourceB]]);
    expect(pointers.rows.find((row) => row.id === sourceA)?.remediation_task_id).toBe(remediation.id);
    expect(pointers.rows.find((row) => row.id === sourceB)?.remediation_task_id).toBeNull();
    expect(Number((await pool.query(`SELECT count(*)::int AS count FROM ${store.remediationAttemptsTable} WHERE remediation_task_id=$1`, [remediation.id])).rows[0].count)).toBe(1);
  });

  it('TASK-69 merge fact wins over stale_subject and records one ignored late Resolution', async () => {
    const board = await store.createBoard(identity, { name: 'TASK-69 playback' });
    const delivery = await store.createTask(identity, board.id, { title: 'Merged delivery', status: 'todo' });
    const executionId = randomUUID();
    const runId = `run-${executionId}`;
    await pool.query(
      `UPDATE ${store.tasksTable} SET status='in_review',provider_pull_request_id='24',
              reviewed_subject_digest='digest-24',version=version+1 WHERE id=$1`,
      [delivery.id],
    );
    await pool.query(
      `INSERT INTO ${store.executionsTable}
         (id,task_id,run_id,session_id,status,purpose,trigger,protocol_version,attempt_id,requested_by)
       VALUES($1,$2,$3,$4,'running','review','initial',2,$5,$6)`,
      [executionId, delivery.id, runId, `session-${executionId}`, `attempt-${executionId}`, identity.ownerUserId],
    );
    const beforeMerge = await store.getExecutionContextV2(identity, delivery.id, { runId });
    await pool.query(
      `UPDATE ${store.tasksTable} SET status='done',merged_commit_oid='merged-24',
              workflow_epoch=workflow_epoch+1,version=version+1 WHERE id=$1`,
      [delivery.id],
    );
    await pool.query(
      `UPDATE ${store.executionsTable} SET status='cancelled',superseded_at=now(),fence_epoch=fence_epoch+1 WHERE id=$1`,
      [executionId],
    );
    const late = {
      resolutionId: randomUUID(), outcome: 'stale_subject', summary: 'Late review receipt',
      evidence: ['old subject'], receipt: beforeMerge.receipt,
    };
    await expect(store.resolveExecutionV2(identity, runId, late)).resolves.toMatchObject({
      status: 'done', mergedCommitOid: 'merged-24',
    });
    await expect(store.resolveExecutionV2(identity, runId, late)).resolves.toMatchObject({ status: 'done' });
    const resolution = await pool.query(
      `SELECT applied,ignored_reason FROM ${store.resolutionsTable} WHERE execution_id=$1`,
      [executionId],
    );
    expect(resolution.rows).toEqual([{ applied: false, ignored_reason: 'merged_terminal' }]);
  });

  it('merge confirmation atomically converges D-R-S-I and permits current merge run to finish', async () => {
    const provider: RepositoryProvider = {
      getPullRequest: async () => ({
        providerPullRequestId: '77', number: 77, state: 'open', draft: false,
        headRef: 'task/77', headOid: 'head-77', baseRef: 'main', baseOid: 'base-1',
        mergeable: true, requiredChecks: [{ name: 'test', status: 'success' }], requiredChecksKnown: true,
        subjectDigest: 'digest-77',
      }),
      mergePullRequest: async (_repository, input) => ({
        providerRequestId: input.requestId, providerPullRequestId: input.providerPullRequestId,
        merged: true, mergedCommitOid: 'merge-77', raw: { merged: true },
      }),
    };
    store.setRepositoryProvider(provider);
    const board = await store.createBoard(identity, {
      name: 'DRSI board',
      repository: {
        provider: 'github', repositoryId: 'github:acme/workflow', owner: 'acme', name: 'workflow',
        baseBranch: 'main', allowForkPullRequest: false,
      },
      integrationPolicy: {
        schemaVersion: 1, enabled: true, revision: 'normalized-by-server',
        trigger: { mode: 'manual', allowedRoles: ['maintainer', 'owner'] },
        batch: { maxTasks: 10, selection: 'priority_then_ready_at' },
        execution: {
          mergeMethod: 'squash', continueIndependentSources: true, autoResolveConflicts: true,
          maxAutomaticRemediationRounds: 2, maxTransientRetries: 2, requireGreenChecks: true,
          deleteRemoteBranch: false, deploy: false,
        },
      },
    });
    const delivery = await store.createTask(identity, board.id, { title: 'D', status: 'todo' });
    await pool.query(
      `UPDATE ${store.tasksTable} SET status='ready_to_merge',provider_pull_request_id='77',
              head_oid='head-77',base_oid='base-1',reviewed_subject_digest='digest-77',version=version+1 WHERE id=$1`,
      [delivery.id],
    );
    await seedSuccessfulReviewCi(pool, store, delivery.id, 'head-77');
    const integration = await store.createIntegrationBatch(identity, board.id, {
      deliveryTaskIds: [delivery.id], expectedBoardVersion: (await store.getBoard(identity, board.id)).version,
    });
    const source = (await store.listIntegrationSources(identity, integration.id))[0]!;
    const remediation = await store.createTask(identity, board.id, { title: 'temporary R', status: 'todo' });
    await pool.query(
      `UPDATE ${store.tasksTable} SET kind='remediation',status='in_review',version=version+1 WHERE id=$1`,
      [remediation.id],
    );
    await pool.query(
      `UPDATE ${store.integrationSourcesTable} SET remediation_task_id=$2,state='pending' WHERE id=$1`,
      [source.id, remediation.id],
    );
    await pool.query(
      `INSERT INTO ${store.remediationAttemptsTable}(id,integration_source_id,round,remediation_task_id,state)
       VALUES($1,$2,1,$3,'active')`,
      [randomUUID(), source.id, remediation.id],
    );
    const executionId = randomUUID();
    const runId = `run-${executionId}`;
    await pool.query(
      `INSERT INTO ${store.executionsTable}
         (id,task_id,run_id,session_id,status,purpose,trigger,protocol_version,attempt_id,requested_by)
       VALUES($1,$2,$3,$4,'running','merge','initial',2,$5,$6)`,
      [executionId, integration.id, runId, `session-${executionId}`, `attempt-${executionId}`, identity.ownerUserId],
    );
    const context = await store.getExecutionContextV2(identity, integration.id, { runId });
    await store.inspectIntegrationSourceV2(identity, runId, source.id);
    await store.mergeIntegrationSourceV2(identity, runId, source.id);

    const firstRemediation = await store.getTask(identity, remediation.id);
    expect(firstRemediation).toMatchObject({ status: 'done', completedAt: expect.any(String) });
    const remediationVersion = firstRemediation.version;
    const [deliveryAfter, remediationAfter, integrationAfter] = await Promise.all([
      store.getTask(identity, delivery.id), store.getTask(identity, remediation.id), store.getTask(identity, integration.id),
    ]);
    expect(deliveryAfter).toMatchObject({ status: 'done', mergedCommitOid: 'merge-77' });
    expect(remediationAfter).toMatchObject({ status: 'done', completedAt: firstRemediation.completedAt, version: remediationVersion });
    expect(integrationAfter.status).toBe('done');
    expect((await store.listIntegrationSources(identity, integration.id))[0]).toMatchObject({
      state: 'merged', mergedCommitOid: 'merge-77',
    });
    expect((await store.listExecutions(identity, integration.id))[0]).toMatchObject({ status: 'running' });

    await store.resolveExecutionV2(identity, runId, {
      resolutionId: randomUUID(), outcome: 'completed', summary: 'All sources merged',
      evidence: ['merge-77'], receipt: context.receipt,
    });
    await store.completeExecution(runId, { status: 'succeeded', commentBody: 'Integration completed' });
    expect((await store.listExecutions(identity, integration.id))[0]).toMatchObject({
      status: 'succeeded', resolutionOutcome: 'completed', ignoredReason: 'merged_terminal',
    });
    const attempt = await pool.query(
      `SELECT state FROM ${store.remediationAttemptsTable} WHERE remediation_task_id=$1`,
      [remediation.id],
    );
    expect(attempt.rows[0].state).toBe('resolved');
  });

  it('conflict recovery creates one work remediation, records a new commit, reviews, and resumes merge', async () => {
    let mergeable = false;
    let headOid = 'head-base';
    let subjectDigest = 'digest-base';
    const mergeCalls: string[] = [];
    const provider: RepositoryProvider = {
      getPullRequest: async () => ({
        providerPullRequestId: '801', number: 801, state: 'open', draft: false,
        headRef: 'feature/801', headOid, baseRef: 'main', baseOid: 'base-1', mergeable,
        requiredChecks: [{ name: 'ci', status: 'success' }], requiredChecksKnown: true, subjectDigest,
      }),
      mergePullRequest: async (_repository, input) => {
        mergeCalls.push(input.providerPullRequestId);
        return {
          providerRequestId: input.requestId, providerPullRequestId: input.providerPullRequestId,
          merged: true, mergedCommitOid: 'merge-801', raw: { merged: true },
        };
      },
    };
    store.setRepositoryProvider(provider);
    const board = await store.createBoard(identity, {
      name: 'Automatic remediation board',
      repository: {
        provider: 'github', repositoryId: 'github:acme/automatic-remediation', owner: 'acme',
        name: 'automatic-remediation', baseBranch: 'main', allowForkPullRequest: false,
      },
      integrationPolicy: {
        schemaVersion: 1, enabled: true, revision: 'automatic-remediation-policy',
        trigger: { mode: 'manual', allowedRoles: ['owner'] },
        batch: { maxTasks: 5, selection: 'priority_then_ready_at' },
        execution: {
          mergeMethod: 'merge', continueIndependentSources: true, autoResolveConflicts: true,
          maxAutomaticRemediationRounds: 2, maxTransientRetries: 1, requireGreenChecks: true,
          deleteRemoteBranch: false, deploy: false,
        },
      },
    });
    const delivery = await store.createTask(identity, board.id, {
      title: 'Conflict delivery', status: 'todo', branch: 'feature/801',
    });
    await pool.query(
      `UPDATE ${store.tasksTable}
          SET status='ready_to_merge',provider_pull_request_id='801',pull_request_number=801,
              head_oid='head-base',base_oid='base-1',reviewed_subject_digest='digest-base',version=version+1
        WHERE id=$1`,
      [delivery.id],
    );
    await seedSuccessfulReviewCi(pool, store, delivery.id, 'head-base');
    const integration = await store.createIntegrationBatch(identity, board.id, {
      deliveryTaskIds: [delivery.id], expectedBoardVersion: (await store.getBoard(identity, board.id)).version,
    });
    const source = (await store.listIntegrationSources(identity, integration.id))[0]!;
    const mergeExecutionId = randomUUID();
    const mergeRunId = `merge-run-${mergeExecutionId}`;
    const mergeClaim = executionClaim(integration.id, integration.version, mergeExecutionId, mergeRunId);
    mergeClaim.purpose = 'merge';
    const mergeStarted = await store.claimExecution(identity, integration.id, mergeClaim);
    await store.inspectIntegrationSourceV2(identity, mergeRunId, source.id);
    await expect(store.mergeIntegrationSourceV2(identity, mergeRunId, source.id))
      .rejects.toMatchObject({ code: 'TASKBOARD_SOURCE_NOT_MERGEABLE' });
    const mergeContext = await store.getExecutionContextV2(identity, integration.id, { runId: mergeRunId });
    expect((await store.listIntegrationSources(identity, integration.id))[0]).toMatchObject({
      state: 'resolving_conflict', remediationCount: 0,
    });
    await store.resolveExecutionV2(identity, mergeRunId, {
      outcome: 'progress', summary: 'Conflict routed to automatic remediation', receipt: mergeContext.receipt,
    });
    await store.completeExecution(mergeRunId, { status: 'succeeded', commentBody: 'Merge is waiting for remediation' });

    const recovery = (await store.claimIntegrationDispatchCandidatesV2(10))
      .find((candidate) => candidate.task.kind === 'remediation');
    expect(recovery).toBeTruthy();
    expect(recovery!.purpose).toBe('work');
    expect(recovery!.task).toMatchObject({
      status: 'todo', branch: 'feature/801', providerPullRequestId: '801',
    });
    expect((await store.listIntegrationSources(identity, integration.id))[0]).toMatchObject({
      state: 'waiting_remediation', remediationCount: 0, remediationTaskId: recovery!.task.id,
    });

    const remediationExecutionId = randomUUID();
    const remediationRunId = `remediation-run-${remediationExecutionId}`;
    const remediationClaim = executionClaim(
      recovery!.task.id, recovery!.task.version, remediationExecutionId, remediationRunId,
    );
    await store.claimExecution(identity, recovery!.task.id, remediationClaim);
    await expect(store.attachExecutionPullRequestV2(identity, remediationRunId, '999'))
      .rejects.toMatchObject({ code: 'TASKBOARD_REMEDIATION_PR_MISMATCH' });
    await store.inspectExecutionPullRequestV2(identity, remediationRunId);
    const noCommitContext = await store.getExecutionContextV2(identity, recovery!.task.id, {
      runId: remediationRunId,
    });
    await expect(store.resolveExecutionV2(identity, remediationRunId, {
      outcome: 'ready_for_review', summary: 'No new commit yet', receipt: noCommitContext.receipt,
    })).rejects.toMatchObject({ code: 'TASKBOARD_REMEDIATION_COMMIT_REQUIRED' });
    expect(await store.getTask(identity, recovery!.task.id)).toMatchObject({ status: 'in_progress' });
    expect((await store.listIntegrationSources(identity, integration.id))[0]).toMatchObject({
      state: 'waiting_remediation', remediationCount: 0, remediationTaskId: recovery!.task.id,
    });
    const activeAttempt = await pool.query(
      `SELECT state,round FROM ${store.remediationAttemptsTable} WHERE remediation_task_id=$1`,
      [recovery!.task.id],
    );
    expect(activeAttempt.rows[0]).toMatchObject({ state: 'active', round: 1 });
    headOid = 'head-fixed';
    subjectDigest = 'digest-fixed';
    mergeable = true;
    await pool.query(
      `UPDATE ${store.tasksTable} SET head_oid='head-fixed',version=version+1 WHERE id=$1`,
      [recovery!.task.id],
    );
    await store.inspectExecutionPullRequestV2(identity, remediationRunId);
    const remediationContext = await store.getExecutionContextV2(identity, recovery!.task.id, {
      runId: remediationRunId,
    });
    const remediationResolved = await store.resolveExecutionV2(identity, remediationRunId, {
      outcome: 'ready_for_review', summary: 'Conflict fixed and committed', evidence: ['head-fixed'],
      receipt: remediationContext.receipt,
    });
    expect(remediationResolved.status).toBe('in_review');
    expect((await store.listIntegrationSources(identity, integration.id))[0]).toMatchObject({
      state: 'waiting_remediation', remediationCount: 1,
    });
    await store.completeExecution(remediationRunId, {
      status: 'succeeded', commentBody: 'Remediation work delivered',
    });

    const reviewExecutionId = randomUUID();
    const reviewRunId = `review-run-${reviewExecutionId}`;
    const reviewClaim = executionClaim(
      recovery!.task.id, remediationResolved.version, reviewExecutionId, reviewRunId,
    );
    reviewClaim.purpose = 'review';
    await store.claimExecution(identity, recovery!.task.id, reviewClaim);
    await store.inspectExecutionPullRequestV2(identity, reviewRunId);
    await store.recordReviewedExecutionSubjectV2(identity, reviewRunId);
    const reviewContext = await store.getExecutionContextV2(identity, recovery!.task.id, { runId: reviewRunId });
    const approved = await store.resolveExecutionV2(identity, reviewRunId, {
      outcome: 'approved', summary: 'Reviewed the repaired PR subject', evidence: ['digest-fixed'],
      receipt: reviewContext.receipt,
    });
    expect(approved.status).toBe('done');
    await store.completeExecution(reviewRunId, { status: 'succeeded', commentBody: 'Remediation approved' });
    expect((await store.listIntegrationSources(identity, integration.id))[0]).toMatchObject({
      state: 'pending', remediationCount: 1,
    });

    const resumed = (await store.claimIntegrationDispatchCandidatesV2(10))
      .find((candidate) => candidate.task.kind === 'integration');
    expect(resumed).toBeTruthy();
    const resumedExecutionId = randomUUID();
    const resumedRunId = `resumed-merge-run-${resumedExecutionId}`;
    const resumedClaim = executionClaim(
      integration.id, resumed!.task.version, resumedExecutionId, resumedRunId,
    );
    resumedClaim.purpose = 'merge';
    await store.claimExecution(identity, integration.id, resumedClaim);
    await store.inspectIntegrationSourceV2(identity, resumedRunId, source.id);
    const merged = await store.mergeIntegrationSourceV2(identity, resumedRunId, source.id);
    expect(merged.source).toMatchObject({ state: 'merged', mergedCommitOid: 'merge-801' });
    expect(mergeCalls).toEqual(['801']);
    expect((await store.getTask(identity, integration.id)).status).toBe('done');
    expect((await store.getTask(identity, delivery.id))).toMatchObject({ status: 'done', mergedCommitOid: 'merge-801' });
    expect(mergeStarted.execution.purpose).toBe('merge');
  });

  it('failed required checks do not re-dispatch the integration merge while awaiting remediation', async () => {
    const board = await store.createBoard(identity, {
      name: 'Failed checks gate board',
      repository: {
        provider: 'github', repositoryId: 'github:acme/check-gate', owner: 'acme',
        name: 'check-gate', baseBranch: 'main', allowForkPullRequest: false,
      },
      integrationPolicy: {
        schemaVersion: 1, enabled: true, revision: 'check-gate-policy',
        trigger: { mode: 'manual', allowedRoles: ['owner'] },
        batch: { maxTasks: 5, selection: 'priority_then_ready_at' },
        execution: {
          mergeMethod: 'merge', continueIndependentSources: true, autoResolveConflicts: true,
          maxAutomaticRemediationRounds: 2, maxTransientRetries: 1, requireGreenChecks: true,
          deleteRemoteBranch: false, deploy: false,
        },
      },
    });
    let checkStatus: 'failure' | 'success' = 'success';
    const provider: RepositoryProvider = {
      getPullRequest: async () => ({
        providerPullRequestId: '901', number: 901, state: 'open', draft: false,
        headRef: 'feature/901', headOid: 'head-901', baseRef: 'main', baseOid: 'base-901', mergeable: true,
        requiredChecks: [{ name: 'ci', status: checkStatus }], requiredChecksKnown: true, subjectDigest: 'digest-901',
      }),
      mergePullRequest: async () => { throw new Error('must not merge'); },
    };
    store.setRepositoryProvider(provider);
    const delivery = await store.createTask(identity, board.id, { title: 'Check failure', status: 'todo' });
    await pool.query(`UPDATE ${store.tasksTable} SET status='ready_to_merge',provider_pull_request_id='901',
      pull_request_number=901,head_oid='head-901',base_oid='base-901',reviewed_subject_digest='digest-901' WHERE id=$1`, [delivery.id]);
    await seedSuccessfulReviewCi(pool, store, delivery.id, 'head-901');
    const integration = await store.createIntegrationBatch(identity, board.id, {
      deliveryTaskIds: [delivery.id], expectedBoardVersion: (await store.getBoard(identity, board.id)).version,
    });
    checkStatus = 'failure';
    const source = (await store.listIntegrationSources(identity, integration.id))[0]!;
    const executionId = randomUUID();
    const runId = `checks-run-${executionId}`;
    const claim = executionClaim(integration.id, integration.version, executionId, runId);
    claim.purpose = 'merge';
    await store.claimExecution(identity, integration.id, claim);
    await store.inspectIntegrationSourceV2(identity, runId, source.id);
    await expect(store.mergeIntegrationSourceV2(identity, runId, source.id))
      .rejects.toMatchObject({ code: 'TASKBOARD_SOURCE_NOT_MERGEABLE' });
    const context = await store.getExecutionContextV2(identity, integration.id, { runId });
    expect((await store.listIntegrationSources(identity, integration.id))[0]).toMatchObject({
      state: 'resolving_conflict', remediationCount: 0,
    });
    await store.resolveExecutionV2(identity, runId, {
      outcome: 'progress', summary: 'Checks routed to remediation', receipt: context.receipt,
    });
    await store.completeExecution(runId, { status: 'succeeded', commentBody: 'Waiting for checks remediation' });
    const candidates = await store.claimIntegrationDispatchCandidatesV2(10);
    expect(candidates.filter((candidate) => candidate.task.boardId === board.id
      && candidate.task.kind === 'integration')).toHaveLength(0);
    expect(candidates.filter((candidate) => candidate.task.boardId === board.id
      && candidate.task.kind === 'remediation')).toHaveLength(1);
  });

  it('schema migration projects one valid legacy Resolution and exposes duplicate/incomplete anomalies', async () => {
    const board = await store.createBoard(identity, { name: 'Legacy resolution migration board' });
    const fixtures = await Promise.all([
      store.createTask(identity, board.id, { title: 'Legacy valid', kind: 'advisory', status: 'todo' }),
      store.createTask(identity, board.id, { title: 'Legacy duplicate', kind: 'advisory', status: 'todo' }),
      store.createTask(identity, board.id, { title: 'Legacy incomplete', kind: 'advisory', status: 'todo' }),
    ]);
    for (const [index, task] of fixtures.entries()) {
      const executionId = `legacy-execution-${randomUUID()}`;
      const runId = `legacy-run-${randomUUID()}`;
      await pool.query(
        `INSERT INTO ${store.executionsTable}
           (id,task_id,run_id,session_id,status,purpose,trigger,protocol_version,attempt_id,requested_by)
         VALUES($1,$2,$3,$4,'succeeded','work','initial',2,$5,$6)`,
        [executionId, task.id, runId, `session-${executionId}`, `attempt-${executionId}`, identity.ownerUserId],
      );
      const payload = { schemaVersion: 2, executionId, runId, outcome: 'completed', ...(index === 2 ? {} : { summary: `legacy-${index}` }) };
      await pool.query(
        `INSERT INTO ${store.changesTable}(task_id,change_type,actor_type,actor_id,execution_id,payload)
         VALUES($1,'execution.resolved.v2','agent',$2,$3,$4::jsonb)`,
        [task.id, runId, executionId, JSON.stringify(payload)],
      );
      if (index === 1) {
        await pool.query(
          `INSERT INTO ${store.changesTable}(task_id,change_type,actor_type,actor_id,execution_id,payload)
           VALUES($1,'execution.resolved.v2','agent',$2,$3,$4::jsonb)`,
          [task.id, runId, executionId, JSON.stringify({ ...payload, summary: 'duplicate' })],
        );
      }
    }
    await store.init();
    const [valid, duplicate, incomplete] = await Promise.all(fixtures.map((task) => store.listExecutions(identity, task.id)));
    expect(valid[0]).toMatchObject({ resolutionState: 'historical', resolutionOutcome: 'completed', resolutionSummary: 'legacy-0' });
    expect(duplicate[0]).toMatchObject({ resolutionState: 'legacy_ambiguous' });
    expect(incomplete[0]).toMatchObject({ resolutionState: 'legacy_incomplete' });
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
              head_oid='head-88',base_oid='base-88',reviewed_subject_digest='digest-88',version=version+1 WHERE id=$1`,
      [delivery.id],
    );
    await seedSuccessfulReviewCi(pool, store, delivery.id, 'head-88');
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
      await pool.query(`DROP INDEX ${store.integrationSourcesTable}_apr_uq`);
      await pool.query(
        `INSERT INTO ${store.integrationSourcesTable}
           (id,integration_task_id,delivery_task_id,repository_id,provider_pull_request_id,reviewed_subject_digest,source_order,state)
         VALUES($1,$2,$3,$4,'88','duplicate-digest',0,'pending')`,
        [randomUUID(), duplicateIntegration.id, duplicateDelivery.id, source.repositoryId],
      );
      await expect(store.init()).rejects.toThrow(/TASKBOARD_ACTIVE_PR_DUPLICATES/);
      const duplicateRepair = await execFileAsync('pnpm', [
        'exec', 'tsx', 'scripts/repairTaskboardWorkflow.ts', '--apply', `--table-prefix=${prefix}`,
        `--task-id=${duplicateDelivery.id}`, `--output=${outputBase}-duplicate`,
      ], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: connectionString! }, timeout: 30_000 });
      expect(duplicateRepair.stderr).toBe('');
      await expect(store.init()).resolves.toBeUndefined();
      const index = await pool.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [`${store.integrationSourcesTable}_apr_uq`]);
      expect(index.rows[0].present).toBe(true);
    } finally {
      for (const suffix of ['dry', 'apply-1', 'apply-2', 'unapproved', 'duplicate']) {
        await rm(`${outputBase}-${suffix}.json`, { force: true });
        await rm(`${outputBase}-${suffix}.md`, { force: true });
      }
    }
  }, 60_000);
});
