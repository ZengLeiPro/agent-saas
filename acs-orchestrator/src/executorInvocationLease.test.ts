import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { ActiveSandboxRegistry } from './activeSandboxRegistry.js';
import { AcsExecutor } from './executor.js';
import type { Kubectl } from './kubectl.js';
import type { SandboxManager, SandboxRef } from './sandboxManager.js';
import { baseConfig, noopLogger } from './sandboxManagerTestFixtures.js';

const ref: SandboxRef = {
  name: 'as-lease-fail-closed',
  workspaceId: 'ws_kaiyan__lease',
  sandboxScopeId: 'scope-lease',
  sessionId: 'session-lease',
  mountSubPath: 'ws_kaiyan__lease',
};

const request = {
  toolName: 'Shell',
  input: { command: 'long-tool' },
  context: {
    invocationId: 'inv-lease-fail-closed',
    workspace: {
      id: ref.workspaceId,
      sessionId: ref.sessionId,
      sandboxScopeId: ref.sandboxScopeId,
    },
  },
};

describe('AcsExecutor persisted invocation lease fail-closed and ownership', () => {
  it.each([
    {
      caseName: 'first renewal is rejected',
      renewal: () => Promise.reject(new Error('renew denied')),
      advanceMs: 60_000,
      expectedError: 'renew denied',
    },
    {
      caseName: 'first renewal remains pending past the safe window',
      renewal: () => new Promise<void>(() => {}),
      advanceMs: 115_000,
      expectedError: 'did not complete before expiry',
    },
  ])('$caseName aborts the runner and cannot return success', async ({ renewal, advanceMs, expectedError }) => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      const registry = new ActiveSandboxRegistry();
      const setActiveInvocationLease = vi.fn()
        .mockResolvedValueOnce('uid-lease')
        .mockImplementationOnce(renewal);
      const manager = {
        ref: () => ref,
        ensureRunning: vi.fn(async () => ref),
        setActiveInvocationLease,
        completeInvocation: vi.fn(async () => 'uid-1'),
        touch: vi.fn(async () => undefined),
      } as unknown as SandboxManager;
      const executor = new AcsExecutor(
        baseConfig(),
        { spawn: vi.fn(() => child) } as unknown as Kubectl,
        manager,
        noopLogger,
        registry,
        { persistentRunner: false },
      );

      const result = executor.execute(request);
      await vi.advanceTimersByTimeAsync(0);
      expect(registry.isBusy(ref.name)).toBe(true);
      expect(setActiveInvocationLease).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(advanceMs);
      expect(setActiveInvocationLease).toHaveBeenCalledTimes(2);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(registry.isBusy(ref.name)).toBe(true);

      // Even a runner success racing with cancellation must be suppressed.
      child.stdout.end(`${JSON.stringify({
        kind: 'final', response: { status: 'success', content: 'must-not-escape' },
      })}\n`);
      child.emit('close', 0, null);
      await vi.advanceTimersByTimeAsync(0);

      await expect(result).resolves.toMatchObject({
        status: 'error',
        error: expect.stringContaining(expectedError),
      });
      expect(registry.isBusy(ref.name)).toBe(false);
      // A failed/pending renewal may complete late, so leave its lease to expire; do not race a clear.
      expect(setActiveInvocationLease).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('advances activity generation when a new attempt is admitted after an old fence read', async () => {
    const childA = fakeChild();
    const childB = fakeChild();
    const setLeaseA = vi.fn(async () => 'uid-lease');
    const setLeaseB = vi.fn(async () => 'uid-lease');
    const completeA = vi.fn(async () => 'uid-lease');
    const completeB = vi.fn(async () => 'uid-lease');
    const manager = (
      setActiveInvocationLease: typeof setLeaseA,
      completeInvocation: typeof completeA,
    ) => ({
      ref: () => ref,
      ensureRunning: vi.fn(async () => ref),
      setActiveInvocationLease,
      completeInvocation,
      touch: vi.fn(async () => undefined),
    } as unknown as SandboxManager);
    const executorA = new AcsExecutor(baseConfig(), { spawn: vi.fn(() => childA) } as unknown as Kubectl,
      manager(setLeaseA, completeA), noopLogger, new ActiveSandboxRegistry(), { persistentRunner: false });
    const executorB = new AcsExecutor(baseConfig(), { spawn: vi.fn(() => childB) } as unknown as Kubectl,
      manager(setLeaseB, completeB), noopLogger, new ActiveSandboxRegistry(), { persistentRunner: false });

    const requestForAttempt = (attemptId: string) => ({
      ...request,
      context: {
        ...request.context,
        correlation: { version: 1 as const, invocationId: 'logical-invocation', attemptId },
      },
    });
    const first = executorA.execute(requestForAttempt('attempt-a'));
    await vi.waitFor(() => expect(setLeaseA).toHaveBeenCalledOnce());
    const leaseA = (setLeaseA.mock.calls as unknown[][])[0]?.[1];
    const staleFence = (setLeaseA.mock.calls as unknown[][])[0]?.[4];

    const second = executorB.execute(requestForAttempt('attempt-b'));
    await vi.waitFor(() => expect(setLeaseB).toHaveBeenCalledOnce());
    const leaseB = (setLeaseB.mock.calls as unknown[][])[0]?.[1];
    const currentFence = (setLeaseB.mock.calls as unknown[][])[0]?.[4];
    expect(leaseA).not.toBe(leaseB);
    expect(staleFence).toBe(leaseA);
    expect(currentFence).toBe(leaseB);
    expect(currentFence).not.toBe(staleFence);

    childA.stdout.end(`${JSON.stringify({ kind: 'final', response: { status: 'success', content: 'a' } })}\n`);
    childA.emit('close', 0, null);
    await expect(first).resolves.toMatchObject({ status: 'success' });
    expect(setLeaseA).toHaveBeenCalledTimes(2);
    expect(setLeaseA).toHaveBeenLastCalledWith(ref.name, leaseA, expect.any(String), 'uid-lease');
    expect(completeA).toHaveBeenCalledWith(ref.name, leaseA, expect.any(Date), 'uid-lease');
    expect(setLeaseB).toHaveBeenCalledOnce();

    childB.stdout.end(`${JSON.stringify({ kind: 'final', response: { status: 'success', content: 'b' } })}\n`);
    childB.emit('close', 0, null);
    await expect(second).resolves.toMatchObject({ status: 'success' });
    expect(setLeaseB).toHaveBeenCalledTimes(2);
    expect(setLeaseB).toHaveBeenLastCalledWith(ref.name, leaseB, expect.any(String), 'uid-lease');
    expect(completeB).toHaveBeenCalledWith(ref.name, leaseB, expect.any(Date), 'uid-lease');
  });
});

function fakeChild(): EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}
