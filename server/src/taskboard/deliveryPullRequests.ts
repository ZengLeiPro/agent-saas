import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import type { TaskBoardTask } from '../../../shared/src/types/taskboard.js';
import {
  finalizeMergedSource,
  type IntegrationOperationHost,
} from './integrationOperations.js';
import { integrationCandidateTableNames } from './integrationCandidateSchema.js';
import type {
  RepositoryProvider,
  RepositoryPullRequestInspection,
  RepositoryPullRequestSnapshot,
} from './repositoryProvider.js';
import { rowToTask, visibleCommentPredicate } from './storeHelpers.js';
import { fenceTaskExecutions } from './workflow/commandService.js';
import {
  TaskboardNotFoundError,
  TaskboardValidationError,
  type TaskboardIdentity,
} from './types.js';

interface DeliveryPullRequestHost extends IntegrationOperationHost {}

export interface ExecutionPullRequestInspectionReceipt {
  inspectionId: string;
  digest: string;
  executionId: string;
  taskId: string;
  purpose: 'work' | 'review';
  repositoryId: string;
  providerPullRequestId: string;
  headOid: string;
  providerQueriedAt: string;
  candidateId?: string;
  candidateRevision?: number;
  candidateSubjectDigest?: string;
}

export interface ExecutionPullRequestInspection {
  receipt: ExecutionPullRequestInspectionReceipt;
  snapshot: RepositoryPullRequestInspection;
  gateStatus: 'success' | 'pending' | 'failure' | 'unavailable';
}

