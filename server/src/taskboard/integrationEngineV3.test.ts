import { describe, expect, it, vi } from 'vitest';

import type { TaskBoardIntegrationCandidate, TaskBoardIntegrationCandidateRevision, TaskBoardRepositoryConfig } from '../../../shared/src/types/taskboard.js';
import { IntegrationEngineV3, type IntegrationEngineV3CandidateHost, type IntegrationEngineV3ExpectedSubject, type IntegrationEngineV3ProviderFacts, type IntegrationEngineV3RequestHost } from './integrationEngineV3.js';
import { IntegrationProviderOperationService, integrationProviderOperationKey, type IntegrationProviderOperationRecord, type IntegrationProviderOperationState, type IntegrationProviderOperationStorageHost } from './integrationProviderOperations.js';

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
  const requests = {
    requestWork: vi.fn<IntegrationEngineV3RequestHost['requestWork']>(async () => ({ requestId: 'work-request' })),
    requestReview: vi.fn<IntegrationEngineV3RequestHost['requestReview']>(async () => ({ requestId: 'review-request' })),
    requestWorkspaceSync: vi.fn(async () => ({ requestId: 'sync-request' })),
    requestCleanup: vi.fn(async () => ({ requestId: 'cleanup-request' })),
  };
  let currentFacts = providerFacts;
  const merge = vi.fn(async (_repository: TaskBoardRepositoryConfig, input: { operationKey: string }) => ({
    providerRequestId: input.operationKey,
    providerPullRequestId: '42',
    mergedCommitOid: 'commit-1',
  }));
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

  it('waits for at least one observed check when no provider-enforced gate can exist', async () => {
    const value = candidate('waiting_checks');
    const { engine, candidates, requests } = setup('waiting_checks', facts({ requiredChecks: [] }));

    const result = await engine.execute({ type: 'request_review', candidateId: value.id, expected: expected(value) });

    expect(result.status).toBe('waiting');
    expect(candidates.value.state).toBe('waiting_checks');
    expect(requests.requestReview).not.toHaveBeenCalled();
  });

  it('turns a current-base advance into a recoverable work round instead of a permanent worker failure', async () => {
    const value = candidate('waiting_checks');
    const { engine, candidates, requests } = setup('waiting_checks', facts({ baseOid: 'new-main' }));

    const result = await engine.execute({ type: 'request_review', candidateId: value.id, expected: expected(value) });

    expect(result.status).toBe('applied');
    expect(candidates.value).toMatchObject({
      state: 'needs_work',
      lastError: 'Provider base advanced; candidate refresh required',
    });
    expect(requests.requestReview).not.toHaveBeenCalled();
  });

  it('still fails closed for provider head drift', async () => {
    const value = candidate('waiting_checks');
    const { engine, requests } = setup('waiting_checks', facts({ headOid: 'unexpected-head' }));

    await expect(engine.execute({
      type: 'request_review', candidateId: value.id, expected: expected(value),
    })).rejects.toMatchObject({ code: 'TASKBOARD_INTEGRATION_SUBJECT_DRIFT' });
    expect(requests.requestReview).not.toHaveBeenCalled();
  });

  it.each([
    ['unavailable', facts({ requiredChecksKnown: false }), 'TASKBOARD_INTEGRATION_REQUIRED_CHECKS_UNKNOWN'],
    ['failure', facts({ requiredChecks: [{ name: 'ci', status: 'failure' }] }), 'TASKBOARD_INTEGRATION_REQUIRED_CHECKS_FAILED'],
    ['pending', facts({ requiredChecks: [{ name: 'ci', status: 'pending' }] }), 'TASKBOARD_INTEGRATION_REQUIRED_CHECKS_PENDING'],
  ] as const)('rechecks required checks and blocks %s before the final merge side effect', async (_case, providerFacts, code) => {
    const value = candidate('approved');
    const { engine, merge, operations } = setup('approved', providerFacts);

    await expect(engine.execute({
      type: 'merge_approved', candidateId: value.id, expected: expected(value), executionId: 'merge-execution-1',
    })).rejects.toMatchObject({ code });
    expect(merge).not.toHaveBeenCalled();
    expect(operations.records.size).toBe(0);
  });

  it.each(['approved', 'merging'] as const)(
    'converges an externally merged %s candidate to needs_human without fabricating a controlled receipt',
    async (state) => {
      const value = candidate(state);
      const context = setup(state, facts({
        state: 'merged', baseOid: 'advanced-main', mergeCommitOid: 'external-merge', mergedTreeOid: 'tree-1',
      }));

      const result = await context.engine.execute({
        type: 'merge_approved', candidateId: value.id, expected: expected(value), executionId: 'merge-execution-1',
      });

      expect(result).toMatchObject({
        status: 'applied',
        candidate: {
          state: 'needs_human',
          lastError: expect.stringContaining('outside the controlled Workflow v3 operation'),
        },
      });
      expect(context.merge).not.toHaveBeenCalled();
      expect(context.operations.records.size).toBe(0);
    },
  );

  it('converges a mismatched external merge to needs_human instead of poisoning worker health', async () => {
    const value = candidate('merging');
    const context = setup('merging', facts({
      state: 'merged', baseOid: 'advanced-main', mergeCommitOid: 'external-merge', mergedTreeOid: 'different-tree',
    }));

    const result = await context.engine.execute({
      type: 'merge_approved', candidateId: value.id, expected: expected(value), executionId: 'merge-execution-1',
    });

    expect(result).toMatchObject({
      status: 'applied',
      candidate: { state: 'needs_human', lastError: expect.stringContaining('mismatched approved facts') },
    });
    expect(context.merge).not.toHaveBeenCalled();
  });

  it('recomposes an approved candidate when the base advances before merge preparation', async () => {
    const value = candidate('approved');
    const context = setup('approved', facts({ baseOid: 'new-main' }));

    const result = await context.engine.execute({
      type: 'merge_approved', candidateId: value.id, expected: expected(value), executionId: 'merge-execution-1',
    });

    expect(result).toMatchObject({ status: 'applied', candidate: { state: 'composing' } });
    expect(context.merge).not.toHaveBeenCalled();
    expect(context.operations.records.size).toBe(0);
  });

  it('recomposes a merging candidate when only a prepared merge exists and the base advances', async () => {
    const value = candidate('merging');
    const context = setup('merging', facts({ baseOid: 'new-main' }));
    const operationKey = integrationProviderOperationKey({
      repositoryId: value.repositoryId,
      candidateId: value.id,
      candidateRevision: 1,
      kind: 'merge_pull_request',
      target: '42',
    });
    context.operations.records.set(operationKey, {
      id: 'operation-1', operationKey, kind: 'merge_pull_request', repositoryId: value.repositoryId,
      fence: { workflowEpoch: 3, laneEpoch: 9, candidateId: value.id, candidateRevision: 1, executionId: 'merge-execution-1' },
      expected: {}, command: {}, intentDigest: 'digest', state: 'prepared', attemptCount: 0,
      createdAt: '2026-08-19T00:00:00.000Z', updatedAt: '2026-08-19T00:00:00.000Z',
    });

    const result = await context.engine.execute({
      type: 'merge_approved', candidateId: value.id, expected: expected(value), executionId: 'merge-execution-1',
    });

    expect(result).toMatchObject({ status: 'applied', candidate: { state: 'composing' } });
    expect(context.merge).not.toHaveBeenCalled();
    expect(context.operations.records.get(operationKey)?.state).toBe('prepared');
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

    context.setFacts(facts({ state: 'merged', baseOid: 'merged-main', mergeCommitOid: 'commit-1', mergedTreeOid: 'tree-1' }));
    const reconciled = await context.engine.execute({ type: 'reconcile_merge', candidateId: value.id, expected: expected(context.candidates.value), operationKey });
    expect(reconciled.candidate).toMatchObject({ state: 'merged', mergedCommitOid: 'commit-1' });
    expect(context.reconcileMerge).toHaveBeenCalledTimes(1);
    expect(context.merge).toHaveBeenCalledTimes(1);
  });

  it('accepts an exact direct controlled receipt when a squash merge tree includes an advanced base', async () => {
    const value = candidate('approved');
    const context = setup('approved');
    context.merge.mockImplementationOnce(async (_repository: TaskBoardRepositoryConfig, input: { operationKey: string }) => {
      context.setFacts(facts({
        state: 'merged', baseOid: 'merged-main', mergeCommitOid: 'commit-1', mergedTreeOid: 'squash-result-tree',
      }));
      return {
        providerRequestId: input.operationKey,
        providerPullRequestId: '42',
        mergedCommitOid: 'commit-1',
      };
    });

    const result = await context.engine.execute({
      type: 'merge_approved', candidateId: value.id, expected: expected(value), executionId: 'merge-execution-1',
    });

    expect(result).toMatchObject({ status: 'applied', candidate: { state: 'merged', mergedCommitOid: 'commit-1' } });
  });

  it('recovers a needs_human candidate only from its exact succeeded controlled receipt', async () => {
    const value = candidate('needs_human');
    const context = setup('needs_human', facts({
      state: 'merged', baseOid: 'merged-main', mergeCommitOid: 'commit-1', mergedTreeOid: 'squash-result-tree',
    }));
    const operationKey = integrationProviderOperationKey({
      repositoryId: value.repositoryId,
      candidateId: value.id,
      candidateRevision: 1,
      kind: 'merge_pull_request',
      target: '42',
    });
    context.operations.records.set(operationKey, {
      id: 'operation-1', operationKey, kind: 'merge_pull_request', repositoryId: value.repositoryId,
      fence: { workflowEpoch: 3, laneEpoch: 9, candidateId: value.id, candidateRevision: 1, executionId: 'merge-execution-1' },
      expected: {}, command: {}, intentDigest: 'digest', state: 'succeeded', attemptCount: 1,
      receipt: { providerRequestId: operationKey, providerPullRequestId: '42', mergedCommitOid: 'commit-1' },
      createdAt: '2026-08-19T00:00:00.000Z', updatedAt: '2026-08-19T00:00:00.000Z',
    });

    const result = await context.engine.execute({
      type: 'reconcile_merge', candidateId: value.id, expected: expected(value), operationKey,
    });

    expect(result).toMatchObject({ status: 'applied', candidate: { state: 'merged', mergedCommitOid: 'commit-1' } });
    expect(context.reconcileMerge).not.toHaveBeenCalled();
  });

  it('reconciles request rows from their target candidate states without advancing twice', async () => {
    const working = setup('working');
    const workValue = working.candidates.value;
    const work = await working.engine.execute({ type: 'request_work', candidateId: workValue.id, expected: expected(workValue) });
    expect(work.candidate).toMatchObject({ state: 'working', workRound: 0, version: 7 });
    expect(working.requests.requestWork).toHaveBeenCalledWith(expect.objectContaining({ workRound: 0, subjectDigest: revision.subjectDigest }));

    const reviewing = setup('in_review');
    const reviewValue = reviewing.candidates.value;
    const review = await reviewing.engine.execute({ type: 'request_review', candidateId: reviewValue.id, expected: expected(reviewValue) });
    expect(review.candidate).toMatchObject({ state: 'in_review', version: 7 });
    expect(reviewing.requests.requestReview).toHaveBeenCalledWith(expect.objectContaining({ subjectDigest: revision.subjectDigest, sourceSetDigest: revision.sourceSetDigest }));
  });

  it('turns an exhausted work/review request into explicit operator recovery instead of auto-reviving it', async () => {
    const working = setup('working');
    working.requests.requestWork.mockResolvedValue({ requestId: 'work-request', status: 'failed' });
    await expect(working.engine.execute({
      type: 'request_work', candidateId: 'candidate-1', expected: expected(working.candidates.value),
    })).rejects.toMatchObject({ code: 'TASKBOARD_CANDIDATE_REQUEST_FAILED' });

    const reviewing = setup('in_review');
    reviewing.requests.requestReview.mockResolvedValue({ requestId: 'review-request', status: 'failed' });
    await expect(reviewing.engine.execute({
      type: 'request_review', candidateId: 'candidate-1', expected: expected(reviewing.candidates.value),
    })).rejects.toMatchObject({ code: 'TASKBOARD_CANDIDATE_REQUEST_FAILED' });
  });

  it('emits main synchronization as a deterministic workspace request', async () => {
    const value = candidate('needs_work');
    const { engine, requests } = setup('needs_work');
    const result = await engine.execute({ type: 'sync_main', candidateId: value.id, expected: expected(value) });
    expect(result).toMatchObject({ status: 'requested', requestId: 'sync-request' });
    expect(requests.requestWorkspaceSync).toHaveBeenCalledWith({ candidateId: 'candidate-1', revision: 1, baseBranch: 'main', expectedBaseOid: 'base-1' });
  });
});
