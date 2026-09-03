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

function finishBackground(
  child: ReturnType<typeof fakeChild>,
  taskId: string,
  protectedUntil: string,
  requestOwned = true,
): void {
  child.stdout.end(`${JSON.stringify({
    kind: 'final',
    response: {
      status: 'success', content: '{}',
      metadata: { backgroundShell: {
        taskId, status: 'running', protectedUntil, requestOwned,
      } },
    },
  })}\n`);
  child.emit('close', 0, null);
}

describe('AcsExecutor request ownership and termination fence', () => {
  it('keeps recovery without name-based termination when the termination fence cannot renew', async () => {
    vi.useFakeTimers();
    try {
      const sandboxRef = ref('as-background-fence-renew-failed');
      const child = fakeChild();
      const protectedUntil = '2099-07-20T00:10:00.000Z';
      let originalGone = false;
      let leaseWriteCount = 0;
      const setActiveInvocationLease = vi.fn(async (
        _name: string, _key: string, until?: string,
      ) => {
        leaseWriteCount += 1;
        if (leaseWriteCount === 1 && until) return 'uid-old';
        if (!until) return 'uid-old';
        throw new Error('termination fence CAS exhausted');
      });
      const getSandboxUid = vi.fn(async () => originalGone ? 'uid-new' : 'uid-old');
      const terminateBackgroundTasks = vi.fn(async () => undefined);
      const sandboxManager = {
        ref: () => sandboxRef,
        ensureRunning: vi.fn(async () => sandboxRef),
        setActiveInvocationLease,
        completeInvocation: vi.fn(async () => 'uid-old'),
        setBackgroundShellProtection: vi.fn(async () => { throw new Error('protection CAS exhausted'); }),
        getSandboxUid,
        touch: vi.fn(async () => undefined),
      } as unknown as SandboxManager;
      const executor = new AcsExecutor(
        baseConfig(), { spawn: vi.fn(() => child) } as unknown as Kubectl,
        sandboxManager, noopLogger, undefined,
        { persistentRunner: false, terminateBackgroundTasks, backgroundRecoveryRetryMs: 100 },
      );

      const resultPromise = executor.execute({
        toolName: 'Shell', input: {
          command: 'sleep 60', mode: 'background', taskId: 'shell-bg-fence-renew-failed',
        },
        context: { invocationId: 'inv-fence-renew-failed', workspace: {
          id: sandboxRef.workspaceId, sessionId: sandboxRef.sessionId,
          sandboxScopeId: sandboxRef.sandboxScopeId,
        } },
      });
      const resultAssertion = expect(resultPromise).rejects.toThrow(/保留现有 invocation lease/u);
      await vi.advanceTimersByTimeAsync(0);
      finishBackground(child, 'shell-bg-fence-renew-failed', protectedUntil);
      await vi.advanceTimersByTimeAsync(0);
      await resultAssertion;

      expect(getSandboxUid).toHaveBeenCalled();
      expect(terminateBackgroundTasks).not.toHaveBeenCalled();
      expect(executor.backgroundRecoveryCount()).toBe(1);

      originalGone = true;
      await vi.advanceTimersByTimeAsync(100);
      await vi.waitFor(() => expect(executor.backgroundRecoveryCount()).toBe(0));
      expect(terminateBackgroundTasks).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not claim or terminate an idempotently returned task owned by another invocation', async () => {
    const sandboxRef = ref('as-background-idempotent-existing');
    const child = fakeChild();
    const protectedUntil = '2099-07-20T00:10:00.000Z';
    const setActiveInvocationLease = vi.fn()
      .mockResolvedValueOnce('uid-1')
      .mockRejectedValueOnce(new Error('lease CAS exhausted'))
      .mockResolvedValue('uid-1');
    const terminateBackgroundTasks = vi.fn(async () => undefined);
    const sandboxManager = {
      ref: () => sandboxRef,
      ensureRunning: vi.fn(async () => sandboxRef),
      setActiveInvocationLease,
      completeInvocation: vi.fn(async () => 'uid-1'),
      setBackgroundShellProtection: vi.fn(async () => { throw new Error('protection CAS exhausted'); }),
      getSandboxUid: vi.fn(async () => 'uid-1'),
      touch: vi.fn(async () => undefined),
    } as unknown as SandboxManager;
    const executor = new AcsExecutor(
      baseConfig(), { spawn: vi.fn(() => child) } as unknown as Kubectl,
      sandboxManager, noopLogger, undefined,
      { persistentRunner: false, terminateBackgroundTasks, backgroundRecoveryRetryMs: 1,
        reconcileBackgroundTasks: async () => ({ activeTaskIds: [] }) },
    );

    const resultPromise = executor.execute({
      toolName: 'Shell', input: {
        command: 'sleep 60', mode: 'background', taskId: 'shell-bg-existing',
      },
      context: { invocationId: 'inv-idempotent-existing', workspace: {
        id: sandboxRef.workspaceId, sessionId: sandboxRef.sessionId,
        sandboxScopeId: sandboxRef.sandboxScopeId,
      } },
    });
    await vi.waitFor(() => expect(setActiveInvocationLease).toHaveBeenCalledOnce());
    finishBackground(child, 'shell-bg-existing', protectedUntil, false);

    await expect(resultPromise).rejects.toThrow(/不终止无所有权任务/u);
    await vi.waitFor(() => expect(executor.backgroundRecoveryCount()).toBe(0));
    expect(terminateBackgroundTasks).not.toHaveBeenCalled();
  });

  it('does not terminate when a UID-bound fence returns after its usable window elapsed', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.parse('2026-08-30T00:00:00.000Z'));
      const sandboxRef = ref('as-background-fence-returned-late');
      const child = fakeChild();
      const protectedUntil = '2099-07-20T00:10:00.000Z';
      const config = baseConfig();
      config.sandboxWaitTimeoutMs = 1_000;
      config.execTimeoutMs = 1_000;
      let originalGone = false;
      let leaseWriteCount = 0;
      const setActiveInvocationLease = vi.fn(async (
        _name: string, _key: string, until?: string,
      ) => {
        leaseWriteCount += 1;
        if (leaseWriteCount === 1 && until) return 'uid-old';
        if (until === protectedUntil) throw new Error('long lease CAS exhausted');
        if (leaseWriteCount === 3 && until) {
          vi.setSystemTime(Date.now() + config.sandboxWaitTimeoutMs + 1);
          return 'uid-old';
        }
        if (!until) return 'uid-old';
        throw new Error('termination fence unavailable');
      });
      const terminateBackgroundTasks = vi.fn(async () => undefined);
      const sandboxManager = {
        ref: () => sandboxRef,
        ensureRunning: vi.fn(async () => sandboxRef),
        setActiveInvocationLease,
        completeInvocation: vi.fn(async () => 'uid-old'),
        setBackgroundShellProtection: vi.fn(async () => { throw new Error('protection CAS exhausted'); }),
        getSandboxUid: vi.fn(async () => originalGone ? 'uid-new' : 'uid-old'),
        touch: vi.fn(async () => undefined),
      } as unknown as SandboxManager;
      const executor = new AcsExecutor(
        config, { spawn: vi.fn(() => child) } as unknown as Kubectl,
        sandboxManager, noopLogger, undefined,
        { persistentRunner: false, terminateBackgroundTasks, backgroundRecoveryRetryMs: 100 },
      );

      const resultPromise = executor.execute({
        toolName: 'Shell', input: {
          command: 'sleep 60', mode: 'background', taskId: 'shell-bg-fence-returned-late',
        },
        context: { invocationId: 'inv-fence-returned-late', workspace: {
          id: sandboxRef.workspaceId, sessionId: sandboxRef.sessionId,
          sandboxScopeId: sandboxRef.sandboxScopeId,
        } },
      });
      const resultAssertion = expect(resultPromise).rejects.toThrow(/保留现有 invocation lease/u);
      await vi.advanceTimersByTimeAsync(0);
      finishBackground(child, 'shell-bg-fence-returned-late', protectedUntil);
      await vi.advanceTimersByTimeAsync(0);
      await resultAssertion;

      expect(terminateBackgroundTasks).not.toHaveBeenCalled();
      expect(executor.backgroundRecoveryCount()).toBe(1);
      originalGone = true;
      await vi.advanceTimersByTimeAsync(100);
      await vi.waitFor(() => expect(executor.backgroundRecoveryCount()).toBe(0));
      expect(terminateBackgroundTasks).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not terminate when a same-name replacement appears after the UID check', async () => {
    const sandboxRef = ref('as-background-recreated-after-check');
    const child = fakeChild();
    const protectedUntil = '2099-07-20T00:10:00.000Z';
    let currentUid = 'uid-old';
    let leaseWriteCount = 0;
    const setActiveInvocationLease = vi.fn(async (
      _name: string, _key: string, until?: string,
    ) => {
      leaseWriteCount += 1;
      if (leaseWriteCount === 1 && until) return 'uid-old';
      if (until === protectedUntil) throw new Error('long lease CAS exhausted');
      if (until) {
        currentUid = 'uid-new';
        throw new Error('termination fence UID mismatch');
      }
      return 'uid-old';
    });
    const getSandboxUid = vi.fn(async () => currentUid);
    const terminateBackgroundTasks = vi.fn(async () => undefined);
    const sandboxManager = {
      ref: () => sandboxRef,
      ensureRunning: vi.fn(async () => sandboxRef),
      setActiveInvocationLease,
      completeInvocation: vi.fn(async () => 'uid-old'),
      setBackgroundShellProtection: vi.fn(async () => { throw new Error('protection CAS exhausted'); }),
      getSandboxUid,
      touch: vi.fn(async () => undefined),
    } as unknown as SandboxManager;
    const executor = new AcsExecutor(
      baseConfig(), { spawn: vi.fn(() => child) } as unknown as Kubectl,
      sandboxManager, noopLogger, undefined,
      { persistentRunner: false, terminateBackgroundTasks, backgroundRecoveryRetryMs: 1 },
    );

    const resultPromise = executor.execute({
      toolName: 'Shell', input: {
        command: 'sleep 60', mode: 'background', taskId: 'shell-bg-recreated-after-check',
      },
      context: { invocationId: 'inv-recreated-after-check', workspace: {
        id: sandboxRef.workspaceId, sessionId: sandboxRef.sessionId,
        sandboxScopeId: sandboxRef.sandboxScopeId,
      } },
    });
    await vi.waitFor(() => expect(setActiveInvocationLease).toHaveBeenCalledOnce());
    finishBackground(child, 'shell-bg-recreated-after-check', protectedUntil);

    await expect(resultPromise).rejects.toThrow(/保留现有 invocation lease/u);
    await vi.waitFor(() => expect(executor.backgroundRecoveryCount()).toBe(0));
    await expect(getSandboxUid.mock.results[0]?.value).resolves.toBe('uid-old');
    expect(terminateBackgroundTasks).not.toHaveBeenCalled();
  });
});
