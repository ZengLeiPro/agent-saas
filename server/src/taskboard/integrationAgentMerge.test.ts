import { describe, expect, it, vi } from 'vitest';

import { mergeIntegrationAgent, type IntegrationAgentMergeHost } from './integrationAgentMerge.js';
import type { RepositoryPullRequestSnapshot } from './repositoryProvider.js';
import type { TaskboardIdentity } from './types.js';

const identity: TaskboardIdentity = { tenantId: 'tenant-1', ownerUserId: 'owner-1', username: 'owner' };
const now = '2026-08-25T09:00:00.000Z';

const pullRequest: RepositoryPullRequestSnapshot = {
  providerPullRequestId: '42', number: 42, state: 'open', draft: false,
  headRef: 'integration/integration-1', headOid: 'agent-head', baseRef: 'main', baseOid: 'base',
  mergeable: true, requiredChecksKnown: true, requiredChecksConfigured: true,
  requiredChecks: [{ name: 'Build & Check', status: 'success' }], subjectDigest: 'digest',
};

function integrationTaskRow() {
  return {
    id: 'integration-1', board_id: 'board-1', identifier: 'TB-1', kind: 'integration', workflow_version: 3,
    title: 'Integrate', description: '', status: 'done', priority: 'none', labels: [], sort_order: 0,
    version: 2, created_at: now, updated_at: now, completed_at: now, merged_commit_oid: 'merge-42',
  };
}

function loadedRow(): Record<string, unknown> {
  return {
    ...integrationTaskRow(), status: 'in_progress', merged_commit_oid: null,
    repository: { provider: 'github', repositoryId: 'github:acme/repo', owner: 'acme', name: 'repo', baseBranch: 'main', allowForkPullRequest: false },
    integration_policy: {}, owner_user_id: identity.ownerUserId,
    execution_id: 'merge-execution-1', purpose: 'merge', execution_status: 'running', transitioned_at: null, superseded_at: null,
    provider_pull_request_id: '42', integration_branch: 'integration/integration-1', review_head_oid: 'agent-head',
    verdict: 'approved', review_execution_id: 'review-execution-1', agent_status: 'ready_to_merge',
    review_purpose: 'review', review_transitioned_at: now,
    merge_in_flight_execution_id: null, merge_in_flight_review_execution_id: null, merge_in_flight_review_head_oid: null,
    fence_owner_execution_id: null, fence_owner_execution_status: null,
    fence_owner_transitioned_at: null, fence_owner_superseded_at: null,
  };
}

function finalizationClient(mergeExecutionId = 'merge-execution-1') {
  return {
    release: vi.fn(),
    query: vi.fn(async (sql: string) => {
      if (sql.includes('SELECT id,delivery_task_id,remediation_task_id')) {
        return { rows: [{ id: 'source-1', delivery_task_id: 'delivery-1', remediation_task_id: null }] };
      }
      if (sql.includes('SELECT DISTINCT integration_source_id,remediation_task_id')) return { rows: [] };
      if (sql.includes('FROM sources_agents')) return { rows: [{
        provider_pull_request_id: '42', integration_branch: 'integration/integration-1', status: 'ready_to_merge', verdict: 'approved',
        review_head_oid: 'agent-head', review_execution_id: 'review-execution-1',
        merge_in_flight_execution_id: mergeExecutionId, merge_in_flight_review_execution_id: 'review-execution-1',
        merge_in_flight_review_head_oid: 'agent-head',
      }] };
      if (sql.includes('SELECT * FROM sources') && sql.includes('integration_task_id=$1')) {
        return { rows: [{ id: 'source-1', state: 'ready', merged_commit_oid: null }] };
      }
      if (sql.includes('RETURNING *')) return { rows: [integrationTaskRow()] };
      return { rows: [], rowCount: 0 };
    }),
  };
}

