import { describe, expect, it, vi } from 'vitest';

import { ContextPlanePhase2Runtime } from './runtime.js';

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

function lease(events: unknown[]): object {
  return {
    tenantId: 'tenant-a', consumerId: 'consumer', leaseOwner: 'owner', leaseFence: '1',
    cursorSeq: '0', leaseExpiresAt: '2026-08-23T00:00:00Z', events,
  };
}
