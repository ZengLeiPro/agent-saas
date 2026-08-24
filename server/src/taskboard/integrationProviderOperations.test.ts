import { describe, expect, it, vi } from 'vitest';

import {
  IntegrationProviderOperationService,
  ProviderOperationKeyCollisionError,
  ProviderOperationReconcileRequiredError,
  integrationProviderOperationKey,
  type IntegrationProviderOperationIntent,
  type IntegrationProviderOperationRecord,
  type IntegrationProviderOperationState,
  type IntegrationProviderOperationStorageHost,
} from './integrationProviderOperations.js';

class MemoryStorage implements IntegrationProviderOperationStorageHost {
  readonly records = new Map<string, IntegrationProviderOperationRecord>();
  readonly casInputs: Array<{ mutationFence?: { leaseId: string; leaseEpoch: string; releaseIdentity: string } }> = [];

  async getByOperationKey(key: string): Promise<IntegrationProviderOperationRecord | undefined> {
    return clone(this.records.get(key));
  }

  async insertPrepared(record: IntegrationProviderOperationRecord): Promise<IntegrationProviderOperationRecord> {
    const winner = this.records.get(record.operationKey);
    if (winner) return clone(winner)!;
    this.records.set(record.operationKey, clone(record)!);
    return clone(record)!;
  }

  async compareAndSet(input: {
    id: string;
    expectedState: IntegrationProviderOperationState;
    nextState: IntegrationProviderOperationState;
    patch: Pick<IntegrationProviderOperationRecord, 'attemptCount' | 'updatedAt'> & { receipt?: Record<string, unknown>; error?: string };
    mutationFence?: { leaseId: string; leaseEpoch: string; releaseIdentity: string };
  }): Promise<IntegrationProviderOperationRecord | undefined> {
    this.casInputs.push(input);
    const current = [...this.records.values()].find((record) => record.id === input.id);
    if (!current || current.state !== input.expectedState) return undefined;
    const updated = { ...current, ...input.patch, state: input.nextState };
    this.records.set(updated.operationKey, updated);
    return clone(updated);
  }
}

const operationKey = integrationProviderOperationKey({
  repositoryId: 'github:acme/app', candidateId: 'candidate-1', candidateRevision: 1,
  kind: 'create_branch', target: 'integration/task-1',
});

const intent: IntegrationProviderOperationIntent = {
  operationKey,
  kind: 'create_branch',
  repositoryId: 'github:acme/app',
  fence: { workflowEpoch: 3, laneEpoch: 7, candidateId: 'candidate-1', candidateRevision: 1, executionId: 'execution-1' },
  expected: { baseOid: 'base-oid', baseTreeOid: 'base-tree' },
  command: { ref: 'integration/task-1', oid: 'base-oid' },
};

function clone<T>(value: T): T { return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T; }

function setup() {
  const storage = new MemoryStorage();
  const fences = { assertCurrent: vi.fn(async () => undefined) };
  let tick = 0;
  const service = new IntegrationProviderOperationService(storage, fences, () => new Date(1_700_000_000_000 + tick++));
  return { storage, fences, service };
}

