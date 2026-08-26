import { describe, expect, it, vi } from 'vitest';

import {
  assertPullRequestGate,
  inspectExecutionPullRequest,
  pullRequestGateStatus,
  recordReviewedExecutionSubject,
  type DeliveryPullRequestHost,
} from './deliveryPullRequests.js';
import type { RepositoryPullRequestSnapshot } from './repositoryProvider.js';
import type { TaskboardIdentity } from './types.js';

const identity: TaskboardIdentity = {
  tenantId: 'tenant-1',
  ownerUserId: 'owner-1',
  username: 'owner',
};

const mergedPullRequest: RepositoryPullRequestSnapshot = {
  providerPullRequestId: '32',
  number: 32,
  state: 'merged',
  draft: false,
  headRef: 'fix/task-32',
  headOid: 'head-32',
  baseRef: 'main',
  baseOid: 'base-32',
  mergeCommitOid: 'merge-32',
  mergeable: null,
  requiredChecks: [],
  subjectDigest: 'digest-32',
};

function contextRow() {
  return {
    task_id: 'task-87',
    kind: 'delivery',
    provider_pull_request_id: '32',
    execution_id: 'execution-41',
    purpose: 'review',
    execution_status: 'running',
    transitioned_at: null,
    superseded_at: null,
    repository: {
      provider: 'github', repositoryId: 'github:acme/repo', owner: 'acme', name: 'repo',
      baseBranch: 'main', allowForkPullRequest: false,
    },
    owner_user_id: identity.ownerUserId,
  };
}

function taskRow() {
  const now = new Date('2026-08-18T14:00:00.000Z');
  return {
    id: 'task-87', board_id: 'board-1', identifier: 'TASK-87', kind: 'delivery',
    title: 'Externally merged', description: '', attachments: [], status: 'done', priority: 'high',
    labels: [], sort_order: 1024, provider_pull_request_id: '32', pull_request_number: 32,
    merged_commit_oid: 'merge-32', comment_count: 1, version: 8,
    created_at: now, updated_at: now, completed_at: now,
  };
}

function client(query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>) {
  return { query: vi.fn(query), release: vi.fn() };
}

function hostWithPullRequest(pullRequest: RepositoryPullRequestSnapshot) {
  const loadClient = client(async () => ({ rows: [contextRow()] }));
  const sourceClient = client(async () => ({ rows: [] }));
  const transactionClient = client(async (sql) => {
    if (sql.includes('SELECT id FROM tasks WHERE id=')) return { rows: [{ id: 'task-87' }] };
    if (sql.includes('SELECT id FROM executions') && sql.includes('run_id=')) {
      return { rows: [{ id: 'execution-41' }] };
    }
    if (sql.includes('SELECT provider_pull_request_id FROM tasks')) {
      return { rows: [{ provider_pull_request_id: '32' }] };
    }
    if (sql.includes("SET status='done'")) return { rows: [taskRow()] };
    if (sql.includes("SET status='cancelled'")) {
      return { rows: [{ id: 'execution-41', run_id: 'run-41', fence_epoch: '1', task_id: 'task-87' }] };
    }
    return { rows: [] };
  });
  const clients = [loadClient, sourceClient, transactionClient];
  const host = {
    pool: { connect: vi.fn(async () => clients.shift()!) },
    boardsTable: 'boards', tasksTable: 'tasks', commentsTable: 'comments',
    executionsTable: 'executions', changesTable: 'changes', integrationLanesTable: 'lanes',
    integrationSourcesTable: 'sources', mergeAuthorizationsTable: 'authorizations',
    mergeOperationsTable: 'operations', blockEpisodesTable: 'blocks',
    remediationAttemptsTable: 'attempts',
    cancellationOutboxTable: 'cancellations',
    repositoryProvider: {
      getPullRequest: vi.fn(async () => pullRequest),
      mergePullRequest: vi.fn(),
    },
  } as unknown as DeliveryPullRequestHost;
  return { host, transactionClient };
}

