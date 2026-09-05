/**
 * 被测定制项目的进程管理：doctor 用真实进程跑一致性测试，不在单测里模拟。
 *
 * 启动约定（写进模板与 README）：
 * 1. 若 `package.json` 有 `ky.start`（字符串数组，`{{port}}` 会被替换成实际端口），按它启动；
 * 2. 否则 `pnpm start --port <port>`，同时把 `PORT` 注入环境变量。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface AppStartOptions {
  projectDir: string;
  port: number;
  env: Record<string, string>;
  /** 最长等待就绪时间，默认 90 秒。 */
  readyTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface AppInstance {
  baseUrl: string;
  port: number;
  /** 进程输出（stdout + stderr）最近若干行，失败时打印。 */
  readonly logs: string[];
  stop(): Promise<void>;
}

/** 读取项目自定的启动命令。 */
export async function resolveStartCommand(
  projectDir: string,
  port: number,
): Promise<{ command: string; args: string[] }> {
  const raw = await readFile(join(projectDir, 'package.json'), 'utf8');
  const parsed = JSON.parse(raw) as { ky?: { start?: unknown } };
  const custom = parsed.ky?.start;
  if (
    Array.isArray(custom) &&
    custom.length > 0 &&
    custom.every((item) => typeof item === 'string')
  ) {
    const parts = (custom as string[]).map((item) => item.replaceAll('{{port}}', String(port)));
    return { command: parts[0], args: parts.slice(1) };
  }
  return { command: 'pnpm', args: ['start', '--port', String(port)] };
}

/** 起一个被测项目进程并等它的 `/ky/v1/health/live` 就绪。 */
export async function startApp(options: AppStartOptions): Promise<AppInstance> {
  const log = options.log ?? (() => undefined);
  const { command, args } = await resolveStartCommand(options.projectDir, options.port);
  const logs: string[] = [];
  const child: ChildProcess = spawn(command, args, {
    cwd: options.projectDir,
    env: { ...process.env, ...options.env, PORT: String(options.port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const capture = (chunk: Buffer): void => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim() === '') continue;
      logs.push(line);
      if (logs.length > 300) logs.shift();
    }
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);

  let exited = false;
  child.on('exit', () => {
    exited = true;
  });

  const baseUrl = `http://127.0.0.1:${String(options.port)}`;
  const instance: AppInstance = {
    baseUrl,
    port: options.port,
    logs,
    stop: async () => {
      if (exited) return;
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 5000);
        child.on('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };

  const deadline = Date.now() + (options.readyTimeoutMs ?? 90_000);
  log(`启动被测项目：${command} ${args.join(' ')}（端口 ${String(options.port)}）`);
  for (;;) {
    if (exited) {
      throw new Error(`被测项目进程提前退出：\n${logs.slice(-30).join('\n')}`);
    }
    try {
      const response = await fetch(`${baseUrl}/ky/v1/health/live`);
      if (response.ok) return instance;
    } catch {
      // 还没起来，继续等。
    }
    if (Date.now() > deadline) {
      await instance.stop();
      throw new Error(
        `被测项目 ${String(options.port)} 端口没有在超时内就绪：\n${logs.slice(-30).join('\n')}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}
