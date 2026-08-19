import { describe, expect, it, vi } from 'vitest';

import type { TaskBoardIntegrationCandidate, TaskBoardIntegrationCandidateRevision, TaskBoardRepositoryConfig } from '../../../shared/src/types/taskboard.js';
import { IntegrationEngineV3, type IntegrationEngineV3CandidateHost, type IntegrationEngineV3ExpectedSubject, type IntegrationEngineV3ProviderFacts } from './integrationEngineV3.js';
import { IntegrationProviderOperationService, type IntegrationProviderOperationRecord, type IntegrationProviderOperationState, type IntegrationProviderOperationStorageHost } from './integrationProviderOperations.js';

const repository: TaskBoardRepositoryConfig = { provider: 'github', repositoryId: 'github:acme/app', owner: 'acme', name: 'app', baseBranch: 'main', allowForkPullRequest: false };
const revision: TaskBoardIntegrationCandidateRevision = {
  candidateId: 'candidate-1', revision: 1, digestVersion: 1, baseOid: 'base-1', headOid: 'head-1', treeOid: 'tree-1',
  sourceSetDigest: 'sha256:sources', subjectDigest: 'sha256:subject', policySnapshotDigest: 'sha256:policy', policyRevision: 'policy-1',
  mergeMethod: 'squash', workRound: 0, createdAt: '2026-08-19T00:00:00.000Z',
};
function candidate(state: TaskBoardIntegrationCandidate['state']): TaskBoardIntegrationCandidate {
  return {
    id: 'candidate-1', integrationTaskId: 'integration-1', repositoryId: repository.repositoryId, baseBranch: 'main', branch: 'integration/integration-1',
    providerPullRequestId: '42', state, currentRevision: 1, workRound: 0, version: 7, workflowEpoch: '3', laneEpoch: '9',
    policyRevision: 'policy-1', mergeMethod: 'squash', policySnapshot: { requiredChecks: ['ci'] }, sourceSetDigest: revision.sourceSetDigest,
    ...(state === 'approved' || state === 'merging' ? { approvedRevision: 1, approvedReviewExecutionId: 'review-1' } : {}),
    createdAt: '2026-08-19T00:00:00.000Z', updatedAt: '2026-08-19T00:00:00.000Z',
  };
}
function expected(value: TaskBoardIntegrationCandidate): IntegrationEngineV3ExpectedSubject {
  return { candidateVersion: value.version, candidateRevision: 1, workflowEpoch: '3', laneEpoch: '9', repositoryId: repository.repositoryId,
    baseOid: revision.baseOid, headOid: revision.headOid, treeOid: revision.treeOid, sourceSetDigest: revision.sourceSetDigest,
    policyRevision: revision.policyRevision, policySnapshotDigest: revision.policySnapshotDigest, subjectDigest: revision.subjectDigest };
}
function facts(overrides: Partial<IntegrationEngineV3ProviderFacts> = {}): IntegrationEngineV3ProviderFacts {
  return { repositoryId: repository.repositoryId, providerPullRequestId: '42', state: 'open', baseBranch: 'main', baseOid: 'base-1', headOid: 'head-1', treeOid: 'tree-1',
    requiredChecksKnown: true, requiredChecks: [{ name: 'ci', status: 'success' }], unsupportedRules: [], mergeQueueRequired: false, ...overrides };
}

class MemoryCandidateHost implements IntegrationEngineV3CandidateHost {
  constructor(public value: TaskBoardIntegrationCandidate) {}
  async getCurrent() { return { candidate: structuredClone(this.value), revision: structuredClone(revision) }; }
  async appendRevision(): Promise<TaskBoardIntegrationCandidate> { throw new Error('not used'); }
  async beginNextWorkRound(): Promise<TaskBoardIntegrationCandidate> { this.value = { ...this.value, state: 'working', workRound: this.value.workRound + 1, version: this.value.version + 1 }; return structuredClone(this.value); }
  async transition(_id: string, input: { to: TaskBoardIntegrationCandidate['state']; approvedReviewExecutionId?: string; mergedCommitOid?: string; lastError?: string }): Promise<TaskBoardIntegrationCandidate> {
    this.value = { ...this.value, state: input.to, version: this.value.version + 1, ...(input.approvedReviewExecutionId ? { approvedRevision: 1, approvedReviewExecutionId: input.approvedReviewExecutionId } : {}), ...(input.lastError ? { lastError: input.lastError } : {}) };
    return structuredClone(this.value);
  }
  async commitMerged(input: { mergedCommitOid: string }): Promise<TaskBoardIntegrationCandidate> { this.value = { ...this.value, state: 'merged', mergedCommitOid: input.mergedCommitOid, version: this.value.version + 1 }; return structuredClone(this.value); }
}
class MemoryOperations implements IntegrationProviderOperationStorageHost {
  records = new Map<string, IntegrationProviderOperationRecord>();
  async getByOperationKey(key: string) { const value = this.records.get(key); return value && structuredClone(value); }
  async insertPrepared(record: IntegrationProviderOperationRecord) { const winner = this.records.get(record.operationKey) ?? record; this.records.set(record.operationKey, structuredClone(winner)); return structuredClone(winner); }
  async compareAndSet(input: { id: string; expectedState: IntegrationProviderOperationState; nextState: IntegrationProviderOperationState; patch: Pick<IntegrationProviderOperationRecord, 'attemptCount' | 'updatedAt'> & { receipt?: Record<string, unknown>; error?: string } }) {
    const current = [...this.records.values()].find((item) => item.id === input.id);
    if (!current || current.state !== input.expectedState) return undefined;
    const updated = { ...current, ...input.patch, state: input.nextState };
    this.records.set(updated.operationKey, updated);
    return structuredClone(updated);
  }
}

