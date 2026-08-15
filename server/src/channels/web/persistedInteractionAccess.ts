import type { SessionMeta } from '../../data/transcripts/meta.js';
import type { TenantStore } from '../../data/tenants/store.js';
import { tenantAccessErrorMessage } from '../../data/tenants/access.js';
import type { RunRecord } from '../../runtime/runStore.js';
import type { WsClient } from './wsServer.js';
import { isPlatformAdminUser } from './channelHelpers.js';

interface PersistedInteractionAccessInput {
  sessionId: string;
  user: WsClient['user'];
  meta?: SessionMeta;
  sourceRun: RunRecord | null;
  tenantStore?: TenantStore;
  orgAgentAccessError: (
    orgAgentId?: string,
    tenantId?: string,
    username?: string,
  ) => string | null | undefined;
}

export function persistedInteractionAccessError(input: PersistedInteractionAccessInput): string | undefined {
  if (input.sourceRun?.sessionId !== undefined && input.sourceRun.sessionId !== input.sessionId) return 'Access denied';
  if (input.sourceRun && input.meta && (
    (input.sourceRun.tenantId && input.meta.tenantId && input.sourceRun.tenantId !== input.meta.tenantId)
    || (input.sourceRun.userId && input.meta.userId && input.sourceRun.userId !== input.meta.userId)
  )) return 'Access denied';

  const targetTenantId = input.sourceRun?.tenantId ?? input.meta?.tenantId ?? undefined;
  const tenantError = tenantAccessErrorMessage(input.tenantStore, targetTenantId);
  if (tenantError) return tenantError;

  if (input.user?.role !== 'admin') {
    const ownerUserId = input.sourceRun?.userId ?? input.meta?.userId;
    if (!ownerUserId || ownerUserId !== input.user?.sub) return 'Access denied';
    if (targetTenantId && input.user?.tenantId !== targetTenantId) return 'Access denied';
  } else if (
    input.user
    && !isPlatformAdminUser(input.user)
    && (!targetTenantId || targetTenantId !== input.user.tenantId)
  ) {
    return 'Access denied';
  }

  const orgAgentId = typeof input.sourceRun?.metadata?.orgAgentId === 'string'
    ? input.sourceRun.metadata.orgAgentId
    : input.meta?.orgAgentId ?? undefined;
  return input.orgAgentAccessError(orgAgentId, targetTenantId, input.meta?.username ?? undefined) ?? undefined;
}
