import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
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

  // 生产 release 只交付 prod 依赖，既没有 pnpm workspace 根也没有 devDependency tsx，
  // 因此不能用 `pnpm -F server run kb:previews`（实测自 2026-07-13 起每 15 分钟失败一次，
  // 预览停更 52 天）。改为执行 build 预编译出的 dist 入口，与 dist/admin 同策略。
  const entryPath = resolve(processCwd, 'dist/jobs/kb-previews.mjs');
  const run = () => {
    if (stopped || child) return;
    if (!existsSync(entryPath)) {
      // 未 build 的开发环境没有该产物；跳过而不是每轮 spawn 失败刷错误日志。
      serverLogger.info(`[KB Preview] generator entry not built, skipping: ${entryPath}`);
      return;
    }
    const node = process.execPath;
    const args = [entryPath, '--root', kbRootDir];
    const command = process.platform === 'win32' ? node : 'nice';
    const commandArgs = process.platform === 'win32' ? args : ['-n', '10', node, ...args];
    child = spawn(command, commandArgs, {
      cwd: processCwd,
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
