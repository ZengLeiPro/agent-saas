import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { PendingRunnerInvocation } from './pendingRunnerInvocation.js';
import { localProcessResult } from './localProcessSupervisor.js';
import { invocationTransportBudget } from './runnerTransport.js';
import { authenticatedRunnerResult, type AuthenticatedRunnerInput } from './authenticatedRunnerResult.js';
import { REMOTE_CONTROL_FRAME_BYTES } from './remoteAttemptProtocol.js';
import { OWNED_WAIT_BUDGETS } from './ownedWait.js';
import type { AcsOrchestratorConfig } from './config.js';
import type { Kubectl } from './kubectl.js';
import type { SandboxRunnerFinalOutput, SandboxRunnerInput, SandboxRunnerOutput } from './protocol.js';
import { parseRunnerDaemonResponse, RUNNER_DAEMON_PROTOCOL_VERSION, type RunnerDaemonRequest } from './runnerDaemonProtocol.js';
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
  private runnerId?: string;
  private podUid?: string;
  private capabilities: string[] = [];
  private readyResolve?: () => void;
  private readyReject?: (error: Error) => void;
  private readonly readyPromise: Promise<void>;
  private readonly pending = new Map<string, PendingRunnerInvocation>();
  private readonly expectedInputs = new Map<string, SandboxRunnerInput>();
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
    this.readyPromise = new Promise<void>((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    void this.readyPromise.catch(() => undefined);
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error('ACS persistent runner is closed');
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
    } catch (error) {
      this.close('runner_start_failed');
      throw error;
    } finally { if (timer) clearTimeout(timer); }
  }

  isHealthy(now = Date.now()): boolean {
    return this.ready && !this.closed && Boolean(this.child) && now - this.lastHeartbeatAt <= HEARTBEAT_STALE_MS;
  }

  controlIdentity(): { podUid?: string; capabilities: readonly string[] } {
    return { podUid: this.podUid, capabilities: [...this.capabilities] };
  }

  hasOwnedAttempts(): boolean { return [...this.pending.values()].some((pending) => pending.retained); }

  async *invoke(invocationKey: string, input: SandboxRunnerInput, signal: AbortSignal): AsyncIterable<RunnerOutput> {
    if (signal.aborted) return;
    await this.start();
    if (signal.aborted) return;
    if (!this.isHealthy()) throw new Error('ACS persistent runner is not healthy');
    if (this.pending.has(invocationKey)) throw new Error(`runner invocation already owned: ${invocationKey}`);
    if (this.pending.size >= 128) throw new Error('ACS persistent runner ownership capacity exhausted');
    const pending = new PendingRunnerInvocation(
      () => { this.write({ kind: 'cancel', invocationKey }); },
      (output) => this.hooks.lateTerminal?.(invocationKey, output),
      () => this.hooks.unresolved?.(invocationKey),
    );
    this.pending.set(invocationKey, pending);
    this.expectedInputs.set(invocationKey, input);
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
      if (!pending.retained && this.pending.get(invocationKey) === pending) this.forgetTerminal(invocationKey);
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
    // The Python control process becomes non-dumpable before reading an attempt
    // key. No Node/shell proxy retains the control pipe beside same-UID tools.
    const child = this.kubectl.spawn([
      'exec', '-i', this.ref.name, '-c', this.config.sandboxContainerName, '--',
      '/usr/local/bin/python3', '-I', '/app/acs-orchestrator/dist/remote/runner_daemon.py',
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
      const text = chunk.toString('utf8').trim();
      if (text) this.logger.warn(`kubectl_runner_daemon_stderr sandbox=${this.ref.name} ${summarizeRunnerStderr(text)}`);
    });
    child.on('error', () => this.onClose('runner_process_error'));
    child.on('close', () => this.onClose('runner_process_closed'));
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuffer += this.decoder.write(chunk);
    let index: number;
    // A coalesced read may contain many valid frames. Apply the byte limit to
    // individual frames and the remaining partial frame, not the whole read.
    while ((index = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, index).replace(/\r$/, '');
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      if (Buffer.byteLength(line) > REMOTE_CONTROL_FRAME_BYTES) { this.onClose('runner_frame_budget_exceeded'); return; }
      if (line.trim()) this.acceptLine(line);
    }
    if (Buffer.byteLength(this.stdoutBuffer) > REMOTE_CONTROL_FRAME_BYTES) this.onClose('runner_partial_frame_budget_exceeded');
  }

  private acceptLine(line: string): void {
    let raw: unknown;
    try { raw = JSON.parse(line); }
    catch { this.logger.warn(`runner_daemon_invalid_json sandbox=${this.ref.name}`); return; }
    const response = parseRunnerDaemonResponse(raw);
    if (!response) return;
    if (response.kind === 'daemon_ready') {
      if (response.protocolVersion !== RUNNER_DAEMON_PROTOCOL_VERSION || (this.runnerId && response.runnerId !== this.runnerId)) {
        this.onClose('runner_protocol_or_generation_mismatch');
        return;
      }
      this.runnerId = response.runnerId;
      this.podUid = response.podUid;
      this.capabilities = response.capabilities ?? [];
      this.ready = true;
      this.lastHeartbeatAt = Date.now();
      this.readyResolve?.();
      this.logger.info(`runner_daemon_ready sandbox=${this.ref.name} runner=${response.runnerId}`);
      return;
    }
    if (response.kind === 'daemon_heartbeat') {
      if (response.runnerId === this.runnerId) this.lastHeartbeatAt = Date.now();
      return;
    }
    if (response.kind !== 'invocation_output') return;
    const pending = this.pending.get(response.invocationKey);
    const expected = this.expectedInputs.get(response.invocationKey);
    if (!pending || !expected) return;
    let output = response.output;
    const fenced = expected as Partial<AuthenticatedRunnerInput>;
    // Legacy protocol fixtures/readers remain readable. Production dispatch is
    // separately gated on all signed-control capabilities and a persisted fence.
    if (fenced.executionFence || fenced.receiptKey) {
      if (!fenced.executionFence || !fenced.receiptKey) { pending.unresolved('incomplete_remote_fence'); return; }
      if (output.kind === 'final') {
        output = { kind: 'final', response: authenticatedRunnerResult(expected as AuthenticatedRunnerInput, output.response) };
      } else if (output.kind === 'chunk' && output.chunk.type === 'completed') {
        output = { kind: 'chunk', chunk: { type: 'completed',
          response: authenticatedRunnerResult(expected as AuthenticatedRunnerInput, output.chunk.response) } };
      }
    }
    pending.accept(output);
    if (pending.remoteDone && this.pending.get(response.invocationKey) === pending) this.forgetTerminal(response.invocationKey);
  }

  private forgetTerminal(key: string): void {
    this.pending.delete(key);
    this.expectedInputs.delete(key);
  }

  private onClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.readyReject?.(new Error(reason));
    this.transportController.abort();
    this.failPending(reason);
  }

  private failPending(reason: string): void {
    for (const pending of this.pending.values()) pending.unresolved(reason.replace(/[^a-z0-9_]/gi, '_').slice(0, 80));
  }

  private write(request: RunnerDaemonRequest): boolean {
    if (!this.child?.stdin.writable || this.closed) return false;
    const frame = `${JSON.stringify(request)}\n`;
    if (Buffer.byteLength(frame) > REMOTE_CONTROL_FRAME_BYTES) return false;
    try { this.child.stdin.write(frame); return true; }
    catch { return false; }
  }
}