describe('IntegrationProviderOperationService', () => {
  it('prepares and executes one semantic operation exactly once', async () => {
    const { service, fences } = setup();
    const executor = vi.fn(async () => ({ ref: 'integration/task-1', oid: 'base-oid' }));

    const first = await service.prepare(intent);
    const duplicatePrepare = await service.prepare(intent);
    const completed = await service.execute(operationKey, executor);
    const duplicateExecute = await service.execute(operationKey, executor);

    expect(duplicatePrepare.id).toBe(first.id);
    expect(completed).toMatchObject({ state: 'succeeded', attemptCount: 1, receipt: { oid: 'base-oid' } });
    expect(duplicateExecute.state).toBe('succeeded');
    expect(executor).toHaveBeenCalledTimes(1);
    expect(fences.assertCurrent).toHaveBeenCalledTimes(3);
  });

  it('records a timeout as unknown and reconciles the provider receipt without resending', async () => {
    const { service } = setup();
    await service.prepare(intent);
    const executor = vi.fn(async () => { throw new Error('request timed out after GitHub created the ref'); });

    const unknown = await service.execute(operationKey, executor);
    expect(unknown).toMatchObject({ state: 'unknown', attemptCount: 1 });
    await expect(service.execute(operationKey, executor)).rejects.toBeInstanceOf(ProviderOperationReconcileRequiredError);

    const reconciler = vi.fn(async () => ({
      status: 'succeeded' as const,
      receipt: { ref: 'integration/task-1', oid: 'base-oid', reconciled: true },
    }));
    const reconciled = await service.reconcile(operationKey, reconciler);

    expect(reconciled).toMatchObject({ state: 'succeeded', attemptCount: 1, receipt: { reconciled: true } });
    expect(executor).toHaveBeenCalledTimes(1);
    expect(reconciler).toHaveBeenCalledTimes(1);
  });

  it('keeps not-found reconcile outcomes unknown rather than blindly retrying create', async () => {
    const { service } = setup();
    await service.prepare(intent);
    await service.execute(operationKey, async () => { throw new TypeError('network reset'); });

    const result = await service.reconcile(operationKey, async () => ({ status: 'not_found', detail: 'ref is not visible yet' }));

    expect(result).toMatchObject({ state: 'unknown', error: 'ref is not visible yet', attemptCount: 1 });
  });

  it('requires two exact no-effect observations after an ambiguous timeout before terminalizing', async () => {
    const { service } = setup();
    await service.prepare(intent);
    const executor = vi.fn(async () => { throw new Error('transport failed'); });
    await service.execute(operationKey, executor);
    const reconcile = vi.fn(async () => ({
      status: 'not_applied' as const, detail: 'exact ref remains at the expected old OID',
      evidence: { actualOid: 'base-oid', verifiedNotApplied: true },
    }));

    const quiescing = await service.reconcile(operationKey, reconcile);
    expect(quiescing).toMatchObject({ state: 'unknown', attemptCount: 1,
      receipt: { outcome: 'quiescence_observed', actualOid: 'base-oid', verifiedNotApplied: true } });
    const terminal = await service.reconcile(operationKey, reconcile);
    expect(terminal).toMatchObject({ state: 'failed', attemptCount: 1,
      error: 'exact ref remains at the expected old OID',
      receipt: { outcome: 'not_applied', actualOid: 'base-oid', verifiedNotApplied: true } });
    expect(executor).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it('requires two exact no-effect observations before classifying an executing operation as not applied', async () => {
    const { service, storage } = setup();
    const prepared = await service.prepare(intent);
    await storage.compareAndSet({ id: prepared.id, expectedState: 'prepared', nextState: 'executing',
      patch: { attemptCount: 1, updatedAt: prepared.updatedAt } });
    const reconcile = vi.fn(async () => ({
      status: 'not_applied' as const, detail: 'ref still old', evidence: { verifiedNotApplied: true },
    }));

    const quiescing = await service.reconcile(operationKey, reconcile);
    expect(quiescing).toMatchObject({
      state: 'unknown', attemptCount: 1,
      receipt: { outcome: 'quiescence_observed', verifiedNotApplied: true },
    });
    const terminal = await service.reconcile(operationKey, reconcile);
    expect(terminal).toMatchObject({
      state: 'failed', attemptCount: 1,
      receipt: { outcome: 'not_applied', verifiedNotApplied: true },
    });
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it('moves a reconciled mismatch to needs_human', async () => {
    const { service } = setup();
    await service.prepare(intent);
    await service.execute(operationKey, async () => { throw new Error('timeout'); });

    const result = await service.reconcile(operationKey, async () => ({
      status: 'mismatch', detail: 'branch points to a different base', evidence: { actualOid: 'other-oid' },
    }));

    expect(result).toMatchObject({ state: 'needs_human', error: 'branch points to a different base', receipt: { actualOid: 'other-oid' } });
  });

  it('redacts provider errors and reconciliation evidence before durable CAS', async () => {
    const { service } = setup();
    await service.prepare(intent);
    await service.execute(operationKey, async () => { throw new Error('timeout ghs_serverinstallationtoken'); });

    const result = await service.reconcile(operationKey, async () => ({
      status: 'mismatch',
      detail: 'remote https://user:url-password@github.com/acme/repo.git differs',
      evidence: { diagnostic: 'github_pat_11AA_secretvalue' },
    }));

    expect(result.error).toBe('remote https://[REDACTED]@github.com/acme/repo.git differs');
    expect(result.receipt).toEqual({ diagnostic: '[REDACTED_GITHUB_TOKEN]' });
  });

  it('rejects reuse of a semantic key with a different expected state', async () => {
    const { service } = setup();
    await service.prepare(intent);

    await expect(service.prepare({ ...intent, expected: { baseOid: 'drifted-base' } })).rejects.toBeInstanceOf(ProviderOperationKeyCollisionError);
  });

  it('records a definitive executor rejection as explicitly not applied', async () => {
    const { service } = setup();
    await service.prepare(intent);

    const result = await service.execute(
      operationKey,
      async () => { throw new Error('final provider gate rejected'); },
      { isDefinitiveFailure: () => true },
    );

    expect(result).toMatchObject({
      state: 'failed', attemptCount: 1, error: 'final provider gate rejected',
      receipt: { outcome: 'not_applied', evidence: 'executor_definitive_failure' },
    });
  });

  it('terminalizes an executing operation when its second pre-provider fence is stale', async () => {
    const storage = new MemoryStorage();
    const fences = { assertCurrent: vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('candidate cleanup fenced provider calls')) };
    const service = new IntegrationProviderOperationService(storage, fences);
    const executor = vi.fn(async () => ({ ok: true }));
    await service.prepare(intent);

    const result = await service.execute(operationKey, executor);

    expect(result).toMatchObject({ state: 'failed', attemptCount: 1,
      error: 'candidate cleanup fenced provider calls',
      receipt: { outcome: 'not_applied', evidence: 'pre_execution_fence_rejected' } });
    expect(executor).not.toHaveBeenCalled();
  });

  it('leaves an applied provider attempt executing when the Worker loses its lease before receipt persistence', async () => {
    const { service, storage } = setup();
    await service.prepare(intent);
    let leaseCurrent = true;
    const assertAttemptCurrent = vi.fn(async () => {
      if (!leaseCurrent) throw new Error('candidate lease lost');
    });
    const providerWrite = vi.fn(async () => {
      leaseCurrent = false;
      return { ref: 'integration/task-1', oid: 'base-oid' };
    });

    await expect(service.execute(operationKey, providerWrite, { assertAttemptCurrent }))
      .rejects.toThrow('candidate lease lost');
    expect(providerWrite).toHaveBeenCalledOnce();
    const durable = await storage.getByOperationKey(operationKey);
    expect(durable).toMatchObject({ state: 'executing', attemptCount: 1 });
    expect(durable).not.toHaveProperty('receipt');
  });

  it('does not mark an operation definitively failed when the Worker loses its lease with the provider error', async () => {
    const { service, storage } = setup();
    await service.prepare(intent);
    let leaseCurrent = true;
    const assertAttemptCurrent = vi.fn(async () => {
      if (!leaseCurrent) throw new Error('candidate lease lost');
    });
    const providerWrite = vi.fn(async () => {
      leaseCurrent = false;
      throw new Error('provider rejected request');
    });

    await expect(service.execute(operationKey, providerWrite, {
      assertAttemptCurrent,
      isDefinitiveFailure: () => true,
    })).rejects.toThrow('candidate lease lost');
    expect(providerWrite).toHaveBeenCalledOnce();
    const durable = await storage.getByOperationKey(operationKey);
    expect(durable).toMatchObject({ state: 'executing', attemptCount: 1 });
    expect(durable).not.toHaveProperty('receipt');
    expect(durable).not.toHaveProperty('error');
  });

  it('passes the Worker mutation fence to every ledger CAS in an execute attempt', async () => {
    const { service, storage } = setup();
    const mutationFence = { leaseId: 'lease-1', leaseEpoch: '4', releaseIdentity: 'release-1' };
    await service.prepare(intent);
    await service.execute(operationKey, async () => ({ ok: true }), { mutationFence });

    expect(storage.casInputs).toHaveLength(2);
    expect(storage.casInputs.every((input) => input.mutationFence === mutationFence)).toBe(true);
  });

  it('fails before a write when durable fences are stale', async () => {
    const storage = new MemoryStorage();
    const fences = { assertCurrent: vi.fn(async () => { throw new Error('lane epoch changed'); }) };
    const service = new IntegrationProviderOperationService(storage, fences);
    const executor = vi.fn(async () => ({ ok: true }));
    await service.prepare(intent);

    await expect(service.execute(operationKey, executor)).rejects.toThrow('lane epoch changed');
    expect(executor).not.toHaveBeenCalled();
    expect((await storage.getByOperationKey(operationKey))?.state).toBe('prepared');
  });
});
