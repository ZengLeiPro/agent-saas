import type { PoolClient } from 'pg';

import type { TaskBoardIntegrationPolicy, TaskBoardTask } from '../../../shared/src/types/taskboard.js';
import { repositoryWithBoardCiPolicy } from './ciPolicy.js';
import { assertPullRequestGate } from './deliveryPullRequests.js';
import { integrationAgentTableNames } from './integrationAgentSchema.js';
import { rowToTask } from './storeHelpers.js';
import type { RepositoryMergeReceipt, RepositoryProvider, RepositoryPullRequestSnapshot } from './repositoryProvider.js';
import { TaskboardNotFoundError, TaskboardValidationError, type TaskboardIdentity } from './types.js';

export interface IntegrationAgentMergeHost {
  pool: { connect(): Promise<PoolClient> };
  tasksTable: string;
  boardsTable: string;
  executionsTable: string;
  commentsTable: string;
  changesTable: string;
  integrationLanesTable: string;
  integrationSourcesTable: string;
  mergeAuthorizationsTable: string;
  mergeOperationsTable: string;
  blockEpisodesTable: string;
  remediationAttemptsTable: string;
  cancellationOutboxTable: string;
  repositoryProvider?: RepositoryProvider;
}

/** Final Agent merge gate. It fences resume durably, then performs provider I/O without a DB transaction. */
export async function mergeIntegrationAgent(
  host: IntegrationAgentMergeHost,
  identity: TaskboardIdentity,
  runId: string,
): Promise<TaskBoardTask> {
  if (!host.repositoryProvider) throw new TaskboardValidationError('Repository provider is unavailable', 'TASKBOARD_CI_UNAVAILABLE');
  const client = await host.pool.connect();
  let row: Record<string, unknown> | undefined;
  let fenceMarked = false;
  let mergeAuthorityMayHaveCommitted = false;
  const { agentsTable } = integrationAgentTableNames(host.integrationSourcesTable);
  try {
    await client.query('BEGIN');
    const loaded = await client.query(
      `SELECT t.*,b.repository,b.integration_policy,b.owner_user_id,
              e.id AS execution_id,e.purpose,e.status AS execution_status,e.transitioned_at,e.superseded_at,
              a.provider_pull_request_id,a.integration_branch,a.review_head_oid,a.verdict,a.review_execution_id,a.status AS agent_status,
              a.merge_in_flight_execution_id,a.merge_in_flight_review_execution_id,a.merge_in_flight_review_head_oid,
              review_e.purpose AS review_purpose,review_e.transitioned_at AS review_transitioned_at,
              fence_e.id AS fence_owner_execution_id,fence_e.status AS fence_owner_execution_status,
              fence_e.transitioned_at AS fence_owner_transitioned_at,fence_e.superseded_at AS fence_owner_superseded_at,
              review_i.payload AS review_inspection_payload
         FROM ${host.executionsTable} e
         JOIN ${host.tasksTable} t ON t.id=e.task_id
         JOIN ${host.boardsTable} b ON b.id=t.board_id
         JOIN ${agentsTable} a ON a.integration_task_id=t.id
         LEFT JOIN ${host.executionsTable} review_e ON review_e.id=a.review_execution_id AND review_e.task_id=t.id
         LEFT JOIN ${host.executionsTable} fence_e ON fence_e.id=a.merge_in_flight_execution_id AND fence_e.task_id=t.id
         LEFT JOIN LATERAL (
           SELECT c.payload FROM ${host.changesTable} c
            WHERE c.task_id=t.id AND c.execution_id=a.review_execution_id
              AND c.change_type='pull_request.inspected'
            ORDER BY c.seq DESC LIMIT 1
         ) review_i ON true
        WHERE e.run_id=$1 AND b.tenant_id=$2 AND (b.owner_user_id=$3 OR b.visibility='organization')
        FOR UPDATE OF t,e,a`, [runId, identity.tenantId, identity.ownerUserId],
    );
    row = loaded.rows[0];
    if (!row) throw new TaskboardNotFoundError('Integration Agent execution not found');
    if (row.kind !== 'integration' || Number(row.workflow_version) !== 3 || row.purpose !== 'merge'
      || !['queued', 'running', 'waiting_user', 'waiting_approval'].includes(String(row.execution_status))
      || row.transitioned_at || row.superseded_at) {
      throw new TaskboardValidationError('Current execution cannot merge the integration Agent pull request', 'TASKBOARD_INTEGRATION_AGENT_MERGE_INVALID');
    }
    const executionId = String(row.execution_id);
    const pullRequestId = String(row.provider_pull_request_id ?? '');
    const reviewHeadOid = String(row.review_head_oid ?? '');
    const reviewExecutionId = String(row.review_execution_id ?? '');
    if (row.agent_status !== 'ready_to_merge' || row.verdict !== 'approved' || !reviewExecutionId
      || row.review_purpose !== 'review' || !row.review_transitioned_at || !pullRequestId || !reviewHeadOid) {
      throw new TaskboardValidationError('Integration Agent lacks a head-bound approved review', 'TASKBOARD_INTEGRATION_AGENT_REVIEW_REQUIRED');
    }
    const existingFence = String(row.merge_in_flight_execution_id ?? '');
    const existingFenceReviewExecutionId = String(row.merge_in_flight_review_execution_id ?? '');
    const existingFenceReviewHeadOid = String(row.merge_in_flight_review_head_oid ?? '');
    if (existingFence && (existingFenceReviewExecutionId !== reviewExecutionId
      || existingFenceReviewHeadOid !== reviewHeadOid)) {
      throw new TaskboardValidationError('Another Integration Agent merge is already in flight', 'TASKBOARD_INTEGRATION_AGENT_MERGE_IN_FLIGHT');
    }
    if (existingFence && existingFence !== executionId) {
      const fenceOwnerActive = Boolean(row.fence_owner_execution_id)
        && ['queued', 'running', 'waiting_user', 'waiting_approval'].includes(String(row.fence_owner_execution_status))
        && !row.fence_owner_transitioned_at && !row.fence_owner_superseded_at;
      if (fenceOwnerActive) {
        throw new TaskboardValidationError('Another Integration Agent merge is already in flight', 'TASKBOARD_INTEGRATION_AGENT_MERGE_IN_FLIGHT');
      }
      const takeover = await client.query(
        `UPDATE ${agentsTable}
            SET merge_in_flight_execution_id=$2,updated_at=now()
          WHERE integration_task_id=$1 AND status='ready_to_merge' AND verdict='approved'
            AND review_execution_id=$3 AND review_head_oid=$4
            AND merge_in_flight_execution_id=$5
            AND merge_in_flight_review_execution_id=$3 AND merge_in_flight_review_head_oid=$4`,
        [String(row.id), executionId, reviewExecutionId, reviewHeadOid, existingFence],
      );
      if (takeover.rowCount !== 1) {
        throw new TaskboardValidationError('Another Integration Agent merge is already in flight', 'TASKBOARD_INTEGRATION_AGENT_MERGE_IN_FLIGHT');
      }
    } else if (!existingFence) {
      const marked = await client.query(
        `UPDATE ${agentsTable}
            SET merge_in_flight_execution_id=$2,merge_in_flight_review_execution_id=$3,
                merge_in_flight_review_head_oid=$4,updated_at=now()
          WHERE integration_task_id=$1 AND status='ready_to_merge' AND verdict='approved'
            AND review_execution_id=$3 AND review_head_oid=$4
            AND merge_in_flight_execution_id IS NULL`,
        [String(row.id), executionId, reviewExecutionId, reviewHeadOid],
      );
      if (marked.rowCount !== 1) {
        throw new TaskboardValidationError('Another Integration Agent merge is already in flight', 'TASKBOARD_INTEGRATION_AGENT_MERGE_IN_FLIGHT');
      }
    }
    fenceMarked = true;
    await client.query('COMMIT');

    const repository = jsonObject(row.repository);
    if (!repository || repository.provider !== 'github') throw new TaskboardValidationError('Board repository is not configured', 'TASKBOARD_REPOSITORY_REQUIRED');
    const policy = jsonObject(row.integration_policy) as TaskBoardIntegrationPolicy | undefined;
    const configured = repositoryWithBoardCiPolicy(repository as { provider: 'github'; repositoryId: string; owner: string; name: string; baseBranch: string; allowForkPullRequest: false }, policy);
    const configuredMethod = policy?.execution?.mergeMethod;
    const mergeMethod = configuredMethod === 'rebase' || configuredMethod === 'squash' ? configuredMethod : 'merge';
    const inspectionPayload = jsonObject(row.review_inspection_payload);
    const inspectionReceipt = jsonObject(inspectionPayload?.receipt);
    const reviewed = jsonObject(inspectionPayload?.snapshot);
    const expectedBaseOid = String(reviewed?.baseOid ?? '');
    const reviewedSubjectDigest = String(reviewed?.subjectDigest ?? '');
    if (inspectionPayload?.gateStatus !== 'success' || inspectionReceipt?.executionId !== reviewExecutionId
      || inspectionReceipt?.taskId !== String(row.id) || inspectionReceipt?.purpose !== 'review'
      || inspectionReceipt?.providerPullRequestId !== pullRequestId || inspectionReceipt?.headOid !== reviewHeadOid
      || reviewed?.providerPullRequestId !== pullRequestId || reviewed?.headOid !== reviewHeadOid
      || reviewed?.baseRef !== configured.baseBranch || reviewed?.headRef !== String(row.integration_branch)
      || !expectedBaseOid || !reviewedSubjectDigest) {
      throw new TaskboardValidationError('Integration Agent approval lacks an exact reviewed revision', 'TASKBOARD_INTEGRATION_AGENT_REVIEW_REQUIRED');
    }
    if (!host.repositoryProvider.getCommit) {
      throw new TaskboardValidationError('Repository provider cannot verify merge trees', 'TASKBOARD_CI_UNAVAILABLE');
    }
    const ownerUserId = String(row.owner_user_id);
    const reviewedCommit = await host.repositoryProvider.getCommit(configured, reviewHeadOid, ownerUserId);
    if (reviewedCommit.oid !== reviewHeadOid || !reviewedCommit.treeOid) {
      throw new TaskboardValidationError('Reviewed head tree could not be verified', 'TASKBOARD_SUBJECT_STALE');
    }
    const current = await host.repositoryProvider.getPullRequest(configured, pullRequestId, ownerUserId);
    assertExactSubject(current, {
      providerPullRequestId: pullRequestId, headOid: reviewHeadOid, headRef: String(row.integration_branch),
      baseRef: configured.baseBranch, baseOid: expectedBaseOid, subjectDigest: reviewedSubjectDigest,
    });
    let receipt: RepositoryMergeReceipt | undefined;
    const operationKey = `integration-agent:${String(row.id)}:${expectedBaseOid}:${reviewHeadOid}:${reviewedCommit.treeOid}`;
    if (current.state === 'merged') {
      mergeAuthorityMayHaveCommitted = true;
      if (!current.mergeCommitOid) {
        throw new TaskboardValidationError('Provider did not return the merged commit oid', 'TASKBOARD_PROVIDER_RECEIPT_INCOMPLETE');
      }
      if (!existingFence) {
        throw new TaskboardValidationError('Merged pull request is not bound to a prior controlled merge attempt', 'TASKBOARD_MERGE_RECEIPT_CONFLICT');
      }
      receipt = {
        providerRequestId: operationKey,
        providerPullRequestId: pullRequestId,
        merged: true,
        mergedCommitOid: current.mergeCommitOid,
        raw: { recoveredMergedPullRequest: true },
      };
    } else {
      assertPullRequestGate(current, {
        providerPullRequestId: pullRequestId, headOid: reviewHeadOid, baseOid: expectedBaseOid,
        subjectDigest: reviewedSubjectDigest, requireMergeable: true,
      });
    }

    let mergedFacts = current;
    if (!receipt) try {
      mergeAuthorityMayHaveCommitted = true;
      receipt = await host.repositoryProvider.mergePullRequest(configured, {
        providerPullRequestId: pullRequestId, expectedHeadOid: reviewHeadOid, method: mergeMethod,
        requestId: operationKey, operationKey,
      }, ownerUserId);
      if (receipt.providerRequestId !== operationKey || receipt.providerPullRequestId !== pullRequestId) {
        throw new TaskboardValidationError('Provider merge receipt is not bound to this request', 'TASKBOARD_PROVIDER_RECEIPT_INCOMPLETE');
      }
      mergedFacts = await host.repositoryProvider.getPullRequest(configured, pullRequestId, ownerUserId);
    } catch (error) {
      if (error instanceof TaskboardValidationError) throw error;
      // A timeout can mean GitHub merged the PR but the response was lost. Keep the
      // fence if reconciliation itself is unavailable so the same execution can retry.
      const afterError = await host.repositoryProvider.getPullRequest(configured, pullRequestId, ownerUserId);
      if (afterError.state !== 'merged') {
        mergeAuthorityMayHaveCommitted = false;
        throw error;
      }
      mergedFacts = afterError;
      if (!afterError.mergeCommitOid) {
        throw new TaskboardValidationError('Provider did not return the merged commit oid', 'TASKBOARD_PROVIDER_RECEIPT_INCOMPLETE');
      }
      receipt = {
        providerRequestId: operationKey,
        providerPullRequestId: pullRequestId,
        merged: true,
        mergedCommitOid: afterError.mergeCommitOid,
        raw: { reconciledAfterProviderError: true },
      };
    }
    if (!receipt.merged || !receipt.mergedCommitOid) {
      mergeAuthorityMayHaveCommitted = false;
      throw new TaskboardValidationError(receipt.message ?? 'Provider did not confirm merge', 'TASKBOARD_PROVIDER_RECEIPT_INCOMPLETE');
    }
    assertExactSubject(mergedFacts, {
      providerPullRequestId: pullRequestId, headOid: reviewHeadOid, headRef: String(row.integration_branch),
      baseRef: configured.baseBranch, baseOid: expectedBaseOid, subjectDigest: reviewedSubjectDigest,
    });
    if (mergedFacts.state !== 'merged' || mergedFacts.mergeCommitOid !== receipt.mergedCommitOid) {
      throw new TaskboardValidationError('Provider facts do not match the merge receipt', 'TASKBOARD_PROVIDER_RECEIPT_INCOMPLETE');
    }
    const mergedCommit = await host.repositoryProvider.getCommit(configured, receipt.mergedCommitOid, ownerUserId);
    if (mergedCommit.oid !== receipt.mergedCommitOid || mergedCommit.treeOid !== reviewedCommit.treeOid) {
      throw new TaskboardValidationError('Merged tree does not match the approved revision', 'TASKBOARD_MERGE_RECEIPT_CONFLICT');
    }
    // Provider merge and local terminal convergence are deliberately separate.  Persist
    // the authority receipt first; cleanup must reconcile remote/file facts before the
    // current Execution may finish the task.
    const recorded = await client.query(
      `UPDATE ${agentsTable}
          SET merge_receipt=$2::jsonb,updated_at=now()
        WHERE integration_task_id=$1 AND merge_in_flight_execution_id=$3
        RETURNING integration_task_id`,
      [String(row.id), JSON.stringify({
        providerRequestId: receipt.providerRequestId,
        providerPullRequestId: pullRequestId,
        integrationBranch: String(row.integration_branch),
        reviewHeadOid,
        reviewExecutionId,
        executionId: String(row.execution_id),
        runId,
        mergedCommitOid: receipt.mergedCommitOid,
        raw: {
          providerRequestId: receipt.providerRequestId,
          providerPullRequestId: pullRequestId,
          mergedCommitOid: receipt.mergedCommitOid,
          approvedRevision: { baseOid: expectedBaseOid, headOid: reviewHeadOid, treeOid: reviewedCommit.treeOid },
          providerFacts: {
            providerPullRequestId: mergedFacts.providerPullRequestId, baseRef: mergedFacts.baseRef,
            baseOid: mergedFacts.baseOid, headRef: mergedFacts.headRef, headOid: mergedFacts.headOid,
            subjectDigest: mergedFacts.subjectDigest, state: mergedFacts.state,
            mergeCommitOid: mergedCommit.oid, mergedTreeOid: mergedCommit.treeOid,
          },
          providerReceipt: receipt.raw,
        },
      }), String(row.execution_id)],
    );
    if (!recorded.rows[0]) throw new TaskboardValidationError('Integration Agent merge fence changed before receipt persistence', 'TASKBOARD_CONTEXT_STALE');
    return rowToTask(row);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (fenceMarked && row && !mergeAuthorityMayHaveCommitted) {
      await client.query(
        `UPDATE ${agentsTable}
            SET merge_in_flight_execution_id=NULL,merge_in_flight_review_execution_id=NULL,
                merge_in_flight_review_head_oid=NULL,updated_at=now()
          WHERE integration_task_id=$1 AND merge_in_flight_execution_id=$2
            AND merge_in_flight_review_execution_id=$3 AND merge_in_flight_review_head_oid=$4`,
        [String(row.id), String(row.execution_id), String(row.review_execution_id), String(row.review_head_oid)],
      ).catch(() => undefined);
    }
    throw error;
  } finally { client.release(); }
}

function assertExactSubject(
  actual: RepositoryPullRequestSnapshot,
  expected: Pick<RepositoryPullRequestSnapshot, 'providerPullRequestId' | 'headOid' | 'headRef' | 'baseRef' | 'baseOid' | 'subjectDigest'>,
): void {
  if (actual.providerPullRequestId !== expected.providerPullRequestId || actual.headOid !== expected.headOid
    || actual.headRef !== expected.headRef || actual.baseRef !== expected.baseRef || actual.baseOid !== expected.baseOid
    || actual.subjectDigest !== expected.subjectDigest) {
    throw new TaskboardValidationError('Integration Agent review is stale after pull request subject drift', 'TASKBOARD_SUBJECT_STALE');
  }
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
