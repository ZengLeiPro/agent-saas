import { describe, expect, it, vi } from 'vitest';

import { cleanupIntegrationAgent, type IntegrationAgentCleanupHost } from './integrationAgentCleanup.js';
import type { TaskboardIdentity } from './types.js';

const identity: TaskboardIdentity = { tenantId: 'tenant-1', ownerUserId: 'owner-1', username: 'owner' };
const now = '2026-08-25T09:00:00.000Z';

function taskRow() {
  return { id: 'integration-1', board_id: 'board-1', identifier: 'TB-1', kind: 'integration', workflow_version: 3,
    title: 'Integrate', description: '', status: 'in_progress', priority: 'none', labels: [], sort_order: 0,
    version: 2, created_at: now, updated_at: now };
}

function finalizerClient() {
  return { release: vi.fn(), query: vi.fn(async (sql: string) => {
    if (sql.includes('SELECT id,delivery_task_id,remediation_task_id')) return { rows: [{ id: 'source-1', delivery_task_id: 'delivery-1', remediation_task_id: null }] };
    if (sql.includes('SELECT DISTINCT integration_source_id,remediation_task_id')) return { rows: [] };
    if (sql.includes('FROM sources_agents')) return { rows: [{ provider_pull_request_id: '42', integration_branch: 'integration/integration-1', status: 'ready_to_merge', verdict: 'approved', review_head_oid: 'agent-head', review_execution_id: 'review-1', merge_in_flight_execution_id: 'merge-1', merge_in_flight_review_execution_id: 'review-1', merge_in_flight_review_head_oid: 'agent-head' }] };
    if (sql.includes('SELECT * FROM sources') && sql.includes('integration_task_id=$1')) return { rows: [{ id: 'source-1', state: 'ready', merged_commit_oid: null }] };
    if (sql.includes('RETURNING *')) return { rows: [{ ...taskRow(), status: 'done', completed_at: now, merged_commit_oid: 'merge-42' }] };
    return { rows: [], rowCount: 0 };
  }) };
}

function loadClient(cleanupReceipt: Record<string, unknown>) {
  return { release: vi.fn(), query: vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes('FROM executionsTable')) return { rows: [] };
    if (sql.includes('FROM executions e')) return { rows: [{
      ...taskRow(), repository: { provider: 'github', repositoryId: 'github:acme/repo', owner: 'acme', name: 'repo', baseBranch: 'main', allowForkPullRequest: false }, integration_policy: {}, owner_user_id: 'owner-1',
      execution_id: 'merge-1', session_id: 'session-1', durable_session_id: 'session-1', integration_branch: 'integration/integration-1', provider_pull_request_id: '42',
      merge_receipt: { providerRequestId: 'request-1', providerPullRequestId: '42', integrationBranch: 'integration/integration-1', reviewHeadOid: 'agent-head', reviewExecutionId: 'review-1', executionId: 'merge-1', runId: 'run-1', mergedCommitOid: 'merge-42', raw: {} },
      cleanup_receipt: cleanupReceipt,
      sources: [{ sourceId: 'source-1', providerPullRequestId: '11', deliveryProviderPullRequestId: '11', branch: 'feature/source-1' }],
    }] };
    if (sql.includes('SET cleanup_receipt=')) Object.assign(cleanupReceipt, JSON.parse(String(values?.[1])));
    return { rows: [], rowCount: 1 };
  }) };
}

describe('cleanupIntegrationAgent', () => {
  it('keeps the task in progress on branch failure and resumes from provider/file facts', async () => {
    const cleanupReceipt: Record<string, unknown> = { version: 1, workspaceId: 'workspace-1', sources: {}, worktreeDone: true };
    const first = loadClient(cleanupReceipt); const second = loadClient(cleanupReceipt); const finalized = finalizerClient();
    let sourceOpen = true; let failSourceBranch = true;
    const provider = {
      getPullRequest: vi.fn(async () => ({ providerPullRequestId: '11', number: 11, state: sourceOpen ? 'open' : 'closed', draft: false, headRef: 'feature/source-1', headOid: 'source-head', baseRef: 'main', baseOid: 'base', mergeable: true, requiredChecks: [], subjectDigest: 'digest' })),
      closePullRequest: vi.fn(async () => { sourceOpen = false; return { operationKey: 'close', providerPullRequestId: '11', raw: {} }; }),
      deleteBranch: vi.fn(async (_repository: unknown, input: { ref: string }) => {
        if (input.ref === 'feature/source-1' && failSourceBranch) { failSourceBranch = false; throw new Error('branch delete failed'); }
        return { operationKey: 'delete', ref: input.ref, deleted: true, raw: {} };
      }),
      mergePullRequest: vi.fn(),
    };
    const clients = [first, second, finalized];
    const host = { pool: { connect: vi.fn(async () => clients.shift()!) }, tasksTable: 'tasks', boardsTable: 'boards', executionsTable: 'executions', commentsTable: 'comments', changesTable: 'changes', integrationLanesTable: 'lanes', integrationSourcesTable: 'sources', mergeAuthorizationsTable: 'auths', mergeOperationsTable: 'ops', blockEpisodesTable: 'blocks', remediationAttemptsTable: 'attempts', cancellationOutboxTable: 'cancel', repositoryProvider: provider } as unknown as IntegrationAgentCleanupHost;

    await expect(cleanupIntegrationAgent(host, identity, 'run-1', { id: 'workspace-1', root: '/already-removed' })).rejects.toThrow('branch delete failed');
    expect(cleanupReceipt).not.toHaveProperty('completed');
    await expect(cleanupIntegrationAgent(host, identity, 'run-1', { id: 'workspace-1', root: '/already-removed' })).resolves.toMatchObject({ status: 'done' });
    expect(provider.closePullRequest).toHaveBeenCalledOnce();
    expect(provider.deleteBranch).toHaveBeenCalledTimes(3);
    expect(cleanupReceipt).toMatchObject({ integrationBranchDone: true, worktreeDone: true, completed: true });
  });
});
