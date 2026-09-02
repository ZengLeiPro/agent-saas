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

/** Completes a one-shot runner with request-owned background metadata. */
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
      metadata: { backgroundShell: { taskId, status, protectedUntil, requestOwned: true } },
    },
  })}\n`);
  child.emit('close', 0, null);
}

describe('AcsExecutor background shell protection handoff', () => {
  it('sweeps expired invocation-only residues without spawning or touching on repeated scans', async () => {
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

  it('enforces strict reconciliation when lifecycle protection is scanned', async () => {
    const sandboxRef = ref('as-protected-reconcile');
    const child = fakeChild();
    const setBackgroundShellProtection = vi.fn(async () => undefined);
    const sandboxManager = {
      listManagedSandboxes: vi.fn(async () => [{
        ...sandboxRef, uid: 'uid-1',
        activeInvocationLeases: [{
          annotationKey: 'agent-saas.kaiyan.net/active-invocation-restart', raw: '{}', invocationKey: 'inv-restart', until: '2000-01-01T00:00:00.000Z',
          state: 'executing', malformed: false,
        }],
      }]),
      clearExpiredInvocationLeases: vi.fn(async () => ({ active: false, removed: 0 })),
      ref: () => sandboxRef,
      ensureRunning: vi.fn(async () => sandboxRef),
      setActiveInvocationLease: vi.fn(async () => 'uid-1'),
      completeInvocation: vi.fn(async () => 'uid-1'),
      setBackgroundShellProtection,
      touch: vi.fn(async () => undefined),
    } as unknown as SandboxManager;
    const spawn = vi.fn(() => child);
    const executor = new AcsExecutor(
      baseConfig(), { spawn } as unknown as Kubectl, sandboxManager, noopLogger, undefined,
      { persistentRunner: false },
    );

    const resultPromise = executor.reconcileBackgroundShellProtections();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    const runnerInput = JSON.parse(String((spawn.mock.calls as unknown[][])[0]?.[1]
      && ((spawn.mock.calls as unknown[][])[0]?.[1] as { input?: unknown }).input));
    expect(runnerInput).toMatchObject({
      toolName: '__BackgroundShellReconcile',
      input: { fail_closed: true },
    });
    child.stdout.end(`${JSON.stringify({
      kind: 'final', response: {
        status: 'success', content: '{}', metadata: { backgroundShell: { activeTaskIds: [] } },
      },
    })}\n`);
    child.emit('close', 0, null);

    await expect(resultPromise).resolves.toEqual({ checked: 1, failed: 0 });
    expect(sandboxManager.clearExpiredInvocationLeases).not.toHaveBeenCalled();
  });

  it('persists background protection before returning and clearing the invocation lease', async () => {
    const sandboxRef = ref('as-background');
    const child = fakeChild();
    const setBackgroundShellProtection = vi.fn(async () => undefined);
    const sandboxManager = {
      ref: () => sandboxRef,
      setActiveInvocationLease: vi.fn(async () => 'uid-1'),
      completeInvocation: vi.fn(async () => 'uid-1'),
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
      completeInvocation: vi.fn(async () => 'uid-1'),
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
      completeInvocation: vi.fn(async () => 'uid-1'),
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
    expect((setActiveInvocationLease.mock.calls as unknown[][])[0]?.[5]).toBe('background_pending');

    await expect(resultPromise).resolves.toMatchObject({ status: 'success' });
    const leaseKey = (setActiveInvocationLease.mock.calls as unknown[][])[0]![1] as string;
    expect(setActiveInvocationLease).toHaveBeenCalledTimes(2);
    expect(setActiveInvocationLease).toHaveBeenNthCalledWith(
      2, sandboxRef.name, leaseKey, protectedUntil, 'uid-1', undefined, 'background_pending',
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
  ])('does not terminate unowned tasks for %s when both protection writes fail', async (_case, backgroundShell) => {
    const sandboxRef = ref(`as-background-${String(_case).replaceAll(' ', '-')}`);
    const child = fakeChild();
    const setActiveInvocationLease = vi.fn()
      .mockResolvedValueOnce('uid-1')
      .mockRejectedValueOnce(new Error('lease CAS exhausted'))
      .mockResolvedValue('uid-1');
    const setBackgroundShellProtection = vi.fn()
      .mockRejectedValueOnce(new Error('protection CAS exhausted'))
      .mockResolvedValue('uid-1');
    const terminateBackgroundTasks = vi.fn(async () => undefined);
    const sandboxManager = {
      ref: () => sandboxRef,
      ensureRunning: vi.fn(async () => sandboxRef),
      setActiveInvocationLease,
      completeInvocation: vi.fn(async () => 'uid-1'),
      setBackgroundShellProtection,
      getSandboxUid: vi.fn(async () => 'uid-1'),
    } as unknown as SandboxManager;
    const executor = new AcsExecutor(
      baseConfig(),
      { spawn: vi.fn(() => child) } as unknown as Kubectl,
      sandboxManager,
      noopLogger,
      undefined,
      { persistentRunner: false, terminateBackgroundTasks, backgroundRecoveryRetryMs: 1 },
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

    await expect(resultPromise).rejects.toThrow(/不终止无所有权任务/u);
    await vi.waitFor(() => expect(executor.backgroundRecoveryCount()).toBe(0));
    expect(terminateBackgroundTasks).not.toHaveBeenCalled();
    expect(setBackgroundShellProtection).toHaveBeenLastCalledWith(
      sandboxRef.name, '2099-07-20T00:10:00.000Z', 'uid-1', undefined, expect.any(String),
    );
  });

  it('terminates only request-owned task A when task B is already protected in the same workspace', async () => {
    const sandboxRef = ref('as-background-owned-only');
    const child = fakeChild();
    const setActiveInvocationLease = vi.fn()
      .mockResolvedValueOnce('uid-1')
      .mockRejectedValueOnce(new Error('fallback lease CAS exhausted'))
      .mockResolvedValue('uid-1');
    const terminateBackgroundTasks = vi.fn(async () => undefined);
    const sandboxManager = {
      ref: () => sandboxRef,
      ensureRunning: vi.fn(async () => sandboxRef),
      setActiveInvocationLease,
      completeInvocation: vi.fn(async () => 'uid-1'),
      setBackgroundShellProtection: vi.fn(async () => { throw new Error('protection CAS exhausted'); }),
      getSandboxUid: vi.fn(async () => 'uid-1'),
    } as unknown as SandboxManager;
    const executor = new AcsExecutor(
      baseConfig(), { spawn: vi.fn(() => child) } as unknown as Kubectl,
      sandboxManager, noopLogger, undefined,
      { persistentRunner: false, terminateBackgroundTasks },
    );

    const resultPromise = executor.execute({
      toolName: 'Shell', input: { command: 'sleep 60', mode: 'background', taskId: 'shell-bg-a' },
      context: { invocationId: 'inv-owned-a', workspace: {
        id: sandboxRef.workspaceId, sessionId: sandboxRef.sessionId,
        sandboxScopeId: sandboxRef.sandboxScopeId,
      } },
    });
    await vi.waitFor(() => expect(setActiveInvocationLease).toHaveBeenCalledOnce());
    child.stdout.end(`${JSON.stringify({
      kind: 'final',
      response: { status: 'success', content: '{}', metadata: { backgroundShell: {
        taskId: 'shell-bg-a', status: 'running', requestOwned: true,
        activeTaskIds: ['shell-bg-a', 'shell-bg-b'],
        protectedUntil: '2099-07-20T00:10:00.000Z',
      } } },
    })}\n`);
    child.emit('close', 0, null);

    await expect(resultPromise).rejects.toThrow(/已终止活跃任务/u);
    expect(terminateBackgroundTasks).toHaveBeenCalledOnce();
    expect(terminateBackgroundTasks).toHaveBeenCalledWith(sandboxRef, ['shell-bg-a']);
    expect(terminateBackgroundTasks).not.toHaveBeenCalledWith(sandboxRef, ['shell-bg-b']);
  });

  it('does not terminate a returned taskId that differs from the request-owned taskId', async () => {
    const sandboxRef = ref('as-background-task-mismatch'); const child = fakeChild();
    const protectedUntil = '2099-07-20T00:10:00.000Z';
    const setActiveInvocationLease = vi.fn(async (_name: string, _key: string, until?: string) => {
      if (until === protectedUntil) throw new Error('fallback lease CAS exhausted');
      return 'uid-1';
    });
    const terminateBackgroundTasks = vi.fn(async () => undefined);
    const sandboxManager = {
      ref: () => sandboxRef, ensureRunning: vi.fn(async () => sandboxRef), setActiveInvocationLease,
      completeInvocation: vi.fn(async () => 'uid-1'), getSandboxUid: vi.fn(async () => 'uid-1'),
      setBackgroundShellProtection: vi.fn(async () => { throw new Error('protection CAS exhausted'); }),
    } as unknown as SandboxManager;
    const executor = new AcsExecutor(baseConfig(), { spawn: vi.fn(() => child) } as unknown as Kubectl,
      sandboxManager, noopLogger, undefined, { persistentRunner: false, terminateBackgroundTasks,
        backgroundRecoveryRetryMs: 1, reconcileBackgroundTasks: async () => ({ activeTaskIds: [] }) });

    const resultPromise = executor.execute({
      toolName: 'Shell', input: { command: 'sleep 60', mode: 'background', taskId: 'shell-bg-a' },
      context: { invocationId: 'inv-task-mismatch', workspace: { id: sandboxRef.workspaceId,
        sessionId: sandboxRef.sessionId, sandboxScopeId: sandboxRef.sandboxScopeId } },
    });
    await vi.waitFor(() => expect(setActiveInvocationLease).toHaveBeenCalledOnce());
    finishBackground(child, 'shell-bg-b', protectedUntil);
    await expect(resultPromise).rejects.toThrow(/不终止无所有权任务/u);
    await vi.waitFor(() => expect(executor.backgroundRecoveryCount()).toBe(0));
    expect(terminateBackgroundTasks).not.toHaveBeenCalled();
  });

  it('does not mutate or terminate a same-name replacement Sandbox by UID', async () => {
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
      completeInvocation: vi.fn(async () => 'uid-1'),
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
      toolName: 'Shell', input: { command: 'sleep 60', mode: 'background', taskId: 'shell-bg-recreated' },
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

  it('stops recovery when the original Sandbox has entered deletion', async () => {
    const sandboxRef = ref('as-background-deleting'); const child = fakeChild();
    const protectedUntil = '2099-07-20T00:10:00.000Z';
    const setActiveInvocationLease = vi.fn(async (_name: string, _key: string, until?: string) => {
      if (until === protectedUntil) throw new Error('Sandbox 已进入删除流程');
      return 'uid-old';
    });
    const getMutableSandboxUid = vi.fn(async () => null);
    const terminateBackgroundTasks = vi.fn(async () => undefined);
    const sandboxManager = {
      ref: () => sandboxRef, ensureRunning: vi.fn(async () => sandboxRef), setActiveInvocationLease,
      completeInvocation: vi.fn(async () => 'uid-old'), getSandboxUid: vi.fn(async () => 'uid-old'),
      setBackgroundShellProtection: vi.fn(async () => { throw new Error('protection CAS exhausted'); }),
      getMutableSandboxUid,
    } as unknown as SandboxManager;
    const executor = new AcsExecutor(baseConfig(), { spawn: vi.fn(() => child) } as unknown as Kubectl,
      sandboxManager, noopLogger, undefined, { persistentRunner: false, terminateBackgroundTasks });

    const resultPromise = executor.execute({
      toolName: 'Shell', input: { command: 'sleep 60', mode: 'background', taskId: 'shell-bg-deleting' },
      context: { invocationId: 'inv-background-deleting', workspace: { id: sandboxRef.workspaceId,
        sessionId: sandboxRef.sessionId, sandboxScopeId: sandboxRef.sandboxScopeId } },
    });
    await vi.waitFor(() => expect(setActiveInvocationLease).toHaveBeenCalledOnce());
    finishBackground(child, 'shell-bg-deleting', protectedUntil);
    await expect(resultPromise).rejects.toThrow(/原 Sandbox 已消失/u);
    expect(getMutableSandboxUid).toHaveBeenCalledWith(sandboxRef.name);
    expect(terminateBackgroundTasks).not.toHaveBeenCalled();
    expect(executor.backgroundRecoveryCount()).toBe(0);
  });

  it('terminates the owned task when protection CAS returns after its exact deadline expired', async () => {
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
        completeInvocation: vi.fn(async () => 'uid-1'),
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
        toolName: 'Shell', input: {
          command: 'sleep 60', mode: 'background', taskId: 'shell-bg-expired-during-cas',
        },
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
            if (proof === 'termination' && shortLeaseWriteCount === 3) {
              throw new Error('recovery renewal CAS exhausted');
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
          toolName: 'Shell', input: {
            command: 'sleep 60', mode: 'background', taskId: `shell-recovery-${proof}`,
          },
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
            taskId: `shell-recovery-${proof}`, status: 'running', protectedUntil, requestOwned: true,
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
          expect(warn).toHaveBeenCalledWith(expect.stringContaining('recovery renewal CAS exhausted'));
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

  it('does not trust an empty early inventory and recovers with conservative protection after final loss', async () => {
    const sandboxRef = ref('as-background-final-lost');
    const child = fakeChild();
    let protectionAvailable = false;
    const setActiveInvocationLease = vi.fn(async () => 'uid-1');
    const setBackgroundShellProtection = vi.fn(async () => {
      if (!protectionAvailable) throw new Error('aggregate protection unavailable');
    });
    const terminateBackgroundTasks = vi.fn(async () => { throw new Error('KillBash unavailable'); });
    const sandboxManager = {
      ref: () => sandboxRef,
      ensureRunning: vi.fn(async () => sandboxRef),
      setActiveInvocationLease,
      completeInvocation: vi.fn(async () => 'uid-1'),
      setBackgroundShellProtection,
      getSandboxUid: vi.fn(async () => 'uid-1'),
    } as unknown as SandboxManager;
    const executor = new AcsExecutor(
      baseConfig(), { spawn: vi.fn(() => child) } as unknown as Kubectl,
      sandboxManager, noopLogger, undefined,
      {
        persistentRunner: false,
        terminateBackgroundTasks,
        backgroundRecoveryRetryMs: 1,
        reconcileBackgroundTasks: async () => ({ activeTaskIds: [] }),
      },
    );

    const resultPromise = executor.execute({
      toolName: 'Shell',
      input: { command: 'sleep 60', mode: 'background', taskId: 'shell-bg-final-lost' },
      context: { invocationId: 'inv-background-final-lost', workspace: {
        id: sandboxRef.workspaceId,
        sessionId: sandboxRef.sessionId,
        sandboxScopeId: sandboxRef.sandboxScopeId,
      } },
    });
    await vi.waitFor(() => expect(setActiveInvocationLease).toHaveBeenCalledOnce());
    child.stdout.end();
    child.emit('close', 1, null);

    await expect(resultPromise).resolves.toMatchObject({
      status: 'error', error: expect.stringContaining('启动结果不确定'),
    });
    expect(executor.backgroundRecoveryCount()).toBe(1);
    expect((setActiveInvocationLease.mock.calls as unknown[][])
      .some((call) => call[2] === undefined)).toBe(false);
    expect(terminateBackgroundTasks).not.toHaveBeenCalled();

    protectionAvailable = true;
    await vi.waitFor(() => expect((setActiveInvocationLease.mock.calls as unknown[][]).some((call) => (
      call[0] === sandboxRef.name && call[2] === undefined && call[3] === 'uid-1'
    ))).toBe(true));
    const aggregateDeadline = (setBackgroundShellProtection.mock.calls as unknown[][]).at(-1)?.[1];
    expect(Date.parse(aggregateDeadline as string) - Date.now()).toBeGreaterThan(24 * 60 * 60_000);
    expect(setBackgroundShellProtection).toHaveBeenLastCalledWith(
      sandboxRef.name, aggregateDeadline, 'uid-1', undefined, expect.any(String),
    );
    expect(executor.backgroundRecoveryCount()).toBe(0);
  });

  it('reconciles without wildcard termination after an ownerless synthetic deadline expires', async () => {
    vi.useFakeTimers();
    try {
      const sandboxRef = ref('as-background-final-lost-expired');
      const child = fakeChild();
      const setActiveInvocationLease = vi.fn(async () => 'uid-1');
      const setBackgroundShellProtection = vi.fn(async () => {
        throw new Error('aggregate protection unavailable');
      });
      const terminateBackgroundTasks = vi.fn(async () => undefined);
      const reconcileBackgroundTasks = vi.fn(async () => ({ activeTaskIds: ['shell-bg-unowned'] }));
      let originalGone = false;
      const sandboxManager = {
        ref: () => sandboxRef,
        ensureRunning: vi.fn(async () => sandboxRef),
        setActiveInvocationLease,
        completeInvocation: vi.fn(async () => 'uid-1'),
        setBackgroundShellProtection,
        getSandboxUid: vi.fn(async () => originalGone ? null : 'uid-1'),
      } as unknown as SandboxManager;
      const executor = new AcsExecutor(
        baseConfig(), { spawn: vi.fn(() => child) } as unknown as Kubectl,
        sandboxManager, noopLogger, undefined,
        {
          persistentRunner: false, terminateBackgroundTasks, reconcileBackgroundTasks,
          backgroundRecoveryRetryMs: 30_000,
        },
      );

      const resultPromise = executor.execute({
        toolName: 'Shell', input: { command: 'sleep 60', mode: 'background' },
        context: { invocationId: 'inv-final-lost-expired', workspace: {
          id: sandboxRef.workspaceId, sessionId: sandboxRef.sessionId,
          sandboxScopeId: sandboxRef.sandboxScopeId,
        } },
      });
      await vi.advanceTimersByTimeAsync(0);
      child.stdout.end();
      child.emit('close', 1, null);
      await vi.advanceTimersByTimeAsync(0);
      await expect(resultPromise).resolves.toMatchObject({ status: 'error' });
      expect(executor.backgroundRecoveryCount()).toBe(1);

      vi.setSystemTime(new Date(Date.now() + 49 * 60 * 60_000));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(reconcileBackgroundTasks).toHaveBeenCalledWith(sandboxRef);
      expect(terminateBackgroundTasks).not.toHaveBeenCalled();
      expect((setActiveInvocationLease.mock.calls as unknown[][])
        .some((call) => call[2] === undefined)).toBe(false);

      originalGone = true;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(executor.backgroundRecoveryCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the short lease as the last fence when owned-task protection and fenced termination fail', async () => {
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
      completeInvocation: vi.fn(async () => 'uid-1'),
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
      input: { command: 'sleep 60', mode: 'background', taskId: 'shell-bg-fail-closed' },
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
          taskId: 'shell-bg-fail-closed', status: 'running', protectedUntil, requestOwned: true,
          activeTaskIds: ['shell-bg-fail-closed'],
        } },
      },
    })}\n`);
    child.emit('close', 0, null);

    await expect(resultPromise).rejects.toThrow(/终止任务失败，保留现有 invocation lease/u);
    expect(executor.backgroundRecoveryCount()).toBe(1);
    expect(terminateBackgroundTasks).toHaveBeenCalledWith(sandboxRef, ['shell-bg-fail-closed']);
    // Recovery keeps the short lease alive, then renews a fresh fence before each termination attempt.
    expect(setActiveInvocationLease).toHaveBeenCalledTimes(5);
    expect(touch).not.toHaveBeenCalled();
  });
});
