import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgTaskboardStore } from '../taskboard/store.js';
import type { RepositoryProvider } from '../taskboard/repositoryProvider.js';
import type { TaskboardExecutionClaimInput, TaskboardIdentity } from '../taskboard/types.js';
import { seedSuccessfulReviewCi } from './taskboardCiPgTestHelpers.js';

const { Pool } = pg;
const connectionString = process.env.TEST_DATABASE_URL?.trim();
const describePg = connectionString ? describe : describe.skip;

const identity: TaskboardIdentity = {
  tenantId: 'tenant-integration-recovery', ownerUserId: 'integration-recovery-owner',
  username: 'integration-recovery-owner',
};

function executionClaim(
  taskId: string,
  version: number,
  executionId: string,
  runId: string,
  purpose: 'work' | 'review' | 'merge',
): TaskboardExecutionClaimInput {
  const now = new Date().toISOString();
  const sessionId = `session-${executionId}`;
  return {
    expectedVersion: version, executionId, runId, sessionId, purpose, protocolVersion: 2,
    executionOwnerUserId: identity.ownerUserId,
    dispatch: {
      version: 1,
      session: {
        sessionId, userId: identity.ownerUserId, username: identity.username, tenantId: identity.tenantId,
        channel: 'web', cwd: '/tmp/taskboard-integration-recovery', transcriptPath: `/tmp/${sessionId}.jsonl`,
        status: 'running', createdAt: now, updatedAt: now,
      },
      run: {
        runId, sessionId, userId: identity.ownerUserId, tenantId: identity.tenantId,
        channel: 'web', idempotencyKey: `taskboard-execution:${executionId}`,
        metadata: { taskboardExecution: true, taskboardExecutionId: executionId, taskId },
      },
    },
  };
}

