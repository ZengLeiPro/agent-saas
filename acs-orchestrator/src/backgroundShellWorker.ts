import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  MAX_BACKGROUND_SHELL_OUTPUT_BYTES,
  consumeBackgroundShellLaunch,
  readBackgroundShellState,
  writeBackgroundShellState,
  type BackgroundShellState,
} from './backgroundShell.js';

async function main(): Promise<void> {
  const taskDir = process.argv[2];
  const taskId = process.argv[3];
  if (!taskDir || !taskId) throw new Error('background shell worker requires taskDir and taskId');
  process.title = `ky-background-shell:${taskId}`;
  const command = await consumeBackgroundShellLaunch(taskDir);
  const initial = await readBackgroundShellState(taskDir);
  const startedAt = new Date().toISOString();
  const child = spawn('/bin/sh', ['-lc', command], {
    cwd: process.cwd(),
    env: { ...process.env, KY_BACKGROUND_SHELL_TASK_ID: taskId },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let spawnError: string | undefined;
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
    child.once('error', (err) => {
      spawnError = err.message;
      resolve({ code: 1, signal: null });
    });
  });
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let cancelled = false;
  let timedOut = false;
  let settled = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
  let streamError: string | undefined;
  const stdout = createWriteStream(join(taskDir, 'stdout.log'), { flags: 'a', mode: 0o600 });
  const stderr = createWriteStream(join(taskDir, 'stderr.log'), { flags: 'a', mode: 0o600 });
  stdout.on('error', (err) => { streamError ??= `stdout log failed: ${err.message}`; });
  stderr.on('error', (err) => { streamError ??= `stderr log failed: ${err.message}`; });
  const writeLimited = (stream: NodeJS.WritableStream, chunk: Buffer, channel: 'stdout' | 'stderr') => {
    const previous = channel === 'stdout' ? stdoutBytes : stderrBytes;
    const remaining = Math.max(0, MAX_BACKGROUND_SHELL_OUTPUT_BYTES - previous);
    if (remaining > 0) stream.write(chunk.subarray(0, remaining));
    const next = previous + Math.min(chunk.byteLength, remaining);
    if (channel === 'stdout') {
      stdoutBytes = next;
      if (chunk.byteLength > remaining) stdoutTruncated = true;
    } else {
      stderrBytes = next;
      if (chunk.byteLength > remaining) stderrTruncated = true;
    }
  };
  child.stdout.on('data', (chunk: Buffer) => writeLimited(stdout, chunk, 'stdout'));
  child.stderr.on('data', (chunk: Buffer) => writeLimited(stderr, chunk, 'stderr'));

  await writeBackgroundShellState(taskDir, {
    ...initial,
    status: 'running',
    workerPid: process.pid,
    childPid: child.pid,
    startedAt,
    updatedAt: startedAt,
  });

  const terminateChild = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); } catch { /* already exited */ }
  };
  const scheduleForceKill = () => {
    if (forceKillTimer) return;
    forceKillTimer = setTimeout(() => {
      if (!settled) terminateChild('SIGKILL');
    }, 5_000);
    forceKillTimer.unref();
  };
  const cancel = () => {
    if (settled || cancelled || timedOut) return;
    cancelled = true;
    terminateChild('SIGTERM');
    scheduleForceKill();
  };
  process.once('SIGTERM', cancel);
  process.once('SIGINT', cancel);
  process.once('SIGHUP', cancel);
  const timeout = setTimeout(() => {
    if (settled || cancelled) return;
    timedOut = true;
    terminateChild('SIGTERM');
    scheduleForceKill();
  }, Math.max(0, Date.parse(initial.expiresAt) - Date.now()));
  timeout.unref?.();

  const exit = await exitPromise;
  settled = true;
  clearTimeout(timeout);
  if (forceKillTimer) clearTimeout(forceKillTimer);
  await Promise.all([endStream(stdout), endStream(stderr)]);
  const completedAt = new Date().toISOString();
  const status: BackgroundShellState['status'] = cancelled
    ? 'cancelled'
    : timedOut
      ? 'timed_out'
      : exit.code === 0 && !streamError
        ? 'completed'
        : 'failed';
  await writeBackgroundShellState(taskDir, {
    ...(await readBackgroundShellState(taskDir)),
    status,
    completedAt,
    updatedAt: completedAt,
    exitCode: exit.code,
    signal: exit.signal,
    ...(status === 'cancelled' ? { error: 'background shell cancelled' } : {}),
    ...(status === 'timed_out' ? { error: `background shell timed out after ${initial.timeoutMs}ms` } : {}),
    ...(status === 'failed' ? { error: spawnError ?? streamError ?? `command exited ${exit.code ?? exit.signal ?? 'unknown'}` } : {}),
    stdoutBytes: await safeFileSize(join(taskDir, 'stdout.log'), stdoutBytes),
    stderrBytes: await safeFileSize(join(taskDir, 'stderr.log'), stderrBytes),
    stdoutTruncated,
    stderrTruncated,
  });
}

async function endStream(stream: NodeJS.WritableStream): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    stream.once('error', finish);
    stream.once('close', finish);
    stream.end(finish);
  });
}

async function safeFileSize(path: string, fallback: number): Promise<number> {
  try { return (await stat(path)).size; } catch { return fallback; }
}

function isDirectRun(): boolean {
  return Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
}

if (isDirectRun()) {
  main().catch(async (err) => {
    const taskDir = process.argv[2];
    if (taskDir) {
      try {
        const state = await readBackgroundShellState(taskDir);
        const now = new Date().toISOString();
        await writeBackgroundShellState(taskDir, {
          ...state,
          status: 'failed',
          completedAt: now,
          updatedAt: now,
          error: err instanceof Error ? err.message : String(err),
        });
      } catch {
        // 状态文件本身损坏时只能让查询侧报告失败。
      }
    }
    process.exitCode = 1;
  });
}
