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

function finishBackground(child: ReturnType<typeof fakeChild>, taskId: string, protectedUntil: string): void {
  child.stdout.end(`${JSON.stringify({
    kind: 'final',
    response: {
      status: 'success', content: '{}',
      metadata: { backgroundShell: { taskId, status: 'running', protectedUntil } },
    },
  })}\n`);
  child.emit('close', 0, null);
}

describe('AcsExecutor background shell protection handoff', () => {
  it('persists background protection before returning and clearing the invocation lease', async () => {
    const sandboxRef = ref('as-background');
    const child = fakeChild();
    const setBackgroundShellProtection = vi.fn(async () => undefined);
    const sandboxManager = {
      ref: () => sandboxRef,
      setActiveInvocationLease: vi.fn(async () => undefined),
      touch: vi.fn(async () => undefined),
      ensureRunning: vi.fn(async () => sandboxRef),
      setBackgroundShellProtection,
    } as unknown as SandboxManager;
    const kubectl = { spawn: vi.fn(() => child) } as unknown as Kubectl;
    const executor = new AcsExecutor(
      baseConfig(), kubectl, sandboxManager, noopLogger, undefined, { persistentRunner: false },
    );
    const protectedUntil = '2026-07-20T00:00:00.000Z';

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
    expect(setBackgroundShellProtection).toHaveBeenCalledWith(sandboxRef.name, protectedUntil);
  });

  it('falls back to the invocation lease and does not clear it when background protection fails', async () => {
    const sandboxRef = ref('as-background-fallback');
    const child = fakeChild();
    const protectedUntil = '2026-07-20T00:10:00.000Z';
    const setActiveInvocationLease = vi.fn(async () => undefined);
    const touch = vi.fn(async () => undefined);
    const warn = vi.fn();
    const sandboxManager = {
      ref: () => sandboxRef,
      ensureRunning: vi.fn(async () => sandboxRef),
      setActiveInvocationLease,
      setBackgroundShellProtection: vi.fn(async () => { throw new Error('protection CAS exhausted'); }),
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
    expect(setActiveInvocationLease).toHaveBeenNthCalledWith(2, sandboxRef.name, leaseKey, protectedUntil);
    expect(touch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('background_shell_protection_fallback'));
  });

  it('preserves the existing invocation lease when both background protection writes fail', async () => {
    const sandboxRef = ref('as-background-fail-closed');
    const child = fakeChild();
    const protectedUntil = '2026-07-20T00:10:00.000Z';
    const setActiveInvocationLease = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('lease CAS exhausted'));
    const touch = vi.fn(async () => undefined);
    const sandboxManager = {
      ref: () => sandboxRef,
      ensureRunning: vi.fn(async () => sandboxRef),
      setActiveInvocationLease,
      setBackgroundShellProtection: vi.fn(async () => { throw new Error('protection CAS exhausted'); }),
      touch,
    } as unknown as SandboxManager;
    const executor = new AcsExecutor(
      baseConfig(),
      { spawn: vi.fn(() => child) } as unknown as Kubectl,
      sandboxManager,
      noopLogger,
      undefined,
      { persistentRunner: false },
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
    finishBackground(child, 'shell-bg-fail-closed', protectedUntil);

    await expect(resultPromise).rejects.toThrow(/保留现有 invocation lease/u);
    expect(setActiveInvocationLease).toHaveBeenCalledTimes(2);
    expect(touch).not.toHaveBeenCalled();
  });
});
