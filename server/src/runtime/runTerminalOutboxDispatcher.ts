import type { TerminalEventOutboxRunStore } from './runTerminalOutboxStore.js';
export { PgTerminalEventOutboxRunStore } from './runTerminalOutboxStore.js';
import {
  readTerminalEventOutbox,
  retryPendingTerminalEvents,
  type TerminalEventLogger,
} from './runTerminalCoordinator.js';
import type { EventStore } from './types.js';

export interface TerminalEventOutboxDispatcherOptions {
  runStore: TerminalEventOutboxRunStore;
  eventStore: EventStore;
  logger?: TerminalEventLogger;
  scanIntervalMs?: number;
  claimTtlMs?: number;
  batchSize?: number;
  now?: () => Date;
}

/**
 * Production consumer for terminal event outboxes.
 *
 * One unref'ed one-shot timer is armed only after the prior bounded scan ends,
 * so scans never overlap and shutdown can synchronously prevent future work.
 * PgRunStore's claim CAS makes any number of dispatcher processes safe.
 */
export class TerminalEventOutboxDispatcher {
  private readonly scanIntervalMs: number;
  private readonly claimTtlMs: number;
  private readonly batchSize: number;
  private readonly now: () => Date;
  private timer?: NodeJS.Timeout;
  private running = false;
  private scanning = false;

  constructor(private readonly options: TerminalEventOutboxDispatcherOptions) {
    this.scanIntervalMs = Math.max(25, options.scanIntervalMs ?? 1_000);
    this.claimTtlMs = Math.max(100, options.claimTtlMs ?? 30_000);
    this.batchSize = Math.max(1, Math.min(200, Math.trunc(options.batchSize ?? 50)));
    this.now = options.now ?? (() => new Date());
  }

  /** Runs startup recovery before returning, then arms bounded background scans. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.scanAndSchedule();
  }

  /** Cancels future scans without waiting on an unavailable EventStore call. */
  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  isRunning(): boolean {
    return this.running;
  }

  async runOnce(): Promise<number> {
    const now = this.now();
    const rows = await this.options.runStore.listPendingTerminalEventOutboxes(
      now,
      new Date(now.getTime() - this.claimTtlMs),
      this.batchSize,
    );
    let delivered = 0;
    for (const run of rows) {
      if (!this.running) break;
      const outbox = readTerminalEventOutbox(run);
      if (!outbox) continue;
      if (await retryPendingTerminalEvents({
        runStore: this.options.runStore,
        eventStore: this.options.eventStore,
        runId: run.runId,
        ctx: run.tenantId ? { tenantId: run.tenantId } : undefined,
        logger: this.options.logger,
        now,
        claimTtlMs: this.claimTtlMs,
      })) delivered += 1;
    }
    return delivered;
  }

  private async scanAndSchedule(): Promise<void> {
    if (!this.running || this.scanning) return;
    this.scanning = true;
    let saturated = false;
    try {
      const now = this.now();
      const rows = await this.options.runStore.listPendingTerminalEventOutboxes(
        now,
        new Date(now.getTime() - this.claimTtlMs),
        this.batchSize,
      );
      saturated = rows.length === this.batchSize;
      for (const run of rows) {
        if (!this.running) break;
        await retryPendingTerminalEvents({
          runStore: this.options.runStore,
          eventStore: this.options.eventStore,
          runId: run.runId,
          ctx: run.tenantId ? { tenantId: run.tenantId } : undefined,
          logger: this.options.logger,
          now,
          claimTtlMs: this.claimTtlMs,
        });
      }
    } catch (error) {
      this.options.logger?.warn(
        `[run-terminal] outbox scan failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.scanning = false;
    }
    if (!this.running) return;
    this.timer = setTimeout(() => void this.scanAndSchedule(), saturated ? 0 : this.scanIntervalMs);
    this.timer.unref?.();
  }
}

export async function startTerminalEventOutboxDispatcher(
  options: TerminalEventOutboxDispatcherOptions,
): Promise<TerminalEventOutboxDispatcher> {
  const dispatcher = new TerminalEventOutboxDispatcher(options);
  await dispatcher.start();
  return dispatcher;
}
