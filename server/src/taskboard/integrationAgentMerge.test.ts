import { describe, expect, it, vi } from 'vitest';

import { createIntegrationAdmissionReceipt, digestCanonical } from './integrationAdmission.js';
import { mergeIntegrationAgent, type IntegrationAgentMergeHost } from './integrationAgentMerge.js';
import type { RepositoryPullRequestSnapshot } from './repositoryProvider.js';
import type { TaskboardIdentity } from './types.js';

const identity: TaskboardIdentity = {
  tenantId: 'tenant-1',
  ownerUserId: 'owner-1',
  username: 'owner',
};
const now = '2026-08-25T09:00:00.000Z';

const pullRequest: RepositoryPullRequestSnapshot = {
  providerPullRequestId: '42',
  number: 42,
  state: 'open',
  draft: false,
  headRef: 'integration/integration-1',
  headOid: 'agent-head',
  baseRef: 'main',
  baseOid: 'base',
  mergeable: true,
  requiredChecksKnown: true,
  requiredChecksConfigured: true,
  requiredChecks: [{ name: 'Build & Check', status: 'success' }],
  subjectDigest: 'digest',
};
const admissionSources = [
  {
    id: 'source-1',
    deliveryTaskId: 'delivery-1',
    providerPullRequestId: '41',
    reviewedSubjectDigest: 'delivery-subject',
    frozenHeadOid: 'delivery-head',
    sourceOrder: 0,
  },
];

function integrationTaskRow() {
  return {
    id: 'integration-1',
    board_id: 'board-1',
    identifier: 'TB-1',
    kind: 'integration',
    workflow_version: 3,
    title: 'Integrate',
    description: '',
    status: 'done',
    priority: 'none',
    labels: [],
    sort_order: 0,
    version: 2,
    workflow_epoch: 4,
    created_at: now,
    updated_at: now,
    completed_at: now,
    merged_commit_oid: 'merge-42',
  };
}

function loadedRow(
  integrationPolicy: Record<string, unknown> = { revision: 'policy-1' },
): Record<string, unknown> {
  const admissionReceipt = createIntegrationAdmissionReceipt(
    {
      candidateId: 'integration-1',
      candidateRevision: 2,
      reviewExecutionId: 'review-execution-1',
      headOid: 'agent-head',
      baseOid: 'base',
      treeOid: 'approved-tree',
      subjectDigest: 'digest',
      workflowEpoch: 4,
      laneEpoch: 1,
      policyRevision: String(integrationPolicy.revision),
      policyDigest: digestCanonical(integrationPolicy),
      sourceSetDigest: digestCanonical(admissionSources),
    },
    now,
  );
  return {
    ...integrationTaskRow(),
    status: 'in_progress',
    merged_commit_oid: null,
    repository: {
      provider: 'github',
      repositoryId: 'github:acme/repo',
      owner: 'acme',
      name: 'repo',
      baseBranch: 'main',
      allowForkPullRequest: false,
    },
    integration_policy: integrationPolicy,
    owner_user_id: identity.ownerUserId,
    admission_receipt: admissionReceipt,
    admission_sources: admissionSources,
    lane_epoch: 1,
    active_integration_task_id: 'integration-1',
    execution_id: 'merge-execution-1',
    purpose: 'merge',
    execution_status: 'running',
    transitioned_at: null,
    superseded_at: null,
    provider_pull_request_id: '42',
    integration_branch: 'integration/integration-1',
    review_head_oid: 'agent-head',
    verdict: 'approved',
    review_execution_id: 'review-execution-1',
    agent_status: 'ready_to_merge',
    review_purpose: 'review',
    review_transitioned_at: now,
    review_inspection_payload: {
      gateStatus: 'success',
      receipt: {
        executionId: 'review-execution-1',
        taskId: 'integration-1',
        purpose: 'review',
        providerPullRequestId: '42',
        headOid: 'agent-head',
      },
      snapshot: pullRequest,
    },
    merge_in_flight_execution_id: null,
    merge_in_flight_review_execution_id: null,
    merge_in_flight_review_head_oid: null,
    fence_owner_execution_id: null,
    fence_owner_execution_status: null,
    fence_owner_transitioned_at: null,
    fence_owner_superseded_at: null,
  };
}

