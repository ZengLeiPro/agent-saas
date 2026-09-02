import { chmod, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import {
  backgroundShellTaskDir,
  getBackgroundShellOutput,
  isBackgroundShellTerminal,
  killBackgroundShell,
  reconcileBackgroundShells,
  startBackgroundShell,
  terminateBackgroundShellsFailClosed,
  type BackgroundShellOutput,
} from './backgroundShell.js';

describe('background shell runtime', () => {
  it('survives the starter invocation and exposes durable stdout/stderr', async () => {
    const root = await mkdtemp(join(tmpdir(), 'acs-background-shell-'));
    const taskId = `shell-bg-test-${randomUUID()}`;
    const started = await startBackgroundShell({
      workspaceRoot: root,
      taskId,
      command: 'printf hello; sleep 0.1; printf warning >&2',
      timeoutMs: 5_000,
      env: process.env,
    });
    expect(started.taskId).toBe(taskId);
    expect(['starting', 'running', 'completed']).toContain(started.status);
    const completed = await waitForTerminal(root, taskId);
    expect(completed).toMatchObject({ status: 'completed', exitCode: 0 });
    expect(completed.stdoutPath).toBe(`.ky-agent/runtime/background-shell/tasks/${taskId}/stdout.log`);
    expect(completed.stderrPath).toBe(`.ky-agent/runtime/background-shell/tasks/${taskId}/stderr.log`);
    expect(completed.stdout).toBe('hello');
    expect(completed.stderr).toBe('warning');
    expect((await reconcileBackgroundShells(root)).activeTaskIds).toEqual([]);

    const idempotent = await startBackgroundShell({
      workspaceRoot: root,
      taskId,
      command: 'printf hello; sleep 0.1; printf warning >&2',
      timeoutMs: 5_000,
      env: process.env,
    });
    expect(idempotent.status).toBe('completed');
  });

  it('strict reconciliation treats a partially written task as unknown activity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'acs-background-shell-strict-'));
    const taskId = `shell-bg-test-${randomUUID()}`;
    const taskDir = backgroundShellTaskDir(root, taskId);
    await mkdir(taskDir, { recursive: true });
    await writeFile(join(taskDir, 'state.json'), '{not-json', 'utf8');

    await expect(reconcileBackgroundShells(root, { strict: true })).rejects.toThrow(
      /task state is unreadable/u,
    );
    await expect(reconcileBackgroundShells(root)).resolves.toEqual({ activeTaskIds: [] });
  });

  it('preserves the injected PATH instead of resetting it through a login shell', async () => {
    const root = await mkdtemp(join(tmpdir(), 'acs-background-shell-path-'));
    const bin = join(root, 'bin');
    await mkdir(bin);
    const executable = join(bin, 'task21-path-probe');
    await writeFile(executable, '#!/bin/sh\nprintf path-preserved', 'utf8');
    await chmod(executable, 0o755);
    const taskId = `shell-bg-test-${randomUUID()}`;
    await startBackgroundShell({
      workspaceRoot: root,
      taskId,
      command: 'task21-path-probe',
      timeoutMs: 5_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });

    const completed = await waitForTerminal(root, taskId);
    expect(completed).toMatchObject({ status: 'completed', stdout: 'path-preserved' });
  });

  it('runs the command in commandCwd while keeping task state under the workspace root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'acs-background-shell-cwd-'));
    const commandCwd = join(root, 'code', 'project');
    await mkdir(commandCwd, { recursive: true });
    const taskId = `shell-bg-test-${randomUUID()}`;
    await startBackgroundShell({
      workspaceRoot: root,
      commandCwd,
      taskId,
      command: 'pwd',
      timeoutMs: 5_000,
      env: process.env,
    });

    const completed = await waitForTerminal(root, taskId);
    expect(completed).toMatchObject({ status: 'completed', stdout: `${await realpath(commandCwd)}\n` });
  });

  it('cancels the worker and its child process group', async () => {
    const root = await mkdtemp(join(tmpdir(), 'acs-background-shell-cancel-'));
    const taskId = `shell-bg-test-${randomUUID()}`;
    await startBackgroundShell({
      workspaceRoot: root,
      taskId,
      command: 'sleep 20',
      timeoutMs: 30_000,
      env: process.env,
    });
    await waitForStatus(root, taskId, 'running');
    const cancelled = await killBackgroundShell(root, taskId);
    expect(cancelled.status).toBe('cancelled');
    expect((await reconcileBackgroundShells(root)).activeTaskIds).toEqual([]);
  });

  it('terminates only requested tasks and leaves unrelated workspace tasks running', async () => {
    const root = await mkdtemp(join(tmpdir(), 'acs-background-shell-fail-closed-'));
    const taskIds = [
      `shell-bg-test-${randomUUID()}`,
      `shell-bg-test-${randomUUID()}`,
    ];
    for (const taskId of taskIds) {
      await startBackgroundShell({
        workspaceRoot: root,
        taskId,
        command: 'sleep 20',
        timeoutMs: 30_000,
        env: process.env,
      });
      await waitForStatus(root, taskId, 'running');
    }

    await expect(terminateBackgroundShellsFailClosed(root, [taskIds[0]!])).resolves.toMatchObject({
      activeTaskIds: [taskIds[1]],
    });
    expect((await getBackgroundShellOutput({ workspaceRoot: root, taskId: taskIds[0]! })).status)
      .toBe('cancelled');
    expect((await getBackgroundShellOutput({ workspaceRoot: root, taskId: taskIds[1]! })).status)
      .toBe('running');
    await killBackgroundShell(root, taskIds[1]!);
  }, 15_000);

  it('ignores unreadable unrequested tasks while terminating the owned task', async () => {
    const root = await mkdtemp(join(tmpdir(), 'acs-background-shell-corrupt-state-'));
    const runningTaskId = `shell-bg-test-${randomUUID()}`;
    const corruptTaskId = `shell-bg-test-${randomUUID()}`;
    await startBackgroundShell({
      workspaceRoot: root,
      taskId: runningTaskId,
      command: 'sleep 20',
      timeoutMs: 30_000,
      env: process.env,
    });
    await waitForStatus(root, runningTaskId, 'running');
    const corruptDir = backgroundShellTaskDir(root, corruptTaskId);
    await mkdir(corruptDir, { recursive: true });
    await writeFile(join(corruptDir, 'state.json'), '{half-written');

    await expect(terminateBackgroundShellsFailClosed(root, [runningTaskId]))
      .resolves.toEqual({ activeTaskIds: [] });
    expect((await getBackgroundShellOutput({ workspaceRoot: root, taskId: runningTaskId })).status)
      .toBe('cancelled');
  }, 15_000);

  it('records timeout as timed_out instead of cancellation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'acs-background-shell-timeout-'));
    const taskId = `shell-bg-test-${randomUUID()}`;
    await startBackgroundShell({
      workspaceRoot: root,
      taskId,
      command: 'sleep 20',
      timeoutMs: 1_000,
      env: process.env,
    });

    const timedOut = await waitForTerminal(root, taskId);
    expect(timedOut.status).toBe('timed_out');
    expect(timedOut.error).toContain('timed out after 1000ms');
  });

  it('persists a failed state when the detached worker cannot start', async () => {
    const root = await mkdtemp(join(tmpdir(), 'acs-background-shell-spawn-fail-'));
    const taskId = `shell-bg-test-${randomUUID()}`;
    const spawnWorker = (() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('error', new Error('worker executable unavailable')));
      return child;
    }) as unknown as typeof spawn;

    await expect(startBackgroundShell({
      workspaceRoot: root,
      taskId,
      command: 'printf never-runs',
      timeoutMs: 5_000,
      env: process.env,
      spawnWorker,
    })).rejects.toThrow('worker executable unavailable');

    const failed = await getBackgroundShellOutput({ workspaceRoot: root, taskId });
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('worker failed to start');
  });

  it('terminates a live worker before recording startup timeout as failed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'acs-background-shell-start-timeout-'));
    const taskId = `shell-bg-test-${randomUUID()}`;
    const kill = vi.fn((signal: NodeJS.Signals) => {
      child.signalCode = signal;
      queueMicrotask(() => child.emit('exit', null, signal));
      return true;
    });
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill,
      unref: vi.fn(),
    });
    const spawnWorker = (() => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    }) as unknown as typeof spawn;

    await expect(startBackgroundShell({
      workspaceRoot: root,
      taskId,
      command: 'printf never-runs',
      timeoutMs: 5_000,
      workerStartTimeoutMs: 50,
      env: process.env,
      spawnWorker,
    })).rejects.toThrow('worker did not reach running within 50ms');

    expect(kill).toHaveBeenCalledWith('SIGTERM');
    const failed = await getBackgroundShellOutput({ workspaceRoot: root, taskId });
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('worker did not reach running within 50ms');
  });

  it('does not acknowledge a spawned worker that exits before consuming the launch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'acs-background-shell-early-exit-'));
    const taskId = `shell-bg-test-${randomUUID()}`;
    const spawnWorker = (() => {
      const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null });
      queueMicrotask(() => {
        child.emit('spawn');
        child.exitCode = 1;
        child.emit('exit', 1, null);
      });
      return child;
    }) as unknown as typeof spawn;

    await expect(startBackgroundShell({
      workspaceRoot: root,
      taskId,
      command: 'printf never-runs',
      timeoutMs: 5_000,
      env: process.env,
      spawnWorker,
    })).rejects.toThrow('worker exited before running');

    const failed = await getBackgroundShellOutput({ workspaceRoot: root, taskId });
    expect(failed.status).toBe('failed');
    expect(failed.startedAt).toBeUndefined();
    expect(failed.error).toContain('worker exited before running');
  });
});

async function waitForStatus(
  workspaceRoot: string,
  taskId: string,
  expected: BackgroundShellOutput['status'],
): Promise<BackgroundShellOutput> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const output = await getBackgroundShellOutput({ workspaceRoot, taskId, waitMs: 100 });
    if (output.status === expected) return output;
    if (isBackgroundShellTerminal(output.status)) throw new Error(`task reached ${output.status} before ${expected}`);
  }
  throw new Error(`timed out waiting for ${expected}`);
}

async function waitForTerminal(workspaceRoot: string, taskId: string): Promise<BackgroundShellOutput> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const output = await getBackgroundShellOutput({ workspaceRoot, taskId, waitMs: 250 });
    if (isBackgroundShellTerminal(output.status)) return output;
  }
  throw new Error('timed out waiting for terminal background shell state');
}
