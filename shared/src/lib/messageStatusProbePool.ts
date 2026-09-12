import {
  beforeReadDeadline, MESSAGE_STATUS_BUDGET_MS, ReadDeadlineError, readMessageStatus,
  type MessageStatusFetch, type MessageStatusResult,
} from './messageStatus';

interface ProbeFlight {
  controller: AbortController;
  promise: Promise<MessageStatusResult>;
}
interface WaitingSlot { start: () => void; cancel: () => void }

/** One instance belongs to ONE captured identity. This is a read limiter, not a chat outbox. */
export class MessageStatusProbePool {
  private readonly flights = new Map<string, ProbeFlight>();
  private readonly waiting: WaitingSlot[] = [];
  private active = 0;
  private disposed = false;
  constructor(private readonly request?: MessageStatusFetch) {}
  get activeCount(): number { return this.active; }
  get waitingCount(): number { return this.waiting.length; }

  probe(clientMessageId: string, sessionId?: string): Promise<MessageStatusResult> {
    if (this.disposed) return Promise.resolve({ kind: 'unknown', reason: 'cancelled' });
    const existing = this.flights.get(clientMessageId);
    if (existing) return existing.promise;
    // Queueing time is part of this deadline; it is never reset when a slot becomes available.
    const deadlineAt = Date.now() + MESSAGE_STATUS_BUDGET_MS;
    const controller = new AbortController();
    const promise = beforeReadDeadline(async signal => {
      const release = await this.acquire(signal);
      try {
        if (signal.aborted) return { kind: 'unknown', reason: 'cancelled' } as const;
        return await readMessageStatus(clientMessageId, { sessionId, deadlineAt, signal, request: this.request });
      } finally { release(); }
    }, deadlineAt, controller.signal).catch((error: unknown): MessageStatusResult => ({
      kind: 'unknown', reason: error instanceof ReadDeadlineError ? error.reason : 'network',
    })).finally(() => {
      if (this.flights.get(clientMessageId)?.controller === controller) this.flights.delete(clientMessageId);
    });
    this.flights.set(clientMessageId, { controller, promise });
    return promise;
  }

  cancel(clientMessageId: string): void { this.flights.get(clientMessageId)?.controller.abort(); }
  dispose(): void {
    this.disposed = true;
    for (const flight of this.flights.values()) flight.controller.abort();
  }

  private acquire(signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      let granted = false;
      const slot: WaitingSlot = {
        start: () => {
          if (signal.aborted) { slot.cancel(); return; }
          granted = true;
          signal.removeEventListener('abort', slot.cancel);
          this.active += 1;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            this.active -= 1;
            this.drain();
          });
        },
        cancel: () => {
          if (granted) return;
          const index = this.waiting.indexOf(slot);
          if (index >= 0) this.waiting.splice(index, 1);
          signal.removeEventListener('abort', slot.cancel);
          reject(new ReadDeadlineError('cancelled'));
        },
      };
      if (signal.aborted) { slot.cancel(); return; }
      signal.addEventListener('abort', slot.cancel);
      this.waiting.push(slot);
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < 2 && this.waiting.length > 0) this.waiting.shift()!.start();
  }
}