describe('pull request CI gate', () => {
  const current: RepositoryPullRequestSnapshot = {
    ...mergedPullRequest,
    state: 'open',
    mergeCommitOid: undefined,
    requiredChecksKnown: true,
    requiredChecksConfigured: true,
    requiredChecks: [{ name: 'Build & Check', status: 'success' }],
  };

  const statusCases: Array<[RepositoryPullRequestSnapshot, string]> = [
    [{ ...current, requiredChecks: [{ name: 'Build & Check', status: 'pending' }] }, 'pending'],
    [{ ...current, requiredChecks: [{ name: 'Build & Check', status: 'failure' }] }, 'failure'],
    [{ ...current, requiredChecksKnown: false }, 'unavailable'],
    [{ ...current, requiredChecksConfigured: false, requiredChecks: [] }, 'unconfigured'],
    [current, 'success'],
  ];

  it.each(statusCases)('classifies Provider checks fail-closed as %s', (snapshot, expected) => {
    expect(pullRequestGateStatus(snapshot)).toBe(expected);
  });

  it('accepts only the exact registered head/base/subject', () => {
    expect(() => assertPullRequestGate(current, {
      providerPullRequestId: current.providerPullRequestId,
      headOid: current.headOid,
      baseOid: current.baseOid,
      subjectDigest: current.subjectDigest,
    })).not.toThrow();
    expect(() => assertPullRequestGate({ ...current, headOid: 'new-head' }, {
      providerPullRequestId: current.providerPullRequestId,
      headOid: current.headOid,
    })).toThrowError(expect.objectContaining({ code: 'TASKBOARD_SUBJECT_STALE' }));
  });

  const rejectionCases: Array<[RepositoryPullRequestSnapshot, string]> = [
    [{ ...current, requiredChecks: [{ name: 'Build & Check', status: 'pending' }] }, 'TASKBOARD_CI_PENDING'],
    [{ ...current, requiredChecks: [{ name: 'Build & Check', status: 'failure' }] }, 'TASKBOARD_CI_FAILED'],
    [{ ...current, requiredChecksKnown: false }, 'TASKBOARD_CI_UNAVAILABLE'],
    [{ ...current, requiredChecksConfigured: false, requiredChecks: [] }, 'TASKBOARD_CI_UNCONFIGURED'],
  ];

  it.each(rejectionCases)('rejects non-green checks with %s', (snapshot, code) => {
    expect(() => assertPullRequestGate(snapshot, {
      providerPullRequestId: current.providerPullRequestId,
      headOid: current.headOid,
    })).toThrowError(expect.objectContaining({ code }));
  });
});

describe('recordReviewedExecutionSubject external merge reconciliation', () => {
  it('converges an externally merged pull request and fences the active review', async () => {
    const { host, transactionClient } = hostWithPullRequest(mergedPullRequest);

    await expect(recordReviewedExecutionSubject(host, identity, 'run-41')).resolves.toMatchObject({
      status: 'done', mergedCommitOid: 'merge-32',
    });
    expect(transactionClient.query).toHaveBeenCalledWith(
      expect.stringContaining("SET status='cancelled'"),
      expect.arrayContaining([['task-87']]),
    );
    expect(transactionClient.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO cancellations'),
      expect.any(Array),
    );
    expect(transactionClient.query).toHaveBeenCalledWith('COMMIT');
  });

  it('keeps a closed but unmerged pull request fail-closed', async () => {
    const loadClient = client(async () => ({ rows: [contextRow()] }));
    const host = {
      ...hostWithPullRequest(mergedPullRequest).host,
      pool: { connect: vi.fn(async () => loadClient) },
      repositoryProvider: {
        getPullRequest: vi.fn(async () => ({ ...mergedPullRequest, state: 'closed' as const, mergeCommitOid: undefined })),
        mergePullRequest: vi.fn(),
      },
    } as unknown as DeliveryPullRequestHost;

    await expect(recordReviewedExecutionSubject(host, identity, 'run-41')).rejects.toMatchObject({
      code: 'TASKBOARD_PR_NOT_OPEN',
    });
  });
});

