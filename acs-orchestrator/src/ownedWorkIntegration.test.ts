import { afterEach, describe, expect, it, vi } from 'vitest';
import { PendingRunnerInvocation } from './pendingRunnerInvocation.js';
import { OwnedSharedWork } from './ownedSharedWork.js';
import { OwnedOperations } from './ownedOperations.js';

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

  it('does not permit a new recipe after an unknown failed owner', async () => {
    const operations = new OwnedOperations();
    const pool = new OwnedSharedWork<string>(operations);
    const failed = pool.run({ key: 'sandbox', fingerprint: 'a', kind: 'provision', scope,
      work: async () => { throw new Error('remote setup transport lost'); } });
    await expect(failed).rejects.toThrow('remote setup transport lost');
    const replacement = vi.fn(async () => 'not allowed');
    await expect(pool.run({ key: 'sandbox', fingerprint: 'b', kind: 'provision', scope, work: replacement }))
      .rejects.toMatchObject({ code: 'ownership_unresolved' });
    expect(replacement).not.toHaveBeenCalled();
  });
});
