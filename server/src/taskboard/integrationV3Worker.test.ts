import { describe, expect, it, vi } from 'vitest';

import type { TaskBoardIntegrationCandidate, TaskBoardIntegrationCandidateRevision } from '../../../shared/src/types/taskboard.js';
import type { IntegrationEngineV3, IntegrationEngineV3Command } from './integrationEngineV3.js';
import { IntegrationV3Worker, type IntegrationV3RequestLease, type IntegrationV3WorkerHost } from './integrationV3Worker.js';

const revision: TaskBoardIntegrationCandidateRevision = {
  candidateId: 'candidate-1', revision: 1, digestVersion: 1, baseOid: 'base', headOid: 'head', treeOid: 'tree',
  sourceSetDigest: 'sources', subjectDigest: 'subject', policySnapshotDigest: 'policy', policyRevision: 'p1',
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
  completedRequests: Array<{ request: IntegrationV3RequestLease; outcome?: string }> = [];
  operationKey?: string;
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
  async cleanup(request: IntegrationV3RequestLease) { this.cleanupCalls.push(request); }
  async completeRequest(request: IntegrationV3RequestLease, outcome?: 'completed' | 'skipped-by-policy' | 'disabled') { this.completedRequests.push({ request, ...(outcome ? { outcome } : {}) }); }
  async releaseRequest() { throw new Error('unexpected request failure'); }
  async findRecoverableMergeOperation() { return this.operationKey; }
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
        if (command.type === 'merge_approved') host.operationKey = 'merge-op';
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

    expect(commands).toEqual(['start_compose', 'compose_clean', 'request_review', 'merge_approved', 'reconcile_merge', 'cleanup']);
    expect(host.cleanupCalls).toHaveLength(1);
    expect(host.completedRequests.at(-1)).toMatchObject({ request: { kind: 'cleanup' }, outcome: 'skipped-by-policy' });
    expect(host.dispatched.every((item) => item.kind === 'work' || item.kind === 'review')).toBe(true);
    expect(host.errors.filter(Boolean)).toEqual(['Provider outcome awaits durable reconciliation']);
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

  it('recovers a succeeded merge operation after restart without resending merge', async () => {
    const host = new MemoryHost();
    host.current.candidate = candidate('merging');
    host.operationKey = 'succeeded-merge-op';
    const engine = { execute: vi.fn(async (command: IntegrationEngineV3Command) => ({ candidate: { ...host.current.candidate, state: 'merged' }, status: 'applied' })) } as unknown as IntegrationEngineV3;
    const worker = new IntegrationV3Worker({
      host, engine,
      composer: { compose: vi.fn(), refreshAfterWork: vi.fn() },
    });
    await worker.runOnce();
    expect(engine.execute).toHaveBeenCalledWith(expect.objectContaining({ type: 'reconcile_merge', operationKey: 'succeeded-merge-op' }));
    expect(host.errors.at(-1)).toBeUndefined();
  });
});
