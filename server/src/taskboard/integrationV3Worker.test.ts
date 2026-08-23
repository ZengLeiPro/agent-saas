import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { TaskBoardIntegrationCandidate, TaskBoardIntegrationCandidateRevision } from '../../../shared/src/types/taskboard.js';
import type { IntegrationEngineV3, IntegrationEngineV3Command } from './integrationEngineV3.js';
import { IntegrationV3CandidateReloadRequiredError, IntegrationV3ComposeConflictError } from './integrationV3ComposeExecutor.js';
import { IntegrationV3Worker, type IntegrationV3RequestLease, type IntegrationV3WorkerHost } from './integrationV3Worker.js';
import { executeIntegrationV3Cleanup, terminalizeIntegrationV3PreparedOperations } from './integrationV3WorkerPostgres.js';

const revision: TaskBoardIntegrationCandidateRevision = {
  candidateId: 'candidate-1', revision: 1, digestVersion: 1, baseOid: 'base', headOid: 'head', treeOid: 'tree',
  compositionComplete: true, sourceSetDigest: 'sources', subjectDigest: 'subject', policySnapshotDigest: 'policy', policyRevision: 'p1',
  mergeMethod: 'squash', workRound: 0, createdAt: '2026-08-19T00:00:00.000Z',
};
function candidate(state: TaskBoardIntegrationCandidate['state']): TaskBoardIntegrationCandidate {
  return {
    id: 'candidate-1', integrationTaskId: 'integration-1', repositoryId: 'github:acme/app', baseBranch: 'main',
    branch: 'integration/candidate-1', providerPullRequestId: '42', state, currentRevision: 1, workRound: 0,
    version: 1, workflowEpoch: '3', laneEpoch: '9', policyRevision: 'p1', mergeMethod: 'squash', policySnapshot: {},
    createdAt: '2026-08-19T00:00:00.000Z', updatedAt: '2026-08-19T00:00:00.000Z',
  };
}

class MemoryHost implements IntegrationV3WorkerHost {
  current = { candidate: candidate('preparing'), revision };
  requests: IntegrationV3RequestLease[] = [];
  checkpoints: Record<string, unknown>[] = [];
  errors: Array<string | undefined> = [];
  dispatched: IntegrationV3RequestLease[] = [];
  cleanupCalls: IntegrationV3RequestLease[] = [];
  completedRequests: Array<{ request: IntegrationV3RequestLease; receipt?: import('./integrationV3Worker.js').IntegrationV3CleanupReceipt }> = [];
  mergeOperation?: { operationKey: string; state: 'prepared' | 'executing' | 'unknown' | 'failed' | 'needs_human' | 'succeeded' };
  async claimCandidate() {
    if (['merged', 'canceled'].includes(this.current.candidate.state) && this.checkpoints.at(-1)?.status === 'requested') return undefined;
    return { candidateId: 'candidate-1', leaseId: 'candidate-lease' };
  }
  async loadCurrent() { return structuredClone(this.current); }
  async checkpointCandidate(_lease: unknown, value: Record<string, unknown>) { this.checkpoints.push(value); }
  async releaseCandidate(_lease: unknown, error?: string, _retryable?: boolean) { this.errors.push(error); }
  async claimRequest() { return this.requests.shift(); }
  async dispatchAgent(request: IntegrationV3RequestLease) { this.dispatched.push(request); }
  async syncWorkspace() {}
  async cleanup(request: IntegrationV3RequestLease) {
    this.cleanupCalls.push(request);
    return { version: 1 as const, outcome: 'succeeded' as const, completedAt: new Date().toISOString(), actions: [
      { action: 'revoke_capabilities' as const, status: 'succeeded' as const },
      { action: 'fence_capabilities' as const, status: 'succeeded' as const },
      { action: 'terminalize_prepared_operations' as const, status: 'succeeded' as const, target: '0' },
      { action: 'remove_candidate_worktree' as const, status: 'skipped' as const, reason: 'test has no server worktree' },
      { action: 'source_pull_request' as const, status: 'skipped' as const, reason: 'policy disabled' },
    ] };
  }
  async completeRequest(request: IntegrationV3RequestLease, receipt?: import('./integrationV3Worker.js').IntegrationV3CleanupReceipt) { this.completedRequests.push({ request, ...(receipt ? { receipt } : {}) }); }
  async releaseRequest() { throw new Error('unexpected request failure'); }
  async findRecoverableMergeOperation() { return this.mergeOperation; }
}

