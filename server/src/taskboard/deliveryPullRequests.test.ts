import { describe, expect, it, vi } from 'vitest';

import {
  attachExecutionPullRequest,
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

describe('Integration Agent pull request attachment', () => {
  it('updates only columns that exist in the Integration Agent schema', async () => {
    const integrationSnapshot = {
      ...snapshot,
      providerPullRequestId: '400',
      number: 400,
      headRef: 'integration/task-400',
      headOid: 'head-400',
      baseOid: 'base-400',
      observedChecks: [],
      workflowRuns: [],
    };
    const context = {
      query: vi.fn(async () => ({ rows: [{
        task_id: 'integration-1', kind: 'integration', task_branch: null,
        provider_pull_request_id: null, execution_id: 'execution-400', purpose: 'work',
        execution_status: 'running', transitioned_at: null, superseded_at: null,
        repository: {
          provider: 'github', repositoryId: 'github:acme/repo', owner: 'acme', name: 'repo',
          baseBranch: 'main', allowForkPullRequest: false,
        },
        owner_user_id: identity.ownerUserId, agent_task_id: 'integration-1',
        agent_provider_pull_request_id: null, integration_branch: 'integration/task-400',
      }] })),
      release: vi.fn(),
    };
    const now = new Date('2026-09-01T12:00:00.000Z');
    const transaction = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('SELECT id FROM tasks')) return { rows: [{ id: 'integration-1' }] };
        if (sql.includes('SELECT id FROM executions')) return { rows: [{ id: 'execution-400' }] };
        if (sql.includes('UPDATE integration_agents')) {
          if (sql.includes('admission_receipt')) throw new Error('column "admission_receipt" does not exist');
          return { rows: [{ integration_task_id: 'integration-1' }] };
        }
        if (sql.includes('SELECT t.*')) return { rows: [{
          id: 'integration-1', board_id: 'board-1', identifier: 'TASK-400', kind: 'integration',
          title: 'Integration', description: '', attachments: [], status: 'in_progress',
          priority: 'high', labels: [], sort_order: 1, stage_models: {}, workflow_version: 3,
          workflow_epoch: 1, next_action: 'none', next_action_revision: 0,
          comment_count: 0, version: 1, created_at: now, updated_at: now,
        }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const clients = [context, transaction];
    const value = {
      ...host({ getPullRequest: vi.fn(async () => integrationSnapshot), mergePullRequest: vi.fn() }),
      pool: { connect: vi.fn(async () => clients.shift()!) },
    } as unknown as DeliveryPullRequestHost;

    await expect(attachExecutionPullRequest(value, identity, 'run-integration-400', '400'))
      .resolves.toMatchObject({ id: 'integration-1', kind: 'integration' });

    const updateSql = transaction.query.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes('UPDATE integration_agents')) ?? '';
    expect(updateSql).toContain('provider_pull_request_id');
    expect(updateSql).toContain('review_head_oid=NULL');
    expect(updateSql).toContain('review_execution_id=NULL');
    expect(updateSql).not.toContain('admission_receipt');
  });
});
