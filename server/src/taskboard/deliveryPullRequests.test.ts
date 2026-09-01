import { describe, expect, it, vi } from 'vitest';

import {
  inspectExecutionPullRequest,
  readExecutionPullRequestJobLog,
  type DeliveryPullRequestHost,
} from './deliveryPullRequests.js';
import type { RepositoryPullRequestInspection } from './repositoryProvider.js';
import type { TaskboardIdentity } from './types.js';

const identity: TaskboardIdentity = {
  tenantId: 'tenant-1',
  ownerUserId: 'owner-1',
  username: 'owner',
};

const snapshot: RepositoryPullRequestInspection = {
  repositoryId: 'github:acme/repo',
  providerPullRequestId: '32',
  number: 32,
  state: 'open',
  draft: false,
  headRef: 'fix/task-32',
  headOid: 'head-32',
  baseRef: 'main',
  baseOid: 'base-32',
  mergeable: null,
  requiredChecks: [],
  requiredChecksKnown: true,
  requiredChecksConfigured: false,
  observedChecks: [{ name: 'build', status: 'failure' }],
  subjectDigest: 'digest-32',
  providerQueriedAt: '2026-09-01T12:00:00.000Z',
  workflowRuns: [{
    id: 'run-8', name: 'CI', event: 'pull_request', status: 'completed', conclusion: 'failure',
    headOid: 'head-32', jobs: [{
      id: '9001', name: 'build', status: 'completed', conclusion: 'failure',
      steps: [{ number: 1, name: 'test', status: 'completed', conclusion: 'failure' }],
      failureLogRef: 'github-job:9001',
    }],
  }],
};

function contextClient() {
  return {
    query: vi.fn(async () => ({ rows: [{
      task_id: 'task-87', kind: 'delivery', task_branch: 'fix/task-32', provider_pull_request_id: '32',
      execution_id: 'execution-41', purpose: 'review', execution_status: 'running',
      transitioned_at: null, superseded_at: null,
      repository: {
        provider: 'github', repositoryId: 'github:acme/repo', owner: 'acme', name: 'repo',
        baseBranch: 'main', allowForkPullRequest: false,
      },
      owner_user_id: identity.ownerUserId,
    }] })),
    release: vi.fn(),
  };
}

function host(provider: DeliveryPullRequestHost['repositoryProvider']): DeliveryPullRequestHost {
  const client = contextClient();
  return {
    pool: { connect: vi.fn(async () => client) },
    boardsTable: 'boards', tasksTable: 'tasks', commentsTable: 'comments', executionsTable: 'executions',
    changesTable: 'changes', integrationSourcesTable: 'integration_sources', mergeOperationsTable: 'merge_ops',
    mergeAuthorizationsTable: 'merge_auths', blockEpisodesTable: 'blocks', cancellationOutboxTable: 'cancellations',
    repositoryProvider: provider,
  } as unknown as DeliveryPullRequestHost;
}

describe('execution pull request observations', () => {
  it('returns the current observed PR/workflow as a pure read without a gate verdict or receipt', async () => {
    const inspectPullRequest = vi.fn(async () => snapshot);
    const value = host({ getPullRequest: vi.fn(), inspectPullRequest, mergePullRequest: vi.fn() });

    await expect(inspectExecutionPullRequest(value, identity, 'run-review-1')).resolves.toEqual(snapshot);
    expect(inspectPullRequest).toHaveBeenCalledOnce();
    const client = await value.pool.connect();
    const sql = (client.query as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n');
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE)\b|gateStatus|inspectionId|provider_ci/i);
  });

  it('re-inspects the current PR before allowing a current observed workflow job log read', async () => {
    const inspectPullRequest = vi.fn(async () => snapshot);
    const getWorkflowJobLog = vi.fn(async () => 'failure details');
    const value = host({ getPullRequest: vi.fn(), inspectPullRequest, getWorkflowJobLog, mergePullRequest: vi.fn() });

    await expect(readExecutionPullRequestJobLog(value, identity, 'run-review-1', '9001')).resolves.toEqual({
      providerJobId: '9001', log: 'failure details',
    });
    expect(inspectPullRequest).toHaveBeenCalledOnce();
    expect(getWorkflowJobLog).toHaveBeenCalledWith(expect.anything(), '9001', identity.ownerUserId);
  });

  it('rejects a job absent from the current observed workflow', async () => {
    const getWorkflowJobLog = vi.fn();
    const value = host({
      getPullRequest: vi.fn(), inspectPullRequest: vi.fn(async () => snapshot),
      getWorkflowJobLog, mergePullRequest: vi.fn(),
    });
    await expect(readExecutionPullRequestJobLog(value, identity, 'run-review-1', '9999'))
      .rejects.toMatchObject({ code: 'TASKBOARD_CI_LOG_SCOPE_INVALID' });
    expect(getWorkflowJobLog).not.toHaveBeenCalled();
  });
});