describePg('taskboard integration recovery workflow (PostgreSQL)', () => {
  const prefix = `tbir_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
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

  it('required checks failure completes remediation review and resumes merge', async () => {
    let headOid = 'head-check-901';
    let subjectDigest = 'digest-check-901';
    let checkStatus: 'failure' | 'success' = 'success';
    let mergeable = true;
    let mergeCalls = 0;
    const observedChecks: string[] = [];
    const provider: RepositoryProvider = {
      getPullRequest: async (_repository, providerPullRequestId) => {
        observedChecks.push(checkStatus);
        return {
          providerPullRequestId, number: Number(providerPullRequestId), state: 'open', draft: false,
          headRef: 'feature/check-901', headOid, baseRef: 'main', baseOid: 'base-check-1', mergeable,
          requiredChecks: [{ name: 'ci', status: checkStatus }], requiredChecksKnown: true, subjectDigest,
        };
      },
      mergePullRequest: async (_repository, input) => {
        mergeCalls += 1;
        return {
          providerRequestId: input.requestId, providerPullRequestId: input.providerPullRequestId,
          merged: true, mergedCommitOid: 'merge-check-901', raw: { merged: true },
        };
      },
    };
    store.setRepositoryProvider(provider);
    const board = await store.createBoard(identity, {
      name: 'Checks recovery board',
      repository: {
        provider: 'github', repositoryId: 'github:acme/checks-recovery', owner: 'acme',
        name: 'checks-recovery', baseBranch: 'main', allowForkPullRequest: false,
      },
      integrationPolicy: {
        schemaVersion: 1, enabled: true, revision: 'checks-recovery-policy',
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
      title: 'Checks delivery', status: 'todo', branch: 'feature/check-901',
    });
    await pool.query(
      `UPDATE ${store.tasksTable}
          SET status='ready_to_merge',provider_pull_request_id='901',pull_request_number=901,
              head_oid=$2,base_oid='base-check-1',reviewed_subject_digest=$3,version=version+1
        WHERE id=$1`,
      [delivery.id, headOid, subjectDigest],
    );
    await seedSuccessfulReviewCi(pool, store, delivery.id, headOid);
    const integration = await store.createIntegrationBatch(identity, board.id, {
      deliveryTaskIds: [delivery.id], expectedBoardVersion: (await store.getBoard(identity, board.id)).version,
    });
    const source = (await store.listIntegrationSources(identity, integration.id))[0]!;
    checkStatus = 'failure';

    const firstMergeExecutionId = randomUUID();
    const firstMergeRunId = `checks-merge-${firstMergeExecutionId}`;
    await store.claimExecution(
      identity, integration.id,
      executionClaim(integration.id, integration.version, firstMergeExecutionId, firstMergeRunId, 'merge'),
    );
    const firstMergeContext = await store.getExecutionContextV2(identity, integration.id, { runId: firstMergeRunId });
    await store.inspectIntegrationSourceV2(identity, firstMergeRunId, source.id);
    await expect(store.mergeIntegrationSourceV2(identity, firstMergeRunId, source.id))
      .rejects.toMatchObject({ code: 'TASKBOARD_SOURCE_NOT_MERGEABLE' });
    expect((await store.listIntegrationSources(identity, integration.id))[0]).toMatchObject({
      state: 'resolving_conflict', remediationCount: 0,
    });
    expect(await store.claimIntegrationDispatchCandidatesV2(10)).toHaveLength(0);
    await store.resolveExecutionV2(identity, firstMergeRunId, {
      outcome: 'progress', summary: 'Checks failure routed to remediation', receipt: firstMergeContext.receipt,
    });
    await store.completeExecution(firstMergeRunId, { status: 'succeeded', commentBody: 'Waiting for checks remediation' });

    const recovery = (await store.claimIntegrationDispatchCandidatesV2(10))
      .find((candidate) => candidate.task.kind === 'remediation');
    expect(recovery).toBeTruthy();
    expect((await store.claimIntegrationDispatchCandidatesV2(10))
      .filter((candidate) => candidate.task.kind === 'integration')).toHaveLength(0);
    const remediationExecutionId = randomUUID();
    const remediationRunId = `checks-remediation-${remediationExecutionId}`;
    await store.claimExecution(
      identity, recovery!.task.id,
      executionClaim(recovery!.task.id, recovery!.task.version, remediationExecutionId, remediationRunId, 'work'),
    );
    headOid = 'head-check-901-fixed';
    subjectDigest = 'digest-check-901-fixed';
    checkStatus = 'success';
    await pool.query(
      `UPDATE ${store.tasksTable} SET head_oid=$2,version=version+1 WHERE id=$1`,
      [recovery!.task.id, headOid],
    );
    await store.inspectExecutionPullRequestV2(identity, remediationRunId);
    const remediationContext = await store.getExecutionContextV2(identity, recovery!.task.id, {
      runId: remediationRunId,
    });
    const remediationResolved = await store.resolveExecutionV2(identity, remediationRunId, {
      outcome: 'ready_for_review', summary: 'Checks fixed with a new commit', evidence: ['checks rerun'],
      receipt: remediationContext.receipt,
    });
    expect(remediationResolved.status).toBe('in_review');
    expect((await store.listIntegrationSources(identity, integration.id))[0]).toMatchObject({
      state: 'waiting_remediation', remediationCount: 1,
    });
    await store.completeExecution(remediationRunId, { status: 'succeeded', commentBody: 'Remediation work delivered' });

    const reviewExecutionId = randomUUID();
    const reviewRunId = `checks-review-${reviewExecutionId}`;
    await store.claimExecution(
      identity, recovery!.task.id,
      executionClaim(recovery!.task.id, remediationResolved.version, reviewExecutionId, reviewRunId, 'review'),
    );
    await store.inspectExecutionPullRequestV2(identity, reviewRunId);
    await store.recordReviewedExecutionSubjectV2(identity, reviewRunId);
    const reviewContext = await store.getExecutionContextV2(identity, recovery!.task.id, { runId: reviewRunId });
    const approved = await store.resolveExecutionV2(identity, reviewRunId, {
      outcome: 'approved', summary: 'New PR subject and green checks reviewed', evidence: ['ci=success'],
      receipt: reviewContext.receipt,
    });
    expect(approved.status).toBe('done');
    await store.completeExecution(reviewRunId, { status: 'succeeded', commentBody: 'Checks remediation approved' });
    expect((await store.listIntegrationSources(identity, integration.id))[0]).toMatchObject({
      state: 'pending', remediationCount: 1,
    });

    const resumed = (await store.claimIntegrationDispatchCandidatesV2(10))
      .find((candidate) => candidate.task.kind === 'integration');
    expect(resumed).toBeTruthy();
    const resumedExecutionId = randomUUID();
    const resumedRunId = `checks-resumed-merge-${resumedExecutionId}`;
    await store.claimExecution(
      identity, integration.id,
      executionClaim(integration.id, resumed!.task.version, resumedExecutionId, resumedRunId, 'merge'),
    );
    await store.inspectIntegrationSourceV2(identity, resumedRunId, source.id);
    const merged = await store.mergeIntegrationSourceV2(identity, resumedRunId, source.id);
    expect(merged.source).toMatchObject({ state: 'merged', mergedCommitOid: 'merge-check-901' });
    expect(mergeCalls).toBe(1);
    expect(observedChecks).toContain('failure');
    expect(observedChecks).toContain('success');
  });

  it('requires two actual remediation commits before exhausting repeated checks failures', async () => {
    let headOid = 'head-check-902';
    let subjectDigest = 'digest-check-902';
    let checkStatus: 'failure' | 'success' = 'success';
    const provider: RepositoryProvider = {
      getPullRequest: async (_repository, providerPullRequestId) => ({
        providerPullRequestId, number: Number(providerPullRequestId), state: 'open', draft: false,
        headRef: 'feature/check-902', headOid, baseRef: 'main', baseOid: 'base-check-2', mergeable: true,
        requiredChecks: [{ name: 'ci', status: checkStatus }], requiredChecksKnown: true, subjectDigest,
      }),
      mergePullRequest: async () => { throw new Error('checks failure must block provider merge'); },
    };
    store.setRepositoryProvider(provider);
    const board = await store.createBoard(identity, {
      name: 'Checks exhaustion board',
      repository: {
        provider: 'github', repositoryId: 'github:acme/checks-exhaustion', owner: 'acme',
        name: 'checks-exhaustion', baseBranch: 'main', allowForkPullRequest: false,
      },
      integrationPolicy: {
        schemaVersion: 1, enabled: true, revision: 'checks-exhaustion-policy',
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
      title: 'Checks exhaustion delivery', status: 'todo', branch: 'feature/check-902',
    });
    await pool.query(
      `UPDATE ${store.tasksTable}
          SET status='ready_to_merge',provider_pull_request_id='902',pull_request_number=902,
              head_oid=$2,base_oid='base-check-2',reviewed_subject_digest=$3,version=version+1
        WHERE id=$1`,
      [delivery.id, headOid, subjectDigest],
    );
    await seedSuccessfulReviewCi(pool, store, delivery.id, headOid);
    const integration = await store.createIntegrationBatch(identity, board.id, {
      deliveryTaskIds: [delivery.id], expectedBoardVersion: (await store.getBoard(identity, board.id)).version,
    });
    const source = (await store.listIntegrationSources(identity, integration.id))[0]!;
    checkStatus = 'failure';

    for (let round = 1; round <= 2; round += 1) {
      const mergeCandidate = (await store.claimIntegrationDispatchCandidatesV2(10))
        .find((candidate) => candidate.task.kind === 'integration');
      expect(mergeCandidate).toBeTruthy();
      const mergeExecutionId = randomUUID();
      const mergeRunId = `checks-exhaustion-merge-${round}-${mergeExecutionId}`;
      await store.claimExecution(
        identity, integration.id,
        executionClaim(integration.id, mergeCandidate!.task.version, mergeExecutionId, mergeRunId, 'merge'),
      );
      const mergeContext = await store.getExecutionContextV2(identity, integration.id, { runId: mergeRunId });
      await store.inspectIntegrationSourceV2(identity, mergeRunId, source.id);
      await expect(store.mergeIntegrationSourceV2(identity, mergeRunId, source.id))
        .rejects.toMatchObject({ code: 'TASKBOARD_SOURCE_NOT_MERGEABLE' });
      expect((await store.listIntegrationSources(identity, integration.id))[0]).toMatchObject({
        state: 'resolving_conflict', remediationCount: round - 1,
      });
      await store.resolveExecutionV2(identity, mergeRunId, {
        outcome: 'progress', summary: `Checks failure round ${round}`, receipt: mergeContext.receipt,
      });
      await store.completeExecution(mergeRunId, { status: 'succeeded', commentBody: 'Route to remediation' });

      const recovery = (await store.claimIntegrationDispatchCandidatesV2(10))
        .find((candidate) => candidate.task.kind === 'remediation');
      expect(recovery).toBeTruthy();
      expect((await store.claimIntegrationDispatchCandidatesV2(10))
        .filter((candidate) => candidate.task.kind === 'integration')).toHaveLength(0);
      const remediationExecutionId = randomUUID();
      const remediationRunId = `checks-exhaustion-remediation-${round}-${remediationExecutionId}`;
      await store.claimExecution(
        identity, recovery!.task.id,
        executionClaim(recovery!.task.id, recovery!.task.version, remediationExecutionId, remediationRunId, 'work'),
      );
      headOid = `head-check-902-fixed-${round}`;
      subjectDigest = `digest-check-902-fixed-${round}`;
      checkStatus = 'success';
      await pool.query(
        `UPDATE ${store.tasksTable} SET head_oid=$2,version=version+1 WHERE id=$1`,
        [recovery!.task.id, headOid],
      );
      await store.inspectExecutionPullRequestV2(identity, remediationRunId);
      const remediationContext = await store.getExecutionContextV2(identity, recovery!.task.id, {
        runId: remediationRunId,
      });
      const remediationResolved = await store.resolveExecutionV2(identity, remediationRunId, {
        outcome: 'ready_for_review', summary: `Checks remediation commit ${round}`, evidence: ['ci rerun'],
        receipt: remediationContext.receipt,
      });
      expect((await store.listIntegrationSources(identity, integration.id))[0]).toMatchObject({
        state: 'waiting_remediation', remediationCount: round,
      });
      await store.completeExecution(remediationRunId, { status: 'succeeded', commentBody: 'Work complete' });

      const reviewExecutionId = randomUUID();
      const reviewRunId = `checks-exhaustion-review-${round}-${reviewExecutionId}`;
      await store.claimExecution(
        identity, recovery!.task.id,
        executionClaim(recovery!.task.id, remediationResolved.version, reviewExecutionId, reviewRunId, 'review'),
      );
      await store.inspectExecutionPullRequestV2(identity, reviewRunId);
      await store.recordReviewedExecutionSubjectV2(identity, reviewRunId);
      const reviewContext = await store.getExecutionContextV2(identity, recovery!.task.id, { runId: reviewRunId });
      const approved = await store.resolveExecutionV2(identity, reviewRunId, {
        outcome: 'approved', summary: `Checks review ${round}`, evidence: ['subject refreshed'],
        receipt: reviewContext.receipt,
      });
      expect(approved.status).toBe('done');
      await store.completeExecution(reviewRunId, { status: 'succeeded', commentBody: 'Review complete' });
      expect((await store.listIntegrationSources(identity, integration.id))[0]).toMatchObject({
        state: 'pending', remediationCount: round,
      });
      checkStatus = 'failure';
    }

    const exhaustedCandidate = (await store.claimIntegrationDispatchCandidatesV2(10))
      .find((candidate) => candidate.task.kind === 'integration');
    expect(exhaustedCandidate).toBeTruthy();
    const exhaustedExecutionId = randomUUID();
    const exhaustedRunId = `checks-exhausted-merge-${exhaustedExecutionId}`;
    await store.claimExecution(
      identity, integration.id,
      executionClaim(integration.id, exhaustedCandidate!.task.version, exhaustedExecutionId, exhaustedRunId, 'merge'),
    );
    const exhaustedContext = await store.getExecutionContextV2(identity, integration.id, { runId: exhaustedRunId });
    await store.inspectIntegrationSourceV2(identity, exhaustedRunId, source.id);
    await expect(store.mergeIntegrationSourceV2(identity, exhaustedRunId, source.id))
      .rejects.toMatchObject({ code: 'TASKBOARD_SOURCE_NOT_MERGEABLE' });
    expect((await store.listIntegrationSources(identity, integration.id))[0]).toMatchObject({
      state: 'needs_human', remediationCount: 2,
    });
    await store.resolveExecutionV2(identity, exhaustedRunId, {
      outcome: 'needs_human', summary: 'Two actual checks remediation rounds exhausted', receipt: exhaustedContext.receipt,
    });
    await store.completeExecution(exhaustedRunId, { status: 'succeeded', commentBody: 'Human intervention required' });
    const remaining = await store.claimIntegrationDispatchCandidatesV2(10);
    expect(remaining.filter((candidate) => candidate.task.kind === 'integration')).toHaveLength(0);
    expect(remaining.filter((candidate) => candidate.task.kind === 'remediation')).toHaveLength(0);
  });
  it('reconciles a pull request merged outside the taskboard while recording review subject', async () => {
    const board = await store.createBoard(identity, {
      name: 'External merge reconciliation',
      repository: {
        provider: 'github', repositoryId: 'github:acme/external', owner: 'acme', name: 'external',
        baseBranch: 'main', allowForkPullRequest: false,
      },
    });
    const delivery = await store.createTask(identity, board.id, { title: 'Externally merged delivery', status: 'todo' });
    const executionId = randomUUID();
    const runId = `run-${executionId}`;
    await pool.query(
      `UPDATE ${store.tasksTable}
          SET status='in_review',provider_pull_request_id='32',pull_request_number=32,
              head_oid='head-32',base_oid='base-32',version=version+1
        WHERE id=$1`,
      [delivery.id],
    );
    await pool.query(
      `INSERT INTO ${store.executionsTable}
         (id,task_id,run_id,session_id,status,purpose,trigger,protocol_version,attempt_id,requested_by)
       VALUES($1,$2,$3,$4,'running','review','initial',2,$5,$6)`,
      [executionId, delivery.id, runId, `session-${executionId}`, `attempt-${executionId}`, identity.ownerUserId],
    );
    store.setRepositoryProvider({
      getPullRequest: async () => ({
        providerPullRequestId: '32', number: 32, state: 'merged', draft: false,
        headRef: 'fix/task-32', headOid: 'head-32', baseRef: 'main', baseOid: 'base-32',
        mergeCommitOid: 'merge-32', mergeable: null, requiredChecks: [], subjectDigest: 'digest-32',
      }),
      mergePullRequest: async () => ({
        providerRequestId: 'unused', providerPullRequestId: '32', merged: true,
        mergedCommitOid: 'merge-32', raw: {},
      }),
    });

    await expect(store.recordReviewedExecutionSubjectV2(identity, runId)).resolves.toMatchObject({
      status: 'done', mergedCommitOid: 'merge-32',
    });
    const execution = await pool.query(
      `SELECT status,superseded_at FROM ${store.executionsTable} WHERE id=$1`,
      [executionId],
    );
    expect(execution.rows[0]).toMatchObject({ status: 'cancelled' });
    expect(execution.rows[0].superseded_at).toBeTruthy();
    const cancellations = await pool.query(
      `SELECT count(*)::int AS count FROM ${store.cancellationOutboxTable} WHERE execution_id=$1`,
      [executionId],
    );
    expect(cancellations.rows[0].count).toBe(1);
  });

  it('returns unresolved protocol V2 executions to a dispatchable business state', async () => {
    const board = await store.createBoard(identity, {
      name: 'Cancelled execution recovery',
      repository: {
        provider: 'github', repositoryId: 'github:acme/recovery', owner: 'acme', name: 'recovery',
        baseBranch: 'main', allowForkPullRequest: false,
      },
    });
    const delivery = await store.createTask(identity, board.id, { title: 'Cancelled work', status: 'todo' });
    const executionId = randomUUID();
    const runId = `run-${executionId}`;
    await store.claimExecution(
      identity,
      delivery.id,
      executionClaim(delivery.id, delivery.version, executionId, runId, 'work'),
    );

    const completed = await store.completeExecution(runId, {
      status: 'cancelled', commentBody: 'Agent execution cancelled', error: 'aborted',
    });
    expect(completed?.task).toMatchObject({ status: 'todo' });
    expect(completed?.execution).toMatchObject({ status: 'cancelled' });
  });
});
