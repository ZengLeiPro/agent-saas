import { spawn } from 'node:child_process';

import type { AcsOrchestratorConfig } from './config.js';

export interface KubectlResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export class Kubectl {
  constructor(private readonly config: AcsOrchestratorConfig) {}

  async run(args: string[], options: { input?: string; timeoutMs?: number } = {}): Promise<KubectlResult> {
    return await new Promise<KubectlResult>((resolve) => {
      const fullArgs = this.baseArgs(args);
      const child = spawn(this.config.kubectlPath, fullArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) child.kill('SIGTERM');
      }, options.timeoutMs ?? this.config.execTimeoutMs);
      timer.unref?.();
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8'); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });
      child.on('error', (err) => {
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr: stderr + `\n${err.message}`, exitCode: -1, signal: null });
      });
      child.on('close', (exitCode, signal) => {
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode, signal });
      });
      if (options.input !== undefined) child.stdin?.end(options.input);
      else child.stdin?.end();
    });
  }

  spawn(args: string[], options: { input?: string; signal?: AbortSignal } = {}) {
    const child = spawn(this.config.kubectlPath, this.baseArgs(args), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    const onAbort = () => child.kill('SIGTERM');
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('close', () => options.signal?.removeEventListener('abort', onAbort));
    if (options.input !== undefined) child.stdin?.end(options.input);
    return child;
  }

  private baseArgs(args: string[]): string[] {
    return [
      ...(this.config.kubeconfig ? ['--kubeconfig', this.config.kubeconfig] : []),
      '-n',
      this.config.namespace,
      ...args,
    ];
  }
}