describe('Workflow v3 integration Agent PR inspection', () => {
  const snapshot = {
    ...mergedPullRequest,
    state: 'open' as const,
    mergeCommitOid: undefined,
    headRef: 'integration/integration-1',
    headOid: 'agent-head',
    baseOid: 'agent-base',
    requiredChecksKnown: true,
    requiredChecksConfigured: true,
    requiredChecks: [{ name: 'Build & Check', status: 'success' as const }],
    repositoryId: 'github:acme/repo', providerQueriedAt: '2026-08-22T11:00:00.000Z', workflowRuns: [],
  };

  it('uses the Agent rendezvous and generic GitHub provider without Candidate reads', async () => {
    const loadClient = client(async () => ({ rows: [{
      task_id: 'integration-1', kind: 'integration', task_branch: null, provider_pull_request_id: null,
      execution_id: 'review-1', purpose: 'review', execution_status: 'running', transitioned_at: null, superseded_at: null,
      repository: contextRow().repository, owner_user_id: identity.ownerUserId,
      agent_task_id: 'integration-1', agent_provider_pull_request_id: '32', integration_branch: 'integration/integration-1',
    }] }));
    const transactionClient = client(async (sql) => {
      if (sql.includes('SELECT id FROM tasks')) return { rows: [{ id: 'integration-1' }] };
      if (sql.includes('SELECT id FROM executions')) return { rows: [{ id: 'review-1' }] };
      if (sql.includes('FROM sources_agents')) return { rows: [{ provider_pull_request_id: '32', integration_branch: 'integration/integration-1' }] };
      return { rows: [] };
    });
    const inspectPullRequest = vi.fn(async () => snapshot);
    const clients = [loadClient, transactionClient];
    const host = {
      ...hostWithPullRequest(mergedPullRequest).host,
      pool: { connect: vi.fn(async () => clients.shift()!) },
      repositoryProvider: { getPullRequest: vi.fn(), inspectPullRequest, mergePullRequest: vi.fn() },
    } as unknown as DeliveryPullRequestHost;

    await expect(inspectExecutionPullRequest(host, identity, 'run-review-1')).resolves.toMatchObject({
      receipt: { providerPullRequestId: '32', headOid: 'agent-head', integrationAgent: true }, gateStatus: 'success',
    });
    expect(inspectPullRequest).toHaveBeenCalledOnce();
    expect(transactionClient.query.mock.calls.flat().join('\n')).not.toContain('candidates');
  });

  it('records an exact externally merged Agent subject without bypassing merge receipt and cleanup', async () => {
    const mergedAgent = { ...snapshot, state: 'merged' as const, mergeCommitOid: 'merge-agent' };
    const loadClient = client(async () => ({ rows: [{
      task_id: 'integration-1', kind: 'integration', task_branch: null, provider_pull_request_id: null,
      execution_id: 'review-1', purpose: 'review', execution_status: 'running', transitioned_at: null, superseded_at: null,
      repository: contextRow().repository, owner_user_id: identity.ownerUserId,
      agent_task_id: 'integration-1', agent_provider_pull_request_id: '32', integration_branch: 'integration/integration-1',
    }] }));
    const activeTask = { ...taskRow(), id: 'integration-1', kind: 'integration', workflow_version: 3,
      status: 'in_review', merged_commit_oid: null, completed_at: null };
    const transactionClient = client(async (sql) => {
      if (sql.includes('SELECT id FROM tasks')) return { rows: [{ id: 'integration-1' }] };
      if (sql.includes('SELECT id FROM executions')) return { rows: [{ id: 'review-1' }] };
      if (sql.includes('SELECT a.provider_pull_request_id')) return { rows: [{
        provider_pull_request_id: '32', integration_branch: 'integration/integration-1', repository_id: 'github:acme/repo',
        provider_ci_execution_id: 'review-1', provider_ci_purpose: 'review', provider_ci_head_oid: 'agent-head', provider_ci_status: 'success',
      }] };
      if (sql.includes('SET pull_request_number=')) return { rows: [activeTask] };
      return { rows: [] };
    });
    const host = {
      ...hostWithPullRequest(mergedPullRequest).host,
      pool: { connect: vi.fn(async () => [loadClient, transactionClient].shift()!) },
      repositoryProvider: { getPullRequest: vi.fn(async () => mergedAgent), mergePullRequest: vi.fn() },
    } as unknown as DeliveryPullRequestHost;
    const clients = [loadClient, transactionClient];
    (host.pool.connect as ReturnType<typeof vi.fn>).mockImplementation(async () => clients.shift()!);

    await expect(recordReviewedExecutionSubject(host, identity, 'run-review-1')).resolves.toMatchObject({
      id: 'integration-1', status: 'in_review',
    });
    const sql = transactionClient.query.mock.calls.flat().join('\n');
    expect(sql).not.toContain("SET status='done'");
    expect(sql).not.toContain('merge_receipt');
    expect(sql).toContain('review.subject_recorded');
  });

  it.each([
    ['repository', { repositoryId: 'github:other/repo' }],
    ['base', { baseRef: 'release' }],
    ['head', { headOid: 'other-head' }],
    ['branch', { headRef: 'integration/other' }],
  ])('fails closed when an externally merged Agent %s binding drifts', async (_field, patch) => {
    const loadClient = client(async () => ({ rows: [{
      task_id: 'integration-1', kind: 'integration', task_branch: null, provider_pull_request_id: null,
      execution_id: 'review-1', purpose: 'review', execution_status: 'running', transitioned_at: null, superseded_at: null,
      repository: contextRow().repository, owner_user_id: identity.ownerUserId,
      agent_task_id: 'integration-1', agent_provider_pull_request_id: '32', integration_branch: 'integration/integration-1',
    }] }));
    const host = {
      ...hostWithPullRequest(mergedPullRequest).host,
      pool: { connect: vi.fn(async () => loadClient) },
      repositoryProvider: { getPullRequest: vi.fn(async () => ({ ...snapshot, state: 'merged' as const, mergeCommitOid: 'merge-agent', ...patch })), mergePullRequest: vi.fn() },
    } as unknown as DeliveryPullRequestHost;
    await expect(recordReviewedExecutionSubject(host, identity, 'run-review-1'))
      .rejects.toMatchObject({ code: 'TASKBOARD_SUBJECT_STALE' });
  });

  it('rejects an Agent branch drift before recording review evidence', async () => {
    const loadClient = client(async () => ({ rows: [{
      task_id: 'integration-1', kind: 'integration', task_branch: null, provider_pull_request_id: null,
      execution_id: 'review-1', purpose: 'review', execution_status: 'running', transitioned_at: null, superseded_at: null,
      repository: contextRow().repository, owner_user_id: identity.ownerUserId,
      agent_task_id: 'integration-1', agent_provider_pull_request_id: '32', integration_branch: 'integration/changed',
    }] }));
    const host = {
      ...hostWithPullRequest(mergedPullRequest).host,
      pool: { connect: vi.fn(async () => loadClient) },
      repositoryProvider: { getPullRequest: vi.fn(async () => snapshot), mergePullRequest: vi.fn() },
    } as unknown as DeliveryPullRequestHost;
    await expect(recordReviewedExecutionSubject(host, identity, 'run-review-1'))
      .rejects.toMatchObject({ code: 'TASKBOARD_SUBJECT_STALE' });
  });
});
