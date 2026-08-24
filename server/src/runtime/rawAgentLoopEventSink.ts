import type { LegacyTranscriptProjection } from './legacyTranscriptProjection.js';
import type { EventStore, PlatformEventInput, RunContext } from './types.js';

export function requireEventTenantId(context: RunContext): string {
  const candidates = [
    context.tenantId,
    context.channelContext.sessionOwner?.tenantId,
    context.channelContext.user?.tenantId,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const tenantId = candidates[0]?.trim();
  if (!tenantId) throw new Error(`RawAgentLoop tenant context is missing for session ${context.sessionId}`);
  if (candidates.some((candidate) => candidate.trim() !== tenantId)) {
    throw new Error(`RawAgentLoop tenant context mismatch for session ${context.sessionId}`);
  }
  return tenantId;
}

export class TenantProjectingEventSink {
  constructor(
    private readonly eventStore: EventStore,
    private readonly transcriptProjection: LegacyTranscriptProjection,
    private readonly resolveActiveTenantId: () => string | undefined,
  ) {}

  async appendBatch(events: PlatformEventInput[]): Promise<void> {
    const ctx = { tenantId: this.requireTenantId() };
    const storedEvents = this.eventStore.appendBatch
      ? await this.eventStore.appendBatch(events, ctx)
      : await this.appendIndividually(events, ctx);
    for (const stored of storedEvents) await this.transcriptProjection.project(stored);
  }

  async append(event: Parameters<EventStore['append']>[0]): Promise<void> {
    const stored = await this.eventStore.append(event, { tenantId: this.requireTenantId() });
    await this.transcriptProjection.project(stored);
  }

  private async appendIndividually(
    events: PlatformEventInput[],
    ctx: Parameters<EventStore['append']>[1],
  ) {
    const storedEvents = [];
    for (const event of events) storedEvents.push(await this.eventStore.append(event, ctx));
    return storedEvents;
  }

  requireTenantId(): string {
    const tenantId = this.resolveActiveTenantId();
    if (!tenantId) throw new Error('RawAgentLoop tenant context is not active');
    return tenantId;
  }
}
