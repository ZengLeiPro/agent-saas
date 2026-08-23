import type { UserStore } from '../../data/users/store.js';
import { isPlatformAdminUser } from './channelHelpers.js';
import type { WsClient, WsServer } from './wsServer.js';

export interface SensitiveActionTarget {
  tenantId?: string;
  ownerUserId?: string;
  ownerOnly?: boolean;
}

export function sensitiveActionAccessError(
  client: WsClient,
  target: SensitiveActionTarget,
  wsServer: WsServer | undefined,
  userStore: UserStore | undefined,
): string | null {
  if (wsServer && !wsServer.refreshAuthoritativeUser(client)) return 'Access denied';
  const actor = client.user;
  if (!actor) return 'Access denied';
  const isPlatformAdmin = isPlatformAdminUser(actor);
  const owner = target.ownerUserId ? userStore?.findById(target.ownerUserId) : undefined;
  const targetTenantId = target.tenantId ?? owner?.tenantId;
  if (target.ownerUserId && userStore && (!owner || owner.disabled)) return 'Access denied';
  if (target.tenantId && owner && owner.tenantId !== target.tenantId) return 'Access denied';
  if (targetTenantId && !isPlatformAdmin && actor.tenantId !== targetTenantId) return 'Access denied';
  if (target.ownerUserId && !isPlatformAdmin) {
    if (target.ownerOnly && actor.sub !== target.ownerUserId) return 'Access denied';
    if (actor.role !== 'admin' && actor.sub !== target.ownerUserId) return 'Access denied';
  }
  return null;
}
