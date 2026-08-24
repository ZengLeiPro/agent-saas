import type { RuntimeSessionRecord, SessionCatalog } from '../runtime/sessionCatalog.js';
import type { EventStore, PlatformEvent, PlatformEventInput } from '../runtime/types.js';

export class MemorySessionCatalog implements SessionCatalog {
  private readonly sessions: RuntimeSessionRecord[];

  constructor(session: RuntimeSessionRecord | RuntimeSessionRecord[]) {
    this.sessions = Array.isArray(session) ? session : [session];
  }
  async upsert(): Promise<void> {}
  async ensure(): Promise<void> {}
  async get(sessionId: string): Promise<RuntimeSessionRecord | null> {
    return this.sessions.find((session) => session.sessionId === sessionId) ?? null;
  }
  async markStatus(): Promise<void> {}
  async findTranscriptPath(sessionId: string): Promise<string | null> {
    return this.sessions.find((session) => session.sessionId === sessionId)?.transcriptPath ?? null;
  }
}

export class MemoryEventStore implements EventStore {
  events: PlatformEvent[] = [];
  private readonly eventsByTenant = new Map<string, PlatformEvent[]>();
  appendContexts: Array<Parameters<EventStore['append']>[1]> = [];
  async append(event: PlatformEventInput, ctx: Parameters<EventStore['append']>[1]): Promise<PlatformEvent> {
    const full = { ...event, id: `e${this.events.length + 1}`, timestamp: new Date().toISOString() } as PlatformEvent;
    this.appendContexts.push(ctx);
    this.events.push(full);
    const tenantEvents = this.eventsByTenant.get(ctx.tenantId) ?? [];
    tenantEvents.push(full);
    this.eventsByTenant.set(ctx.tenantId, tenantEvents);
    return full;
  }
  async list(tenantId: string, sessionId: string, options?: Parameters<EventStore['list']>[2]): Promise<PlatformEvent[]> {
    const includedTypes = options?.includeTypes ? new Set(options.includeTypes) : null;
    return (this.eventsByTenant.get(tenantId) ?? []).filter((event) => (
      (!('sessionId' in event) || event.sessionId === sessionId)
      && (!includedTypes || includedTypes.has(event.type))
    ));
  }
}
