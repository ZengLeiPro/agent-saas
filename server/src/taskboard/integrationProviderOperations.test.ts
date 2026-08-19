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
  }): Promise<IntegrationProviderOperationRecord | undefined> {
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
    expect(fences.assertCurrent).toHaveBeenCalledTimes(2);
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

  it('moves a reconciled mismatch to needs_human', async () => {
    const { service } = setup();
    await service.prepare(intent);
    await service.execute(operationKey, async () => { throw new Error('timeout'); });

    const result = await service.reconcile(operationKey, async () => ({
      status: 'mismatch', detail: 'branch points to a different base', evidence: { actualOid: 'other-oid' },
    }));

    expect(result).toMatchObject({ state: 'needs_human', error: 'branch points to a different base', receipt: { actualOid: 'other-oid' } });
  });

  it('rejects reuse of a semantic key with a different expected state', async () => {
    const { service } = setup();
    await service.prepare(intent);

    await expect(service.prepare({ ...intent, expected: { baseOid: 'drifted-base' } })).rejects.toBeInstanceOf(ProviderOperationKeyCollisionError);
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
