import { describe, expect, it, vi } from 'vitest';

import { DerivedStoreError } from '../derived/index.js';
import { ContextPlanePhase2Runtime, derivedProjectionFailureCode } from './runtime.js';

describe('ContextPlanePhase2Runtime fast sync isolation', () => {
  it('continues successful tenant projection after another tenant projector fails', async () => {
    const { runtime, warn } = makeRuntime({});
    const internals = runtime as unknown as RuntimeInternals;
    internals.taskboard = { runOnce: vi.fn().mockResolvedValue([{ tenantId: 'tenant-a' }, { tenantId: 'tenant-b' }]) };
    internals.directory = { runOnce: vi.fn().mockResolvedValue([{ tenantId: 'tenant-a' }, { tenantId: 'tenant-b' }]) };
    internals.ensurePhase2Assignments = vi.fn().mockResolvedValue(undefined);
    internals.projectDerived = vi.fn()
      .mockRejectedValueOnce(new Error('projector unavailable'))
      .mockResolvedValueOnce(undefined);

    await runtime.runFastOnce();

    expect(internals.projectDerived).toHaveBeenNthCalledWith(1, 'tenant-a');
    expect(internals.projectDerived).toHaveBeenNthCalledWith(2, 'tenant-b');
    expect(warn).toHaveBeenCalledWith(
      'Context fast projection failed for tenant tenant-a: projector unavailable',
    );
  });

  it('keeps Directory and projection running when the Taskboard coordinator is unavailable', async () => {
    const { runtime, warn } = makeRuntime({});
    const internals = runtime as unknown as RuntimeInternals;
    internals.taskboard = { runOnce: vi.fn().mockRejectedValue(new Error('taskboard offline')) };
    internals.directory = { runOnce: vi.fn().mockResolvedValue([{ tenantId: 'tenant-b' }]) };
    internals.ensurePhase2Assignments = vi.fn().mockResolvedValue(undefined);
    internals.projectDerived = vi.fn().mockResolvedValue(undefined);

    await runtime.runFastOnce();

    expect(internals.projectDerived).toHaveBeenCalledWith('tenant-b');
    expect(warn).toHaveBeenCalledWith('Context Taskboard coordinator failed: taskboard offline');
  });

  it('supports a runtime with no Taskboard worker', async () => {
    const warn = vi.fn();
    const runtime = new ContextPlanePhase2Runtime({
      contextStore: {} as never,
      membershipStore: {} as never,
      assignmentStore: {} as never,
      userStore: {} as never,
      logger: { info: vi.fn(), warn },
    });
    const internals = runtime as unknown as RuntimeInternals;
    internals.directory = { runOnce: vi.fn().mockResolvedValue([{ tenantId: 'tenant-directory' }]) };
    internals.ensurePhase2Assignments = vi.fn().mockResolvedValue(undefined);
    internals.projectDerived = vi.fn().mockResolvedValue(undefined);

    await runtime.runFastOnce();

    expect(internals.taskboard).toBeUndefined();
    expect(internals.projectDerived).toHaveBeenCalledWith('tenant-directory');
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('ContextPlanePhase2Runtime relation draining', () => {
  it.each([
    { name: 'no projector lease', claims: [null], released: 0, projected: 0 },
    { name: 'empty outbox page', claims: [lease([])], released: 1, projected: 0 },
    { name: 'last partial outbox page', claims: [lease([{}])], released: 0, projected: 1 },
    { name: 'full page followed by normal empty completion', claims: [lease(Array(100).fill({})), lease([])], released: 1, projected: 1 },
  ])('resolves pending candidates after $name', async ({ claims, released, projected }) => {
    const derivedStore = {
      claimContextOutbox: vi.fn().mockImplementation(() => Promise.resolve(claims.shift() ?? null)),
      releaseConsumerLease: vi.fn().mockResolvedValue(true),
      projectClaimed: vi.fn().mockResolvedValue({ projected: 1, cursorSeq: '1' }),
      resolvePendingRelationCandidates: vi.fn().mockResolvedValue({ materialized: 0, pending: true }),
    };
    const { runtime } = makeRuntime(derivedStore);

    await projectDerived(runtime, 'tenant-a');

    expect(derivedStore.resolvePendingRelationCandidates).toHaveBeenCalledWith({ tenantId: 'tenant-a', limit: 100 });
    expect(derivedStore.releaseConsumerLease).toHaveBeenCalledTimes(released);
    expect(derivedStore.projectClaimed).toHaveBeenCalledTimes(projected);
  });

  it('persists a structured retry state when deterministic projection fails', async () => {
    const projectionError = new Error('projection failed');
    const claimed = lease([{}]);
    const derivedStore = {
      claimContextOutbox: vi.fn().mockResolvedValue(claimed),
      releaseConsumerLease: vi.fn(),
      projectClaimed: vi.fn().mockRejectedValue(projectionError),
      failConsumerLease: vi.fn().mockResolvedValue(true),
      resolvePendingRelationCandidates: vi.fn(),
    };
    const { runtime } = makeRuntime(derivedStore);

    await expect(projectDerived(runtime, 'tenant-a')).rejects.toThrow('projection failed');
    expect(derivedStore.failConsumerLease).toHaveBeenCalledWith(claimed, 'DERIVED_PROJECTION_FAILED');
    expect(derivedStore.resolvePendingRelationCandidates).not.toHaveBeenCalled();
  });

  it.each([
    [new DerivedStoreError('DERIVED_EVIDENCE_INVALID'), 'DERIVED_EVIDENCE_INVALID'],
    [Object.assign(new Error('foreign key'), { code: '23503' }), 'DERIVED_REFERENCE_MISSING'],
    [Object.assign(new Error('unique'), { code: '23505' }), 'DERIVED_UNIQUE_CONFLICT'],
    [Object.assign(new Error('check'), { code: '23514' }), 'DERIVED_CONSTRAINT_VIOLATION'],
    [Object.assign(new Error('column'), { code: '42703' }), 'DERIVED_SCHEMA_MISMATCH'],
    [new Error('unknown'), 'DERIVED_PROJECTION_FAILED'],
  ])('classifies projection failures without persisting raw database messages', (error, expected) => {
    expect(derivedProjectionFailureCode(error)).toBe(expected);
  });

  it('drains more than one 100-candidate batch without a busy loop', async () => {
    const derivedStore = {
      claimContextOutbox: vi.fn().mockResolvedValue(null),
      releaseConsumerLease: vi.fn(),
      projectClaimed: vi.fn(),
      resolvePendingRelationCandidates: vi.fn()
        .mockResolvedValueOnce({ materialized: 100, pending: true })
        .mockResolvedValueOnce({ materialized: 25, pending: false }),
    };
    const { runtime, warn } = makeRuntime(derivedStore);

    await projectDerived(runtime, 'tenant-a');

    expect(derivedStore.resolvePendingRelationCandidates).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it('stops at the explicit page cap, leaves pending truthful and warns', async () => {
    const derivedStore = {
      claimContextOutbox: vi.fn().mockResolvedValue(null),
      releaseConsumerLease: vi.fn(),
      projectClaimed: vi.fn(),
      resolvePendingRelationCandidates: vi.fn().mockResolvedValue({ materialized: 100, pending: true }),
    };
    const { runtime, warn } = makeRuntime(derivedStore);

    await projectDerived(runtime, 'tenant-cap');

    expect(derivedStore.resolvePendingRelationCandidates).toHaveBeenCalledTimes(100);
    await expect(derivedStore.resolvePendingRelationCandidates.mock.results.at(-1)?.value)
      .resolves.toEqual({ materialized: 100, pending: true });
    expect(warn).toHaveBeenCalledWith(
      'Context relation resolver page cap reached with pending candidates for tenant tenant-cap',
    );
  });
});

function makeRuntime(derivedStore: object): { runtime: ContextPlanePhase2Runtime; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  return {
    runtime: new ContextPlanePhase2Runtime({
      contextStore: {} as never,
      taskboardStore: {} as never,
      membershipStore: {} as never,
      assignmentStore: {} as never,
      userStore: {} as never,
      derivedStore: derivedStore as never,
      logger: { info: vi.fn(), warn },
    }),
    warn,
  };
}

async function projectDerived(runtime: ContextPlanePhase2Runtime, tenantId: string): Promise<void> {
  await (runtime as unknown as { projectDerived(id: string): Promise<void> }).projectDerived(tenantId);
}

interface RuntimeInternals {
  taskboard?: { runOnce(): Promise<Array<{ tenantId: string }>> };
  directory: { runOnce(): Promise<Array<{ tenantId: string }>> };
  ensurePhase2Assignments(tenantId: string, includeAzeroth: boolean): Promise<void>;
  projectDerived(tenantId: string): Promise<void>;
}

function lease(events: unknown[]): object {
  return {
    tenantId: 'tenant-a', consumerId: 'consumer', leaseOwner: 'owner', leaseFence: '1',
    cursorSeq: '0', leaseExpiresAt: '2026-08-23T00:00:00Z', events,
  };
}
