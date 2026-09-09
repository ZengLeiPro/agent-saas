import { spawn } from 'node:child_process';
import { localProcessResult } from './localProcessSupervisor.js';

import type { AcsOrchestratorConfig } from './config.js';

export interface KubectlResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Transport observation only; local completion is never remote-stop proof. */
  remoteState?: 'unknown' | 'not_started';
}

export class Kubectl {
  private ownershipObserver?: (reason: string) => void;
  constructor(private readonly config: AcsOrchestratorConfig) {}
  setOwnershipObserver(observer: (reason: string) => void): void { this.ownershipObserver = observer; }

  async run(args: string[], options: { input?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<KubectlResult> {
    if (options.signal?.aborted) return { stdout: '', stderr: 'kubectl request aborted before spawn', exitCode: -1, signal: null, remoteState: 'not_started' };
    const observer = this.ownershipObserver;
    let child;
    try {
      child = spawn(this.config.kubectlPath, this.baseArgs(args), { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    } catch {
      return { stdout: '', stderr: 'kubectl spawn failed', exitCode: -1, signal: null, remoteState: 'not_started' };
    }
    const task = localProcessResult(child, { signal: options.signal, timeoutMs: options.timeoutMs ?? this.config.execTimeoutMs });
    child.stdin.end(options.input);
    const result = await task;
    if (result.remoteState === 'unknown') observer?.(result.reason ?? 'transport_unknown');
    return result;
  }

  spawn(args: string[], options: { input?: string; signal?: AbortSignal; timeoutMs?: number } = {}) {
    options.signal?.throwIfAborted();
    const observer = this.ownershipObserver;
    const child = spawn(this.config.kubectlPath, this.baseArgs(args), { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    const task = localProcessResult(child, { signal: options.signal, timeoutMs: options.timeoutMs, collectOutput: false });
    void task.then((result) => {
      if (result.remoteState === 'unknown') observer?.(result.reason ?? 'transport_unknown');
    }).catch(() => observer?.('transport_observer_failed'));
    if (options.input !== undefined) child.stdin.end(options.input);
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
