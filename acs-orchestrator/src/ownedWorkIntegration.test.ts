import { afterEach, describe, expect, it, vi } from 'vitest';
import { PendingRunnerInvocation } from './pendingRunnerInvocation.js';
import { OwnedSharedWork } from './ownedSharedWork.js';
import { OwnedOperations } from './ownedOperations.js';
import type { OwnershipJournal } from './ownershipJournal.js';
import type { OwnershipRecord } from './ownershipState.js';

const scope = { storageId: 'test', mountSubPath: 'workspaces/account', sandboxName: 'as-test',
  workspaceId: 'account', sessionId: 'session', sandboxScopeId: 'scope' };

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('actual owned work integration', () => {
  it('keeps the cancelled attempt tombstone while independently delivering a late terminal receipt', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const late = vi.fn();
    const pending = new PendingRunnerInvocation(cancel, late);
    pending.start(30 * 60_000);
    const next = pending.next();
    pending.cancel();
    pending.cancel();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(cancel).toHaveBeenCalledOnce();
    expect((await next).value).toMatchObject({ kind: 'final', response: { metadata: { remoteExecution: { state: 'unknown' } } } });
    pending.detach();
    expect(pending.retained).toBe(true);
    pending.accept({ kind: 'final', response: { status: 'success', content: 'done' } });
    expect(late).toHaveBeenCalledOnce();
    expect(pending.retained).toBe(false);
  });

  it('does not evict a provisioning owner when one equal-recipe follower aborts', async () => {
    const operations = new OwnedOperations();
    const pool = new OwnedSharedWork<string>(operations);
    let finish!: (value: string) => void;
    const work = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    const controller = new AbortController();
    const input = { key: 'sandbox', fingerprint: 'recipe-a', kind: 'provision' as const, scope, work };
    const leader = pool.run(input);
    const follower = pool.run({ ...input, signal: controller.signal });
    const rejected = expect(follower).rejects.toMatchObject({ code: 'wait_cancelled' });
    controller.abort();
    await rejected;
    await vi.waitFor(() => expect(work).toHaveBeenCalledOnce());
    expect(operations.drainBlockers()).toBe(1);
    finish('ready');
    await expect(leader).resolves.toBe('ready');
    expect(operations.drainBlockers()).toBe(0);
  });

  it('settles a never-dispatched failed ensure and lets drain and a new recipe proceed', async () => {
    const records = new Map<string, OwnershipRecord>();
    const journal = {
      reserve: vi.fn(async (record: OwnershipRecord) => {
        records.set(record.operationId, structuredClone(record));
        return record;
      }),
      update: vi.fn(async (record: OwnershipRecord) => {
        records.set(record.operationId, structuredClone(record));
        return record;
      }),
      snapshot: () => ({ available: true, records: [...records.values()] }),
    } as unknown as OwnershipJournal;
    const operations = new OwnedOperations(journal);
    const pool = new OwnedSharedWork<string>(operations);
    const failed = pool.run({
      key: 'as-ws-kaiyan-kyvynk4r399zsr-workspaces--b7d26d0218f50eec',
      fingerprint: 'ensure-v1', kind: 'ensure', scope,
      work: async (operation) => {
        operation.markUncertain('shared_work_unconfirmed');
        throw new Error('shared work failed before dispatch');
      },
    });
    await expect(failed).rejects.toThrow('shared work failed before dispatch');
    const local = operations.records().find((record) => record.kind === 'ensure');
    expect(local).toMatchObject({ resource: 'not_started', outcome: 'failed' });
    expect(local?.remoteFence).toBeUndefined();
    expect(operations.drainBlockers()).toBe(0);
    expect([...records.values()].some((record) => record.resource === 'not_started' && record.outcome === 'failed')).toBe(true);
    const replacement = vi.fn(async () => 'ready');
    await expect(pool.run({
      key: 'as-ws-kaiyan-kyvynk4r399zsr-workspaces--b7d26d0218f50eec',
      fingerprint: 'ensure-v2', kind: 'ensure', scope, work: replacement,
    })).resolves.toBe('ready');
    expect(replacement).toHaveBeenCalledOnce();
    expect(operations.drainBlockers()).toBe(0);
  });

  it('does not permit a new recipe after a dispatched failed owner', async () => {
    const operations = new OwnedOperations();
    const pool = new OwnedSharedWork<string>(operations);
    const failed = pool.run({ key: 'sandbox', fingerprint: 'a', kind: 'provision', scope,
      work: async (operation) => {
        await operation.dispatch('sandbox-uid-lost');
        throw new Error('remote setup transport lost');
      } });
    await expect(failed).rejects.toThrow('remote setup transport lost');
    expect(operations.records()[0]?.resource).toBe('unknown');
    expect(operations.records()[0]?.reasonCode).toBe('shared_work_unconfirmed');
    expect(operations.drainBlockers()).toBe(1);
    const replacement = vi.fn(async () => 'not allowed');
    await expect(pool.run({ key: 'sandbox', fingerprint: 'b', kind: 'provision', scope, work: replacement }))
      .rejects.toMatchObject({ code: 'ownership_unresolved' });
    expect(replacement).not.toHaveBeenCalled();
  });
});
