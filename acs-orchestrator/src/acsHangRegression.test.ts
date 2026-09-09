import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import { Kubectl } from './kubectl.js';
import { PersistentSandboxRunner } from './persistentRunner.js';
import type { AcsOrchestratorConfig } from './config.js';
import type { SandboxRef } from './sandboxManager.js';
import type { SandboxRunnerInput } from './protocol.js';

const config = {
  namespace: 'test-only', kubectlPath: 'test-kubectl', execTimeoutMs: 10,
  sandboxContainerName: 'sandbox',
} as AcsOrchestratorConfig;
const ref: SandboxRef = {
  name: 'as-test', workspaceId: 'ws-test', sessionId: 'session-test',
  sandboxScopeId: 'scope-test', mountSubPath: 'workspaces/test',
};
const input = {
  toolName: 'Shell', input: { command: 'fixture-only', timeoutMs: 30 * 60_000 },
  workspace: { id: 'ws-test', root: '/workspace' },
} as SandboxRunnerInput;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function childFixture() {
  const child = Object.assign(new EventEmitter(), {
    pid: 12345, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    killed: false, exitCode: null, signalCode: null,
    kill: vi.fn((_signal: string) => { child.killed = true; return true; }),
  });
  return child;
}

async function readyRunner() {
  const child = childFixture();
  const runner = new PersistentSandboxRunner(config, {
    spawn: () => child as unknown as ChildProcessWithoutNullStreams,
  } as unknown as Kubectl, ref, logger);
  const started = runner.start();
  child.stdout.write(`${JSON.stringify({ kind: 'daemon_ready', protocolVersion: 1, runnerId: 'runner-test' })}\n`);
  await started;
  return { child, runner };
}

function output(child: ReturnType<typeof childFixture>, key: string, status = 'success') {
  child.stdout.write(`${JSON.stringify({
    kind: 'invocation_output', invocationKey: key,
    output: { kind: 'final', response: { status, content: 'done' } },
  })}\n`);
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('ACS actual-module bounded waiting regressions', () => {
  it('R03 escalates an ignored TERM without treating child.killed as death', async () => {
    vi.useFakeTimers();
    const child = childFixture();
    spawnMock.mockReturnValue(child);
    const task = new Kubectl(config).run(['exec', 'as-test', '--', 'fixture'], { timeoutMs: 10 });
    let settled = false;
    void task.then(() => { settled = true; });
    try {
      await vi.advanceTimersByTimeAsync(5_010);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      expect(settled).toBe(true);
      expect(await task).toMatchObject({ exitCode: -1, remoteState: 'unknown' });
    } finally {
      child.emit('close', null, 'SIGKILL');
      await task;
    }
  });

  it('R04 bounds stdio wait after parent exit without claiming remote termination', async () => {
    vi.useFakeTimers();
    const child = childFixture();
    spawnMock.mockReturnValue(child);
    const task = new Kubectl(config).run(['exec', 'as-test', '--', 'fixture'], { timeoutMs: 60_000 });
    let settled = false;
    void task.then(() => { settled = true; });
    try {
      child.emit('exit', 0, null); // A grandchild deliberately retains the pipes.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(settled).toBe(true);
      expect(await task).toMatchObject({ exitCode: -1, remoteState: 'unknown' });
    } finally {
      child.emit('close', 0, null);
      await task;
    }
  });

  it('R05 pre-aborted kubectl run never spawns', async () => {
    vi.useFakeTimers();
    const child = childFixture();
    spawnMock.mockReturnValue(child);
    const controller = new AbortController();
    controller.abort();
    const options = { signal: controller.signal, timeoutMs: 10 };
    const task = new Kubectl(config).run(['get', 'pods'], options);
    try {
      await Promise.resolve();
      expect(spawnMock).not.toHaveBeenCalled();
      expect(await task).toMatchObject({ exitCode: -1, remoteState: 'not_started' });
    } finally {
      child.emit('close', 0, null);
      await task;
    }
  });

  it('R01 R02 cancelled silent iterator settles locally with remote unknown', async () => {
    vi.useFakeTimers();
    const { child, runner } = await readyRunner();
    const controller = new AbortController();
    const iterator = runner.invoke('attempt-1', input, controller.signal)[Symbol.asyncIterator]();
    const next = iterator.next();
    let settled = false;
    void next.then(() => { settled = true; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(settled).toBe(true);
      expect((await next).value).toMatchObject({
        kind: 'final', response: { status: 'error', metadata: { remoteExecution: { state: 'unknown' } } },
      });
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      runner.close('test teardown');
      await next;
      await iterator.return?.();
    }
  });

  it('R05 pre-aborted persistent invocation never opens a daemon', async () => {
    vi.useFakeTimers();
    const child = childFixture();
    const spawn = vi.fn(() => child);
    const runner = new PersistentSandboxRunner(config, { spawn } as unknown as Kubectl, ref, logger);
    const controller = new AbortController();
    controller.abort();
    const iterator = runner.invoke('attempt-pre-aborted', input, controller.signal)[Symbol.asyncIterator]();
    const next = iterator.next().catch(() => undefined);
    try {
      await Promise.resolve();
      expect(spawn).not.toHaveBeenCalled();
      expect(await next).toMatchObject({ done: true });
    } finally {
      runner.close('test teardown');
      await next;
    }
  });

  it('R06 terminal already observed wins over a late cancel', async () => {
    vi.useFakeTimers();
    const { child, runner } = await readyRunner();
    const controller = new AbortController();
    const iterator = runner.invoke('attempt-final', input, controller.signal)[Symbol.asyncIterator]();
    const next = iterator.next();
    try {
      await vi.advanceTimersByTimeAsync(0);
      output(child, 'attempt-final');
      controller.abort();
      expect((await next).value).toMatchObject({ kind: 'final', response: { status: 'success' } });
      expect((await iterator.next()).done).toBe(true);
    } finally {
      runner.close('test teardown');
    }
  });

  it('R14 cancelling one attempt leaves its healthy peer usable', async () => {
    vi.useFakeTimers();
    const { child, runner } = await readyRunner();
    const cancelled = new AbortController();
    const peer = new AbortController();
    const left = runner.invoke('attempt-left', input, cancelled.signal)[Symbol.asyncIterator]();
    const right = runner.invoke('attempt-right', input, peer.signal)[Symbol.asyncIterator]();
    const leftNext = left.next();
    const rightNext = right.next();
    let leftSettled = false;
    void leftNext.then(() => { leftSettled = true; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      cancelled.abort();
      await vi.advanceTimersByTimeAsync(5_000);
      output(child, 'attempt-right');
      expect((await rightNext).value).toMatchObject({ kind: 'final', response: { status: 'success' } });
      expect(child.kill).not.toHaveBeenCalled();
      expect(leftSettled).toBe(true);
    } finally {
      runner.close('test teardown');
      await leftNext;
      await left.return?.();
      await right.return?.();
    }
  });
});