export async function inspectExecutionPullRequest(
  host: DeliveryPullRequestHost,
  identity: TaskboardIdentity,
  runId: string,
): Promise<ExecutionPullRequestInspection> {
  const context = await loadContext(host, identity, runId, ['work', 'review']);
  if (!context.providerPullRequestId) {
    throw new TaskboardValidationError('Current execution has no pull request', 'TASKBOARD_PULL_REQUEST_REQUIRED');
  }
  const provider = context.candidateId ? requireIntegrationV3Provider(host) : requireProvider(host);
  const snapshot = provider.inspectPullRequest
    ? await provider.inspectPullRequest(context.repository, context.providerPullRequestId, context.boardOwnerUserId)
    : {
        ...await provider.getPullRequest(context.repository, context.providerPullRequestId, context.boardOwnerUserId),
        repositoryId: context.repository.repositoryId,
        providerQueriedAt: new Date().toISOString(),
        workflowRuns: [],
      };
  assertPullRequestIdentity(context, snapshot);
  const gateStatus = pullRequestGateStatus(snapshot);
  const inspectionId = randomUUID();
  const receipt: ExecutionPullRequestInspectionReceipt = {
    inspectionId,
    digest: inspectionDigest(context, inspectionId, snapshot),
    executionId: context.executionId,
    taskId: context.taskId,
    purpose: context.purpose,
    repositoryId: context.repository.repositoryId,
    providerPullRequestId: snapshot.providerPullRequestId,
    headOid: snapshot.headOid,
    providerQueriedAt: snapshot.providerQueriedAt,
    ...(context.candidateId ? {
      candidateId: context.candidateId,
      candidateRevision: context.candidateRevision,
      candidateSubjectDigest: context.candidateSubjectDigest,
    } : {}),
  };
  const client = await host.pool.connect();
  try {
    await client.query('BEGIN');
    await lockExecution(client, host, runId, context.taskId);
    if (context.candidateId) {
      const tables = integrationCandidateTableNames(host.integrationSourcesTable);
      const current = await client.query(
        `SELECT c.provider_pull_request_id,c.current_revision,r.head_oid,r.subject_digest
           FROM ${tables.candidatesTable} c
           JOIN ${tables.revisionsTable} r
             ON r.candidate_id=c.id AND r.revision=c.current_revision
          WHERE c.id=$1 AND c.integration_task_id=$2 FOR UPDATE OF c`,
        [context.candidateId, context.taskId],
      );
      const row = current.rows[0];
      if (String(row?.provider_pull_request_id ?? '') !== snapshot.providerPullRequestId
        || Number(row?.current_revision) !== context.candidateRevision
        || String(row?.head_oid ?? '') !== snapshot.headOid
        || String(row?.subject_digest ?? '') !== context.candidateSubjectDigest) {
        throw new TaskboardValidationError('Candidate pull request changed during inspection', 'TASKBOARD_SUBJECT_STALE');
      }
    } else {
      const current = await client.query(
        `SELECT provider_pull_request_id,head_oid FROM ${host.tasksTable} WHERE id=$1 FOR UPDATE`,
        [context.taskId],
      );
      if (String(current.rows[0]?.provider_pull_request_id ?? '') !== snapshot.providerPullRequestId
        || (current.rows[0]?.head_oid && String(current.rows[0].head_oid) !== snapshot.headOid)) {
        throw new TaskboardValidationError('Pull request head changed during inspection', 'TASKBOARD_SUBJECT_STALE');
      }
    }
    await client.query(
      `UPDATE ${host.tasksTable}
          SET provider_ci_inspection_id=$2,provider_ci_execution_id=$3,
              provider_ci_purpose=$4,provider_ci_head_oid=$5,provider_ci_status=$6,
              provider_ci_inspected_at=$7,version=version+1,updated_at=now()
        WHERE id=$1`,
      [context.taskId, inspectionId, context.executionId, context.purpose,
        snapshot.headOid, gateStatus, snapshot.providerQueriedAt],
    );
    await client.query(
      `INSERT INTO ${host.changesTable}
         (task_id, change_type, actor_type, actor_id, execution_id, payload)
       VALUES ($1,'pull_request.inspected','agent',$2,$3,$4::jsonb)`,
      [context.taskId, runId, context.executionId, JSON.stringify({ receipt, gateStatus, snapshot })],
    );
    await client.query('COMMIT');
    return { receipt, snapshot, gateStatus };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function readExecutionPullRequestJobLog(
  host: DeliveryPullRequestHost,
  identity: TaskboardIdentity,
  runId: string,
  inspectionId: string,
  providerJobId: string,
): Promise<{ inspectionId: string; providerJobId: string; log: string }> {
  const context = await loadContext(host, identity, runId, ['work', 'review']);
  const readClient = await host.pool.connect();
  let payload: Record<string, unknown> | undefined;
  try {
    const result = await readClient.query(
      `SELECT payload FROM ${host.changesTable}
        WHERE task_id=$1 AND execution_id=$2 AND change_type='pull_request.inspected'
          AND payload->'receipt'->>'inspectionId'=$3
        ORDER BY seq DESC LIMIT 1`,
      [context.taskId, context.executionId, inspectionId],
    );
    payload = jsonObject(result.rows[0]?.payload);
  } finally {
    readClient.release();
  }
  const snapshot = jsonObject(payload?.snapshot);
  const runs = Array.isArray(snapshot?.workflowRuns) ? snapshot.workflowRuns : [];
  const job = runs.flatMap((run) => {
    const jobs = jsonObject(run)?.jobs;
    return Array.isArray(jobs) ? jobs : [];
  }).map(jsonObject).find((candidate) => candidate?.id === providerJobId);
  if (!job || job.failureLogRef !== `github-job:${providerJobId}`) {
    throw new TaskboardValidationError('Workflow job is not part of this inspection receipt', 'TASKBOARD_CI_LOG_SCOPE_INVALID');
  }
  const provider = context.candidateId ? requireIntegrationV3Provider(host) : requireProvider(host);
  if (!provider.getWorkflowJobLog) {
    throw new TaskboardValidationError('Provider job log reader is unavailable', 'TASKBOARD_CI_UNAVAILABLE');
  }
  const log = await provider.getWorkflowJobLog(context.repository, providerJobId, context.boardOwnerUserId);
  const client = await host.pool.connect();
  try {
    await client.query('BEGIN');
    await lockExecution(client, host, runId, context.taskId);
    await client.query(
      `INSERT INTO ${host.changesTable}
         (task_id, change_type, actor_type, actor_id, execution_id, payload)
       VALUES ($1,'pull_request.failure_log_read','agent',$2,$3,$4::jsonb)`,
      [context.taskId, runId, context.executionId, JSON.stringify({ inspectionId, providerJobId })],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return { inspectionId, providerJobId, log };
}

export function pullRequestGateStatus(
  snapshot: RepositoryPullRequestSnapshot,
): ExecutionPullRequestInspection['gateStatus'] {
  if (snapshot.state !== 'open' || snapshot.draft) return 'failure';
  if (snapshot.requiredChecksKnown !== true) return 'unavailable';
  if (snapshot.requiredChecks.some((check) => check.status === 'failure')) return 'failure';
  if (snapshot.requiredChecks.length === 0
    || snapshot.requiredChecks.some((check) => check.status !== 'success')) return 'pending';
  return 'success';
}

export function assertPullRequestGate(
  snapshot: RepositoryPullRequestSnapshot,
  expected: { providerPullRequestId: string; headOid: string; baseOid?: string; subjectDigest?: string; requireMergeable?: boolean },
): void {
  if (snapshot.providerPullRequestId !== expected.providerPullRequestId
    || snapshot.headOid !== expected.headOid
    || (expected.baseOid && snapshot.baseOid !== expected.baseOid)
    || (expected.subjectDigest && snapshot.subjectDigest !== expected.subjectDigest)) {
    throw new TaskboardValidationError('Pull request subject changed after inspection', 'TASKBOARD_SUBJECT_STALE');
  }
  if (snapshot.state !== 'open' || snapshot.draft) {
    throw new TaskboardValidationError('Pull request is closed or draft', 'TASKBOARD_PR_NOT_OPEN');
  }
  if (expected.requireMergeable && snapshot.mergeable !== true) {
    throw new TaskboardValidationError(
      snapshot.mergeable === false ? 'Pull request is not mergeable' : 'Pull request mergeability is unknown',
      snapshot.mergeable === false ? 'TASKBOARD_PR_NOT_MERGEABLE' : 'TASKBOARD_MERGEABILITY_UNKNOWN',
    );
  }
  if (snapshot.requiredChecksKnown !== true) {
    throw new TaskboardValidationError('Provider could not authoritatively determine required checks', 'TASKBOARD_CI_UNAVAILABLE');
  }
  const failed = snapshot.requiredChecks.filter((check) => check.status === 'failure');
  if (failed.length) {
    throw new TaskboardValidationError(
      `Required checks failed: ${failed.map((check) => check.name).join(', ')}`,
      'TASKBOARD_CI_FAILED',
    );
  }
  const pending = snapshot.requiredChecks.filter((check) => check.status !== 'success');
  if (snapshot.requiredChecks.length === 0 || pending.length) {
    throw new TaskboardValidationError(
      `Required checks are pending: ${pending.map((check) => check.name).join(', ') || 'no checks observed'}`,
      'TASKBOARD_CI_PENDING',
    );
  }
}

export async function attachExecutionPullRequest(
  host: DeliveryPullRequestHost,
  identity: TaskboardIdentity,
  runId: string,
  providerPullRequestId: string,
): Promise<TaskBoardTask> {
  const context = await loadContext(host, identity, runId, ['work']);
  assertRemediationPullRequest(context, providerPullRequestId);
  const provider = requireProvider(host);
  const pullRequest = await provider.getPullRequest(
    context.repository,
    providerPullRequestId,
    context.boardOwnerUserId,
  );
  if (pullRequest.state !== 'open') {
    throw new TaskboardValidationError('Delivery pull request must be open', 'TASKBOARD_PR_NOT_OPEN');
  }
  assertRemediationPullRequest(context, pullRequest.providerPullRequestId);
  assertRemediationBranch(context, pullRequest.headRef);
  const client = await host.pool.connect();
  try {
    await client.query('BEGIN');
    await lockExecution(client, host, runId, context.taskId);
    const result = await client.query(
      `UPDATE ${host.tasksTable}
          SET provider_pull_request_id=$2, pull_request_number=$3,
              head_oid=$4, base_oid=$5, reviewed_subject_digest=NULL,
              provider_ci_inspection_id=NULL,provider_ci_execution_id=NULL,
              provider_ci_purpose=NULL,provider_ci_head_oid=NULL,
              provider_ci_status=NULL,provider_ci_inspected_at=NULL,
              version=version+1, updated_at=now()
        WHERE id=$1
        RETURNING *,
          (SELECT count(*)::int FROM ${host.commentsTable} c WHERE c.task_id=${host.tasksTable}.id AND ${visibleCommentPredicate('c', host.changesTable)}) AS comment_count`,
      [context.taskId, pullRequest.providerPullRequestId, pullRequest.number, pullRequest.headOid, pullRequest.baseOid],
    );
    await client.query(
      `INSERT INTO ${host.changesTable}
         (task_id, change_type, actor_type, actor_id, execution_id, payload)
       VALUES ($1,'pull_request.attached','agent',$2,$3,$4::jsonb)`,
      [context.taskId, runId, context.executionId, JSON.stringify({
        providerPullRequestId: pullRequest.providerPullRequestId,
        number: pullRequest.number,
        headOid: pullRequest.headOid,
        baseOid: pullRequest.baseOid,
        subjectDigest: pullRequest.subjectDigest,
      })],
    );
    await client.query('COMMIT');
    return rowToTask(result.rows[0]!);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function recordReviewedExecutionSubject(
  host: DeliveryPullRequestHost,
  identity: TaskboardIdentity,
  runId: string,
): Promise<TaskBoardTask> {
  const context = await loadContext(host, identity, runId, ['review']);
  if (!context.providerPullRequestId) {
    throw new TaskboardValidationError('Delivery task has no pull request');
  }
  assertRemediationPullRequest(context, context.providerPullRequestId);
  const provider = context.candidateId ? requireIntegrationV3Provider(host) : requireProvider(host);
  const pullRequest = await provider.getPullRequest(
    context.repository,
    context.providerPullRequestId,
    context.boardOwnerUserId,
  );
  if (pullRequest.state === 'merged') {
    if (!pullRequest.mergeCommitOid) {
      throw new TaskboardValidationError(
        'Provider did not return the merged commit oid',
        'TASKBOARD_PROVIDER_RECEIPT_INCOMPLETE',
      );
    }
    return reconcileExternallyMergedPullRequest(host, context, {
      ...pullRequest,
      mergeCommitOid: pullRequest.mergeCommitOid,
    });
  }
  if (pullRequest.state !== 'open' || pullRequest.draft) {
    throw new TaskboardValidationError('Pull request is not reviewable', 'TASKBOARD_PR_NOT_OPEN');
  }
  assertRemediationPullRequest(context, pullRequest.providerPullRequestId);
  assertRemediationBranch(context, pullRequest.headRef);
  const client = await host.pool.connect();
  try {
    await client.query('BEGIN');
    await lockExecution(client, host, runId, context.taskId);
    const current = await client.query(
      `SELECT provider_pull_request_id FROM ${host.tasksTable} WHERE id=$1 FOR UPDATE`,
      [context.taskId],
    );
    if (current.rows[0]?.provider_pull_request_id !== context.providerPullRequestId) {
      throw new TaskboardValidationError('Pull request changed during review', 'TASKBOARD_SUBJECT_STALE');
    }
    const result = await client.query(
      `UPDATE ${host.tasksTable}
          SET pull_request_number=$2, head_oid=$3, base_oid=$4,
              reviewed_subject_digest=$5, version=version+1, updated_at=now()
        WHERE id=$1
        RETURNING *,
          (SELECT count(*)::int FROM ${host.commentsTable} c WHERE c.task_id=${host.tasksTable}.id AND ${visibleCommentPredicate('c', host.changesTable)}) AS comment_count`,
      [context.taskId, pullRequest.number, pullRequest.headOid, pullRequest.baseOid, pullRequest.subjectDigest],
    );
    await client.query(
      `INSERT INTO ${host.changesTable}
         (task_id, change_type, actor_type, actor_id, execution_id, payload)
       VALUES ($1,'review.subject_recorded','agent',$2,$3,$4::jsonb)`,
      [context.taskId, runId, context.executionId, JSON.stringify({
        providerPullRequestId: pullRequest.providerPullRequestId,
        headOid: pullRequest.headOid,
        baseOid: pullRequest.baseOid,
        subjectDigest: pullRequest.subjectDigest,
      })],
    );
    await client.query(
      `UPDATE ${host.integrationSourcesTable}
          SET provider_pull_request_id=$2, reviewed_subject_digest=$3,
              state=CASE WHEN remediation_task_id=$1 THEN state ELSE 'pending' END,
              last_error=NULL, updated_at=now()
        WHERE (delivery_task_id=$1 AND state='re_reviewing')
           OR (remediation_task_id=$1 AND state='waiting_remediation')`,
      [context.taskId, pullRequest.providerPullRequestId, pullRequest.subjectDigest],
    );
    await client.query(
      `UPDATE ${host.tasksTable} d
          SET provider_pull_request_id=$2, pull_request_number=$3,
              head_oid=$4, base_oid=$5, reviewed_subject_digest=$6,
              version=version+1, updated_at=now()
         FROM ${host.integrationSourcesTable} s
        WHERE s.remediation_task_id=$1 AND s.state='waiting_remediation'
          AND d.id=s.delivery_task_id`,
      [context.taskId, pullRequest.providerPullRequestId, pullRequest.number,
        pullRequest.headOid, pullRequest.baseOid, pullRequest.subjectDigest],
    );
    await client.query('COMMIT');
    return rowToTask(result.rows[0]!);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function reconcileExternallyMergedPullRequest(
  host: DeliveryPullRequestHost,
  context: Awaited<ReturnType<typeof loadContext>>,
  pullRequest: RepositoryPullRequestSnapshot & { mergeCommitOid: string },
): Promise<TaskBoardTask> {
  const sourceClient = await host.pool.connect();
  try {
    const source = await sourceClient.query(
      `SELECT id FROM ${host.integrationSourcesTable}
        WHERE delivery_task_id=$1 AND provider_pull_request_id=$2 AND state<>'canceled'
        ORDER BY updated_at DESC,id DESC LIMIT 1`,
      [context.taskId, context.providerPullRequestId],
    );
    if (source.rows[0]) {
      const finalized = await finalizeMergedSource(host, String(source.rows[0].id), {
        providerRequestId: `external-merge:${context.taskId}:${pullRequest.mergeCommitOid}`,
        mergedCommitOid: pullRequest.mergeCommitOid,
        raw: { reconciled: true, source: 'review_subject', pullRequest },
        expectedReview: {
          deliveryTaskId: context.taskId,
          providerPullRequestId: context.providerPullRequestId!,
          executionId: context.executionId,
        },
      });
      return finalized.task;
    }
  } finally {
    sourceClient.release();
  }

  const client = await host.pool.connect();
  try {
    await client.query('BEGIN');
    await lockExecution(client, host, context.runId, context.taskId);
    const current = await client.query(
      `SELECT provider_pull_request_id FROM ${host.tasksTable} WHERE id=$1 FOR UPDATE`,
      [context.taskId],
    );
    if (current.rows[0]?.provider_pull_request_id !== context.providerPullRequestId) {
      throw new TaskboardValidationError('Pull request changed during merge reconciliation', 'TASKBOARD_SUBJECT_STALE');
    }
    const result = await client.query(
      `UPDATE ${host.tasksTable}
          SET status='done', pull_request_number=$2, head_oid=$3, base_oid=$4,
              merged_commit_oid=$5, completed_at=COALESCE(completed_at,now()),
              workflow_epoch=workflow_epoch+1, next_action='none',
              next_action_revision=next_action_revision+1,
              version=version+1, updated_at=now()
        WHERE id=$1
        RETURNING *,
          (SELECT count(*)::int FROM ${host.commentsTable} c WHERE c.task_id=${host.tasksTable}.id AND ${visibleCommentPredicate('c', host.changesTable)}) AS comment_count`,
      [context.taskId, pullRequest.number, pullRequest.headOid, pullRequest.baseOid, pullRequest.mergeCommitOid],
    );
    await client.query(
      `UPDATE ${host.blockEpisodesTable} SET closed_at=COALESCE(closed_at,now())
        WHERE task_id=$1 AND closed_at IS NULL`,
      [context.taskId],
    );
    await fenceTaskExecutions(host, client, [context.taskId], 'external_merge_confirmed');
    const commandId = `external-merge:${context.taskId}:${pullRequest.mergeCommitOid}`;
    await client.query(
      `INSERT INTO ${host.changesTable}
         (task_id, change_type, actor_type, actor_id, execution_id, payload)
       SELECT $1,'merge.succeeded.v2','system',$2,$3,$4::jsonb
        WHERE NOT EXISTS (
          SELECT 1 FROM ${host.changesTable}
           WHERE task_id=$1 AND change_type='merge.succeeded.v2' AND payload->>'commandId'=$2
        )`,
      [context.taskId, commandId, context.executionId, JSON.stringify({
        schemaVersion: 2,
        commandId,
        providerPullRequestId: pullRequest.providerPullRequestId,
        mergedCommitOid: pullRequest.mergeCommitOid,
        reconciledFrom: 'review_subject',
      })],
    );
    await client.query('COMMIT');
    return rowToTask(result.rows[0]!);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function loadContext(
  host: DeliveryPullRequestHost,
  identity: TaskboardIdentity,
  runId: string,
  purposes: string[],
): Promise<{
  taskId: string;
  executionId: string;
  runId: string;
  purpose: 'work' | 'review';
  isRemediation: boolean;
  isIntegrationV3: boolean;
  providerPullRequestId?: string;
  candidateId?: string;
  candidateRevision?: number;
  candidateHeadOid?: string;
  candidateBaseOid?: string;
  candidateSubjectDigest?: string;
  candidateBranch?: string;
  sourceProviderPullRequestId?: string;
  deliveryProviderPullRequestId?: string;
  taskBranch?: string;
  deliveryBranch?: string;
  repository: { provider: 'github'; repositoryId: string; owner: string; name: string; baseBranch: string; allowForkPullRequest: false };
  boardOwnerUserId: string;
}> {
  const client = await host.pool.connect();
  try {
    const candidateTables = integrationCandidateTableNames(host.integrationSourcesTable);
    const result = await client.query(
      `SELECT t.id AS task_id,t.kind,t.branch AS task_branch,t.provider_pull_request_id,
              e.id AS execution_id,e.purpose,e.status AS execution_status,e.resolved_at,e.superseded_at,
              e.candidate_id AS execution_candidate_id,e.candidate_revision AS execution_candidate_revision,
              e.candidate_head_oid AS execution_candidate_head_oid,
              b.repository,b.owner_user_id,
              candidate.id AS candidate_id,candidate.current_revision AS candidate_revision,
              candidate.provider_pull_request_id AS candidate_provider_pull_request_id,
              candidate.branch AS candidate_branch,
              candidate_revision.head_oid AS candidate_head_oid,
              candidate_revision.base_oid AS candidate_base_oid,
              candidate_revision.subject_digest AS candidate_subject_digest,
              remediation_source.provider_pull_request_id AS source_provider_pull_request_id,
              delivery.provider_pull_request_id AS delivery_provider_pull_request_id,
              delivery.branch AS delivery_branch
         FROM ${host.executionsTable} e
         JOIN ${host.tasksTable} t ON t.id=e.task_id
         JOIN ${host.boardsTable} b ON b.id=t.board_id
         LEFT JOIN LATERAL (
           SELECT s.provider_pull_request_id,s.delivery_task_id
             FROM ${host.integrationSourcesTable} s
            WHERE s.remediation_task_id=t.id
            ORDER BY s.updated_at DESC,s.id
            LIMIT 1
         ) remediation_source ON true
         LEFT JOIN ${host.tasksTable} delivery ON delivery.id=remediation_source.delivery_task_id
         LEFT JOIN ${candidateTables.candidatesTable} candidate
           ON candidate.integration_task_id=t.id
         LEFT JOIN ${candidateTables.revisionsTable} candidate_revision
           ON candidate_revision.candidate_id=candidate.id
          AND candidate_revision.revision=candidate.current_revision
        WHERE e.run_id=$1 AND b.tenant_id=$2
          AND (b.owner_user_id=$3 OR b.visibility='organization')
        LIMIT 1`,
      [runId, identity.tenantId, identity.ownerUserId],
    );
    const row = result.rows[0];
    if (!row) throw new TaskboardNotFoundError('Taskboard execution not found');
    const kind = String(row.kind);
    const purpose = String(row.purpose);
    const isIntegrationV3 = kind === 'integration' && purpose === 'review' && Boolean(row.candidate_id);
    if (isIntegrationV3
      && (String(row.execution_candidate_id ?? '') !== String(row.candidate_id)
        || Number(row.execution_candidate_revision) !== Number(row.candidate_revision)
        || String(row.execution_candidate_head_oid ?? '') !== String(row.candidate_head_oid ?? ''))) {
      throw new TaskboardValidationError(
        'Review execution is bound to a stale candidate revision',
        'TASKBOARD_SUBJECT_STALE',
      );
    }
    if ((!['delivery', 'remediation'].includes(kind) && !isIntegrationV3) || !purposes.includes(purpose)) {
      throw new TaskboardValidationError('Execution purpose cannot inspect the current pull request');
    }
    if (row.resolved_at || row.superseded_at
      || !['queued', 'running', 'waiting_user', 'waiting_approval'].includes(String(row.execution_status))) {
      throw new TaskboardValidationError('Taskboard execution is no longer active');
    }
    const repository = jsonObject(row.repository);
    if (!repository || repository.provider !== 'github') {
      throw new TaskboardValidationError('Board repository is not configured');
    }
    return {
      taskId: String(row.task_id),
      executionId: String(row.execution_id),
      runId,
      purpose: purpose as 'work' | 'review',
      isRemediation: kind === 'remediation',
      isIntegrationV3,
      ...(isIntegrationV3 && row.candidate_provider_pull_request_id
        ? { providerPullRequestId: String(row.candidate_provider_pull_request_id) }
        : row.provider_pull_request_id ? { providerPullRequestId: String(row.provider_pull_request_id) } : {}),
      ...(row.candidate_id ? { candidateId: String(row.candidate_id) } : {}),
      ...(row.candidate_revision !== null && row.candidate_revision !== undefined
        ? { candidateRevision: Number(row.candidate_revision) } : {}),
      ...(row.candidate_head_oid ? { candidateHeadOid: String(row.candidate_head_oid) } : {}),
      ...(row.candidate_base_oid ? { candidateBaseOid: String(row.candidate_base_oid) } : {}),
      ...(row.candidate_subject_digest ? { candidateSubjectDigest: String(row.candidate_subject_digest) } : {}),
      ...(row.candidate_branch ? { candidateBranch: String(row.candidate_branch) } : {}),
      ...(row.source_provider_pull_request_id
        ? { sourceProviderPullRequestId: String(row.source_provider_pull_request_id) } : {}),
      ...(row.delivery_provider_pull_request_id
        ? { deliveryProviderPullRequestId: String(row.delivery_provider_pull_request_id) } : {}),
      ...(row.task_branch ? { taskBranch: String(row.task_branch) } : {}),
      ...(row.delivery_branch ? { deliveryBranch: String(row.delivery_branch) } : {}),
      repository: repository as {
        provider: 'github'; repositoryId: string; owner: string; name: string;
        baseBranch: string; allowForkPullRequest: false;
      },
      boardOwnerUserId: String(row.owner_user_id),
    };
  } finally {
    client.release();
  }
}

async function lockExecution(
  client: PoolClient,
  host: DeliveryPullRequestHost,
  runId: string,
  taskId: string,
): Promise<void> {
  await client.query(
    `SELECT id FROM ${host.tasksTable} WHERE id=$1 FOR UPDATE`,
    [taskId],
  );
  const result = await client.query(
    `SELECT id FROM ${host.executionsTable}
      WHERE run_id=$1 AND task_id=$2
        AND status IN ('queued','running','waiting_user','waiting_approval')
        AND resolved_at IS NULL AND superseded_at IS NULL
      FOR UPDATE`,
    [runId, taskId],
  );
  if (!result.rows[0]) throw new TaskboardValidationError('Taskboard execution changed');
}

function assertPullRequestIdentity(
  context: Awaited<ReturnType<typeof loadContext>>,
  snapshot: RepositoryPullRequestSnapshot,
): void {
  if (snapshot.providerPullRequestId !== context.providerPullRequestId
    || snapshot.baseRef !== context.repository.baseBranch) {
    throw new TaskboardValidationError('Provider returned a pull request outside the registered subject', 'TASKBOARD_SUBJECT_STALE');
  }
  if (context.isIntegrationV3
    && (snapshot.headOid !== context.candidateHeadOid
      || snapshot.baseOid !== context.candidateBaseOid
      || snapshot.headRef !== context.candidateBranch)) {
    throw new TaskboardValidationError('Provider returned a pull request outside the candidate revision', 'TASKBOARD_SUBJECT_STALE');
  }
  assertRemediationPullRequest(context, snapshot.providerPullRequestId);
  assertRemediationBranch(context, snapshot.headRef);
}

function inspectionDigest(
  context: Awaited<ReturnType<typeof loadContext>>,
  inspectionId: string,
  snapshot: RepositoryPullRequestInspection,
): string {
  return createHash('sha256').update(JSON.stringify({
    executionId: context.executionId,
    inspectionId,
    repositoryId: snapshot.repositoryId,
    providerPullRequestId: snapshot.providerPullRequestId,
    headOid: snapshot.headOid,
    subjectDigest: snapshot.subjectDigest,
    providerQueriedAt: snapshot.providerQueriedAt,
    candidateId: context.candidateId,
    candidateRevision: context.candidateRevision,
    candidateSubjectDigest: context.candidateSubjectDigest,
  })).digest('hex');
}

function assertRemediationPullRequest(
  context: Awaited<ReturnType<typeof loadContext>>,
  providerPullRequestId: string,
): void {
  if (!context.isRemediation) return;
  if (!context.sourceProviderPullRequestId
    || !context.deliveryProviderPullRequestId
    || context.sourceProviderPullRequestId !== context.deliveryProviderPullRequestId
    || providerPullRequestId !== context.sourceProviderPullRequestId) {
    throw new TaskboardValidationError(
      'Remediation pull request must remain the integration source pull request',
      'TASKBOARD_REMEDIATION_PR_MISMATCH',
    );
  }
}

function assertRemediationBranch(
  context: Awaited<ReturnType<typeof loadContext>>,
  headRef: string,
): void {
  if (!context.isRemediation) return;
  const expectedBranch = context.deliveryBranch ?? context.taskBranch;
  if (expectedBranch && headRef !== expectedBranch) {
    throw new TaskboardValidationError(
      'Remediation pull request head does not match the delivery branch',
      'TASKBOARD_REMEDIATION_BRANCH_MISMATCH',
    );
  }
}

function requireProvider(host: DeliveryPullRequestHost): RepositoryProvider {
  if (!host.repositoryProvider) {
    throw new TaskboardValidationError('Repository provider is unavailable');
  }
  return host.repositoryProvider;
}

function requireIntegrationV3Provider(host: DeliveryPullRequestHost): RepositoryProvider {
  if (!host.integrationV3RepositoryProvider) {
    throw new TaskboardValidationError('Integration v3 repository provider is unavailable', 'TASKBOARD_CI_UNAVAILABLE');
  }
  return host.integrationV3RepositoryProvider;
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  if (!value) return undefined;
  if (typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}
