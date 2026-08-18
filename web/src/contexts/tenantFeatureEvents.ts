import type { TenantFeatureFlags, WsEnvelope, WsEvent } from "@agent/shared";

export interface TenantFeatureUpdate {
  tenantId: string;
  tenantFeatures: TenantFeatureFlags;
  debugMode: boolean;
}

export function tenantFeatureUpdatesFromEnvelope(
  envelope: Pick<WsEnvelope, "data">,
  tenantId: string | undefined,
): TenantFeatureUpdate[] {
  const data = envelope.data as WsEvent;
  const events: WsEvent[] = [data];
  if (data.type === "sync_ok") {
    events.push(...data.events.map(item => item.event as WsEvent));
  }
  return events.flatMap(event => (
    event.type === "tenant_features_changed" && event.tenantId === tenantId
      ? [{ tenantId: event.tenantId, tenantFeatures: event.tenantFeatures, debugMode: event.debugMode }]
      : []
  ));
}
