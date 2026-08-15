import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import type { AcsOrchestratorConfig } from './config.js';
import type { Kubectl } from './kubectl.js';
import type { SandboxRunnerFinalOutput, SandboxRunnerInput, SandboxRunnerOutput } from './protocol.js';
import {
  parseRunnerDaemonResponse,
  RUNNER_DAEMON_PROTOCOL_VERSION,
  type RunnerDaemonRequest,
} from './runnerDaemonProtocol.js';
import type { SandboxRef } from './sandboxManager.js';

const READY_TIMEOUT_MS = 3_000;
const HEARTBEAT_STALE_MS = 40_000;

type RunnerOutput = SandboxRunnerOutput | SandboxRunnerFinalOutput;

interface PendingInvocation {
  queue: RunnerOutput[];
  waiters: Array<() => void>;
  done: boolean;
}

export class PersistentSandboxRunner {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = '';
  private ready = false;
  private closed = false;
  private lastHeartbeatAt = 0;
  private readyResolve?: () => void;
  private readyReject?: (error: Error) => void;
  private readonly readyPromise: Promise<void>;
  private readonly pending = new Map<string, PendingInvocation>();

  constructor(
    private readonly config: AcsOrchestratorConfig,
    private readonly kubectl: Kubectl,
    readonly ref: SandboxRef,
    private readonly logger: { info(msg: string): void; warn(msg: string): void; error(msg: string): void },
  ) {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
  }

  async start(): Promise<void> {
    if (!this.child) this.spawn();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.readyPromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`ACS persistent runner ready timeout (${READY_TIMEOUT_MS}ms)`)), READY_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    } catch (err) {
      this.close('runner_start_failed');
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  isHealthy(now = Date.now()): boolean {
    return this.ready
      && !this.closed
      && Boolean(this.child)
      && (this.pending.size > 0 || now - this.lastHeartbeatAt <= HEARTBEAT_STALE_MS);
  }

  async *invoke(
    invocationKey: string,
    input: SandboxRunnerInput,
    signal: AbortSignal,
  ): AsyncIterable<RunnerOutput> {
    await this.start();
    if (!this.isHealthy()) throw new Error('ACS persistent runner is not healthy');
    if (this.pending.has(invocationKey)) throw new Error(`runner invocation already active: ${invocationKey}`);
    const pending: PendingInvocation = { queue: [], waiters: [], done: false };
    this.pending.set(invocationKey, pending);
    const cancel = () => this.write({ kind: 'cancel', invocationKey });
    signal.addEventListener('abort', cancel, { once: true });
    try {
      if (signal.aborted) return;
      this.write({ kind: 'invoke', invocationKey, input });
      while (!pending.done || pending.queue.length > 0) {
        const output = pending.queue.shift();
        if (output) {
          yield output;
          continue;
        }
        await new Promise<void>((resolve) => pending.waiters.push(resolve));
      }
    } finally {
      signal.removeEventListener('abort', cancel);
      if (!pending.done) cancel();
      this.pending.delete(invocationKey);
    }
  }

  cancel(invocationKey: string): void {
    if (this.pending.has(invocationKey)) this.write({ kind: 'cancel', invocationKey });
  }

  close(reason = 'runner_closed'): void {
    if (this.closed) return;
    this.closed = true;
    this.readyReject?.(new Error(reason));
    this.child?.kill('SIGTERM');
    this.failPending(reason);
  }

  private spawn(): void {
    const script = 'if [ -s /app/acs-orchestrator/dist/sandboxRunner.mjs ]; then '
      + 'exec node /app/acs-orchestrator/dist/sandboxRunner.mjs --daemon; '
      + 'else '
      + 'exec /app/acs-orchestrator/node_modules/.bin/tsx /app/acs-orchestrator/src/sandboxRunner.ts --daemon; '
      + 'fi';
    const child = this.kubectl.spawn([
      'exec', '-i', this.ref.name, '-c', this.config.sandboxContainerName, '--', '/bin/sh', '-c', script,
    ]);
    this.child = child;
    child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8').trim();
      if (text) this.logger.warn(`kubectl_runner_daemon_stderr sandbox=${this.ref.name}: ${text}`);
    });
    child.on('error', (err) => this.onClose(`runner process error: ${err.message}`));
    child.on('close', (exitCode, signal) => {
      this.onClose(`runner process closed (code=${exitCode ?? signal ?? 'unknown'})`);
    });
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString('utf-8');
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        this.logger.warn(`runner_daemon_invalid_json sandbox=${this.ref.name}`);
        continue;
      }
      const response = parseRunnerDaemonResponse(raw);
      if (!response) continue;
      if (response.kind === 'daemon_ready') {
        if (response.protocolVersion !== RUNNER_DAEMON_PROTOCOL_VERSION) {
          this.onClose(`runner protocol mismatch: ${response.protocolVersion}`);
          return;
        }
        this.ready = true;
        this.lastHeartbeatAt = Date.now();
        this.readyResolve?.();
        this.logger.info(`runner_daemon_ready sandbox=${this.ref.name} runner=${response.runnerId}`);
        continue;
      }
      if (response.kind === 'daemon_heartbeat') {
        this.lastHeartbeatAt = Date.now();
        continue;
      }
      if (response.kind !== 'invocation_output') continue;
      this.lastHeartbeatAt = Date.now();
      const pending = this.pending.get(response.invocationKey);
      if (!pending) continue;
      pending.queue.push(response.output);
      if (isTerminalOutput(response.output)) pending.done = true;
      for (const wake of pending.waiters.splice(0)) wake();
    }
  }

  private onClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.readyReject?.(new Error(reason));
    this.failPending(reason);
  }

  private failPending(reason: string): void {
    for (const pending of this.pending.values()) {
      if (!pending.done) {
        pending.queue.push({ kind: 'final', response: { status: 'error', error: `ACS persistent runner disconnected: ${reason}` } });
        pending.done = true;
      }
      for (const wake of pending.waiters.splice(0)) wake();
    }
  }

  private write(request: RunnerDaemonRequest): void {
    if (!this.child?.stdin.writable || this.closed) return;
    this.child.stdin.write(`${JSON.stringify(request)}\n`);
  }
}

function isTerminalOutput(output: RunnerOutput): boolean {
  return output.kind === 'final' || (output.kind === 'chunk' && output.chunk.type === 'completed');
}