function setup(state: TaskBoardIntegrationCandidate['state'], providerFacts = facts()) {
  const candidates = new MemoryCandidateHost(candidate(state));
  const operations = new MemoryOperations();
  const requests = { requestWork: vi.fn(async () => ({ requestId: 'work-request' })), requestReview: vi.fn(async () => ({ requestId: 'review-request' })), requestWorkspaceSync: vi.fn(async () => ({ requestId: 'sync-request' })), requestCleanup: vi.fn(async () => ({ requestId: 'cleanup-request' })) };
  let currentFacts = providerFacts;
  const merge = vi.fn(async () => ({ providerRequestId: 'merge-request' }));
  const reconcileMerge = vi.fn(async () => ({ status: 'succeeded' as const, receipt: { providerPullRequestId: '42', mergedCommitOid: 'commit-1', mergedTreeOid: 'tree-1' } }));
  const getFlags = vi.fn(async () => ({ enabled: true, composeEnabled: true, reviewEnabled: true, mergeEnabled: true, cleanupEnabled: true, workspaceSyncEnabled: true }));
  const engine = new IntegrationEngineV3({
    candidates, providerOperations: new IntegrationProviderOperationService(operations, { assertCurrent: async () => undefined }),
    provider: { readFacts: async () => structuredClone(currentFacts), merge, reconcileMerge },
    features: { getFlags }, requests,
    resolveRepository: async () => repository, credentialOwnerId: 'owner-1',
  });
  return { engine, candidates, operations, requests, merge, reconcileMerge, getFlags, setFacts(value: IntegrationEngineV3ProviderFacts) { currentFacts = value; } };
}

describe('IntegrationEngineV3', () => {
  it('loads frozen feature flags by candidate identity, never by repository history', async () => {
    const value = candidate('waiting_checks');
    const { engine, getFlags } = setup('waiting_checks');
    await engine.execute({ type: 'request_review', candidateId: value.id, expected: expected(value) });
    expect(getFlags).toHaveBeenCalledWith('candidate-1');
  });

  it('rejects a stale subject fence before dispatching any side effect', async () => {
    const { engine, requests } = setup('waiting_checks');
    const stale = { ...expected(candidate('waiting_checks')), headOid: 'stale-head' };
    await expect(engine.execute({ type: 'request_review', candidateId: 'candidate-1', expected: stale })).rejects.toMatchObject({ code: 'TASKBOARD_CANDIDATE_CAS_MISMATCH' });
    expect(requests.requestReview).not.toHaveBeenCalled();
  });

  it('fails closed when GitHub required gate facts are unknown', async () => {
    const value = candidate('waiting_checks');
    const { engine, candidates, requests } = setup('waiting_checks', facts({ requiredChecksKnown: false }));
    const result = await engine.execute({ type: 'request_review', candidateId: value.id, expected: expected(value) });
    expect(result.candidate.state).toBe('blocked');
    expect(candidates.value.lastError).toContain('not authoritative');
    expect(requests.requestReview).not.toHaveBeenCalled();
  });

  it('never resends an unknown merge and commits only after authoritative reconciliation', async () => {
    const value = candidate('approved');
    const context = setup('approved');
    context.merge.mockRejectedValueOnce(new Error('timeout after provider accepted merge'));
    const first = await context.engine.execute({ type: 'merge_approved', candidateId: value.id, expected: expected(value), executionId: 'merge-execution-1' });
    expect(first.status).toBe('provider_unknown');
    expect(first.candidate.state).toBe('merging');
    expect(context.merge).toHaveBeenCalledTimes(1);
    const operationKey = first.operation!.operationKey;

    await expect(context.engine.execute({ type: 'merge_approved', candidateId: value.id, expected: expected(context.candidates.value), executionId: 'merge-execution-1' })).rejects.toThrow(/reconcile is required/);
    expect(context.merge).toHaveBeenCalledTimes(1);

    context.setFacts(facts({ state: 'merged', mergeCommitOid: 'commit-1', mergedTreeOid: 'tree-1' }));
    const reconciled = await context.engine.execute({ type: 'reconcile_merge', candidateId: value.id, expected: expected(context.candidates.value), operationKey });
    expect(reconciled.candidate).toMatchObject({ state: 'merged', mergedCommitOid: 'commit-1' });
    expect(context.reconcileMerge).toHaveBeenCalledTimes(1);
    expect(context.merge).toHaveBeenCalledTimes(1);
  });

  it('emits main synchronization as a deterministic workspace request', async () => {
    const value = candidate('needs_work');
    const { engine, requests } = setup('needs_work');
    const result = await engine.execute({ type: 'sync_main', candidateId: value.id, expected: expected(value) });
    expect(result).toMatchObject({ status: 'requested', requestId: 'sync-request' });
    expect(requests.requestWorkspaceSync).toHaveBeenCalledWith({ candidateId: 'candidate-1', revision: 1, baseBranch: 'main', expectedBaseOid: 'base-1' });
  });
});
