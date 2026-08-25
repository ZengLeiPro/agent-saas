import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import type { TaskBoardIntegrationPolicy, TaskBoardTask } from '../../../shared/src/types/taskboard.js';
import { repositoryWithBoardCiPolicy } from './ciPolicy.js';
import { assertPullRequestGate } from './deliveryPullRequests.js';
import { integrationAgentTableNames } from './integrationAgentSchema.js';
import { finalizeMergedIntegrationAgent } from './integrationFinalization.js';
import type { RepositoryMergeReceipt, RepositoryProvider } from './repositoryProvider.js';
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
              review_e.purpose AS review_purpose,review_e.transitioned_at AS review_transitioned_at
         FROM ${host.executionsTable} e
         JOIN ${host.tasksTable} t ON t.id=e.task_id
         JOIN ${host.boardsTable} b ON b.id=t.board_id
         JOIN ${agentsTable} a ON a.integration_task_id=t.id
         LEFT JOIN ${host.executionsTable} review_e ON review_e.id=a.review_execution_id AND review_e.task_id=t.id
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
    if (existingFence && (existingFence !== executionId
      || String(row.merge_in_flight_review_execution_id ?? '') !== reviewExecutionId
      || String(row.merge_in_flight_review_head_oid ?? '') !== reviewHeadOid)) {
      throw new TaskboardValidationError('Another Integration Agent merge is already in flight', 'TASKBOARD_INTEGRATION_AGENT_MERGE_IN_FLIGHT');
    }
    if (!existingFence) {
      await client.query(
        `UPDATE ${agentsTable}
            SET merge_in_flight_execution_id=$2,merge_in_flight_review_execution_id=$3,
                merge_in_flight_review_head_oid=$4,updated_at=now()
          WHERE integration_task_id=$1 AND status='ready_to_merge' AND verdict='approved'
            AND review_execution_id=$3 AND review_head_oid=$4
            AND merge_in_flight_execution_id IS NULL`,
        [String(row.id), executionId, reviewExecutionId, reviewHeadOid],
      );
    }
    fenceMarked = true;
    await client.query('COMMIT');

    const repository = jsonObject(row.repository);
    if (!repository || repository.provider !== 'github') throw new TaskboardValidationError('Board repository is not configured', 'TASKBOARD_REPOSITORY_REQUIRED');
    const policy = jsonObject(row.integration_policy) as TaskBoardIntegrationPolicy | undefined;
    const configured = repositoryWithBoardCiPolicy(repository as { provider: 'github'; repositoryId: string; owner: string; name: string; baseBranch: string; allowForkPullRequest: false }, policy);
    const configuredMethod = policy?.execution?.mergeMethod;
    const mergeMethod = configuredMethod === 'rebase' || configuredMethod === 'squash' ? configuredMethod : 'merge';
    const current = await host.repositoryProvider.getPullRequest(configured, pullRequestId, String(row.owner_user_id));
    if (current.providerPullRequestId !== pullRequestId || current.headOid !== reviewHeadOid
      || current.baseRef !== configured.baseBranch || current.headRef !== String(row.integration_branch)) {
      throw new TaskboardValidationError('Integration Agent review is stale after pull request subject drift', 'TASKBOARD_SUBJECT_STALE');
    }
    let receipt: RepositoryMergeReceipt | undefined;
    if (current.state === 'merged') {
      mergeAuthorityMayHaveCommitted = true;
      if (!current.mergeCommitOid) {
        throw new TaskboardValidationError('Provider did not return the merged commit oid', 'TASKBOARD_PROVIDER_RECEIPT_INCOMPLETE');
      }
      receipt = {
        providerRequestId: `recovered-merged:${pullRequestId}:${current.mergeCommitOid}`,
        providerPullRequestId: pullRequestId,
        merged: true,
        mergedCommitOid: current.mergeCommitOid,
        raw: { recoveredMergedPullRequest: true, pullRequest: current },
      };
    } else {
      assertPullRequestGate(current, { providerPullRequestId: pullRequestId, headOid: reviewHeadOid, requireMergeable: true });
    }

    const requestId = randomUUID();
    if (!receipt) try {
      mergeAuthorityMayHaveCommitted = true;
      receipt = await host.repositoryProvider.mergePullRequest(configured, {
        providerPullRequestId: pullRequestId, expectedHeadOid: reviewHeadOid, method: mergeMethod, requestId,
        operationKey: `integration-agent:${String(row.id)}:${reviewHeadOid}`,
      }, String(row.owner_user_id));
    } catch (error) {
      // A timeout can mean GitHub merged the PR but the response was lost. Keep the
      // fence if reconciliation itself is unavailable so the same execution can retry.
      const afterError = await host.repositoryProvider.getPullRequest(configured, pullRequestId, String(row.owner_user_id));
      if (afterError.state !== 'merged') {
        mergeAuthorityMayHaveCommitted = false;
        throw error;
      }
      if (afterError.providerPullRequestId !== pullRequestId || afterError.headOid !== reviewHeadOid
        || afterError.baseRef !== configured.baseBranch || afterError.headRef !== String(row.integration_branch)) {
        throw new TaskboardValidationError('Integration Agent review is stale after pull request subject drift', 'TASKBOARD_SUBJECT_STALE');
      }
      if (!afterError.mergeCommitOid) {
        throw new TaskboardValidationError('Provider did not return the merged commit oid', 'TASKBOARD_PROVIDER_RECEIPT_INCOMPLETE');
      }
      receipt = {
        providerRequestId: requestId,
        providerPullRequestId: pullRequestId,
        merged: true,
        mergedCommitOid: afterError.mergeCommitOid,
        raw: { reconciledAfterProviderError: true, pullRequest: afterError },
      };
    }
    if (!receipt.merged || !receipt.mergedCommitOid) {
      mergeAuthorityMayHaveCommitted = false;
      throw new TaskboardValidationError(receipt.message ?? 'Provider did not confirm merge', 'TASKBOARD_PROVIDER_RECEIPT_INCOMPLETE');
    }
    return finalizeMergedIntegrationAgent(host, String(row.id), {
      providerRequestId: receipt.providerRequestId,
      mergedCommitOid: receipt.mergedCommitOid,
      raw: receipt.raw,
      exceptExecutionId: String(row.execution_id),
      expectedAgent: { providerPullRequestId: pullRequestId, integrationBranch: String(row.integration_branch) },
      event: { runId, executionId: String(row.execution_id), reviewHeadOid, reviewExecutionId },
    });
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

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
