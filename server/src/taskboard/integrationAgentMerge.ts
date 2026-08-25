import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import type { TaskBoardIntegrationPolicy, TaskBoardTask } from '../../../shared/src/types/taskboard.js';
import { repositoryWithBoardCiPolicy } from './ciPolicy.js';
import { assertPullRequestGate } from './deliveryPullRequests.js';
import { integrationAgentTableNames } from './integrationAgentSchema.js';
import type { RepositoryProvider } from './repositoryProvider.js';
import { rowToTask } from './storeHelpers.js';
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
  repositoryProvider?: RepositoryProvider;
}

/** Final Agent merge gate. It always re-reads GitHub immediately before merge. */
export async function mergeIntegrationAgent(
  host: IntegrationAgentMergeHost,
  identity: TaskboardIdentity,
  runId: string,
): Promise<TaskBoardTask> {
  if (!host.repositoryProvider) throw new TaskboardValidationError('Repository provider is unavailable', 'TASKBOARD_CI_UNAVAILABLE');
  const client = await host.pool.connect();
  try {
    await client.query('BEGIN');
    const { agentsTable } = integrationAgentTableNames(host.integrationSourcesTable);
    const loaded = await client.query(
      `SELECT t.*,b.repository,b.integration_policy,b.owner_user_id,
              e.id AS execution_id,e.purpose,e.status AS execution_status,e.transitioned_at,e.superseded_at,
              a.provider_pull_request_id,a.integration_branch,a.review_head_oid,a.verdict,a.review_execution_id,a.status AS agent_status
         FROM ${host.executionsTable} e
         JOIN ${host.tasksTable} t ON t.id=e.task_id
         JOIN ${host.boardsTable} b ON b.id=t.board_id
         JOIN ${agentsTable} a ON a.integration_task_id=t.id
        WHERE e.run_id=$1 AND b.tenant_id=$2 AND (b.owner_user_id=$3 OR b.visibility='organization')
        FOR UPDATE OF t,e,a`, [runId, identity.tenantId, identity.ownerUserId],
    );
    const row = loaded.rows[0];
    if (!row) throw new TaskboardNotFoundError('Integration Agent execution not found');
    if (row.kind !== 'integration' || Number(row.workflow_version) !== 3 || row.purpose !== 'merge'
      || !['queued', 'running', 'waiting_user', 'waiting_approval'].includes(String(row.execution_status))
      || row.transitioned_at || row.superseded_at) {
      throw new TaskboardValidationError('Current execution cannot merge the integration Agent pull request', 'TASKBOARD_INTEGRATION_AGENT_MERGE_INVALID');
    }
    const pullRequestId = String(row.provider_pull_request_id ?? '');
    const reviewHeadOid = String(row.review_head_oid ?? '');
    if (row.agent_status !== 'ready_to_merge' || row.verdict !== 'approved' || !row.review_execution_id || !pullRequestId || !reviewHeadOid) {
      throw new TaskboardValidationError('Integration Agent lacks a head-bound approved review', 'TASKBOARD_INTEGRATION_AGENT_REVIEW_REQUIRED');
    }
    const repository = jsonObject(row.repository);
    if (!repository || repository.provider !== 'github') throw new TaskboardValidationError('Board repository is not configured', 'TASKBOARD_REPOSITORY_REQUIRED');
    const configured = repositoryWithBoardCiPolicy(repository as { provider: 'github'; repositoryId: string; owner: string; name: string; baseBranch: string; allowForkPullRequest: false }, jsonObject(row.integration_policy) as TaskBoardIntegrationPolicy | undefined);
    const current = await host.repositoryProvider.getPullRequest(configured, pullRequestId, String(row.owner_user_id));
    assertPullRequestGate(current, { providerPullRequestId: pullRequestId, headOid: reviewHeadOid, requireMergeable: true });
    if (current.baseRef !== configured.baseBranch || current.headRef !== String(row.integration_branch)) {
      throw new TaskboardValidationError('Integration Agent review is stale after pull request subject drift', 'TASKBOARD_SUBJECT_STALE');
    }
    const receipt = await host.repositoryProvider.mergePullRequest(configured, {
      providerPullRequestId: pullRequestId, expectedHeadOid: reviewHeadOid, method: 'squash', requestId: randomUUID(),
      operationKey: `integration-agent:${String(row.id)}:${reviewHeadOid}`,
    }, String(row.owner_user_id));
    if (!receipt.merged || !receipt.mergedCommitOid) {
      throw new TaskboardValidationError(receipt.message ?? 'Provider did not confirm merge', 'TASKBOARD_PROVIDER_RECEIPT_INCOMPLETE');
    }
    await client.query(`UPDATE ${agentsTable} SET status='merged',updated_at=now() WHERE integration_task_id=$1`, [row.id]);
    const taskResult = await client.query(
      `UPDATE ${host.tasksTable} SET status='done',merged_commit_oid=$2,completed_at=now(),workflow_epoch=workflow_epoch+1,
          next_action='none',next_action_revision=next_action_revision+1,version=version+1,updated_at=now()
        WHERE id=$1 RETURNING *`, [row.id, receipt.mergedCommitOid],
    );
    await client.query(`UPDATE ${host.mergeAuthorizationsTable} SET revoked_at=now() WHERE integration_task_id=$1 AND revoked_at IS NULL`, [row.id]);
    await client.query(`UPDATE ${host.integrationLanesTable} SET active_integration_task_id=NULL,lease_id=NULL,epoch=epoch+1,updated_at=now() WHERE active_integration_task_id=$1`, [row.id]);
    await client.query(
      `INSERT INTO ${host.changesTable}(task_id,change_type,actor_type,actor_id,execution_id,payload)
       VALUES ($1,'integration.agent.merge.succeeded','agent',$2,$3,$4::jsonb)`,
      [row.id, runId, row.execution_id, JSON.stringify({ providerPullRequestId: pullRequestId, reviewHeadOid, reviewExecutionId: row.review_execution_id, mergedCommitOid: receipt.mergedCommitOid })],
    );
    await client.query('COMMIT');
    return rowToTask(taskResult.rows[0]!);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
