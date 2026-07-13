import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { serverLogger } from '../utils/logger.js';

export interface KbPreviewScheduler {
  stop(): void;
}

export function startKbPreviewScheduler(processCwd: string): KbPreviewScheduler {
  if (process.env.NODE_ENV === 'test' || process.env.KB_PREVIEW_AUTO_GENERATE === 'false') {
    return { stop() {} };
  }
  const intervalMs = Math.max(60_000, Number(process.env.KB_PREVIEW_INTERVAL_MS) || 15 * 60_000);
  const initialDelayMs = Math.max(5_000, Number(process.env.KB_PREVIEW_INITIAL_DELAY_MS) || 60_000);
  const kbRootDir = resolve(processCwd, 'data/kb');
  let child: ChildProcess | null = null;
  let stopped = false;

  const run = () => {
    if (stopped || child) return;
    const pnpm = 'pnpm';
    const args = ['-F', 'server', 'run', 'kb:previews', '--', '--root', kbRootDir];
    const command = process.platform === 'win32' ? pnpm : 'nice';
    const commandArgs = process.platform === 'win32' ? args : ['-n', '10', pnpm, ...args];
    child = spawn(command, commandArgs, {
      cwd: resolve(processCwd, '..'),
      env: { ...process.env, KB_PREVIEW_SCHEDULER_CHILD: '1' },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout = `${stdout}${String(chunk)}`.slice(-8_000); });
    child.stderr?.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-8_000); });
    child.on('error', (error) => {
      serverLogger.error('[KB Preview] generator failed to start', error);
    });
    child.on('close', (code, signal) => {
      if (code === 0) serverLogger.info(`[KB Preview] generator completed: ${stdout.trim()}`);
      else serverLogger.error(`[KB Preview] generator exited code=${code} signal=${signal}: ${stderr.trim() || stdout.trim()}`);
      child = null;
    });
  };

  const initialTimer = setTimeout(run, initialDelayMs);
  initialTimer.unref();
  const interval = setInterval(run, intervalMs);
  interval.unref();
  return {
    stop() {
      stopped = true;
      clearTimeout(initialTimer);
      clearInterval(interval);
      child?.kill('SIGTERM');
    },
  };
}
