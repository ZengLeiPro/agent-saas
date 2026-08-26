import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { PoolClient } from 'pg';

import type { TaskBoardIntegrationPolicy, TaskBoardRepositoryConfig, TaskBoardTask } from '../../../shared/src/types/taskboard.js';
import { repositoryWithBoardCiPolicy } from './ciPolicy.js';
import { finalizeMergedIntegrationAgent } from './integrationFinalization.js';
import { integrationAgentTableNames } from './integrationAgentSchema.js';
import { isCanonicalGithubRepositoryRemote, type RepositoryProvider } from './repositoryProvider.js';
import { TaskboardNotFoundError, TaskboardValidationError, type TaskboardIdentity } from './types.js';

const exec = promisify(execFile);

export interface IntegrationAgentCleanupHost {
  pool: { connect(): Promise<PoolClient> };
  tasksTable: string; boardsTable: string; executionsTable: string; commentsTable: string; changesTable: string;
  integrationLanesTable: string; integrationSourcesTable: string; mergeAuthorizationsTable: string;
  mergeOperationsTable: string; blockEpisodesTable: string; remediationAttemptsTable: string; cancellationOutboxTable: string;
  repositoryProvider?: RepositoryProvider;
}

type MergeReceipt = {
  providerRequestId: string; providerPullRequestId: string; integrationBranch: string; reviewHeadOid: string;
  reviewExecutionId: string; executionId: string; runId: string; mergedCommitOid: string; raw: Record<string, unknown>;
};

/** Reconciles provider and local worktree facts. Every completed unit is durably checkpointed. */
export async function cleanupIntegrationAgent(
  host: IntegrationAgentCleanupHost,
  identity: TaskboardIdentity,
  runId: string,
  workspace: { id: string; root: string },
): Promise<TaskBoardTask> {
  const provider = host.repositoryProvider;
  if (!provider?.closePullRequest || !provider.deleteBranch) {
    throw new TaskboardValidationError('Repository provider cleanup capability is unavailable', 'TASKBOARD_CI_UNAVAILABLE');
  }
  const client = await host.pool.connect();
  const { agentsTable } = integrationAgentTableNames(host.integrationSourcesTable);
  try {
    const loaded = await client.query(
      `SELECT t.*,b.repository,b.integration_policy,b.owner_user_id,e.id AS execution_id,e.session_id,
              a.integration_branch,a.provider_pull_request_id,a.merge_receipt,a.cleanup_receipt,a.durable_session_id,
              COALESCE(jsonb_agg(jsonb_build_object('sourceId',s.id,'providerPullRequestId',s.provider_pull_request_id,
                'frozenHeadOid',s.frozen_head_oid,'branch',d.branch,
                'deliveryProviderPullRequestId',d.provider_pull_request_id)) FILTER (WHERE s.id IS NOT NULL),'[]'::jsonb) AS sources
         FROM ${host.executionsTable} e JOIN ${host.tasksTable} t ON t.id=e.task_id
         JOIN ${host.boardsTable} b ON b.id=t.board_id JOIN ${agentsTable} a ON a.integration_task_id=t.id
         LEFT JOIN ${host.integrationSourcesTable} s ON s.integration_task_id=t.id
         LEFT JOIN ${host.tasksTable} d ON d.id=s.delivery_task_id
        WHERE e.run_id=$1 AND b.tenant_id=$2 AND (b.owner_user_id=$3 OR b.visibility='organization')
        GROUP BY t.id,b.repository,b.integration_policy,b.owner_user_id,e.id,e.session_id,a.integration_branch,
                 a.provider_pull_request_id,a.merge_receipt,a.cleanup_receipt,a.durable_session_id`,
      [runId, identity.tenantId, identity.ownerUserId],
    );
    const row = loaded.rows[0];
    if (!row) throw new TaskboardNotFoundError('Integration Agent execution not found');
    if (row.kind !== 'integration' || Number(row.workflow_version) !== 3 || String(row.execution_id) !== receipt(row.merge_receipt).executionId
      || String(row.durable_session_id ?? '') !== String(row.session_id ?? '')) {
      throw new TaskboardValidationError('Cleanup is not bound to the current Integration Agent execution', 'TASKBOARD_INTEGRATION_AGENT_MERGE_INVALID');
    }
    const merge = receipt(row.merge_receipt);
    if (!merge.mergedCommitOid || merge.providerPullRequestId !== String(row.provider_pull_request_id)
      || merge.integrationBranch !== String(row.integration_branch)) {
      throw new TaskboardValidationError('A bound merge receipt is required before cleanup', 'TASKBOARD_INTEGRATION_INCOMPLETE');
    }
    const repositoryRaw = object(row.repository);
    if (repositoryRaw?.provider !== 'github') throw new TaskboardValidationError('Board repository is not configured', 'TASKBOARD_REPOSITORY_REQUIRED');
    const repository = repositoryWithBoardCiPolicy(repositoryRaw as unknown as TaskBoardRepositoryConfig, object(row.integration_policy) as TaskBoardIntegrationPolicy | undefined);
    const owner = String(row.owner_user_id);
    const progress = object(row.cleanup_receipt) ?? { version: 1, workspaceId: workspace.id, sources: {} };
    if (String(progress.workspaceId ?? workspace.id) !== workspace.id) throw new TaskboardValidationError('Cleanup workspace binding changed', 'TASKBOARD_SUBJECT_STALE');
    const sourceProgress = object(progress.sources) ?? {};
    for (const value of Array.isArray(row.sources) ? row.sources : []) {
      const source = object(value)!;
      const sourceId = String(source.sourceId);
      const providerPullRequestId = String(source.providerPullRequestId ?? '');
      const frozenHeadOid = String(source.frozenHeadOid ?? '');
      const branch = String(source.branch ?? '');
      if (!providerPullRequestId || providerPullRequestId !== String(source.deliveryProviderPullRequestId ?? '') || !branch
        || branch === repository.baseBranch || branch === merge.integrationBranch) {
        throw new TaskboardValidationError('Source cleanup binding is incomplete', 'TASKBOARD_SUBJECT_STALE');
      }
      if (!frozenHeadOid) {
        throw new TaskboardValidationError(
          `Source ${sourceId} has no verified frozen head; re-review and recreate its integration source`,
          'TASKBOARD_CONTEXT_STALE',
        );
      }
      const current = await provider.getPullRequest(repository, providerPullRequestId, owner);
      if (current.providerPullRequestId !== providerPullRequestId || current.baseRef !== repository.baseBranch
        || current.headRef !== branch || current.headOid !== frozenHeadOid) {
        throw new TaskboardValidationError(
          `Source ${sourceId} head drifted from reviewed ${frozenHeadOid}; cleanup was not authorized`,
          'TASKBOARD_CONTEXT_STALE',
        );
      }
      await provider.deleteBranch(repository, { ref: branch, expectedOid: frozenHeadOid, operationKey: `integration-agent-cleanup:${row.id}:source-branch:${sourceId}` }, owner);
      if (current.state === 'open') await provider.closePullRequest(repository, { providerPullRequestId, operationKey: `integration-agent-cleanup:${row.id}:source-pr:${sourceId}` }, owner);
      sourceProgress[sourceId] = { done: true, providerPullRequestId, branch, headOid: frozenHeadOid };
      progress.sources = sourceProgress;
      await checkpoint(client, agentsTable, String(row.id), progress);
    }
    await provider.deleteBranch(repository, { ref: merge.integrationBranch, expectedOid: merge.reviewHeadOid, operationKey: `integration-agent-cleanup:${row.id}:integration-branch` }, owner);
    progress.integrationBranchDone = true;
    await checkpoint(client, agentsTable, String(row.id), progress);
    await removeBoundWorktree(workspace.root, merge.integrationBranch, repository);
    progress.worktreeDone = true;
    await checkpoint(client, agentsTable, String(row.id), progress);
    progress.completed = true;
    await checkpoint(client, agentsTable, String(row.id), progress);
    return finalizeMergedIntegrationAgent(host, String(row.id), {
      providerRequestId: merge.providerRequestId, mergedCommitOid: merge.mergedCommitOid, raw: merge.raw,
      exceptExecutionId: merge.executionId,
      expectedAgent: { providerPullRequestId: merge.providerPullRequestId, integrationBranch: merge.integrationBranch },
      event: { runId: merge.runId, executionId: merge.executionId, reviewHeadOid: merge.reviewHeadOid, reviewExecutionId: merge.reviewExecutionId },
    });
  } finally { client.release(); }
}

