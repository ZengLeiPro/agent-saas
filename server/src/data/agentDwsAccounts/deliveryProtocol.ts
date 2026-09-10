export type DwsDeliveryProtocol = 'legacy' | 'handoff_pending' | 'durable-v1' | 'unsupported';
export interface DwsRunnableSelection {
  deliveryProtocol?: 'legacy' | 'durable-v1' | 'all';
  /** Identity-cleanup recovery is not a listener and may inspect blocked accounts. */
  includeIdentityCleanup?: boolean;
}

export function readDwsDeliveryProtocol(rawPolicy: unknown): DwsDeliveryProtocol {
  if (rawPolicy === null || rawPolicy === undefined) return 'legacy';
  if (typeof rawPolicy !== 'object' || Array.isArray(rawPolicy)) return 'unsupported';
  const policy = rawPolicy as Record<string, unknown>;
  if (!Object.hasOwn(policy, 'deliveryProtocol')) return 'legacy';
  return policy.deliveryProtocol === 'legacy' || policy.deliveryProtocol === 'handoff_pending' || policy.deliveryProtocol === 'durable-v1'
    ? policy.deliveryProtocol : 'unsupported';
}

export function canRunLegacyDwsListener(account: { deliveryProtocol?: string; identityCleanupPending?: unknown }): boolean {
  return (account.deliveryProtocol === undefined || account.deliveryProtocol === 'legacy') && !account.identityCleanupPending;
}

// A JSON null, malformed object or unknown future protocol is not legacy.
// This predicate also fences cached pre-migration snapshots at the authoritative UPDATE.
export const LEGACY_DWS_DELIVERY_SQL = `jsonb_typeof(COALESCE(event_policy_json,'{}'::jsonb))='object'
  AND (NOT (COALESCE(event_policy_json,'{}'::jsonb) ? 'deliveryProtocol')
    OR event_policy_json->>'deliveryProtocol'='legacy')`;

export function runnableDwsDeliverySql(selection: DwsRunnableSelection = {}): string {
  const protocol = selection.deliveryProtocol ?? 'legacy';
  const delivery = protocol === 'legacy' ? `(${LEGACY_DWS_DELIVERY_SQL})`
    : protocol === 'durable-v1' ? `(event_policy_json->>'deliveryProtocol'='durable-v1')`
    : protocol === 'all' ? `((${LEGACY_DWS_DELIVERY_SQL}) OR event_policy_json->>'deliveryProtocol' IN ('durable-v1','handoff_pending'))`
    : (() => { throw new Error('Unsupported DWS runnable selection'); })();
  return selection.includeIdentityCleanup === true ? delivery
    : `${delivery} AND NOT (COALESCE(event_policy_json,'{}'::jsonb) ? 'identityCleanupPending')`;
}
