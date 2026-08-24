import { describe, expect, it, vi } from 'vitest';

import { PostgresIntegrationEngineV3CandidateHost, PostgresIntegrationEngineV3FeatureHost, PostgresIntegrationEngineV3RequestHost, PostgresIntegrationProviderFenceHost, PostgresIntegrationProviderOperationStorage } from './integrationEngineV3Postgres.js';
import { PostgresIntegrationV3ComposeHost, PostgresIntegrationV3WorkerHost } from './integrationV3WorkerPostgres.js';

function workerHost(query: ReturnType<typeof vi.fn>, dispatchAgent = vi.fn(), syncWorkspace = vi.fn()) {
  return new PostgresIntegrationV3WorkerHost({
    pool: { query, connect: vi.fn() },
    candidatesTable: 'candidates', revisionsTable: 'revisions', sourceSnapshotsTable: 'snapshots',
    providerOperationsTable: 'operations', requestsOutboxTable: 'requests', tasksTable: 'tasks', blockEpisodesTable: 'blocks',
    boardsTable: 'boards', executionsTable: 'executions', dispatchAgent, syncWorkspace, cleanup: vi.fn(),
    releaseIdentity: 'release-2',
  } as never);
}

describe('Integration v3 PostgreSQL lifecycle hosts', () => {
  it('serializes provider operation prepare against terminal candidate transitions', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const storage = new PostgresIntegrationProviderOperationStorage({
      pool: { query }, candidatesTable: 'candidates', providerOperationsTable: 'operations',
    });

    await expect(storage.insertPrepared({
      id: 'operation-1', operationKey: 'operation-key-1', intentDigest: 'digest', kind: 'push_ref',
      repositoryId: 'github:acme/app',
      fence: { candidateId: 'candidate-1', candidateRevision: 1, workflowEpoch: 2, laneEpoch: 3, executionId: 'execution-1' },
      expected: {}, command: {}, state: 'prepared', attemptCount: 0,
      createdAt: '2026-08-22T00:00:00.000Z', updatedAt: '2026-08-22T00:00:00.000Z',
    })).rejects.toThrow('terminal candidate fence');

    const sql = query.mock.calls[0]![0];
    expect(sql).toContain("c.state NOT IN ('merged','canceled')");
    expect(sql).toContain('FOR UPDATE');
  });

  it('freezes flags to the exact candidate, including terminal cleanup', async () => {
    const query = vi.fn(async (_text: string, _values?: unknown[]) => ({ rows: [{ policy_snapshot: { workflowVersion: 3, featureFlags: { engineV3: true, cleanup: true } } }] }));
    const host = new PostgresIntegrationEngineV3FeatureHost({ pool: { query }, candidatesTable: 'candidates' } as never);
    await expect(host.getFlags('candidate-terminal')).resolves.toMatchObject({ enabled: true, cleanupEnabled: true });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('WHERE id=$1'), ['candidate-terminal']);
    expect(query.mock.calls[0]![0]).not.toContain('repository_id');
  });

  it('atomically fences provider-operation CAS with the Candidate Worker lease when supplied', async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [] as Record<string, unknown>[] }));
    const storage = new PostgresIntegrationProviderOperationStorage({
      pool: { query } as never, candidatesTable: 'candidates', providerOperationsTable: 'operations',
    });
    await storage.compareAndSet({
      id: 'operation-1', expectedState: 'prepared', nextState: 'executing',
      patch: { attemptCount: 1, updatedAt: '2026-08-24T00:00:00.000Z' },
      mutationFence: { leaseId: 'lease-1', leaseEpoch: '9', releaseIdentity: 'release-2' },
    });
    const sql = String(query.mock.calls[0]![0]);
    expect(sql).toContain('UPDATE operations o');
    expect(sql).toContain('c.id=o.candidate_id');
    expect(sql).toContain('c.worker_lease_id=$10 AND c.worker_lease_epoch=$11::bigint');
    expect(sql).toContain("c.worker_release_identity=$12 AND c.worker_status='processing'");
    expect(sql).toContain('c.worker_lease_expires_at>clock_timestamp()');
    expect(query.mock.calls[0]![1]?.slice(9)).toEqual(['lease-1', '9', 'release-2']);
  });

  it('keeps provider-operation CAS available to review/merge callers without a Worker fence', async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [] as Record<string, unknown>[] }));
    const storage = new PostgresIntegrationProviderOperationStorage({
      pool: { query } as never, candidatesTable: 'candidates', providerOperationsTable: 'operations',
    });
    await storage.compareAndSet({
      id: 'operation-1', expectedState: 'prepared', nextState: 'executing',
      patch: { attemptCount: 1, updatedAt: '2026-08-24T00:00:00.000Z' },
    });
    expect(query.mock.calls[0]![1]?.slice(9)).toEqual([null, null, null]);
  });

  it('claims against the frozen candidate v3 policy while retaining the database global kill switch', async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [] }));
    await workerHost(query).claimCandidate(30_000);
    const sql = query.mock.calls[0]![0];
    expect(sql).toContain("current_setting('agent_saas.integration_v3_enabled'");
    expect(sql).toContain("c.policy_snapshot->>'workflowVersion'");
    expect(sql).toContain("c.policy_snapshot->'featureFlags'->>'engineV3'");
    expect(sql).toContain("c.state IN ('preparing','composing','waiting_checks','needs_work','working','in_review','approved','merging')");
    expect(sql).toContain("c.state IN ('merged','canceled')");
    expect(sql).toContain("c.state='needs_human'");
    expect(sql).toContain("o.state='succeeded'");
    expect(sql).toContain("o.receipt->>'providerRequestId'=o.operation_key");
    expect(sql).toContain("c.worker_checkpoint->>'releaseIdentity' IS DISTINCT FROM $3");
    expect(sql).toContain("c.worker_status<>'failed'");
    expect(sql).toContain("worker_lease_epoch=c.worker_lease_epoch+1");
    expect(sql).toContain("worker_release_identity=$3");
    expect(sql).toContain("jsonb_build_object('releaseIdentity',$3::text)");
    expect(query.mock.calls[0]![1]).toEqual([expect.any(String), 30_000, 'release-2']);
    expect(sql).not.toContain("'blocked','needs_human'");
    expect(sql).not.toContain('integration_policy');
    expect(sql).not.toContain('JOIN boards');
  });

  it('fences every worker checkpoint by lease id, epoch, release, and expiry', async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [{ id: 'candidate-1' }] }));
    await workerHost(query).checkpointCandidate(
      { candidateId: 'candidate-1', leaseId: 'lease-1', leaseEpoch: '7', releaseIdentity: 'release-2' },
      { state: 'merging', status: 'idle' },
    );
    expect(query.mock.calls[0]![0]).toContain("jsonb_build_object('releaseIdentity',$4::text)");
    expect(query.mock.calls[0]![0]).toContain('worker_lease_expires_at>now() RETURNING id');
    expect(query.mock.calls[0]![1]).toEqual([
      'candidate-1', 'lease-1', '7', 'release-2', JSON.stringify({ state: 'merging', status: 'idle' }),
    ]);
  });

  it('resumes a fenced blocked candidate only after workspace sync succeeds', async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [{ id: 'task-1' }] }));
    const syncWorkspace = vi.fn(async () => undefined);
    const host = workerHost(query, vi.fn(), syncWorkspace);
    await host.syncWorkspace({
      id: 'request-1', leaseId: 'lease-1', kind: 'workspace_sync',
      candidateId: 'candidate-1', candidateRevision: 2,
      payload: { reason: 'resume_reconcile', resumeState: 'needs_work', workflowEpoch: '3', laneEpoch: '4' },
    });
    expect(syncWorkspace).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith(expect.stringContaining("c.state IN ('blocked','needs_human')"), [
      'candidate-1', 2, 'needs_work', 'request-1', 'lease-1',
    ]);
    const resumeSql = String(query.mock.calls[2]![0]);
    expect(resumeSql).toContain('WITH request_lease AS MATERIALIZED');
    expect(resumeSql).toContain("o.id=$4 AND o.lease_id=$5 AND o.status='processing'");
    expect(resumeSql).toContain('o.lease_expires_at>clock_timestamp()');
    expect(resumeSql).toContain('o.candidate_id=c.id AND o.candidate_revision=c.current_revision');
    expect(resumeSql).toContain("worker_status='idle'");
    expect(resumeSql).toContain('worker_attempts=0');
    expect(resumeSql).toContain('worker_available_at=now()');
    expect(resumeSql).toContain('worker_lease_id=NULL');
    expect(resumeSql).toContain('worker_lease_expires_at=NULL');
    expect(resumeSql).toContain('worker_release_identity=NULL');
    expect(resumeSql).toContain('worker_error=NULL');
    expect(resumeSql).toContain('UPDATE blocks b SET closed_at=COALESCE');
  });

  it('rechecks the durable request fence and carries the exact candidate binding into pre-dispatch preparation', async () => {
    const query = vi.fn(async (_text: string, _values?: unknown[]) => ({ rows: [{
      id: 'task-1', version: 7, tenant_id: 'tenant-1', owner_user_id: 'owner-1',
    }] }));
    const dispatchAgent = vi.fn(async (input: { assertCurrent(): Promise<void> }) => {
      await input.assertCurrent();
      return { executionId: 'execution-1' };
    });
    const host = workerHost(query, dispatchAgent);
    await host.dispatchAgent({
      id: 'request-1', leaseId: 'lease-1', kind: 'work',
      candidateId: 'candidate-1', candidateRevision: 2, payload: {},
    });
    const sql = String(query.mock.calls[0]![0]);
    expect(sql).toContain("o.lease_id=$4 AND o.status='processing'");
    expect(sql).toContain('o.workflow_epoch=c.workflow_epoch AND o.lane_epoch=c.lane_epoch');
    expect(query.mock.calls[0]![1]).toEqual(['candidate-1', 2, 'request-1', 'lease-1']);
    expect(String(query.mock.calls[1]![0])).toContain("GREATEST(lease_expires_at,clock_timestamp()+interval '5 minutes')");
    expect(dispatchAgent).toHaveBeenCalledWith(expect.objectContaining({
      candidateId: 'candidate-1', candidateRevision: 2,
      taskId: 'task-1', expectedVersion: 7, purpose: 'work',
    }));
  });

  it('prevents Agent start when the request fence changes during workspace preparation', async () => {
    let selectCount = 0;
    const query = vi.fn(async (text: string) => {
      if (text.includes('SELECT t.id')) {
        selectCount += 1;
        return { rows: selectCount === 1 ? [{
          id: 'task-1', version: 7, tenant_id: 'tenant-1', owner_user_id: 'owner-1',
        }] : [] };
      }
      if (text.includes("clock_timestamp()+interval '5 minutes'")) return { rows: [{ id: 'request-1' }] };
      if (text.includes('SELECT id FROM requests')) return { rows: [{ id: 'request-1' }] };
      return { rows: [] };
    });
    let started = false;
    const host = workerHost(query, vi.fn(async (input: { assertCurrent(): Promise<void> }) => {
      await input.assertCurrent();
      started = true;
      return { executionId: 'execution-1' };
    }));
    await expect(host.dispatchAgent({
      id: 'request-1', leaseId: 'lease-1', kind: 'work',
      candidateId: 'candidate-1', candidateRevision: 2, payload: {},
    })).rejects.toThrow('dispatch fence changed');
    expect(started).toBe(false);
  });

  it('uses two PostgreSQL-safe advisory lock keys without embedding a NUL separator', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const client = { query, release: vi.fn() };
    const host = new PostgresIntegrationV3ComposeHost({
      pool: { query, connect: vi.fn(async () => client) },
      candidatesTable: 'candidates', sourceSnapshotsTable: 'snapshots', requestsOutboxTable: 'requests',
      tasksTable: 'tasks', boardsTable: 'boards', executionsTable: 'executions',
      resolvePaths: vi.fn(), runGit: vi.fn(), validateServerOwnedRepository: vi.fn(),
    } as never);
    const operation = vi.fn(async () => 'done');
    await expect(host.withRepositoryBranchLock({ repositoryPath: '/srv/mirror', branch: 'integration/task-1' }, operation)).resolves.toBe('done');
    expect(query.mock.calls).toEqual([
      ['SELECT pg_advisory_lock(hashtext($1),hashtext($2))', ['integration-v3-repository', '/srv/mirror']],
      ['SELECT pg_advisory_unlock(hashtext($1),hashtext($2))', ['integration-v3-repository', '/srv/mirror']],
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('fails a provider write fence closed when a live kill switch is disabled', async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [{
      global_enabled: true, repository_enabled: false, engine_enabled: true, merge_enabled: true,
    }] }));
    const host = new PostgresIntegrationProviderFenceHost({
      pool: { query }, boardsTable: 'boards', tasksTable: 'tasks', integrationLanesTable: 'lanes', candidatesTable: 'candidates',
    } as never);
    await expect(host.assertCurrent({
      kind: 'merge_pull_request', fence: { candidateId: 'candidate-1', candidateRevision: 1, workflowEpoch: 1, laneEpoch: 1 },
    } as never)).rejects.toMatchObject({ code: 'TASKBOARD_INTEGRATION_KILL_SWITCH' });
    expect(query.mock.calls[0]![0]).toContain('JOIN boards b');
  });

  it('fences a stale prepared merge after the candidate returns to composition', async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [{
      integration_task_id: 'integration-1', current_revision: 4, workflow_epoch: '3', lane_epoch: '9',
      state: 'composing', workflow_version: 3, task_epoch: '3', current_lane_epoch: '9',
      active_integration_task_id: 'integration-1', global_enabled: true, repository_enabled: true,
      engine_enabled: true, merge_enabled: true,
    }] }));
    const host = new PostgresIntegrationProviderFenceHost({
      pool: { query }, boardsTable: 'boards', tasksTable: 'tasks', integrationLanesTable: 'lanes', candidatesTable: 'candidates',
    } as never);

    await expect(host.assertCurrent({
      kind: 'merge_pull_request',
      fence: { candidateId: 'candidate-1', candidateRevision: 4, workflowEpoch: 3, laneEpoch: 9 },
    } as never)).rejects.toMatchObject({ code: 'TASKBOARD_PROVIDER_OPERATION_FENCE_MISMATCH' });
  });

  it.each(['prepared', 'executing', 'unknown', 'failed', 'needs_human', 'succeeded'] as const)(
    'loads %s merge operations for crash/restart convergence',
    async (state) => {
      const query = vi.fn(async (_text: string, _values?: unknown[]) => ({
        rows: [{ operation_key: `merge-${state}`, state }],
      }));
      const host = workerHost(query);
      await expect(host.findRecoverableMergeOperation('candidate-1', 4)).resolves.toEqual({
        operationKey: `merge-${state}`,
        state,
      });
      expect(query.mock.calls[0]![0]).toContain("o.state IN ('prepared','executing','unknown','failed','needs_human','succeeded')");
      expect(query.mock.calls[0]![0]).toContain("o.command->>'providerPullRequestId'=c.provider_pull_request_id");
    },
  );

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
    const query = vi.fn(async (_text: string, _values?: unknown[]) => ({ rows: [{ integration_task_id: 'task-1' }] }));
    const host = workerHost(query);
    await host.releaseCandidate({ candidateId: 'candidate-1', leaseId: 'lease-1', leaseEpoch: '7', releaseIdentity: 'release-2' }, 'temporary network failure', true);
    const releaseSql = String(query.mock.calls[0]![0]);
    expect(releaseSql).toContain('c.worker_attempts<9');
    expect(releaseSql).toContain('c.worker_attempts>=9');
    expect(releaseSql).toContain('c.worker_attempts>=10');
    expect(releaseSql).toContain('worker_attempts=CASE WHEN $5::text IS NULL THEN 0 ELSE c.worker_attempts+1 END');
    expect(releaseSql).toContain('worker_available_at');
    expect(releaseSql).toContain("THEN 'blocked'");
    expect(releaseSql).toContain("SET status='blocked'");
    expect(query.mock.calls[0]![1]).toEqual([
      'candidate-1', 'lease-1', '7', 'release-2', 'temporary network failure', true, null, expect.any(String),
    ]);
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

  it('binds work completion to the request execution and fenced in_review transition', async () => {
    const query = vi.fn(async (sql: string, _values?: unknown[]) => sql.includes('SELECT b.repository')
      ? { rows: [{ repository: { provider: 'github', repositoryId: 'github:acme/app', owner: 'acme', name: 'app', baseBranch: 'main' }, owner_user_id: 'owner', tenant_id: 'tenant',
        work_execution_id: 'work-1', push_execution_id: 'work-1', push_candidate_id: 'candidate-1', push_candidate_revision: 2,
        push_workflow_epoch: 4, push_lane_epoch: 9, push_ref: 'refs/heads/integration/1',
        push_old_oid: 'head-2', push_new_oid: 'head-3',
        trusted_integration_branch_oids: ['a'.repeat(40)] }] }
      : { rows: [] });
    const host = new PostgresIntegrationV3ComposeHost({
      pool: { query }, candidatesTable: 'candidates', sourceSnapshotsTable: 'snapshots', tasksTable: 'tasks', boardsTable: 'boards',
      executionsTable: 'executions', requestsOutboxTable: 'requests', providerOperationsTable: 'operations',
      resolvePaths: async () => ({ repositoryPath: '/repo', worktreePath: '/worktree' }), runGit: vi.fn(), validateServerOwnedRepository: vi.fn(),
    } as never);
    const context = await host.resolveContext({ candidate: {
      id: 'candidate-1', integrationTaskId: 'integration-1', repositoryId: 'github:acme/app', baseBranch: 'main', branch: 'integration/1',
      state: 'working', currentRevision: 2, workRound: 3, version: 4, workflowEpoch: '4', laneEpoch: '9', policyRevision: 'p1', mergeMethod: 'squash', policySnapshot: {}, createdAt: '', updatedAt: '',
    }, revision: { subjectDigest: 'subject-2', headOid: 'head-2' } } as never);
    const sql = String(query.mock.calls[0]![0]);
    expect(sql).toContain("JOIN executions e ON e.id=o.payload->>'executionId'");
    expect(sql).toContain('e.transitioned_at IS NOT NULL');
    expect(sql).toContain('ORDER BY e.transitioned_at DESC');
    expect(sql).not.toContain('resolutions');
    expect(sql).toContain('o.work_round=c.work_round');
    expect(sql).toContain("o.payload->>'subjectDigest','')=$2");
    expect(sql).toContain("o.kind='push_ref' AND o.state='succeeded'");
    expect(sql).toContain("o.state IN ('executing','unknown','failed','needs_human','succeeded')");
    expect(sql).toContain("o.expected->>'ref'=('refs/heads/'||c.branch)");
    expect(sql).toContain("CASE WHEN o.state IN ('executing','unknown','succeeded') THEN o.expected->>'newOid' END");
    expect(sql).toContain("o.receipt->>'ref'=o.expected->>'ref'");
    expect(sql).toContain("o.receipt->>'oldOid'=o.expected->>'oldOid'");
    expect(sql).toContain("o.receipt->>'newOid'=o.expected->>'newOid'");
    expect(sql).toContain('o.workflow_epoch=c.workflow_epoch AND o.lane_epoch=c.lane_epoch');
    expect(sql).toContain('o.attempt_count>0');
    expect(sql).toContain('o.execution_id=work.execution_id');
    expect(sql).toContain('o.workflow_epoch=c.workflow_epoch AND o.lane_epoch=c.lane_epoch');
    expect(sql).not.toContain('c.subject_digest');
    expect(query.mock.calls[0]![1]).toEqual(['candidate-1', 'subject-2', 'head-2']);
    expect(context.trustedIntegrationBranchOids).toEqual(['a'.repeat(40)]);
    expect(context.workPushReceipt).toEqual({
      executionId: 'work-1', candidateId: 'candidate-1', candidateRevision: 2,
      workflowEpoch: '4', laneEpoch: '9', ref: 'refs/heads/integration/1',
      oldOid: 'head-2', newOid: 'head-3',
    });
  });

  it('persists failed cleanup receipts and requeues them with bounded backoff', async () => {
    const query = vi.fn(async (_text: string, _values?: unknown[]) => ({ rows: [{ id: 'cleanup-1' }] }));
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
