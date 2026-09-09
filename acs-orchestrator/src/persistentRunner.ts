import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { PendingRunnerInvocation } from './pendingRunnerInvocation.js';
import { localProcessResult } from './localProcessSupervisor.js';
import { invocationTransportBudget } from './runnerTransport.js';
import { OWNED_WAIT_BUDGETS } from './ownedWait.js';

import type { AcsOrchestratorConfig } from './config.js';
import type { Kubectl } from './kubectl.js';
import type { SandboxRunnerFinalOutput, SandboxRunnerInput, SandboxRunnerOutput } from './protocol.js';
import {
  parseRunnerDaemonResponse,
  RUNNER_DAEMON_PROTOCOL_VERSION,
  type RunnerDaemonRequest,
} from './runnerDaemonProtocol.js';
import type { SandboxRef } from './sandboxManager.js';
import { summarizeRunnerStderr } from './runnerLog.js';

const READY_TIMEOUT_MS = 3_000;
const HEARTBEAT_STALE_MS = 40_000;

type RunnerOutput = SandboxRunnerOutput | SandboxRunnerFinalOutput;


export class PersistentSandboxRunner {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = '';
  private ready = false;
  private closed = false;
  private lastHeartbeatAt = 0;
  private readyResolve?: () => void;
  private readyReject?: (error: Error) => void;
  private readonly readyPromise: Promise<void>;
  private readonly pending = new Map<string, PendingRunnerInvocation>();
  private readonly decoder = new StringDecoder('utf8');
  private readonly transportController = new AbortController();
  private watchdog?: ReturnType<typeof setInterval>;

  constructor(
    private readonly config: AcsOrchestratorConfig,
    private readonly kubectl: Kubectl,
    readonly ref: SandboxRef,
    private readonly logger: { info(msg: string): void; warn(msg: string): void; error(msg: string): void },
    private readonly hooks: { unresolved?(key: string): void; lateTerminal?(key: string, output: RunnerOutput): void } = {},
  ) {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    void this.readyPromise.catch(() => undefined);
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
      && now - this.lastHeartbeatAt <= HEARTBEAT_STALE_MS;
  }

  hasOwnedAttempts(): boolean { return [...this.pending.values()].some((pending) => pending.retained); }

  async *invoke(invocationKey: string, input: SandboxRunnerInput, signal: AbortSignal): AsyncIterable<RunnerOutput> {
    if (signal.aborted) return;
    await this.start();
    if (!this.isHealthy()) throw new Error('ACS persistent runner is not healthy');
    if (this.pending.has(invocationKey)) throw new Error(`runner invocation already owned: ${invocationKey}`);
    if (this.pending.size >= 128) throw new Error('ACS persistent runner ownership capacity exhausted');
    const pending = new PendingRunnerInvocation(
      () => { this.write({ kind: 'cancel', invocationKey }); },
      (output) => this.hooks.lateTerminal?.(invocationKey, output),
      () => this.hooks.unresolved?.(invocationKey),
    );
    this.pending.set(invocationKey, pending);
    const cancel = () => pending.cancel();
    signal.addEventListener('abort', cancel, { once: true });
    try {
      if (signal.aborted) return;
      pending.start(invocationTransportBudget(input));
      if (!this.write({ kind: 'invoke', invocationKey, input })) pending.unresolved('runner_write_failed');
      for (;;) {
        const next = await pending.next();
        if (next.done) break;
        yield next.value;
      }
    } finally {
      signal.removeEventListener('abort', cancel);
      pending.detach();
      if (!pending.retained && this.pending.get(invocationKey) === pending) this.pending.delete(invocationKey);
    }
  }

  cancel(invocationKey: string): void { this.pending.get(invocationKey)?.cancel(); }

  close(reason = 'runner_closed'): void {
    if (this.closed) return;
    this.closed = true;
    this.readyReject?.(new Error(reason));
    this.transportController.abort();
    if (this.watchdog) clearInterval(this.watchdog);
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
    ], { signal: this.transportController.signal });
    this.child = child;
    void localProcessResult(child, { signal: this.transportController.signal, collectOutput: false }).then((result) => {
      if (result.remoteState === 'unknown') this.onClose('runner_transport_unknown');
    });
    this.watchdog = setInterval(() => {
      if (this.ready && Date.now() - this.lastHeartbeatAt > HEARTBEAT_STALE_MS) {
        for (const pending of this.pending.values()) pending.unresolved('control_heartbeat_stale');
      }
    }, OWNED_WAIT_BUDGETS.heartbeatTickMs);
    this.watchdog.unref?.();
    child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8').trim();
      if (text) this.logger.warn(`kubectl_runner_daemon_stderr sandbox=${this.ref.name} ${summarizeRunnerStderr(text)}`);
    });
    child.on('error', (err) => this.onClose(`runner process error: ${err.message}`));
    child.on('close', (exitCode, signal) => {
      this.onClose(`runner process closed (code=${exitCode ?? signal ?? 'unknown'})`);
    });
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuffer += this.decoder.write(chunk);
    if (Buffer.byteLength(this.stdoutBuffer) > 2 * 1024 * 1024) {
      this.onClose('runner_frame_budget_exceeded');
      return;
    }
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
      const pending = this.pending.get(response.invocationKey);
      if (!pending) continue;
      pending.accept(response.output);
      if (pending.remoteDone && this.pending.get(response.invocationKey) === pending) this.pending.delete(response.invocationKey);
    }
  }

  private onClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.readyReject?.(new Error(reason));
    this.failPending(reason);
  }

  private failPending(reason: string): void {
    for (const pending of this.pending.values()) pending.unresolved(reason.replace(/[^a-z0-9_]/gi, '_').slice(0, 80));
  }

  private write(request: RunnerDaemonRequest): boolean {
    if (!this.child?.stdin.writable || this.closed) return false;
    try {
      this.child.stdin.write(`${JSON.stringify(request)}\n`);
      return true;
    } catch { return false; }
  }
}
