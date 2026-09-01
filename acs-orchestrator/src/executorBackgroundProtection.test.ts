import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { AcsExecutor } from './executor.js';
import type { Kubectl } from './kubectl.js';
import type { SandboxManager, SandboxRef } from './sandboxManager.js';
import { baseConfig, noopLogger } from './sandboxManagerTestFixtures.js';

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

function ref(name: string): SandboxRef {
  return {
    name,
    workspaceId: 'ws_kaiyan__u-1',
    sandboxScopeId: 'ws_kaiyan__u-1',
    sessionId: 'session-1',
    mountSubPath: 'workspaces/kaiyan/u-1',
  };
}

/** Completes a one-shot runner with background metadata. */
function finishBackground(
  child: ReturnType<typeof fakeChild>,
  taskId: string,
  protectedUntil: string,
  status = 'running',
): void {
  child.stdout.end(`${JSON.stringify({
    kind: 'final',
    response: {
      status: 'success', content: '{}',
      metadata: { backgroundShell: { taskId, status, protectedUntil } },
    },
  })}\n`);
  child.emit('close', 0, null);
}

describe('AcsExecutor background shell protection handoff', () => {
  it('sweeps expired invocation-only residues without executing or touching on repeated scans', async () => {
    const sandboxRef = ref('as-expired-only');
    const clearExpiredInvocationLeases = vi.fn(async () => ({ active: false, removed: 1 }));
    const ensureRunning = vi.fn(async () => sandboxRef);
    const touch = vi.fn(async () => undefined);
    const sandboxManager = {
      listManagedSandboxes: vi.fn(async () => [{
        ...sandboxRef,
        activeInvocationLeaseUntil: '2026-08-30T00:00:00.000Z',
      }]),
      clearExpiredInvocationLeases,
      ref: () => sandboxRef,
      ensureRunning,
      touch,
    } as unknown as SandboxManager;
    const spawn = vi.fn();
    const executor = new AcsExecutor(
      baseConfig(), { spawn } as unknown as Kubectl, sandboxManager, noopLogger, undefined,
      { persistentRunner: false },
    );

    await expect(executor.reconcileBackgroundShellProtections()).resolves.toEqual({ checked: 1, failed: 0 });
    await expect(executor.reconcileBackgroundShellProtections()).resolves.toEqual({ checked: 1, failed: 0 });
    expect(clearExpiredInvocationLeases).toHaveBeenCalledTimes(2);
    expect(ensureRunning).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(touch).not.toHaveBeenCalled();
  });

  it('persists background protection before returning and clearing the invocation lease', async () => {
    const sandboxRef = ref('as-background');
    const child = fakeChild();
    const setBackgroundShellProtection = vi.fn(async () => undefined);
    const sandboxManager = {
      ref: () => sandboxRef,
      setActiveInvocationLease: vi.fn(async () => 'uid-1'),
      touch: vi.fn(async () => undefined),
      ensureRunning: vi.fn(async () => sandboxRef),
      setBackgroundShellProtection,
    } as unknown as SandboxManager;
    const kubectl = { spawn: vi.fn(() => child) } as unknown as Kubectl;
    const executor = new AcsExecutor(
      baseConfig(), kubectl, sandboxManager, noopLogger, undefined, { persistentRunner: false },
    );
    const protectedUntil = '2099-07-20T00:00:00.000Z';

    const resultPromise = executor.execute({
      toolName: 'Shell',
      input: { command: 'sleep 60', mode: 'background' },
      context: { workspace: {
        id: sandboxRef.workspaceId,
        sessionId: sandboxRef.sessionId,
        sandboxScopeId: sandboxRef.sandboxScopeId,
        mountSubPath: sandboxRef.mountSubPath,
      } },
    });
    await vi.waitFor(() => expect(kubectl.spawn).toHaveBeenCalledOnce());
    finishBackground(child, 'shell-bg-task-1', protectedUntil);

    await expect(resultPromise).resolves.toMatchObject({ status: 'success' });
    expect(setBackgroundShellProtection).toHaveBeenCalledWith(
      sandboxRef.name, protectedUntil, 'uid-1', undefined, expect.any(String),
    );
  });

  it('binds an empty runner snapshot to the background protection observed before execution', async () => {
    const sandboxRef = ref('as-background-empty-snapshot');
    const child = fakeChild();
    const observed = '2026-08-30T00:05:00.000Z'; const observedGeneration = 'generation-old';
    const setBackgroundShellProtection = vi.fn(async () => 'uid-1');
    const sandboxManager = {
      ref: () => sandboxRef,
      setActiveInvocationLease: vi.fn(async () => 'uid-1'),
      getBackgroundShellProtection: vi.fn(async () => ({ protectedUntil: observed, generation: observedGeneration })),
      touch: vi.fn(async () => undefined),
      ensureRunning: vi.fn(async () => sandboxRef),
      setBackgroundShellProtection,
    } as unknown as SandboxManager;
    const kubectl = { spawn: vi.fn(() => child) } as unknown as Kubectl;
    const executor = new AcsExecutor(
      baseConfig(), kubectl, sandboxManager, noopLogger, undefined, { persistentRunner: false },
    );

    const resultPromise = executor.execute({
      toolName: '__BackgroundShellReconcile', input: {},
      context: { workspace: {
        id: sandboxRef.workspaceId, sessionId: sandboxRef.sessionId,
        sandboxScopeId: sandboxRef.sandboxScopeId, mountSubPath: sandboxRef.mountSubPath,
      } },
    });
    await vi.waitFor(() => expect(kubectl.spawn).toHaveBeenCalledOnce());
    child.stdout.end(`${JSON.stringify({
      kind: 'final', response: {
        status: 'success', content: '{}', metadata: { backgroundShell: { activeTaskIds: [] } },
      },
    })}\n`);
    child.emit('close', 0, null);

    await expect(resultPromise).resolves.toMatchObject({ status: 'success' });
    expect(setBackgroundShellProtection).toHaveBeenCalledWith(
      sandboxRef.name, undefined, 'uid-1', observedGeneration,
    );
  });

  it('falls back to a long invocation lease when the background annotation write fails', async () => {
    const sandboxRef = ref('as-background-fallback');
    const child = fakeChild();
    const protectedUntil = '2099-07-20T00:10:00.000Z';
    const setActiveInvocationLease = vi.fn(async () => 'uid-1');
    const touch = vi.fn(async () => undefined);
    const warn = vi.fn();
    const sandboxManager = {
      ref: () => sandboxRef,
      ensureRunning: vi.fn(async () => sandboxRef),
      setActiveInvocationLease,
      setBackgroundShellProtection: vi.fn(async () => { throw new Error('protection CAS exhausted'); }),
      getSandboxUid: vi.fn(async () => 'uid-1'),
      touch,
    } as unknown as SandboxManager;
    const executor = new AcsExecutor(
      baseConfig(),
      { spawn: vi.fn(() => child) } as unknown as Kubectl,
      sandboxManager,
      { ...noopLogger, warn },
      undefined,
      { persistentRunner: false },
    );

    const resultPromise = executor.execute({
      toolName: 'Shell',
      input: { command: 'sleep 60', mode: 'background' },
      context: { invocationId: 'inv-background-fallback', workspace: {
        id: sandboxRef.workspaceId,
        sessionId: sandboxRef.sessionId,
        sandboxScopeId: sandboxRef.sandboxScopeId,
      } },
    });
    await vi.waitFor(() => expect(setActiveInvocationLease).toHaveBeenCalledOnce());
    finishBackground(child, 'shell-bg-fallback', protectedUntil);

    await expect(resultPromise).resolves.toMatchObject({ status: 'success' });
    const leaseKey = (setActiveInvocationLease.mock.calls as unknown[][])[0]![1] as string;
    expect(setActiveInvocationLease).toHaveBeenCalledTimes(2);
    expect(setActiveInvocationLease).toHaveBeenNthCalledWith(
      2, sandboxRef.name, leaseKey, protectedUntil, 'uid-1',
    );
    expect(touch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('background_shell_protection_fallback'));
  });

  it.each([
    ['terminal BashOutput', {
      taskId: 'shell-bg-terminal', status: 'completed',
      protectedUntil: '2099-07-20T00:10:00.000Z', activeTaskIds: ['shell-bg-other'],
    }],
    ['aggregate reconcile', {
      activeTaskIds: ['shell-bg-other'], protectedUntil: '2099-07-20T00:10:00.000Z',
    }],
  ])('terminates active tasks for %s when both protection writes fail', async (_case, backgroundShell) => {
    const sandboxRef = ref(`as-background-${String(_case).replaceAll(' ', '-')}`);
    const child = fakeChild();
    const setActiveInvocationLease = vi.fn()
      .mockResolvedValueOnce('uid-1')
      .mockRejectedValueOnce(new Error('lease CAS exhausted'));
    const terminateBackgroundTasks = vi.fn(async () => undefined);
    const touch = vi.fn(async () => undefined);
    const sandboxManager = {
      ref: () => sandboxRef,
      ensureRunning: vi.fn(async () => sandboxRef),
      setActiveInvocationLease,
      setBackgroundShellProtection: vi.fn(async () => { throw new Error('protection CAS exhausted'); }),
      getSandboxUid: vi.fn(async () => 'uid-1'),
      touch,
    } as unknown as SandboxManager;
    const executor = new AcsExecutor(
      baseConfig(),
      { spawn: vi.fn(() => child) } as unknown as Kubectl,
      sandboxManager,
      noopLogger,
      undefined,
      { persistentRunner: false, terminateBackgroundTasks },
    );

    const resultPromise = executor.execute({
      toolName: _case === 'terminal BashOutput' ? 'BashOutput' : '__BackgroundShellReconcile',
      input: {},
      context: { invocationId: `inv-${_case}`, workspace: {
        id: sandboxRef.workspaceId,
        sessionId: sandboxRef.sessionId,
        sandboxScopeId: sandboxRef.sandboxScopeId,
      } },
    });
    await vi.waitFor(() => expect(setActiveInvocationLease).toHaveBeenCalledOnce());
    child.stdout.end(`${JSON.stringify({
      kind: 'final',
      response: { status: 'success', content: '{}', metadata: { backgroundShell } },
    })}\n`);
    child.emit('close', 0, null);

    await expect(resultPromise).rejects.toThrow(/已终止活跃任务/u);
    expect(terminateBackgroundTasks).toHaveBeenCalledWith(sandboxRef, ['shell-bg-other']);
    expect(setActiveInvocationLease).toHaveBeenCalledTimes(3);
    expect(setActiveInvocationLease).toHaveBeenLastCalledWith(
      sandboxRef.name, expect.any(String), undefined, 'uid-1',
    );
    expect(touch).toHaveBeenCalledOnce();
  });

  it('does not write or terminate a same-name replacement Sandbox', async () => {
    const sandboxRef = ref('as-background-recreated');
    const child = fakeChild();
    const protectedUntil = '2099-07-20T00:10:00.000Z';
    const setActiveInvocationLease = vi.fn(async (
      _name: string, _key: string, until?: string,
    ) => {
      if (until === protectedUntil) throw new Error('Sandbox 已同名重建');
      return 'uid-old';
    });
    const setBackgroundShellProtection = vi.fn(async () => {
      throw new Error('Sandbox 已同名重建');
    });
    const terminateBackgroundTasks = vi.fn(async () => undefined);
    const touch = vi.fn(async () => undefined);
    const sandboxManager = {
      ref: () => sandboxRef,
      ensureRunning: vi.fn(async () => sandboxRef),
      setActiveInvocationLease,
      setBackgroundShellProtection,
      getSandboxUid: vi.fn(async () => 'uid-new'),
      touch,
    } as unknown as SandboxManager;
    const executor = new AcsExecutor(
      baseConfig(), { spawn: vi.fn(() => child) } as unknown as Kubectl,
      sandboxManager, noopLogger, undefined,
      { persistentRunner: false, terminateBackgroundTasks },
    );

    const resultPromise = executor.execute({
      toolName: 'Shell', input: { command: 'sleep 60', mode: 'background' },
      context: { invocationId: 'inv-background-recreated', workspace: {
        id: sandboxRef.workspaceId, sessionId: sandboxRef.sessionId,
        sandboxScopeId: sandboxRef.sandboxScopeId,
      } },
    });
    await vi.waitFor(() => expect(setActiveInvocationLease).toHaveBeenCalledOnce());
    finishBackground(child, 'shell-bg-recreated', protectedUntil);

    await expect(resultPromise).rejects.toThrow(/原 Sandbox 已消失/u);
    expect(terminateBackgroundTasks).not.toHaveBeenCalled();
    expect(setActiveInvocationLease).toHaveBeenCalledTimes(2);
    expect(touch).not.toHaveBeenCalled();
    expect(executor.backgroundRecoveryCount()).toBe(0);
  });

  it('terminates when protection CAS returns after its exact deadline expired', async () => {
    vi.useFakeTimers();
    try {
      const nowMs = Date.parse('2026-08-30T00:00:00.000Z');
      vi.setSystemTime(nowMs);
      const sandboxRef = ref('as-background-expired-during-cas');
      const child = fakeChild();
      const protectedUntil = new Date(nowMs + 10_000).toISOString();
      const setActiveInvocationLease = vi.fn(async () => 'uid-old');
      const setBackgroundShellProtection = vi.fn(async () => {
        vi.setSystemTime(nowMs + 10_000);
        return 'uid-old';
      });
      const terminateBackgroundTasks = vi.fn(async () => undefined);
      const sandboxManager = {
        ref: () => sandboxRef,
        ensureRunning: vi.fn(async () => sandboxRef),
        setActiveInvocationLease,
        setBackgroundShellProtection,
        getSandboxUid: vi.fn(async () => 'uid-old'),
        touch: vi.fn(async () => undefined),
      } as unknown as SandboxManager;
      const executor = new AcsExecutor(
        baseConfig(), { spawn: vi.fn(() => child) } as unknown as Kubectl,
        sandboxManager, noopLogger, undefined,
        { persistentRunner: false, terminateBackgroundTasks },
      );

      const resultPromise = executor.execute({
        toolName: 'Shell', input: { command: 'sleep 60', mode: 'background' },
        context: { invocationId: 'inv-expired-during-cas', workspace: {
          id: sandboxRef.workspaceId, sessionId: sandboxRef.sessionId,
          sandboxScopeId: sandboxRef.sandboxScopeId,
        } },
      });
      const resultAssertion = expect(resultPromise).rejects.toThrow(
        /expired before persistence confirmation/u,
      );
      await vi.advanceTimersByTimeAsync(0);
      finishBackground(child, 'shell-bg-expired-during-cas', protectedUntil);
      await vi.advanceTimersByTimeAsync(0);

      await resultAssertion;
      expect(setBackgroundShellProtection).toHaveBeenCalledWith(
        sandboxRef.name, protectedUntil, 'uid-old', undefined, expect.any(String),
      );
      expect(terminateBackgroundTasks).toHaveBeenCalledWith(
        sandboxRef, ['shell-bg-expired-during-cas'],
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['protection', 'termination'] as const)(
    'keeps renewing beyond two minutes until %s provides a safety proof',
    async (proof) => {
      vi.useFakeTimers();
      try {
        const sandboxRef = ref(`as-background-recovery-${proof}`);
        const child = fakeChild();
        const protectedUntil = '2099-07-20T00:10:00.000Z';
        let proofReady = false;
        let shortLeaseWriteCount = 0;
        const setActiveInvocationLease = vi.fn(async (_name: string, _key: string, until?: string) => {
          if (until === protectedUntil) throw new Error('long lease CAS exhausted');
          if (until) {
            shortLeaseWriteCount += 1;
            if (proof === 'termination' && shortLeaseWriteCount === 2) {
              throw new Error('monitor renewal CAS exhausted');
            }
          }
          return 'uid-1';
        });
        const setBackgroundShellProtection = vi.fn(async () => {
          if (proof !== 'protection' || !proofReady) throw new Error('protection CAS exhausted');
        });
        const terminateBackgroundTasks = vi.fn(async () => {
          if (proof !== 'termination' || !proofReady) throw new Error('kill runner unavailable');
        });
        const sandboxManager = {
          ref: () => sandboxRef,
          ensureRunning: vi.fn(async () => sandboxRef),
          setActiveInvocationLease,
          setBackgroundShellProtection,
          getSandboxUid: vi.fn(async () => 'uid-1'),
          touch: vi.fn(async () => undefined),
        } as unknown as SandboxManager;
        const warn = vi.fn();
        const executor = new AcsExecutor(
          baseConfig(), { spawn: vi.fn(() => child) } as unknown as Kubectl,
          sandboxManager, { ...noopLogger, warn }, undefined,
          { persistentRunner: false, terminateBackgroundTasks, backgroundRecoveryRetryMs: 30_000 },
        );

        const resultPromise = executor.execute({
          toolName: 'Shell', input: { command: 'sleep 60', mode: 'background' },
          context: { invocationId: `inv-recovery-${proof}`, workspace: {
            id: sandboxRef.workspaceId, sessionId: sandboxRef.sessionId,
            sandboxScopeId: sandboxRef.sandboxScopeId,
          } },
        });
        const resultAssertion = expect(resultPromise).rejects.toThrow(/保留现有 invocation lease/u);
        await vi.advanceTimersByTimeAsync(0);
        const leaseKey = (setActiveInvocationLease.mock.calls as unknown[][])[0]![1] as string;
        child.stdout.end(`${JSON.stringify({
          kind: 'final', response: { status: 'success', content: '{}', metadata: { backgroundShell: {
            taskId: `shell-recovery-${proof}`, status: 'running', protectedUntil,
            activeTaskIds: [`shell-recovery-${proof}`],
          } } },
        })}\n`);
        child.emit('close', 0, null);
        await vi.advanceTimersByTimeAsync(0);
        await resultAssertion;
        expect(executor.backgroundRecoveryCount()).toBe(1);

        await vi.advanceTimersByTimeAsync(121_000);
        const leaseCalls = setActiveInvocationLease.mock.calls as unknown[][];
        expect(leaseCalls.some((call) => call[1] === leaseKey
          && typeof call[2] === 'string' && call[2] !== protectedUntil)).toBe(true);
        expect(leaseCalls.some((call) => call[2] === undefined)).toBe(false);
        if (proof === 'termination') {
          expect(warn).toHaveBeenCalledWith(expect.stringContaining('background_shell_recovery_lease_renew_failed'));
          expect(warn).toHaveBeenCalledWith(expect.stringContaining('monitor renewal CAS exhausted'));
        }

        proofReady = true;
        await vi.advanceTimersByTimeAsync(30_000);
        expect(setActiveInvocationLease).toHaveBeenLastCalledWith(
          sandboxRef.name, leaseKey, undefined, 'uid-1',
        );
        if (proof === 'protection') {
          expect(setBackgroundShellProtection).toHaveBeenLastCalledWith(
            sandboxRef.name, protectedUntil, 'uid-1', undefined, leaseKey,
          );
        } else {
          expect(terminateBackgroundTasks).toHaveBeenLastCalledWith(
            sandboxRef, [`shell-recovery-${proof}`],
          );
        }
        expect(executor.backgroundRecoveryCount()).toBe(0);
        const completedCallCount = setActiveInvocationLease.mock.calls.length;
        await vi.advanceTimersByTimeAsync(121_000);
        expect(setActiveInvocationLease).toHaveBeenCalledTimes(completedCallCount);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('keeps the short lease as the last fence when protection writes and task termination all fail', async () => {
    const sandboxRef = ref('as-background-fail-closed');
    const child = fakeChild();
    const protectedUntil = '2099-07-20T00:10:00.000Z';
    const setActiveInvocationLease = vi.fn()
      .mockResolvedValueOnce('uid-1')
      .mockRejectedValueOnce(new Error('lease CAS exhausted'));
    const terminateBackgroundTasks = vi.fn(async () => { throw new Error('kill runner unavailable'); });
    const touch = vi.fn(async () => undefined);
    const sandboxManager = {
      ref: () => sandboxRef,
      ensureRunning: vi.fn(async () => sandboxRef),
      setActiveInvocationLease,
      setBackgroundShellProtection: vi.fn(async () => { throw new Error('protection CAS exhausted'); }),
      getSandboxUid: vi.fn(async () => 'uid-1'),
      touch,
    } as unknown as SandboxManager;
    const executor = new AcsExecutor(
      baseConfig(),
      { spawn: vi.fn(() => child) } as unknown as Kubectl,
      sandboxManager,
      noopLogger,
      undefined,
      { persistentRunner: false, terminateBackgroundTasks },
    );

    const resultPromise = executor.execute({
      toolName: 'Shell',
      input: { command: 'sleep 60', mode: 'background' },
      context: { invocationId: 'inv-background-fail-closed', workspace: {
        id: sandboxRef.workspaceId,
        sessionId: sandboxRef.sessionId,
        sandboxScopeId: sandboxRef.sandboxScopeId,
      } },
    });
    await vi.waitFor(() => expect(setActiveInvocationLease).toHaveBeenCalledOnce());
    child.stdout.end(`${JSON.stringify({
      kind: 'final',
      response: {
        status: 'success', content: '{}',
        metadata: { backgroundShell: {
          taskId: 'shell-bg-fail-closed', status: 'running', protectedUntil,
          activeTaskIds: ['shell-bg-fail-closed'],
        } },
      },
    })}\n`);
    child.emit('close', 0, null);

    await expect(resultPromise).rejects.toThrow(/终止任务失败，保留现有 invocation lease/u);
    expect(executor.backgroundRecoveryCount()).toBe(1);
    expect(terminateBackgroundTasks).toHaveBeenCalledWith(sandboxRef, ['shell-bg-fail-closed']);
    // Recovery's first round renews the original short lease without sleeping.
    expect(setActiveInvocationLease).toHaveBeenCalledTimes(3);
    expect(touch).not.toHaveBeenCalled();
  });
});