function request(kind: 'work'|'review'|'cleanup'): IntegrationV3RequestLease {
  return { id: `${kind}-request`, leaseId: `${kind}-lease`, kind, candidateId: 'candidate-1', candidateRevision: 1, payload: { candidateId: 'candidate-1', revision: 1 } };
}

describe('IntegrationV3Worker pure mock flow', () => {
  it('advances compose/checks/review/merge/cleanup and never dispatches a Merge Agent', async () => {
    const host = new MemoryHost();
    const commands: string[] = [];
    const engine = {
      execute: vi.fn(async (command: IntegrationEngineV3Command) => {
        commands.push(command.type);
        const next: Record<string, TaskBoardIntegrationCandidate['state']> = {
          start_compose: 'composing', compose_clean: 'waiting_checks', request_review: 'in_review',
          merge_approved: 'merging', reconcile_merge: 'merged', cleanup: host.current.candidate.state,
        };
        host.current.candidate = { ...host.current.candidate, state: next[command.type] ?? host.current.candidate.state, version: host.current.candidate.version + 1 };
        if (command.type === 'request_review') host.requests.push(request('review'));
        if (command.type === 'merge_approved') {
          host.mergeOperation = { operationKey: 'merge-op', state: 'unknown' };
        }
        if (command.type === 'cleanup') host.requests.push(request('cleanup'));
        return { candidate: structuredClone(host.current.candidate), status: command.type === 'merge_approved' ? 'provider_unknown' : command.type === 'cleanup' ? 'requested' : 'applied' };
      }),
    } as unknown as IntegrationEngineV3;
    const composer = {
      compose: vi.fn(async () => ({ baseOid: 'base', headOid: 'composed', treeOid: 'composed-tree', sources: [] })),
      refreshAfterWork: vi.fn(async () => undefined),
    };
    const worker = new IntegrationV3Worker({ host, engine, composer, maxRequestsPerTick: 10 });

    await worker.runOnce(); // preparing -> composing
    await worker.runOnce(); // compose -> checks
    await worker.runOnce(); // checks -> in_review + review outbox
    await worker.runOnce(); // dispatch review; in_review waits
    expect(host.dispatched.map((item) => item.kind)).toEqual(['review']);
    expect(host.dispatched[0]).toMatchObject({ candidateId: 'candidate-1', candidateRevision: 1 });

    host.current.candidate = { ...host.current.candidate, state: 'approved', approvedRevision: 1, approvedReviewExecutionId: 'review-exec' };
    await worker.runOnce(); // provider result unknown
    await worker.runOnce(); // reconcile -> merged
    await worker.runOnce(); // enqueue cleanup
    await worker.runOnce(); // consume cleanup

    expect(commands).toEqual(['start_compose', 'compose_clean', 'request_review', 'request_review', 'merge_approved', 'reconcile_merge', 'cleanup']);
    expect(host.cleanupCalls).toHaveLength(1);
    expect(host.completedRequests.at(-1)).toMatchObject({ request: { kind: 'cleanup' }, receipt: { outcome: 'succeeded' } });
    expect(host.dispatched.every((item) => item.kind === 'work' || item.kind === 'review')).toBe(true);
    expect(host.errors.filter(Boolean)).toEqual(['Provider outcome awaits durable reconciliation']);
  });

  it('passes the trusted incomplete revision with compose conflict evidence to the engine', async () => {
    const host = new MemoryHost();
    host.current.candidate = candidate('composing');
    const partial = {
      baseOid: 'base', headOid: 'partial-head', treeOid: 'partial-tree',
      compositionComplete: false, sources: [],
    };
    const execute = vi.fn(async () => ({
      candidate: { ...host.current.candidate, state: 'needs_work' as const, currentRevision: 2 },
      status: 'applied' as const,
    }));
    const worker = new IntegrationV3Worker({
      host, engine: { execute } as unknown as IntegrationEngineV3,
      composer: {
        compose: vi.fn(async () => { throw new IntegrationV3ComposeConflictError('source conflict', partial); }),
        refreshAfterWork: vi.fn(),
      },
    });

    await worker.runOnce();

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      type: 'compose_conflict', evidence: 'source conflict', revision: partial,
    }));
    expect(host.errors.at(-1)).toBeUndefined();
  });

  it('replays a prepared merge intent after a crash between prepare and execute', async () => {
    const host = new MemoryHost();
    host.current.candidate = {
      ...candidate('merging'),
      approvedRevision: 1,
      approvedReviewExecutionId: 'review-exec',
    };
    host.mergeOperation = { operationKey: 'merge-prepared', state: 'prepared' };
    const execute = vi.fn(async (command: IntegrationEngineV3Command) => ({
      candidate: { ...host.current.candidate, state: 'merged' as const },
      status: 'applied' as const,
      ...(command.type === 'merge_approved' ? {} : { unexpected: command.type }),
    }));
    const worker = new IntegrationV3Worker({
      host,
      engine: { execute } as unknown as IntegrationEngineV3,
      composer: { compose: vi.fn(), refreshAfterWork: vi.fn() },
    });

    await worker.runOnce();

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      type: 'merge_approved',
      executionId: 'integration-v3-worker:candidate-1:r1',
    }));
    expect(host.errors.at(-1)).toBeUndefined();
  });

  it('durably requeues transient compose failures instead of terminally failing the candidate', async () => {
    const host = new MemoryHost();
    host.current.candidate = candidate('composing');
    const releases: Array<{ error?: string; retryable?: boolean }> = [];
    host.releaseCandidate = async (_lease: unknown, error?: string, retryable?: boolean) => { releases.push({ ...(error ? { error } : {}), retryable }); };
    const worker = new IntegrationV3Worker({
      host,
      engine: { execute: vi.fn() } as unknown as IntegrationEngineV3,
      composer: {
        compose: async () => { throw new Error('temporary workspace outage'); },
        refreshAfterWork: async () => undefined,
      },
    });
    await worker.runOnce();
    expect(releases.at(-1)).toEqual({ error: 'temporary workspace outage', retryable: true });
  });

  it('reloads after PR binding advances without persisting a worker error', async () => {
    const host = new MemoryHost();
    host.current.candidate = candidate('composing');
    const releaseCandidate = vi.fn(async () => undefined);
    host.releaseCandidate = releaseCandidate;
    const worker = new IntegrationV3Worker({
      host,
      engine: { execute: vi.fn() } as unknown as IntegrationEngineV3,
      composer: {
        compose: async () => { throw new IntegrationV3CandidateReloadRequiredError(); },
        refreshAfterWork: async () => undefined,
      },
    });

    await worker.runOnce();

    expect(releaseCandidate).toHaveBeenCalledWith({ candidateId: 'candidate-1', leaseId: 'candidate-lease' });
  });

  it('converges an invalid ready work result to needs_human without failing the worker lease', async () => {
    const host = new MemoryHost();
    host.current.candidate = candidate('working');
    const execute = vi.fn(async (command: IntegrationEngineV3Command) => command.type === 'needs_human'
      ? { candidate: { ...host.current.candidate, state: 'needs_human' as const, lastError: command.reason }, status: 'applied' as const }
      : { candidate: host.current.candidate, status: 'requested' as const });
    const invalid = new Error('Ready work result changed neither the integration head nor the base');
    invalid.name = 'IntegrationV3InvalidWorkResultError';
    const worker = new IntegrationV3Worker({
      host,
      engine: { execute } as unknown as IntegrationEngineV3,
      composer: { compose: vi.fn(), refreshAfterWork: async () => { throw invalid; } },
    });
    await worker.runOnce();
    expect(execute.mock.calls.map(([command]) => command.type)).toEqual(['request_work', 'needs_human']);
    expect(host.checkpoints.at(-1)).toMatchObject({ state: 'needs_human', status: 'applied' });
    expect(host.errors.at(-1)).toBeUndefined();
  });

  it('reports pending, successful, and failed worker ticks to the activation heartbeat', async () => {
    const host = new MemoryHost();
    host.claimCandidate = async () => undefined;
    const worker = new IntegrationV3Worker({
      host,
      engine: { execute: vi.fn() } as unknown as IntegrationEngineV3,
      composer: { compose: vi.fn(), refreshAfterWork: vi.fn() },
    });
    expect(worker.health()).toEqual({ healthy: false, reason: 'worker_tick_pending' });
    await worker.runOnce();
    expect(worker.health()).toEqual({ healthy: true });
    host.claimRequest = async () => { throw new Error('schema mismatch'); };
    await expect(worker.runOnce()).rejects.toThrow('schema mismatch');
    expect(worker.health()).toEqual({ healthy: false, reason: 'worker_tick_failed' });
  });

  it('keeps readiness healthy during a bounded active tick and fails stale after the bound', async () => {
    const host = new MemoryHost();
    host.claimCandidate = async () => undefined;
    const worker = new IntegrationV3Worker({
      host,
      engine: { execute: vi.fn() } as unknown as IntegrationEngineV3,
      composer: { compose: vi.fn(), refreshAfterWork: vi.fn() },
      maxActiveTickMs: 30_000,
    });
    await worker.runOnce();
    let releaseClaim!: () => void;
    host.claimRequest = () => new Promise((resolve) => { releaseClaim = () => resolve(undefined); });
    const activeTick = worker.runOnce();
    await vi.waitFor(() => expect(releaseClaim).toBeTypeOf('function'));
    const now = Date.now();
    expect(worker.health(now + 29_000)).toEqual({ healthy: true });
    expect(worker.health(now + 31_000)).toEqual({ healthy: false, reason: 'worker_tick_stale' });
    releaseClaim();
    await activeTick;
  });

  it.each(['failed', 'needs_human'] as const)(
    'recovers a terminal %s merge operation from merging after restart',
    async (operationState) => {
      const host = new MemoryHost();
      host.current.candidate = candidate('merging');
      host.mergeOperation = { operationKey: `terminal-${operationState}-op`, state: operationState };
      const engine = { execute: vi.fn(async (_command: IntegrationEngineV3Command) => ({
        candidate: { ...host.current.candidate, state: 'needs_human' as const }, status: 'applied' as const,
      })) } as unknown as IntegrationEngineV3;
      const worker = new IntegrationV3Worker({
        host, engine,
        composer: { compose: vi.fn(), refreshAfterWork: vi.fn() },
      });

      await worker.runOnce();

      expect(engine.execute).toHaveBeenCalledWith(expect.objectContaining({
        type: 'reconcile_merge', operationKey: `terminal-${operationState}-op`,
      }));
      expect(host.errors.at(-1)).toBeUndefined();
    },
  );

  it.each(['merging', 'needs_human'] as const)(
    'recovers a succeeded merge operation from %s after restart without resending merge',
    async (state) => {
      const host = new MemoryHost();
      host.current.candidate = candidate(state);
      host.mergeOperation = { operationKey: 'succeeded-merge-op', state: 'succeeded' };
      const engine = { execute: vi.fn(async (_command: IntegrationEngineV3Command) => ({ candidate: { ...host.current.candidate, state: 'merged' }, status: 'applied' })) } as unknown as IntegrationEngineV3;
      const worker = new IntegrationV3Worker({
        host, engine,
        composer: { compose: vi.fn(), refreshAfterWork: vi.fn() },
      });
      await worker.runOnce();
      expect(engine.execute).toHaveBeenCalledWith(expect.objectContaining({ type: 'reconcile_merge', operationKey: 'succeeded-merge-op' }));
      expect(host.errors.at(-1)).toBeUndefined();
    },
  );
});


