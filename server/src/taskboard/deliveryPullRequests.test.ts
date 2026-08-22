import { describe, expect, it, vi } from 'vitest';

import {
  assertPullRequestGate,
  inspectExecutionPullRequest,
  pullRequestGateStatus,
  recordReviewedExecutionSubject,
} from './deliveryPullRequests.js';
import type { IntegrationOperationHost } from './integrationOperations.js';
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
    resolved_at: null,
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
    remediationAttemptsTable: 'attempts', resolutionsTable: 'resolutions',
    cancellationOutboxTable: 'cancellations',
    repositoryProvider: {
      getPullRequest: vi.fn(async () => pullRequest),
      mergePullRequest: vi.fn(),
    },
  } as unknown as IntegrationOperationHost;
  return { host, transactionClient };
}

describe('pull request CI gate', () => {
  const current: RepositoryPullRequestSnapshot = {
    ...mergedPullRequest,
    state: 'open',
    mergeCommitOid: undefined,
    requiredChecksKnown: true,
    requiredChecks: [{ name: 'Build & Check', status: 'success' }],
  };

  const statusCases: Array<[RepositoryPullRequestSnapshot, string]> = [
    [{ ...current, requiredChecks: [{ name: 'Build & Check', status: 'pending' }] }, 'pending'],
    [{ ...current, requiredChecks: [{ name: 'Build & Check', status: 'failure' }] }, 'failure'],
    [{ ...current, requiredChecksKnown: false }, 'unavailable'],
    [{ ...current, requiredChecks: [] }, 'pending'],
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
    [{ ...current, requiredChecks: [] }, 'TASKBOARD_CI_PENDING'],
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
    } as unknown as IntegrationOperationHost;

    await expect(recordReviewedExecutionSubject(host, identity, 'run-41')).rejects.toMatchObject({
      code: 'TASKBOARD_PR_NOT_OPEN',
    });
  });
});

describe('Workflow v3 candidate PR inspection', () => {
  it('binds a Review receipt to the exact candidate revision and current head', async () => {
    const snapshot = {
      ...mergedPullRequest,
      state: 'open' as const,
      mergeCommitOid: undefined,
      headRef: 'integration/integration-1',
      headOid: 'candidate-head',
      baseOid: 'candidate-base',
      requiredChecksKnown: true,
      requiredChecks: [{ name: 'Build & Check', status: 'success' as const }],
      repositoryId: 'github:acme/repo',
      providerQueriedAt: '2026-08-22T11:00:00.000Z',
      workflowRuns: [],
    };
    const loadClient = client(async () => ({ rows: [{
      task_id: 'integration-1', kind: 'integration', task_branch: null, provider_pull_request_id: null,
      execution_id: 'review-1', purpose: 'review', execution_status: 'running', resolved_at: null, superseded_at: null,
      execution_candidate_id: 'candidate-1', execution_candidate_revision: 3,
      execution_candidate_head_oid: 'candidate-head',
      repository: contextRow().repository, owner_user_id: identity.ownerUserId,
      candidate_id: 'candidate-1', candidate_revision: 3, candidate_provider_pull_request_id: '32',
      candidate_branch: 'integration/integration-1', candidate_head_oid: 'candidate-head',
      candidate_base_oid: 'candidate-base', candidate_subject_digest: 'candidate-subject-3',
    }] }));
    const transactionClient = client(async (sql) => {
      if (sql.includes('SELECT id FROM tasks')) return { rows: [{ id: 'integration-1' }] };
      if (sql.includes('SELECT id FROM executions')) return { rows: [{ id: 'review-1' }] };
      if (sql.includes('FROM sources_candidates c')) return { rows: [{
        provider_pull_request_id: '32', current_revision: 3, head_oid: 'candidate-head',
        subject_digest: 'candidate-subject-3',
      }] };
      return { rows: [] };
    });
    const clients = [loadClient, transactionClient];
    const host = {
      ...hostWithPullRequest(mergedPullRequest).host,
      pool: { connect: vi.fn(async () => clients.shift()!) },
      repositoryProvider: {
        getPullRequest: vi.fn(async () => snapshot),
        inspectPullRequest: vi.fn(async () => snapshot),
        mergePullRequest: vi.fn(),
      },
    } as unknown as IntegrationOperationHost;

    const result = await inspectExecutionPullRequest(host, identity, 'run-review-1');

    expect(result.gateStatus).toBe('success');
    expect(result.receipt).toMatchObject({
      taskId: 'integration-1', executionId: 'review-1', purpose: 'review',
      candidateId: 'candidate-1', candidateRevision: 3, candidateSubjectDigest: 'candidate-subject-3',
      providerPullRequestId: '32', headOid: 'candidate-head',
    });
    expect(transactionClient.query).toHaveBeenCalledWith('COMMIT');
  });

  it('rejects a stale Review execution before inspecting a newer candidate revision', async () => {
    const loadClient = client(async () => ({ rows: [{
      task_id: 'integration-1', kind: 'integration', task_branch: null, provider_pull_request_id: null,
      execution_id: 'review-1', purpose: 'review', execution_status: 'running', resolved_at: null, superseded_at: null,
      execution_candidate_id: 'candidate-1', execution_candidate_revision: 2,
      execution_candidate_head_oid: 'old-head',
      repository: contextRow().repository, owner_user_id: identity.ownerUserId,
      candidate_id: 'candidate-1', candidate_revision: 3, candidate_provider_pull_request_id: '32',
      candidate_branch: 'integration/integration-1', candidate_head_oid: 'candidate-head',
      candidate_base_oid: 'candidate-base', candidate_subject_digest: 'candidate-subject-3',
    }] }));
    const inspectPullRequest = vi.fn();
    const host = {
      ...hostWithPullRequest(mergedPullRequest).host,
      pool: { connect: vi.fn(async () => loadClient) },
      repositoryProvider: {
        getPullRequest: vi.fn(), inspectPullRequest, mergePullRequest: vi.fn(),
      },
    } as unknown as IntegrationOperationHost;

    await expect(inspectExecutionPullRequest(host, identity, 'run-review-1'))
      .rejects.toMatchObject({ code: 'TASKBOARD_SUBJECT_STALE' });
    expect(inspectPullRequest).not.toHaveBeenCalled();
  });
});
