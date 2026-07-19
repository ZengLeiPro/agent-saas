import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import {
  getBackgroundShellOutput,
  isBackgroundShellTerminal,
  killBackgroundShell,
  reconcileBackgroundShells,
  startBackgroundShell,
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