describe('Integration v3 prepared operation terminalization', () => {
  it('terminalizes only unexecuted prepared operations and excludes them from same-snapshot active counts', async () => {
    const query = vi.fn(async (_text: string, _values?: unknown[]) => ({ rows: [{ terminalized_count: 1, remaining_count: 0 }] }));

    await expect(terminalizeIntegrationV3PreparedOperations({
      pool: { query }, providerOperationsTable: 'provider_operations',
      candidateId: 'candidate-1', reason: 'candidate_merged',
    })).resolves.toBe(1);

    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain("state='prepared' AND attempt_count=0");
    expect(sql).toContain("state IN ('prepared','executing','unknown')");
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM terminalized t WHERE t.id=o.id)');
    expect(values).toEqual(['candidate-1', expect.stringContaining('candidate_merged')]);
  });

  it('fails closed while any prepared, executing, or unknown operation remains', async () => {
    const query = vi.fn(async (_text: string, _values?: unknown[]) => ({ rows: [{ terminalized_count: 0, remaining_count: 1 }] }));

    await expect(terminalizeIntegrationV3PreparedOperations({
      pool: { query }, providerOperationsTable: 'provider_operations',
      candidateId: 'candidate-1', reason: 'candidate_merged',
    })).rejects.toThrow('1 active provider operation(s) require reconciliation');
  });
});