function finalizationClient(mergeExecutionId = 'merge-execution-1') {
  return {
    release: vi.fn(),
    query: vi.fn(async (sql: string) => {
      if (sql.includes('SELECT id,delivery_task_id,remediation_task_id')) {
        return {
          rows: [{ id: 'source-1', delivery_task_id: 'delivery-1', remediation_task_id: null }],
        };
      }
      if (sql.includes('SELECT DISTINCT integration_source_id,remediation_task_id'))
        return { rows: [] };
      if (sql.includes('FROM sources_agents'))
        return {
          rows: [
            {
              provider_pull_request_id: '42',
              integration_branch: 'integration/integration-1',
              status: 'ready_to_merge',
              verdict: 'approved',
              review_head_oid: 'agent-head',
              review_execution_id: 'review-execution-1',
              merge_in_flight_execution_id: mergeExecutionId,
              merge_in_flight_review_execution_id: 'review-execution-1',
              merge_in_flight_review_head_oid: 'agent-head',
            },
          ],
        };
      if (sql.includes('SELECT * FROM sources') && sql.includes('integration_task_id=$1')) {
        return { rows: [{ id: 'source-1', state: 'ready', merged_commit_oid: null }] };
      }
      if (sql.includes('RETURNING *')) return { rows: [integrationTaskRow()] };
      return { rows: [], rowCount: 0 };
    }),
  };
}

