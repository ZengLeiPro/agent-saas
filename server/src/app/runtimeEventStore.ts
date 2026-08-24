import { FileEventStore, getRuntimeEventLogPath } from '../runtime/fileEventStore.js';
import type { PgEventStore } from '../runtime/pgEventStore.js';
import type { EventAppendContext, EventStore, PlatformEventInput } from '../runtime/types.js';

export function createRuntimeEventStoreFactory(
  pgEventStore: PgEventStore | undefined,
): (transcriptPath: string, tenantId: string) => EventStore {
  return pgEventStore
    ? (_transcriptPath, _tenantId) => pgEventStore
    : (transcriptPath, tenantId) => new FileEventStore(getRuntimeEventLogPath(transcriptPath), tenantId);
}

export function appendTenantPlatformEvent(
  eventStore: EventStore,
  event: PlatformEventInput,
  ctx: EventAppendContext | undefined,
): ReturnType<EventStore['append']> {
  if (!ctx?.tenantId) throw new Error(`PG platform event tenant is missing for session ${event.sessionId}`);
  return eventStore.append(event, ctx);
}
