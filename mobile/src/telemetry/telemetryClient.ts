import type {
  MobileTelemetryBatch,
  MobileTelemetryEvent,
  MobileTelemetryEventKind,
  MobileTelemetryRelease,
  MobileTelemetryRuntime,
  TelemetryPseudonymizer,
} from '@agent/shared';
import { assertSafeTelemetrySurface, mobileTelemetryEventSchema } from '@agent/shared';

export const MOBILE_TELEMETRY_BUFFER_POLICY = Object.freeze({
  ttlMs: 24 * 60 * 60 * 1_000,
  maxCount: 200,
  maxBytes: 96 * 1024,
  maxBatchCount: 50,
  foregroundFlushBudgetMs: 750,
});

export interface TelemetryStorage {
  getItem(key: string): Promise<string | null> | string | null;
  setItem(key: string, value: string): Promise<void> | void;
  removeItem(key: string): Promise<void> | void;
}

export interface TelemetryTransport {
  send(batch: MobileTelemetryBatch): Promise<{ accepted: boolean; receiptId?: string }>;
}

interface BufferedEvent {
  capturedAt: number;
  event: MobileTelemetryEvent;
}

export interface TelemetryClientDependencies {
  storage: TelemetryStorage;
  transport: TelemetryTransport;
  pseudonymizer: TelemetryPseudonymizer;
  release: MobileTelemetryRelease;
  runtime: MobileTelemetryRuntime;
  owner: { tenantId: string; userId: string };
  wallNow?: () => number;
  monotonicNow?: () => number;
  uuid?: () => string;
  nonce?: () => string;
}

function secureUuid(): string {
  const uuid = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID?.();
  if (!uuid) throw new Error('secure_random_unavailable');
  return uuid;
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export class MobileTelemetryClient {
  private readonly wallNow: () => number;
  private readonly monotonicNow: () => number;
  private readonly uuid: () => string;
  private readonly nonce: () => string;
  private foreground = true;
  private writeChain: Promise<void> = Promise.resolve();
  readonly ownerHashes: { tenantId: string; userId: string };
  readonly bufferKey: string;

  constructor(private readonly deps: TelemetryClientDependencies) {
    this.wallNow = deps.wallNow ?? Date.now;
    this.monotonicNow = deps.monotonicNow ?? (() => globalThis.performance?.now?.() ?? Date.now());
    this.uuid = deps.uuid ?? secureUuid;
    this.nonce = deps.nonce ?? (() => secureUuid().replaceAll('-', ''));
    this.ownerHashes = {
      tenantId: deps.pseudonymizer.pseudonym(deps.owner.tenantId),
      userId: deps.pseudonymizer.pseudonym(deps.owner.userId),
    };
    this.bufferKey = `mobile.telemetry.v1::${this.ownerHashes.tenantId}::${this.ownerHashes.userId}`;
  }

  setForeground(foreground: boolean): void {
    this.foreground = foreground;
  }

  pseudonym(value: string): string {
    return this.deps.pseudonymizer.pseudonym(value);
  }

  /** Best effort by contract: errors are swallowed and never enter a chat control flow. */
  capture(
    kind: MobileTelemetryEventKind,
    input: {
      correlationId: string;
      sessionId?: string;
      runId?: string;
      measurements?: MobileTelemetryEvent['measurements'];
      stack?: MobileTelemetryEvent['stack'];
    },
  ): void {
    try {
      const event = mobileTelemetryEventSchema.parse({
        schemaVersion: 1,
        eventId: this.uuid(),
        kind,
        wallTimestamp: new Date(this.wallNow()).toISOString(),
        monotonicMs: this.monotonicNow(),
        correlation: {
          correlationId: this.deps.pseudonymizer.pseudonym(input.correlationId),
          ...(input.sessionId
            ? { sessionId: this.deps.pseudonymizer.pseudonym(input.sessionId) }
            : {}),
          ...(input.runId ? { runId: this.deps.pseudonymizer.pseudonym(input.runId) } : {}),
        },
        release: this.deps.release,
        runtime: this.deps.runtime,
        ...(input.measurements ? { measurements: input.measurements } : {}),
        ...(input.stack ? { stack: input.stack } : {}),
      });
      assertSafeTelemetrySurface(event);
      this.writeChain = this.writeChain.then(() => this.append(event)).catch(() => undefined);
    } catch {
      // Privacy/schema/randomness failure disables this event only.
    }
  }

  async settled(): Promise<void> {
    await this.writeChain;
  }

  private async read(): Promise<BufferedEvent[]> {
    const raw = await this.deps.storage.getItem(this.bufferKey);
    if (!raw) return [];
    try {
      const value = JSON.parse(raw) as BufferedEvent[];
      if (!Array.isArray(value)) throw new Error('invalid');
      return value.filter(
        (item) =>
          typeof item?.capturedAt === 'number' &&
          this.wallNow() - item.capturedAt <= MOBILE_TELEMETRY_BUFFER_POLICY.ttlMs &&
          mobileTelemetryEventSchema.safeParse(item.event).success,
      );
    } catch {
      await this.deps.storage.removeItem(this.bufferKey);
      return [];
    }
  }

  private async append(event: MobileTelemetryEvent): Promise<void> {
    let items = [...(await this.read()), { capturedAt: this.wallNow(), event }];
    if (items.length > MOBILE_TELEMETRY_BUFFER_POLICY.maxCount) {
      items = items.slice(-MOBILE_TELEMETRY_BUFFER_POLICY.maxCount);
    }
    while (items.length > 0 && byteLength(items) > MOBILE_TELEMETRY_BUFFER_POLICY.maxBytes)
      items.shift();
    if (items.length) await this.deps.storage.setItem(this.bufferKey, JSON.stringify(items));
    else await this.deps.storage.removeItem(this.bufferKey);
  }

  async flush(
    budgetMs: number = MOBILE_TELEMETRY_BUFFER_POLICY.foregroundFlushBudgetMs,
  ): Promise<number> {
    await this.writeChain;
    if (!this.foreground || budgetMs <= 0) return 0;
    const started = this.monotonicNow();
    const items = await this.read();
    if (!items.length) return 0;
    const selected = items.slice(0, MOBILE_TELEMETRY_BUFFER_POLICY.maxBatchCount);
    if (this.monotonicNow() - started >= budgetMs) return 0;
    const batch: MobileTelemetryBatch = {
      schemaVersion: 1,
      batchId: this.uuid(),
      nonce: this.nonce(),
      sentAt: new Date(this.wallNow()).toISOString(),
      owner: this.ownerHashes,
      release: this.deps.release,
      events: selected.map((item) => item.event),
    };
    assertSafeTelemetrySurface(batch);
    try {
      const receipt = await this.deps.transport.send(batch);
      if (!receipt.accepted || this.monotonicNow() - started > budgetMs) return 0;
      const remaining = items.slice(selected.length);
      if (remaining.length)
        await this.deps.storage.setItem(this.bufferKey, JSON.stringify(remaining));
      else await this.deps.storage.removeItem(this.bufferKey);
      return selected.length;
    } catch {
      return 0;
    }
  }

  async clearOwner(): Promise<void> {
    await this.writeChain;
    await this.deps.storage.removeItem(this.bufferKey);
  }
}
