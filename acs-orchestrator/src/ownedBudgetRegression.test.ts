import { afterEach, describe, expect, it, vi } from 'vitest';
import { OwnedOperations } from './ownedOperations.js';
import { OwnedSharedWork } from './ownedSharedWork.js';

const scope = {
  storageId: 'isolated-test', mountSubPath: 'workspaces/account', sandboxName: 'as-budget',
  workspaceId: 'account', sessionId: 'session', sandboxScopeId: 'scope',
};

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('R09 R11 R18 actual shared-owner budget regression', () => {
  it('a caller deadline does not become the execution deadline of a longer legal recipe', async () => {
    vi.useFakeTimers();
    const operations = new OwnedOperations();
    const pool = new OwnedSharedWork<string>(operations);
    let finish!: (value: string) => void;
    const work = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    const input = {
      key: 'sandbox', fingerprint: 'many-legal-setup-steps', kind: 'provision' as const,
      scope, work, timeoutMs: 20, ownerTimeoutMs: 60 * 60_000,
    };
    const caller = pool.run(input);
    const expired = expect(caller).rejects.toMatchObject({ code: 'wait_timeout' });
    await vi.advanceTimersByTimeAsync(21);
    await expired;
    expect(work).toHaveBeenCalledOnce();
    expect(operations.records()).toHaveLength(1);
    // The request is over, not the independently owned provisioning operation.
    expect(operations.records()[0]?.resource).not.toBe('unknown');
    expect(operations.drainBlockers()).toBe(1);
    const follower = pool.run({ ...input, timeoutMs: 1_000 });
    finish('ready');
    await expect(follower).resolves.toBe('ready');
    expect(work).toHaveBeenCalledOnce();
    expect(operations.drainBlockers()).toBe(0);
  });

  it('an explicit owner budget still creates a truthful blocker without starting a second recipe', async () => {
    vi.useFakeTimers();
    const operations = new OwnedOperations();
    const pool = new OwnedSharedWork<string>(operations);
    let finish!: (value: string) => void;
    const work = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    const input = {
      key: 'sandbox', fingerprint: 'a', kind: 'provision' as const,
      scope, work, timeoutMs: 1_000, ownerTimeoutMs: 20,
    };
    const caller = pool.run(input);
    const rejected = expect(caller).rejects.toMatchObject({ code: 'wait_timeout' });
    await vi.advanceTimersByTimeAsync(21);
    expect(operations.records()[0]?.resource).toBe('unknown');
    await rejected;
    const replacement = vi.fn(async () => 'must not start');
    await expect(pool.run({ ...input, fingerprint: 'b', work: replacement }))
      .rejects.toMatchObject({ code: 'ownership_unresolved' });
    expect(replacement).not.toHaveBeenCalled();
    finish('late ready');
    await vi.advanceTimersByTimeAsync(0);
    expect(operations.drainBlockers()).toBe(1);
  });
});
