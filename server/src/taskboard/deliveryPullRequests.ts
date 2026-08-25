import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import type { TaskBoardIntegrationPolicy, TaskBoardTask } from '../../../shared/src/types/taskboard.js';
import { finalizeMergedSource, type IntegrationOperationHost } from './integrationOperations.js';
import { integrationAgentTableNames } from './integrationAgentSchema.js';
import { repositoryWithBoardCiPolicy } from './ciPolicy.js';
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
  integrationAgent?: boolean;
}

export interface ExecutionPullRequestInspection {
  receipt: ExecutionPullRequestInspectionReceipt;
  snapshot: RepositoryPullRequestInspection;
  gateStatus: 'success' | 'pending' | 'failure' | 'unavailable' | 'unconfigured';
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
  const provider = requireProvider(host);
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
    ...(context.isIntegrationAgent ? { integrationAgent: true } : {}),
  };
  const client = await host.pool.connect();
  try {
    await client.query('BEGIN');
    await lockExecution(client, host, runId, context.taskId);
    if (context.isIntegrationAgent) {
      const { agentsTable } = integrationAgentTableNames(host.integrationSourcesTable);
      const current = await client.query(
        `SELECT provider_pull_request_id,integration_branch FROM ${agentsTable}
          WHERE integration_task_id=$1 FOR UPDATE`, [context.taskId],
      );
      if (String(current.rows[0]?.provider_pull_request_id ?? '') !== snapshot.providerPullRequestId
        || String(current.rows[0]?.integration_branch ?? '') !== snapshot.headRef) {
        throw new TaskboardValidationError('Integration Agent pull request changed during inspection', 'TASKBOARD_SUBJECT_STALE');
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
  const provider = requireProvider(host);
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
  if (snapshot.requiredChecksConfigured === false) return 'unconfigured';
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
  if (snapshot.requiredChecksConfigured === false) {
    throw new TaskboardValidationError(
      'CI gate is not configured: add GitHub required checks or this board\'s explicit CI fallback',
      'TASKBOARD_CI_UNCONFIGURED',
    );
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
    if (context.isIntegrationAgent) {
      const { agentsTable } = integrationAgentTableNames(host.integrationSourcesTable);
      const updated = await client.query(
        `UPDATE ${agentsTable} SET provider_pull_request_id=$2,review_head_oid=NULL,verdict=NULL,
            review_execution_id=NULL,updated_at=now()
          WHERE integration_task_id=$1 AND integration_branch=$3 RETURNING integration_task_id`,
        [context.taskId, pullRequest.providerPullRequestId, pullRequest.headRef],
      );
      if (!updated.rows[0]) throw new TaskboardValidationError('Integration Agent branch changed before pull request attachment', 'TASKBOARD_SUBJECT_STALE');
    } else {
      await client.query(
        `UPDATE ${host.tasksTable}
            SET provider_pull_request_id=$2, pull_request_number=$3,
                head_oid=$4, base_oid=$5, reviewed_subject_digest=NULL,
                provider_ci_inspection_id=NULL,provider_ci_execution_id=NULL,
                provider_ci_purpose=NULL,provider_ci_head_oid=NULL,
                provider_ci_status=NULL,provider_ci_inspected_at=NULL,
                version=version+1, updated_at=now()
          WHERE id=$1`,
        [context.taskId, pullRequest.providerPullRequestId, pullRequest.number, pullRequest.headOid, pullRequest.baseOid],
      );
    }
    const result = await client.query(
      `SELECT t.*, (SELECT count(*)::int FROM ${host.commentsTable} c
        WHERE c.task_id=t.id AND ${visibleCommentPredicate('c', host.changesTable)}) AS comment_count
       FROM ${host.tasksTable} t WHERE t.id=$1`, [context.taskId],
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
  const provider = requireProvider(host);
  const pullRequest = await provider.getPullRequest(
    context.repository,
    context.providerPullRequestId,
    context.boardOwnerUserId,
  );
  assertPullRequestIdentity(context, pullRequest);
  if (pullRequest.state === 'merged') {
    if (!pullRequest.mergeCommitOid) {
      throw new TaskboardValidationError(
        'Provider did not return the merged commit oid',
        'TASKBOARD_PROVIDER_RECEIPT_INCOMPLETE',
      );
    }
    if (!context.isIntegrationAgent) {
      return reconcileExternallyMergedPullRequest(host, context, {
        ...pullRequest,
        mergeCommitOid: pullRequest.mergeCommitOid,
      });
    }
    // Do not converge here. The review may race an external merge, but an
    // Integration Agent must still transition through merge receipt persistence,
    // checkpointed cleanup, and the single finalization state machine.
  } else if (pullRequest.state !== 'open' || pullRequest.draft) {
    throw new TaskboardValidationError('Pull request is not reviewable', 'TASKBOARD_PR_NOT_OPEN');
  }
  const client = await host.pool.connect();
  try {
    await client.query('BEGIN');
    await lockExecution(client, host, runId, context.taskId);
    if (context.isIntegrationAgent) {
      const { agentsTable } = integrationAgentTableNames(host.integrationSourcesTable);
      const current = await client.query(
        `SELECT a.provider_pull_request_id,a.integration_branch,a.repository_id,
                t.provider_ci_execution_id,t.provider_ci_purpose,t.provider_ci_head_oid,t.provider_ci_status
           FROM ${agentsTable} a JOIN ${host.tasksTable} t ON t.id=a.integration_task_id
          WHERE a.integration_task_id=$1 FOR UPDATE OF a,t`, [context.taskId],
      );
      const binding = current.rows[0];
      if (String(binding?.provider_pull_request_id ?? '') !== pullRequest.providerPullRequestId
        || String(binding?.integration_branch ?? '') !== pullRequest.headRef
        || String(binding?.repository_id ?? '') !== context.repository.repositoryId
        || String(binding?.provider_ci_execution_id ?? '') !== context.executionId
        || String(binding?.provider_ci_purpose ?? '') !== 'review'
        || String(binding?.provider_ci_head_oid ?? '') !== pullRequest.headOid
        || String(binding?.provider_ci_status ?? '') !== 'success') {
        throw new TaskboardValidationError('Integration Agent pull request changed during review', 'TASKBOARD_SUBJECT_STALE');
      }
    } else {
      const current = await client.query(
        `SELECT provider_pull_request_id FROM ${host.tasksTable} WHERE id=$1 FOR UPDATE`,
        [context.taskId],
      );
      if (current.rows[0]?.provider_pull_request_id !== context.providerPullRequestId) {
        throw new TaskboardValidationError('Pull request changed during review', 'TASKBOARD_SUBJECT_STALE');
      }
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
  isIntegrationAgent: boolean;
  providerPullRequestId?: string;
  integrationBranch?: string;
  sourceProviderPullRequestId?: string;
  deliveryProviderPullRequestId?: string;
  taskBranch?: string;
  deliveryBranch?: string;
  repository: { provider: 'github'; repositoryId: string; owner: string; name: string; baseBranch: string; allowForkPullRequest: false };
  boardOwnerUserId: string;
}> {
  const client = await host.pool.connect();
  try {
    const { agentsTable } = integrationAgentTableNames(host.integrationSourcesTable);
    const result = await client.query(
      `SELECT t.id AS task_id,t.kind,t.branch AS task_branch,t.provider_pull_request_id,
              e.id AS execution_id,e.purpose,e.status AS execution_status,e.transitioned_at,e.superseded_at,
              b.repository,b.integration_policy,b.owner_user_id,
              agent.integration_task_id AS agent_task_id,
              agent.provider_pull_request_id AS agent_provider_pull_request_id,
              agent.integration_branch,
              remediation_source.provider_pull_request_id AS source_provider_pull_request_id,
              delivery.provider_pull_request_id AS delivery_provider_pull_request_id,
              delivery.branch AS delivery_branch
         FROM ${host.executionsTable} e
         JOIN ${host.tasksTable} t ON t.id=e.task_id
         JOIN ${host.boardsTable} b ON b.id=t.board_id
         LEFT JOIN ${agentsTable} agent ON agent.integration_task_id=t.id
         LEFT JOIN LATERAL (
           SELECT s.provider_pull_request_id,s.delivery_task_id
             FROM ${host.integrationSourcesTable} s
            WHERE s.remediation_task_id=t.id
            ORDER BY s.updated_at DESC,s.id LIMIT 1
         ) remediation_source ON true
         LEFT JOIN ${host.tasksTable} delivery ON delivery.id=remediation_source.delivery_task_id
        WHERE e.run_id=$1 AND b.tenant_id=$2
          AND (b.owner_user_id=$3 OR b.visibility='organization') LIMIT 1`,
      [runId, identity.tenantId, identity.ownerUserId],
    );
    const row = result.rows[0];
    if (!row) throw new TaskboardNotFoundError('Taskboard execution not found');
    const kind = String(row.kind);
    const purpose = String(row.purpose);
    const isIntegrationAgent = kind === 'integration' && Boolean(row.agent_task_id);
    if ((!['delivery', 'remediation'].includes(kind) && !isIntegrationAgent) || !purposes.includes(purpose)) {
      throw new TaskboardValidationError('Execution purpose cannot inspect the current pull request');
    }
    if (row.transitioned_at || row.superseded_at
      || !['queued', 'running', 'waiting_user', 'waiting_approval'].includes(String(row.execution_status))) {
      throw new TaskboardValidationError('Taskboard execution is no longer active');
    }
    const repository = jsonObject(row.repository);
    if (!repository || repository.provider !== 'github') {
      throw new TaskboardValidationError('Board repository is not configured');
    }
    return {
      taskId: String(row.task_id), executionId: String(row.execution_id), runId,
      purpose: purpose as 'work' | 'review', isRemediation: kind === 'remediation', isIntegrationAgent,
      ...(isIntegrationAgent && row.agent_provider_pull_request_id
        ? { providerPullRequestId: String(row.agent_provider_pull_request_id) }
        : row.provider_pull_request_id ? { providerPullRequestId: String(row.provider_pull_request_id) } : {}),
      ...(row.integration_branch ? { integrationBranch: String(row.integration_branch) } : {}),
      ...(row.source_provider_pull_request_id ? { sourceProviderPullRequestId: String(row.source_provider_pull_request_id) } : {}),
      ...(row.delivery_provider_pull_request_id ? { deliveryProviderPullRequestId: String(row.delivery_provider_pull_request_id) } : {}),
      ...(row.task_branch ? { taskBranch: String(row.task_branch) } : {}),
      ...(row.delivery_branch ? { deliveryBranch: String(row.delivery_branch) } : {}),
      repository: repositoryWithBoardCiPolicy(repository as {
        provider: 'github'; repositoryId: string; owner: string; name: string; baseBranch: string; allowForkPullRequest: false;
      }, jsonObject(row.integration_policy) as TaskBoardIntegrationPolicy | undefined),
      boardOwnerUserId: String(row.owner_user_id),
    };
  } finally { client.release(); }
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
        AND transitioned_at IS NULL AND superseded_at IS NULL
      FOR UPDATE`,
    [runId, taskId],
  );
  if (!result.rows[0]) throw new TaskboardValidationError('Taskboard execution changed');
}

function assertPullRequestIdentity(
  context: Awaited<ReturnType<typeof loadContext>>,
  snapshot: RepositoryPullRequestSnapshot,
): void {
  if (('repositoryId' in snapshot && snapshot.repositoryId !== context.repository.repositoryId)
    || snapshot.providerPullRequestId !== context.providerPullRequestId
    || snapshot.baseRef !== context.repository.baseBranch) {
    throw new TaskboardValidationError('Provider returned a pull request outside the registered subject', 'TASKBOARD_SUBJECT_STALE');
  }
  if (context.isIntegrationAgent && snapshot.headRef !== context.integrationBranch) {
    throw new TaskboardValidationError('Provider returned a pull request outside the integration Agent branch', 'TASKBOARD_SUBJECT_STALE');
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
    integrationAgent: context.isIntegrationAgent,
    integrationBranch: context.integrationBranch,
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
