import type { PoolClient } from 'pg';

import type { TaskBoardIntegrationPolicy, TaskBoardTask } from '../../../../shared/src/types/taskboard.js';
import { assertPullRequestGate } from '../deliveryPullRequests.js';
import { repositoryWithBoardCiPolicy } from '../ciPolicy.js';
import type { RepositoryPullRequestSnapshot } from '../repositoryProvider.js';
import type { TaskboardV2StoreOptions } from '../v2Store.js';
import { TaskboardValidationError } from '../types.js';

export async function assertCurrentPullRequestGate(
  options: TaskboardV2StoreOptions,
  client: PoolClient,
  task: TaskBoardTask,
  board: Record<string, unknown>,
  executionId: string,
  purpose: 'work' | 'review',
): Promise<RepositoryPullRequestSnapshot> {
  const taskResult = await client.query(
    `SELECT provider_pull_request_id,head_oid,base_oid,reviewed_subject_digest,
            provider_ci_inspection_id,provider_ci_execution_id,provider_ci_purpose,
            provider_ci_head_oid,provider_ci_status
       FROM ${options.tasksTable} WHERE id=$1 FOR UPDATE`,
    [task.id],
  );
  const row = taskResult.rows[0];
  const providerPullRequestId = String(row?.provider_pull_request_id ?? '');
  const headOid = String(row?.head_oid ?? '');
  if (!providerPullRequestId || !headOid) {
    throw new TaskboardValidationError('Pull request registration lacks an exact head oid', 'TASKBOARD_PULL_REQUEST_REQUIRED');
  }
  const inspectionResult = await client.query(
    `SELECT payload FROM ${options.changesTable}
      WHERE task_id=$1 AND execution_id=$2 AND change_type='pull_request.inspected'
      ORDER BY seq DESC LIMIT 1`,
    [task.id, executionId],
  );
  const payload = jsonObject(inspectionResult.rows[0]?.payload);
  const receipt = jsonObject(payload?.receipt);
  const inspected = jsonObject(payload?.snapshot);
  if (!payload || !receipt || !inspected
    || receipt.executionId !== executionId
    || receipt.taskId !== task.id
    || receipt.purpose !== purpose
    || receipt.providerPullRequestId !== providerPullRequestId
    || receipt.headOid !== headOid
    || payload.gateStatus !== 'success'
    || row?.provider_ci_inspection_id !== receipt.inspectionId
    || row?.provider_ci_execution_id !== executionId
    || row?.provider_ci_purpose !== purpose
    || row?.provider_ci_head_oid !== headOid
    || row?.provider_ci_status !== 'success') {
    throw new TaskboardValidationError(
      'Current execution must inspect the registered pull request and successful checks for the current head',
      'TASKBOARD_CI_INSPECTION_REQUIRED',
    );
  }
  const repository = jsonObject(board.repository);
  const configuredRepository = repository && repositoryWithBoardCiPolicy(
    repository as { provider: 'github'; repositoryId: string; owner: string; name: string; baseBranch: string; allowForkPullRequest: false },
    jsonObject(board.integration_policy) as TaskBoardIntegrationPolicy | undefined,
  );
  const provider = options.repositoryProvider;
  if (!repository || repository.provider !== 'github' || !provider) {
    throw new TaskboardValidationError('Repository provider is unavailable', 'TASKBOARD_CI_UNAVAILABLE');
  }
  let current: RepositoryPullRequestSnapshot;
  try {
    current = await provider.getPullRequest(
      configuredRepository!,
      providerPullRequestId,
      String(board.owner_user_id),
    );
  } catch (error) {
    throw new TaskboardValidationError(
      `Repository provider inspection failed: ${error instanceof Error ? error.message : String(error)}`,
      'TASKBOARD_CI_UNAVAILABLE',
    );
  }
  assertPullRequestGate(current, {
    providerPullRequestId,
    headOid,
    ...(row?.base_oid ? { baseOid: String(row.base_oid) } : {}),
    ...(purpose === 'review' && row?.reviewed_subject_digest
      ? { subjectDigest: String(row.reviewed_subject_digest) }
      : {}),
    ...(purpose === 'review' ? { requireMergeable: true } : {}),
  });
  return current;
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
