import { describe, expect, it, vi } from 'vitest';

import { PostgresIntegrationEngineV3CandidateHost, PostgresIntegrationEngineV3FeatureHost, PostgresIntegrationEngineV3RequestHost, PostgresIntegrationProviderFenceHost } from './integrationEngineV3Postgres.js';
import { PostgresIntegrationV3ComposeHost, PostgresIntegrationV3WorkerHost } from './integrationV3WorkerPostgres.js';

function workerHost(query: ReturnType<typeof vi.fn>, dispatchAgent = vi.fn()) {
  return new PostgresIntegrationV3WorkerHost({
    pool: { query, connect: vi.fn() },
    candidatesTable: 'candidates', revisionsTable: 'revisions', sourceSnapshotsTable: 'snapshots',
    providerOperationsTable: 'operations', requestsOutboxTable: 'requests', tasksTable: 'tasks',
    boardsTable: 'boards', executionsTable: 'executions', dispatchAgent, syncWorkspace: vi.fn(), cleanup: vi.fn(),
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

  it('claims against the frozen candidate v3 policy while retaining the database global kill switch', async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [] }));
    await workerHost(query).claimCandidate(30_000);
    const sql = query.mock.calls[0]![0];
    expect(sql).toContain("current_setting('agent_saas.integration_v3_enabled'");
    expect(sql).toContain("c.policy_snapshot->>'workflowVersion'");
    expect(sql).toContain("c.policy_snapshot->'featureFlags'->>'engineV3'");
    expect(sql).not.toContain('integration_policy');
    expect(sql).not.toContain('JOIN boards');
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

  it('preserves a failed idempotent request and claims only the exact candidate subject fence', async () => {
    const query = vi.fn(async (sql: string) => sql.includes('SELECT id,current_revision')
      ? { rows: [{ id: 'candidate-1', current_revision: 2, workflow_epoch: '4', lane_epoch: '9', state: 'working' }] }
      : { rows: [{ id: 'request-1' }] });
    const requests = new PostgresIntegrationEngineV3RequestHost({
      pool: { query }, candidatesTable: 'candidates', requestsOutboxTable: 'requests',
    } as never);
    await requests.requestWork({ candidateId: 'candidate-1', revision: 2, workRound: 3, subjectDigest: 'subject-2' });
    const upsert = String(query.mock.calls[1]![0]);
    expect(upsert).toContain('ON CONFLICT (request_key) DO UPDATE SET request_key=EXCLUDED.request_key');
    expect(upsert).not.toContain("status='pending'");

    const claimQuery = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [] }));
    await workerHost(claimQuery).claimRequest(30_000);
    const claim = String(claimQuery.mock.calls[0]![0]);
    expect(claim).toContain("o.payload->>'subjectDigest'");
    expect(claim).toContain('LEFT JOIN revisions r');
    expect(claim).toContain("COALESCE(r.subject_digest,'')");
    expect(claim).not.toContain('c.subject_digest');
    expect(claim).toContain('o.work_round=c.work_round');
    expect(claim).toContain("o.payload->>'sourceSetDigest'");
    expect(claim).toContain("o.kind='work' AND c.state='working'");
    expect(claim).toContain("o.kind='review' AND c.state='in_review'");
  });

  it('uses the outbox id as the exact idempotency key across dispatch and binding', async () => {
    const query = vi.fn(async (sql: string, _values?: unknown[]) => sql.includes('SELECT t.id,t.version')
      ? { rows: [{ id: 'task-1', version: 4, tenant_id: 'tenant', owner_user_id: 'owner' }] }
      : { rows: [{ id: 'request-1' }] });
    const dispatch = vi.fn(async () => ({ executionId: 'integration-v3-request-request-1' }));
    await workerHost(query, dispatch).dispatchAgent({
      id: 'request-1', leaseId: 'lease-1', kind: 'work', candidateId: 'candidate-1', candidateRevision: 2, payload: {},
    });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ executionId: 'integration-v3-request-request-1' }));
    expect(query.mock.calls.at(-1)?.[1]).toEqual(['request-1', 'lease-1', 'integration-v3-request-request-1']);
  });

  it('does not redispatch an outbox request that already carries its execution binding', async () => {
    const query = vi.fn();
    const dispatch = vi.fn();
    await workerHost(query, dispatch).dispatchAgent({
      id: 'request-1', leaseId: 'lease-1', kind: 'review', candidateId: 'candidate-1', candidateRevision: 2,
      payload: { executionId: 'execution-1' },
    });
    expect(query).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('binds work completion to the request execution and canonical ready_for_review resolution', async () => {
    const query = vi.fn(async (sql: string, _values?: unknown[]) => sql.includes('SELECT b.repository')
      ? { rows: [{ repository: { provider: 'github', repositoryId: 'github:acme/app', owner: 'acme', name: 'app', baseBranch: 'main' }, owner_user_id: 'owner', tenant_id: 'tenant' }] }
      : { rows: [] });
    const host = new PostgresIntegrationV3ComposeHost({
      pool: { query }, candidatesTable: 'candidates', sourceSnapshotsTable: 'snapshots', tasksTable: 'tasks', boardsTable: 'boards',
      executionsTable: 'executions', resolutionsTable: 'resolutions', requestsOutboxTable: 'requests',
      resolvePaths: async () => ({ repositoryPath: '/repo', worktreePath: '/worktree' }), runGit: vi.fn(), validateServerOwnedRepository: vi.fn(),
    } as never);
    await host.resolveContext({ candidate: {
      id: 'candidate-1', integrationTaskId: 'integration-1', repositoryId: 'github:acme/app', baseBranch: 'main', branch: 'integration/1',
      state: 'working', currentRevision: 2, workRound: 3, version: 4, workflowEpoch: '4', laneEpoch: '9', policyRevision: 'p1', mergeMethod: 'squash', policySnapshot: {}, createdAt: '', updatedAt: '',
    }, revision: { subjectDigest: 'subject-2' } } as never);
    const sql = String(query.mock.calls[0]![0]);
    expect(sql).toContain("JOIN executions e ON e.id=o.payload->>'executionId'");
    expect(sql).toContain('JOIN resolutions r ON r.execution_id=e.id');
    expect(sql).toContain("e.status='succeeded' AND r.outcome='ready_for_review'");
    expect(sql).toContain('r.historical=false AND r.applied=true');
    expect(sql).toContain('o.work_round=c.work_round');
    expect(sql).toContain("o.payload->>'subjectDigest','')=$2");
    expect(sql).not.toContain('c.subject_digest');
    expect(query.mock.calls[0]![1]).toEqual(['candidate-1', 'subject-2']);
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
