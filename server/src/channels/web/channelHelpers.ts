import { isPlatformAdmin } from '../../auth/types.js';
import { findTranscriptOrMetaPathBySessionId } from '../../data/transcripts/index.js';
import { readSessionMeta } from '../../data/transcripts/meta.js';
import type { TenantStore } from '../../data/tenants/store.js';
import type { ChannelContext, ContextUsageData } from '../../types/index.js';
import type { WebChannelRuntimeConfig } from './channelConfig.js';
import type { WsClient } from './wsServer.js';

export async function isWebSessionDeleted(
  config: Pick<WebChannelRuntimeConfig, 'enqueueRuntime'> & { agentCwd?: string },
  sessionId: string,
): Promise<boolean> {
  const runtime = config.enqueueRuntime?.enabled === false ? undefined : config.enqueueRuntime;
  if ((runtime ? await runtime.sessionCatalog.get(sessionId).catch(() => null) : null)?.deletedAt) return true;
  const path = config.agentCwd ? await findTranscriptOrMetaPathBySessionId(sessionId) : null;
  return Boolean(path && (await readSessionMeta(path))?.deletedAt);
}

/** 活动日志只保留操作元数据，禁止写入消息正文或摘要。 */
export function buildChatMessageActivityDetail(
  sessionId: string | undefined,
  attachmentCount: number,
  voiceDurationMs?: number,
): string {
  const parts = [
    `session=${sessionId || 'new'}`,
    `attachments=${attachmentCount}`,
  ];
  if (voiceDurationMs !== undefined) parts.push(`voice=${voiceDurationMs}ms`);
  return parts.join(' | ');
}

export function canViewContextUsageDetails(
  context: ChannelContext,
  tenantStore: TenantStore | undefined,
): boolean {
  return canViewContextUsageDetailsForUser(context.user, tenantStore);
}

export function canViewContextUsageDetailsForUser(
  user: { tenantId?: string } | undefined,
  tenantStore: TenantStore | undefined,
): boolean {
  if (!user?.tenantId) return false;
  const settings = tenantStore?.getSettings(user.tenantId);
  return settings?.models.showContextTokens !== false
    && settings?.models.allowContextTokenDetails === true;
}

/** WsUser（tenantId 可选）适配 auth/types 的 isPlatformAdmin（JwtPayload tenantId 必选）。 */
export function isPlatformAdminUser(user: WsClient['user']): boolean {
  if (!user?.tenantId) return false;
  return isPlatformAdmin({
    sub: user.sub,
    username: user.username,
    role: user.role,
    tenantId: user.tenantId,
  });
}

export function redactContextUsageDetails(usage: ContextUsageData): ContextUsageData {
  return {
    ...usage,
    categories: [],
    breakdown: undefined,
    usageTotals: undefined,
    memoryFiles: [],
    mcpTools: [],
  };
}
