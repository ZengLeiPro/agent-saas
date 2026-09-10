import type { SandboxRunnerFinalOutput, SandboxRunnerOutput } from './protocol.js';
import { OWNED_WAIT_BUDGETS } from './ownedWait.js';
import { isRemoteUnknown, remoteUnknownResponse } from './runnerTransport.js';

type Output = SandboxRunnerOutput | SandboxRunnerFinalOutput;

/** A wire attempt owns its tombstone after the HTTP/iterator waiter has left. */
export class PendingRunnerInvocation {
  private queue: Output[] = [];
  private queuedBytes = 0;
  private wake?: () => void;
  private cancelTimer?: ReturnType<typeof setTimeout>;
  private deadlineTimer?: ReturnType<typeof setTimeout>;
  private localEnded = false;
  private cancelSent = false;
  dispatched = false;
  remoteDone = false;

  constructor(
    private readonly sendCancel: () => void,
    private readonly onLateTerminal?: (output: Output) => void,
    private readonly onUnresolved?: () => void,
  ) {}

  start(timeoutMs: number): void {
    this.dispatched = true;
    this.deadlineTimer = setTimeout(() => this.cancel('execution_deadline'), timeoutMs);
    this.deadlineTimer.unref?.();
  }

  get retained(): boolean { return this.dispatched && !this.remoteDone; }

  accept(output: Output): void {
    if (this.remoteDone) return;
    const response = output.kind === 'final' ? output.response
      : output.chunk.type === 'completed' ? output.chunk.response : undefined;
    if (response && !isRemoteUnknown(response)) {
      this.remoteDone = true;
      this.clearTimers();
      if (this.localEnded) {
        this.onLateTerminal?.(output);
        return;
      }
      this.localEnded = true;
    }
    if (response && isRemoteUnknown(response)) {
      this.unresolved('remote_unconfirmed');
      return;
    }
    // A caller which has detached does not accumulate abandoned presentation data.
    if (this.localEnded && !response) return;
    const bytes = Buffer.byteLength(JSON.stringify(output));
    if (!response && (this.queue.length >= 256 || this.queuedBytes + bytes > 8 * 1024 * 1024)) {
      this.cancel('presentation_queue_limit');
      this.unresolved('presentation_queue_limit');
      return;
    }
    this.queue.push(output);
    this.queuedBytes += bytes;
    this.notify();
  }

  cancel(reason = 'cancel_unconfirmed'): void {
    // Once a terminal response is observed, a late abort cannot replace it.
    if (this.remoteDone || !this.dispatched || this.cancelSent) return;
    this.cancelSent = true;
    try { this.sendCancel(); } catch { /* Still retain the exact attempt. */ }
    this.cancelTimer = setTimeout(() => this.unresolved(reason), OWNED_WAIT_BUDGETS.cancellationMs);
    this.cancelTimer.unref?.();
  }

  unresolved(reason: string): void {
    if (this.remoteDone || this.localEnded) return;
    this.localEnded = true;
    this.clearTimers();
    // This is explicitly a local result, never a fabricated remote stop receipt.
    const final: Output = { kind: 'final', response: remoteUnknownResponse(reason) };
    this.queue = [final];
    this.queuedBytes = Buffer.byteLength(JSON.stringify(final));
    this.onUnresolved?.();
    this.notify();
  }

  async next(): Promise<IteratorResult<Output>> {
    for (;;) {
      const output = this.queue.shift();
      if (output) {
        this.queuedBytes -= Buffer.byteLength(JSON.stringify(output));
        return { done: false, value: output };
      }
      if (this.localEnded || !this.dispatched) return { done: true, value: undefined };
      await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }

  detach(): void {
    if (this.retained) {
      this.cancel();
      this.unresolved('iterator_detached');
    }
    this.queue = [];
    this.queuedBytes = 0;
  }

  private clearTimers(): void {
    if (this.cancelTimer) clearTimeout(this.cancelTimer);
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.cancelTimer = undefined;
    this.deadlineTimer = undefined;
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
}