async function checkpoint(client: PoolClient, table: string, taskId: string, value: Record<string, unknown>): Promise<void> {
  await client.query(`UPDATE ${table} SET cleanup_receipt=$2::jsonb,updated_at=now() WHERE integration_task_id=$1`, [taskId, JSON.stringify(value)]);
}

async function removeBoundWorktree(root: string, branch: string, repository: TaskBoardRepositoryConfig): Promise<void> {
  try { await lstat(root); } catch { return; }
  const canonicalRoot = await realpath(root);
  const git = async (...args: string[]) => (await exec('git', ['-C', canonicalRoot, ...args], { timeout: 20_000 })).stdout.trim();
  const top = await realpath(await git('rev-parse', '--show-toplevel'));
  const currentBranch = await git('symbolic-ref', '--short', 'HEAD');
  const origin = await git('remote', 'get-url', 'origin');
  if (top !== canonicalRoot || currentBranch !== branch || !isCanonicalGithubRepositoryRemote(origin, repository)) {
    throw new TaskboardValidationError('Workspace is not the exact task integration worktree', 'TASKBOARD_SUBJECT_STALE');
  }
  if (await git('status', '--porcelain')) throw new TaskboardValidationError('Integration worktree is dirty', 'TASKBOARD_CONTEXT_STALE');
  const commonDir = await realpath(await git('rev-parse', '--git-common-dir'));
  await exec('git', [`--git-dir=${commonDir}`, 'worktree', 'remove', '--', canonicalRoot], { timeout: 20_000 });
}

function receipt(value: unknown): MergeReceipt { return object(value) as MergeReceipt ?? {} as MergeReceipt; }
function object(value: unknown): Record<string, any> | undefined { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined; }