function hostWith(
  provider: { getPullRequest: ReturnType<typeof vi.fn>; mergePullRequest: ReturnType<typeof vi.fn> },
  row = loadedRow(),
) {
  const loadClient = {
    release: vi.fn(),
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM executions e')) return { rows: [row] };
      if (sql.includes('UPDATE sources_agents')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
  };
  const finalized = finalizationClient();
  const clients = [loadClient, finalized];
  return {
    host: {
      pool: { connect: vi.fn(async () => clients.shift()!) },
      tasksTable: 'tasks', boardsTable: 'boards', executionsTable: 'executions', commentsTable: 'comments', changesTable: 'changes',
      integrationLanesTable: 'lanes', integrationSourcesTable: 'sources', mergeAuthorizationsTable: 'authorizations',
      mergeOperationsTable: 'merge_operations', blockEpisodesTable: 'blocks', remediationAttemptsTable: 'remediation_attempts',
      cancellationOutboxTable: 'cancellations', repositoryProvider: provider,
    } as unknown as IntegrationAgentMergeHost,
    loadClient,
    finalized,
    clients,
  };
}

describe('mergeIntegrationAgent', () => {
  it('rejects a review Execution that attempts to invoke the merge gateway directly', async () => {
    const provider = {
      getPullRequest: vi.fn(async () => pullRequest),
      mergePullRequest: vi.fn(),
    };
    const { host } = hostWith(provider, { ...loadedRow(), execution_id: 'review-execution-1', purpose: 'review' });

    await expect(mergeIntegrationAgent(host, identity, 'review-run')).rejects.toMatchObject({
      code: 'TASKBOARD_INTEGRATION_AGENT_MERGE_INVALID',
    });
    expect(provider.getPullRequest).not.toHaveBeenCalled();
    expect(provider.mergePullRequest).not.toHaveBeenCalled();
  });

  it('rejects a new merge execution while the fence owner is still active', async () => {
    const provider = { getPullRequest: vi.fn(async () => pullRequest), mergePullRequest: vi.fn() };
    const { host } = hostWith(provider, {
      ...loadedRow(), execution_id: 'merge-execution-2',
      merge_in_flight_execution_id: 'merge-execution-1',
      merge_in_flight_review_execution_id: 'review-execution-1',
      merge_in_flight_review_head_oid: 'agent-head',
      fence_owner_execution_id: 'merge-execution-1', fence_owner_execution_status: 'waiting_approval',
      fence_owner_transitioned_at: null, fence_owner_superseded_at: null,
    });

    await expect(mergeIntegrationAgent(host, identity, 'run-2')).rejects.toMatchObject({
      code: 'TASKBOARD_INTEGRATION_AGENT_MERGE_IN_FLIGHT',
    });
    expect(provider.getPullRequest).not.toHaveBeenCalled();
  });

  it('fails closed when a terminal owner fence is bound to a different review', async () => {
    const provider = { getPullRequest: vi.fn(async () => pullRequest), mergePullRequest: vi.fn() };
    const { host, loadClient } = hostWith(provider, {
      ...loadedRow(), execution_id: 'merge-execution-2',
      merge_in_flight_execution_id: 'merge-execution-1',
      merge_in_flight_review_execution_id: 'review-execution-old',
      merge_in_flight_review_head_oid: 'agent-head',
      fence_owner_execution_id: 'merge-execution-1', fence_owner_execution_status: 'failed',
      fence_owner_transitioned_at: now, fence_owner_superseded_at: null,
    });

    await expect(mergeIntegrationAgent(host, identity, 'run-2')).rejects.toMatchObject({
      code: 'TASKBOARD_INTEGRATION_AGENT_MERGE_IN_FLIGHT',
    });
    expect(loadClient.query.mock.calls.some(([sql]) => String(sql).includes('AND merge_in_flight_execution_id=$5'))).toBe(false);
    expect(provider.getPullRequest).not.toHaveBeenCalled();
  });

  it('converges every source and delivery after a normal merged receipt', async () => {
    const provider = {
      getPullRequest: vi.fn(async () => pullRequest),
      mergePullRequest: vi.fn(async () => ({ providerRequestId: 'request-1', providerPullRequestId: '42', merged: true, mergedCommitOid: 'merge-42', raw: {} })),
    };
    const { host, finalized } = hostWith(provider);

    await expect(mergeIntegrationAgent(host, identity, 'run-1')).resolves.toMatchObject({
      id: 'integration-1', status: 'done', mergedCommitOid: 'merge-42',
    });
    expect(provider.mergePullRequest).toHaveBeenCalledOnce();
    const queries = finalized.query.mock.calls.map(([sql]) => String(sql)).join('\n');
    expect(queries).toContain("SET state='merged',provider_receipt_id");
    expect(queries).toContain("SET status='done',merged_commit_oid=$2");
    expect(finalized.query.mock.calls).toContainEqual([
      expect.stringContaining('terminal_reason_code=$3'),
      [['integration-1'], 'merge-execution-1', 'integration_converged'],
    ]);
    expect(queries).toContain("SET status='merged',merge_in_flight_execution_id=NULL");
  });

  it.each([
    ['merge', {}],
    ['squash', { execution: { mergeMethod: 'squash' } }],
    ['rebase', { execution: { mergeMethod: 'rebase' } }],
  ] as const)('uses the board integration merge method %s', async (method, integrationPolicy) => {
    const provider = {
      getPullRequest: vi.fn(async () => pullRequest),
      mergePullRequest: vi.fn(async () => ({ providerRequestId: 'request-1', providerPullRequestId: '42', merged: true, mergedCommitOid: 'merge-42', raw: {} })),
    };
    const { host } = hostWith(provider, { ...loadedRow(), integration_policy: integrationPolicy });

    await mergeIntegrationAgent(host, identity, 'run-1');

    expect(provider.mergePullRequest).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ method }), identity.ownerUserId);
  });

  it('atomically takes over a terminal owner fence for the same review and converges an already merged PR', async () => {
    const mergedPullRequest = { ...pullRequest, state: 'merged' as const, mergeCommitOid: 'merge-42' };
    const provider = {
      getPullRequest: vi.fn()
        .mockResolvedValueOnce(pullRequest)
        .mockResolvedValueOnce(mergedPullRequest),
      mergePullRequest: vi.fn(async () => ({ providerRequestId: 'request-1', providerPullRequestId: '42', merged: true, mergedCommitOid: 'merge-42', raw: {} })),
    };
    const { host, loadClient, finalized, clients } = hostWith(provider);
    finalized.query.mockRejectedValueOnce(new Error('finalizer unavailable'));

    await expect(mergeIntegrationAgent(host, identity, 'run-1')).rejects.toThrow('finalizer unavailable');

    const recoveryRow = {
      ...loadedRow(), execution_id: 'merge-execution-2',
      merge_in_flight_execution_id: 'merge-execution-1',
      merge_in_flight_review_execution_id: 'review-execution-1',
      merge_in_flight_review_head_oid: 'agent-head',
      fence_owner_execution_id: 'merge-execution-1', fence_owner_execution_status: 'failed',
      fence_owner_transitioned_at: now, fence_owner_superseded_at: null,
    };
    loadClient.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM executions e')) return { rows: [recoveryRow] };
      if (sql.includes('UPDATE sources_agents')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const recoveredFinalizer = finalizationClient('merge-execution-2');
    clients.push(loadClient, recoveredFinalizer);
    await expect(mergeIntegrationAgent(host, identity, 'run-2')).resolves.toMatchObject({
      status: 'done', mergedCommitOid: 'merge-42',
    });

    expect(loadClient.query).toHaveBeenCalledWith(
      expect.stringContaining('AND merge_in_flight_execution_id=$5'),
      ['integration-1', 'merge-execution-2', 'review-execution-1', 'agent-head', 'merge-execution-1'],
    );
    expect(provider.mergePullRequest).toHaveBeenCalledOnce();
    expect(provider.getPullRequest).toHaveBeenCalledTimes(2);
    expect(recoveredFinalizer.query).toHaveBeenCalledWith(
      expect.stringContaining("SET state='merged',provider_receipt_id"), expect.any(Array),
    );
  });

  it('fails closed when an already merged pull request has no merge commit oid', async () => {
    const provider = {
      getPullRequest: vi.fn(async () => ({ ...pullRequest, state: 'merged' as const })),
      mergePullRequest: vi.fn(),
    };
    const { host, finalized } = hostWith(provider);

    await expect(mergeIntegrationAgent(host, identity, 'run-1')).rejects.toMatchObject({
      code: 'TASKBOARD_PROVIDER_RECEIPT_INCOMPLETE',
    });
    expect(provider.mergePullRequest).not.toHaveBeenCalled();
    expect(finalized.query).not.toHaveBeenCalled();
  });

  it('re-reads a timed-out provider merge and converges an already merged PR without retrying merge', async () => {
    const provider = {
      getPullRequest: vi.fn()
        .mockResolvedValueOnce(pullRequest)
        .mockResolvedValueOnce({ ...pullRequest, state: 'merged', mergeCommitOid: 'merge-42' }),
      mergePullRequest: vi.fn(async () => { throw new Error('provider timeout'); }),
    };
    const { host, finalized } = hostWith(provider);

    await expect(mergeIntegrationAgent(host, identity, 'run-1')).resolves.toMatchObject({ status: 'done', mergedCommitOid: 'merge-42' });
    expect(provider.mergePullRequest).toHaveBeenCalledOnce();
    expect(provider.getPullRequest).toHaveBeenCalledTimes(2);
    expect(finalized.query).toHaveBeenCalledWith(expect.stringContaining("SET state='merged',provider_receipt_id"), expect.any(Array));
  });

  it('does not converge local state when a provider exception re-reads as still open', async () => {
    const providerError = new Error('provider timeout');
    const provider = {
      getPullRequest: vi.fn(async () => pullRequest),
      mergePullRequest: vi.fn(async () => { throw providerError; }),
    };
    const { host, finalized } = hostWith(provider);

    await expect(mergeIntegrationAgent(host, identity, 'run-1')).rejects.toBe(providerError);
    expect(provider.mergePullRequest).toHaveBeenCalledOnce();
    expect(provider.getPullRequest).toHaveBeenCalledTimes(2);
    expect(finalized.query).not.toHaveBeenCalled();
  });
});
