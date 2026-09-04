import type { ChannelContext } from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import type { RuntimeSessionRecord } from './sessionCatalog.js';

const logger = createLogger('RawRuntimeRunDispatch');

export interface RuntimeSessionOwnerResolverConfig {
  resolveUserRole?: (input: { userId?: string; username?: string }) => 'admin' | 'user' | undefined;
  resolveUserRealName?: (input: { userId?: string; username?: string }) => string | undefined;
  resolveUserTenantId?: (input: { userId?: string; username?: string }) => string | undefined;
}

/** Rebuild the pinned account or Agent identity for scheduler wake/resume paths. */
export function resolveWakeSessionOwner(
  config: RuntimeSessionOwnerResolverConfig,
  session: RuntimeSessionRecord,
  fallbackUserId?: string,
  fallbackTenantId?: string,
): NonNullable<ChannelContext['sessionOwner']> {
  const userId = session.userId || fallbackUserId || '';
  const realName = config.resolveUserRealName?.({
    userId: userId || undefined,
    username: session.username || undefined,
  });
  const agentPrincipal = session.principal?.kind === 'org_agent' ? session.principal : undefined;
  const legacyDwsServiceIdentity = Boolean(
    session.orgAgentId &&
    userId.startsWith('adws-') &&
    session.username === `agent-dws:${session.orgAgentId}`,
  );
  return {
    id: userId,
    username: session.username || 'unknown',
    role:
      session.userRole ??
      config.resolveUserRole?.({ userId: session.userId, username: session.username }) ??
      'user',
    tenantId:
      agentPrincipal?.tenantId ??
      (legacyDwsServiceIdentity ? fallbackTenantId : resolveSessionOwnerTenantId(config, session)),
    ...(realName ? { realName } : {}),
  };
}

/**
 * Missing resolver values and exceptions deliberately return undefined. Downstream authorization
 * then fails closed instead of silently assigning a deleted user to the default tenant.
 */
export function resolveSessionOwnerTenantId(
  config: RuntimeSessionOwnerResolverConfig,
  session: RuntimeSessionRecord,
): string | undefined {
  if (!config.resolveUserTenantId) return undefined;
  try {
    return config.resolveUserTenantId({ userId: session.userId, username: session.username });
  } catch (error) {
    logger.warn('resolveUserTenantId 抛错（fail-safe 降级为 undefined）', {
      sessionId: session.sessionId,
      userId: session.userId,
      username: session.username,
      err: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