function hostWith(
  provider: {
    getPullRequest: ReturnType<typeof vi.fn>;
    mergePullRequest: ReturnType<typeof vi.fn>;
    getCommit?: ReturnType<typeof vi.fn>;
  },
  row = loadedRow(),
) {
  provider.getCommit ??= vi.fn(async (_repository: unknown, oid: string) => ({
    oid,
    treeOid: 'approved-tree',
  }));
  const loadClient = {
    release: vi.fn(),
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM executions e')) return { rows: [row] };
      if (sql.includes('SET merge_receipt='))
        return { rows: [{ integration_task_id: 'integration-1' }], rowCount: 1 };
      if (sql.includes('UPDATE sources_agents')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
  };
  const finalized = finalizationClient();
  const clients = [loadClient, finalized];
  return {
    host: {
      pool: { connect: vi.fn(async () => clients.shift()!) },
      tasksTable: 'tasks',
      boardsTable: 'boards',
      executionsTable: 'executions',
      commentsTable: 'comments',
      changesTable: 'changes',
      integrationLanesTable: 'lanes',
      integrationSourcesTable: 'sources',
      mergeAuthorizationsTable: 'authorizations',
      mergeOperationsTable: 'merge_operations',
      blockEpisodesTable: 'blocks',
      remediationAttemptsTable: 'remediation_attempts',
      cancellationOutboxTable: 'cancellations',
      repositoryProvider: provider,
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
    const { host } = hostWith(provider, {
      ...loadedRow(),
      execution_id: 'review-execution-1',
      purpose: 'review',
    });

    await expect(mergeIntegrationAgent(host, identity, 'review-run')).rejects.toMatchObject({
      code: 'TASKBOARD_INTEGRATION_AGENT_MERGE_INVALID',
    });
    expect(provider.getPullRequest).not.toHaveBeenCalled();
    expect(provider.mergePullRequest).not.toHaveBeenCalled();
  });

  it('rejects a new merge execution while the fence owner is still active', async () => {
    const provider = { getPullRequest: vi.fn(async () => pullRequest), mergePullRequest: vi.fn() };
    const { host } = hostWith(provider, {
      ...loadedRow(),
      execution_id: 'merge-execution-2',
      merge_in_flight_execution_id: 'merge-execution-1',
      merge_in_flight_review_execution_id: 'review-execution-1',
      merge_in_flight_review_head_oid: 'agent-head',
      fence_owner_execution_id: 'merge-execution-1',
      fence_owner_execution_status: 'waiting_approval',
      fence_owner_transitioned_at: null,
      fence_owner_superseded_at: null,
    });

    await expect(mergeIntegrationAgent(host, identity, 'run-2')).rejects.toMatchObject({
      code: 'TASKBOARD_INTEGRATION_AGENT_MERGE_IN_FLIGHT',
    });
    expect(provider.getPullRequest).not.toHaveBeenCalled();
  });

  it('fails closed when a terminal owner fence is bound to a different review', async () => {
    const provider = { getPullRequest: vi.fn(async () => pullRequest), mergePullRequest: vi.fn() };
    const { host, loadClient } = hostWith(provider, {
      ...loadedRow(),
      execution_id: 'merge-execution-2',
      merge_in_flight_execution_id: 'merge-execution-1',
      merge_in_flight_review_execution_id: 'review-execution-old',
      merge_in_flight_review_head_oid: 'agent-head',
      fence_owner_execution_id: 'merge-execution-1',
      fence_owner_execution_status: 'failed',
      fence_owner_transitioned_at: now,
      fence_owner_superseded_at: null,
    });

    await expect(mergeIntegrationAgent(host, identity, 'run-2')).rejects.toMatchObject({
      code: 'TASKBOARD_INTEGRATION_AGENT_MERGE_IN_FLIGHT',
    });
    expect(
      loadClient.query.mock.calls.some(([sql]) =>
        String(sql).includes('AND merge_in_flight_execution_id=$5'),
      ),
    ).toBe(false);
    expect(provider.getPullRequest).not.toHaveBeenCalled();
  });

  it('persists the merge receipt but keeps the task in progress until cleanup', async () => {
    const provider = {
      getPullRequest: vi
        .fn()
        .mockResolvedValueOnce(pullRequest)
        .mockResolvedValue({ ...pullRequest, state: 'merged', mergeCommitOid: 'merge-42' }),
      mergePullRequest: vi.fn(async (_repository: unknown, input: { operationKey: string }) => ({
        providerRequestId: input.operationKey,
        providerPullRequestId: '42',
        merged: true,
        mergedCommitOid: 'merge-42',
        raw: {},
      })),
    };
    const { host, loadClient, finalized } = hostWith(provider);

    await expect(mergeIntegrationAgent(host, identity, 'run-1')).resolves.toMatchObject({
      id: 'integration-1',
      status: 'in_progress',
    });
    expect(provider.mergePullRequest).toHaveBeenCalledOnce();
    expect(loadClient.query).toHaveBeenCalledWith(
      expect.stringContaining('SET merge_receipt=$2::jsonb'),
      expect.arrayContaining(['integration-1']),
    );
    expect(finalized.query).not.toHaveBeenCalled();
  });

  it.each([
    ['merge', { revision: 'policy-1' }],
    ['squash', { revision: 'policy-1', execution: { mergeMethod: 'squash' } }],
    ['rebase', { revision: 'policy-1', execution: { mergeMethod: 'rebase' } }],
  ] as const)('uses the board integration merge method %s', async (method, integrationPolicy) => {
    const provider = {
      getPullRequest: vi
        .fn()
        .mockResolvedValueOnce(pullRequest)
        .mockResolvedValue({ ...pullRequest, state: 'merged', mergeCommitOid: 'merge-42' }),
      mergePullRequest: vi.fn(async (_repository: unknown, input: { operationKey: string }) => ({
        providerRequestId: input.operationKey,
        providerPullRequestId: '42',
        merged: true,
        mergedCommitOid: 'merge-42',
        raw: {},
      })),
    };
    const { host } = hostWith(provider, loadedRow(integrationPolicy));

    await mergeIntegrationAgent(host, identity, 'run-1');

    expect(provider.mergePullRequest).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ method }),
      identity.ownerUserId,
    );
  });

  it('atomically takes over a terminal owner fence and persists a recovered merged receipt', async () => {
    const mergedPullRequest = {
      ...pullRequest,
      state: 'merged' as const,
      mergeCommitOid: 'merge-42',
    };
    const provider = {
      getPullRequest: vi.fn(async () => mergedPullRequest),
      mergePullRequest: vi.fn(),
    };
    const recoveryRow = {
      ...loadedRow(),
      execution_id: 'merge-execution-2',
      merge_in_flight_execution_id: 'merge-execution-1',
      merge_in_flight_review_execution_id: 'review-execution-1',
      merge_in_flight_review_head_oid: 'agent-head',
      fence_owner_execution_id: 'merge-execution-1',
      fence_owner_execution_status: 'failed',
      fence_owner_transitioned_at: now,
      fence_owner_superseded_at: null,
    };
    const { host, loadClient } = hostWith(provider, recoveryRow);

    await expect(mergeIntegrationAgent(host, identity, 'run-2')).resolves.toMatchObject({
      status: 'in_progress',
    });
    expect(loadClient.query).toHaveBeenCalledWith(
      expect.stringContaining('AND merge_in_flight_execution_id=$5'),
      [
        'integration-1',
        'merge-execution-2',
        'review-execution-1',
        'agent-head',
        'merge-execution-1',
      ],
    );
    expect(provider.mergePullRequest).not.toHaveBeenCalled();
    expect(loadClient.query).toHaveBeenCalledWith(
      expect.stringContaining('SET merge_receipt=$2::jsonb'),
      expect.any(Array),
    );
  });

  it('fails closed when an already merged pull request has no prior controlled merge fence', async () => {
    const provider = {
      getPullRequest: vi.fn(async () => ({
        ...pullRequest,
        state: 'merged' as const,
        mergeCommitOid: 'merge-42',
      })),
      mergePullRequest: vi.fn(),
    };
    const { host, loadClient } = hostWith(provider);

    await expect(mergeIntegrationAgent(host, identity, 'run-1')).rejects.toMatchObject({
      code: 'TASKBOARD_MERGE_RECEIPT_CONFLICT',
    });
    expect(provider.mergePullRequest).not.toHaveBeenCalled();
    expect(
      loadClient.query.mock.calls.some(([sql]) => String(sql).includes('SET merge_receipt=')),
    ).toBe(false);
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
      getPullRequest: vi
        .fn()
        .mockResolvedValueOnce(pullRequest)
        .mockResolvedValueOnce({ ...pullRequest, state: 'merged', mergeCommitOid: 'merge-42' }),
      mergePullRequest: vi.fn(async () => {
        throw new Error('provider timeout');
      }),
    };
    const { host, loadClient, finalized } = hostWith(provider);

    await expect(mergeIntegrationAgent(host, identity, 'run-1')).resolves.toMatchObject({
      status: 'in_progress',
    });
    expect(provider.mergePullRequest).toHaveBeenCalledOnce();
    expect(provider.getPullRequest).toHaveBeenCalledTimes(2);
    expect(loadClient.query).toHaveBeenCalledWith(
      expect.stringContaining('SET merge_receipt=$2::jsonb'),
      expect.any(Array),
    );
    expect(finalized.query).not.toHaveBeenCalled();
  });

  it('fails closed before merge when the base moved after the approved inspection', async () => {
    const provider = {
      getPullRequest: vi.fn(async () => ({ ...pullRequest, baseOid: 'base-drift' })),
      mergePullRequest: vi.fn(),
    };
    const { host, loadClient } = hostWith(provider);

    await expect(mergeIntegrationAgent(host, identity, 'run-1')).rejects.toMatchObject({
      code: 'TASKBOARD_SUBJECT_STALE',
    });
    expect(provider.mergePullRequest).not.toHaveBeenCalled();
    expect(
      loadClient.query.mock.calls.some(([sql]) => String(sql).includes('SET merge_receipt=')),
    ).toBe(false);
  });

  it('fails closed when the final merged commit tree differs from the approved head tree', async () => {
    const provider = {
      getPullRequest: vi
        .fn()
        .mockResolvedValueOnce(pullRequest)
        .mockResolvedValue({ ...pullRequest, state: 'merged', mergeCommitOid: 'merge-42' }),
      getCommit: vi.fn(async (_repository: unknown, oid: string) => ({
        oid,
        treeOid: oid === 'agent-head' ? 'approved-tree' : 'wrong-tree',
      })),
      mergePullRequest: vi.fn(async (_repository: unknown, input: { operationKey: string }) => ({
        providerRequestId: input.operationKey,
        providerPullRequestId: '42',
        merged: true,
        mergedCommitOid: 'merge-42',
        raw: {},
      })),
    };
    const { host, loadClient } = hostWith(provider);

    await expect(mergeIntegrationAgent(host, identity, 'run-1')).rejects.toMatchObject({
      code: 'TASKBOARD_MERGE_RECEIPT_CONFLICT',
    });
    expect(
      loadClient.query.mock.calls.some(([sql]) => String(sql).includes('SET merge_receipt=')),
    ).toBe(false);
  });

  it('rejects a provider receipt whose request id is not the controlled operation key', async () => {
    const provider = {
      getPullRequest: vi.fn(async () => pullRequest),
      mergePullRequest: vi.fn(async () => ({
        providerRequestId: 'unbound-request',
        providerPullRequestId: '42',
        merged: true,
        mergedCommitOid: 'merge-42',
        raw: {},
      })),
    };
    const { host, loadClient } = hostWith(provider);

    await expect(mergeIntegrationAgent(host, identity, 'run-1')).rejects.toMatchObject({
      code: 'TASKBOARD_PROVIDER_RECEIPT_INCOMPLETE',
    });
    expect(
      loadClient.query.mock.calls.some(([sql]) => String(sql).includes('SET merge_receipt=')),
    ).toBe(false);
  });

  it('persists one receipt binding request, approved revision, and final provider facts', async () => {
    const provider = {
      getPullRequest: vi
        .fn()
        .mockResolvedValueOnce(pullRequest)
        .mockResolvedValue({ ...pullRequest, state: 'merged', mergeCommitOid: 'merge-42' }),
      mergePullRequest: vi.fn(async (_repository: unknown, input: { operationKey: string }) => ({
        providerRequestId: input.operationKey,
        providerPullRequestId: '42',
        merged: true,
        mergedCommitOid: 'merge-42',
        raw: { provider: 'receipt' },
      })),
    };
    const { host, loadClient } = hostWith(provider);

    await mergeIntegrationAgent(host, identity, 'run-1');

    const call = loadClient.query.mock.calls.find(([sql]) =>
      String(sql).includes('SET merge_receipt='),
    ) as unknown as [string, unknown[]];
    const stored = JSON.parse(String(call[1][1]));
    expect(stored).toMatchObject({
      providerRequestId: expect.stringContaining('integration-agent:integration-1:'),
      providerPullRequestId: '42',
      mergedCommitOid: 'merge-42',
      raw: {
        providerRequestId: expect.stringContaining('integration-agent:integration-1:'),
        approvedRevision: { baseOid: 'base', headOid: 'agent-head', treeOid: 'approved-tree' },
        providerFacts: {
          baseOid: 'base',
          headOid: 'agent-head',
          state: 'merged',
          mergedTreeOid: 'approved-tree',
        },
        providerReceipt: { provider: 'receipt' },
      },
    });
  });

  it.each([
    ['source set', { admission_sources: [{ ...admissionSources[0], sourceOrder: 1 }] }],
    ['policy', { integration_policy: { revision: 'policy-2' } }],
    ['lane', { lane_epoch: 2 }],
    ['workflow', { workflow_epoch: 5 }],
    ['candidate revision', { version: 3 }],
  ])('rejects %s drift after review approval', async (_name, drift) => {
    const provider = { getPullRequest: vi.fn(async () => pullRequest), mergePullRequest: vi.fn() };
    const { host } = hostWith(provider, { ...loadedRow(), ...drift });

    await expect(mergeIntegrationAgent(host, identity, 'run-1')).rejects.toMatchObject({
      code: 'TASKBOARD_INTEGRATION_ADMISSION_STALE',
    });
    expect(provider.getPullRequest).not.toHaveBeenCalled();
    expect(provider.mergePullRequest).not.toHaveBeenCalled();
  });

  it('does not converge local state when a provider exception re-reads as still open', async () => {
    const providerError = new Error('provider timeout');
    const provider = {
      getPullRequest: vi.fn(async () => pullRequest),
      mergePullRequest: vi.fn(async () => {
        throw providerError;
      }),
    };
    const { host, finalized } = hostWith(provider);

    await expect(mergeIntegrationAgent(host, identity, 'run-1')).rejects.toBe(providerError);
    expect(provider.mergePullRequest).toHaveBeenCalledOnce();
    expect(provider.getPullRequest).toHaveBeenCalledTimes(2);
    expect(finalized.query).not.toHaveBeenCalled();
  });
});
