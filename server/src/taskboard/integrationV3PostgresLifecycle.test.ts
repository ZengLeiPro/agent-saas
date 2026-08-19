import { describe, expect, it, vi } from 'vitest';

import { PostgresIntegrationEngineV3CandidateHost, PostgresIntegrationEngineV3FeatureHost, PostgresIntegrationProviderFenceHost } from './integrationEngineV3Postgres.js';
import { PostgresIntegrationV3WorkerHost } from './integrationV3WorkerPostgres.js';

function workerHost(query: ReturnType<typeof vi.fn>) {
  return new PostgresIntegrationV3WorkerHost({
    pool: { query, connect: vi.fn() },
    candidatesTable: 'candidates', revisionsTable: 'revisions', sourceSnapshotsTable: 'snapshots',
    providerOperationsTable: 'operations', requestsOutboxTable: 'requests', tasksTable: 'tasks',
    boardsTable: 'boards', executionsTable: 'executions', dispatchAgent: vi.fn(), syncWorkspace: vi.fn(), cleanup: vi.fn(),
  } as never);
}

describe('Integration v3 PostgreSQL lifecycle hosts', () => {
  it('freezes flags to the exact candidate, including terminal cleanup', async () => {
    const query = vi.fn(async (_text: string, _values?: unknown[]) => ({ rows: [{ policy_snapshot: { workflowVersion: 3, featureFlags: { engineV3: true, cleanup: true } } }] }));
    const host = new PostgresIntegrationEngineV3FeatureHost({ pool: { query }, candidatesTable: 'candidates' } as never);
    await expect(host.getFlags('candidate-terminal')).resolves.toMatchObject({ enabled: true, cleanupEnabled: true });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('WHERE id=$1'), ['candidate-terminal']);
    expect(query.mock.calls[0]![0]).not.toContain('repository_id');
  });

  it('queries dynamic global and repository kill switches while claiming candidates', async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [] }));
    await workerHost(query).claimCandidate(30_000);
    expect(query.mock.calls[0]![0]).toContain("current_setting('agent_saas.integration_v3_enabled'");
    expect(query.mock.calls[0]![0]).toContain("b.integration_policy->'featureFlags'->>'engineV3'");
  });

  it('fails a provider write fence closed when a live kill switch is disabled', async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [{
      global_enabled: true, repository_enabled: false, engine_enabled: true, merge_enabled: true,
    }] }));
    const host = new PostgresIntegrationProviderFenceHost({
      pool: { query }, tasksTable: 'x_taskboard_tasks', integrationLanesTable: 'lanes', candidatesTable: 'candidates',
    } as never);
    await expect(host.assertCurrent({
      kind: 'merge_pull_request', fence: { candidateId: 'candidate-1', candidateRevision: 1, workflowEpoch: 1, laneEpoch: 1 },
    } as never)).rejects.toMatchObject({ code: 'TASKBOARD_INTEGRATION_KILL_SWITCH' });
    expect(query.mock.calls[0]![0]).toContain('x_taskboard_boards');
  });

  it('loads succeeded merge operations for crash/restart convergence', async () => {
    const query = vi.fn(async (_text: string, _values?: unknown[]) => ({ rows: [{ operation_key: 'merge-succeeded' }] }));
    const host = workerHost(query);
    await expect(host.findRecoverableMergeOperation('candidate-1', 4)).resolves.toBe('merge-succeeded');
    expect(query.mock.calls[0]![0]).toContain("state IN ('executing','unknown','succeeded')");
  });

  it('rejects commitMerged without an exact succeeded merge operation receipt', async () => {
    const candidateRow = {
      id: 'candidate-1', integration_task_id: 'integration-1', repository_id: 'github:acme/app', base_branch: 'main',
      branch: 'integration/integration-1', provider_pull_request_id: '42', state: 'merging', current_revision: 2,
      work_round: 0, version: 7, workflow_epoch: 4, lane_epoch: 9, policy_revision: 'p1', merge_method: 'squash',
      policy_snapshot: {}, source_set_digest: 'sources', approved_revision: 2, approved_review_execution_id: 'review-1',
      created_at: new Date(), updated_at: new Date(),
    };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT * FROM candidates')) return { rows: [candidateRow] };
      if (sql.includes('SELECT * FROM operations')) return { rows: [] };
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const host = new PostgresIntegrationEngineV3CandidateHost({
      pool: { query, connect: vi.fn(async () => client) }, tasksTable: 'tasks', integrationSourcesTable: 'sources',
      integrationLanesTable: 'lanes', candidatesTable: 'candidates', revisionsTable: 'revisions',
      providerOperationsTable: 'operations', requestsOutboxTable: 'requests',
    } as never);
    await expect(host.commitMerged({ candidateId: 'candidate-1', expectedVersion: 7, expectedRevision: 2, mergedCommitOid: 'commit-1', providerOperationId: 'wrong-kind-op' }))
      .rejects.toMatchObject({ code: 'TASKBOARD_PROVIDER_OPERATION_FENCE_MISMATCH' });
    expect(query.mock.calls.find(([sql]) => String(sql).includes('SELECT * FROM operations'))?.[0]).toContain("kind='merge_pull_request'");
  });

  it('persists bounded retry/backoff instead of converting transient failure to terminal immediately', async () => {
    const query = vi.fn(async (_text: string, _values?: unknown[]) => ({ rows: [] }));
    const host = workerHost(query);
    await host.releaseCandidate({ candidateId: 'candidate-1', leaseId: 'lease-1' }, 'temporary network failure', true);
    expect(query.mock.calls[0]![0]).toContain('worker_attempts<9');
    expect(query.mock.calls[0]![0]).toContain('worker_available_at');
    expect(query.mock.calls[0]![1]).toEqual(['candidate-1', 'lease-1', 'temporary network failure', true]);
  });

  it('persists failed cleanup receipts and requeues them with bounded backoff', async () => {
    const query = vi.fn(async (_text: string, _values?: unknown[]) => ({ rows: [] }));
    const host = workerHost(query);
    await host.completeRequest({
      id: 'cleanup-1', leaseId: 'lease-1', kind: 'cleanup', candidateId: 'candidate-1', candidateRevision: 1, payload: {},
    }, {
      version: 1, outcome: 'failed', completedAt: '2026-08-19T00:00:00.000Z',
      actions: [{ action: 'remove_candidate_worktree', status: 'failed', error: 'dirty worktree' }],
    });
    expect(query.mock.calls[0]![0]).toContain("attempts<5 THEN 'pending'");
    expect(query.mock.calls[0]![0]).toContain('available_at=CASE');
    expect(query.mock.calls[0]![1]).toEqual(expect.arrayContaining(['cleanup-1', 'lease-1', true, 'remove_candidate_worktree: dirty worktree']));
  });
});
