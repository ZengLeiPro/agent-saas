import {
  failClosedAgentDwsContextPolicy,
  type AgentDwsAccountRecord,
} from '../data/agentDwsAccounts/index.js';
import type { AgentDwsInboxRecord, AgentDwsMessageStore } from '../data/agentDwsMessages/index.js';
import type {
  OrgAgentChannelBinding,
  OrgGroupAgentStore,
} from '../data/orgGroupAgents/index.js';
import { deriveAgentWorkspaceId } from '../runtime/workspaceIdentity.js';

export function observedGroupOptions(
  inbox: AgentDwsInboxRecord[],
  bindings: OrgAgentChannelBinding[],
): Array<{ conversationId: string; lastEventAt: string; bindingId: string | null }> {
  const bindingByConversation = new Map(bindings.map(binding => [
    binding.conversationId,
    binding.bindingId,
  ]));
  const observed = new Map<string, string>();
  for (const item of inbox) {
    if (item.eventType !== 'user_im_message_receive_at' || observed.has(item.conversationId)) continue;
    observed.set(item.conversationId, item.eventTimestamp ?? item.createdAt);
  }
  return [...observed].map(([conversationId, lastEventAt]) => ({
    conversationId,
    lastEventAt,
    bindingId: bindingByConversation.get(conversationId) ?? null,
  }));
}

export async function hasObservedGroup(
  messageStore: Partial<Pick<AgentDwsMessageStore, 'hasObservedGroup'>>,
  tenantId: string,
  accountId: string,
  conversationId: string,
): Promise<boolean> {
  if (!messageStore.hasObservedGroup) return false;
  return await messageStore.hasObservedGroup(tenantId, accountId, conversationId);
}

/** 只有服务端按 conversationId 精确确认已观测到的群，才允许管理员创建 shadow binding。 */
export async function ensureObservedGroupBinding(
  store: OrgGroupAgentStore,
  account: AgentDwsAccountRecord,
  conversationId: string,
): Promise<OrgAgentChannelBinding> {
  return await store.ensureShadowBinding({
    tenantId: account.tenantId,
    accountId: account.accountId,
    agentId: account.agentId,
    conversationId,
    channelKind: 'group',
    workspaceId: deriveAgentWorkspaceId(account.tenantId, account.agentId),
  });
}

export function toPublicAccount(account: AgentDwsAccountRecord): Record<string, unknown> {
  return {
    accountId: account.accountId,
    tenantId: account.tenantId,
    agentId: account.agentId,
    displayName: account.displayName,
    loginIdMasked: maskLoginId(account.loginId),
    corpId: account.corpId ?? null,
    corpName: account.corpName ?? null,
    dingtalkUserId: account.dingtalkUserId ?? null,
    dingtalkUserName: account.dingtalkUserName ?? null,
    profileId: account.profileId ?? null,
    status: account.status,
    runtimeStatus: account.runtimeStatus,
    eventKinds: account.eventKinds,
    contextPolicy: account.contextPolicy ?? failClosedAgentDwsContextPolicy(),
    lastEventAt: account.lastEventAt ?? null,
    lastError: account.lastError ?? null,
    revision: account.revision,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

function maskLoginId(value: string): string {
  if (value.length <= 4) return `${value.slice(0, 1)}***`;
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

/** 诊断视图不暴露正文，但必须暴露可查询的业务终态与稳定原因码。 */
export function toPublicInboxRecord(record: AgentDwsInboxRecord): Record<string, unknown> {
  return {
    inboxId: record.inboxId,
    eventId: record.eventId,
    eventType: record.eventType,
    conversationId: record.conversationId,
    messageId: record.messageId ?? null,
    state: record.state,
    disposition: record.disposition ?? null,
    rejectionReasonCode: record.rejectionReasonCode ?? null,
    sessionId: record.sessionId ?? null,
    runId: record.runId ?? null,
    attempt: record.attempt,
    maxAttempts: record.maxAttempts,
    nextAttemptAt: record.nextAttemptAt ?? null,
    lastError: record.lastError ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt ?? null,
  };
}
