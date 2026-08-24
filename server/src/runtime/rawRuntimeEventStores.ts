import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { EventBackedApprovalStore } from './approvalStore.js';
import { FileEventStore, getRuntimeEventLogPath } from './fileEventStore.js';
import type { RuntimeSessionRecord } from './sessionCatalog.js';
import type { ApprovalStore, EventStore } from './types.js';
import type { RawRuntimeRunDispatchConfig } from './rawRuntimeRunDispatchTypes.js';

export function resolveEventTenantId(
  config: RawRuntimeRunDispatchConfig,
  sessionTenantId: string | undefined,
  runTenantId?: string,
  scope = 'runtime session',
): string {
  const sessionTenant = sessionTenantId?.trim();
  const runTenant = runTenantId?.trim();
  if (sessionTenant && runTenant && sessionTenant !== runTenant) {
    throw new Error(`${scope} tenant mismatch`);
  }
  const tenantId = sessionTenant ?? runTenant;
  if (tenantId) return tenantId;
  // The fallback store is a per-session JSONL file. Its tenant binding is only a
  // compatibility label over an already physically isolated legacy path.
  if (!config.eventStoreFactory) return DEFAULT_TENANT_ID;
  throw new Error(`${scope} tenant is missing for shared EventStore`);
}

export function createEventStoreForSession(
  config: RawRuntimeRunDispatchConfig,
  session: RuntimeSessionRecord,
): EventStore {
  return config.eventStoreFactory
    ? config.eventStoreFactory(session)
    : new FileEventStore(
        getRuntimeEventLogPath(session.transcriptPath),
        resolveEventTenantId(config, session.tenantId, undefined, `session ${session.sessionId}`),
      );
}

export function createApprovalStoreForSession(
  config: RawRuntimeRunDispatchConfig,
  session: RuntimeSessionRecord,
  eventStore: EventStore,
): ApprovalStore {
  return config.approvalStoreFactory
    ? config.approvalStoreFactory(session, eventStore)
    : new EventBackedApprovalStore(
        eventStore,
        session.sessionId,
        resolveEventTenantId(config, session.tenantId, undefined, `approval session ${session.sessionId}`),
      );
}