describe('Integration v3 cleanup receipts', () => {
  it('receipts capability fencing, clean server-owned worktree removal, and each source PR policy action', async () => {
    const root = mkdtempSync(join(tmpdir(), 'integration-v3-cleanup-'));
    const controlledWorktreeRoot = join(root, 'worktrees');
    const worktreePath = join(controlledWorktreeRoot, 'candidate-1');
    mkdirSync(worktreePath, { recursive: true });
    const commands: readonly string[][] = [];
    const mutableCommands = commands as string[][];
    const receipt = await executeIntegrationV3Cleanup({
      candidateId: 'candidate-1', repositoryPath: join(root, 'repo-1'),
      controlledWorktreeRoot, worktreePath, branch: 'integration/candidate-1',
      sourcePullRequests: [{ id: 'pr-1', action: 'skip', policyReason: 'policy keeps source PRs open' }],
      withRepositoryBranchLock: async (_lock, operation) => operation(),
      runGit: async (command) => { mutableCommands.push([...command.args]); return { exitCode: 0, stdout: '', stderr: '' }; },
      revokeCapabilities: async () => undefined,
      fenceCapabilities: async () => undefined,
      terminalizePreparedOperations: async () => 1,
      applySourcePullRequest: async () => undefined,
    });
    expect(receipt).toMatchObject({ outcome: 'succeeded', actions: [
      { action: 'revoke_capabilities', status: 'succeeded' },
      { action: 'fence_capabilities', status: 'succeeded' },
      { action: 'terminalize_prepared_operations', status: 'succeeded', target: '1' },
      { action: 'remove_candidate_worktree', status: 'succeeded' },
      { action: 'source_pull_request', status: 'skipped', target: 'pr-1', reason: 'policy keeps source PRs open' },
    ] });
    expect(commands).toEqual([
      ['status', '--porcelain=v1', '--untracked-files=all'],
      ['worktree', 'remove', '--', worktreePath],
    ]);
    rmSync(root, { recursive: true, force: true });
  });

  it('fails closed without removing an unsafe or dirty candidate worktree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'integration-v3-cleanup-dirty-'));
    const controlledWorktreeRoot = join(root, 'worktrees');
    const worktreePath = join(controlledWorktreeRoot, 'candidate-1');
    mkdirSync(worktreePath, { recursive: true });
    const runGit = vi.fn(async () => ({ exitCode: 0, stdout: ' M file.ts\n', stderr: '' }));
    const receipt = await executeIntegrationV3Cleanup({
      candidateId: 'candidate-1', repositoryPath: join(root, 'repo-1'),
      controlledWorktreeRoot, worktreePath, branch: 'integration/candidate-1',
      sourcePullRequests: [], withRepositoryBranchLock: async (_lock, operation) => operation(), runGit,
      revokeCapabilities: async () => undefined, fenceCapabilities: async () => undefined,
      terminalizePreparedOperations: async () => 0,
      applySourcePullRequest: async () => undefined,
    });
    expect(receipt).toMatchObject({ outcome: 'failed', actions: expect.arrayContaining([
      expect.objectContaining({ action: 'remove_candidate_worktree', status: 'failed', error: expect.stringContaining('dirty') }),
    ]) });
    expect(runGit).toHaveBeenCalledTimes(1);
    rmSync(root, { recursive: true, force: true });
  });
});
