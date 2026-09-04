import {
  failClosedAgentDwsContextPolicy,
  type AgentDwsAccountRecord,
} from '../data/agentDwsAccounts/index.js';
import type { AgentDwsInboxRecord, AgentDwsMessageStore } from '../data/agentDwsMessages/index.js';
import {
  bindingMatchesCurrentAccountIdentity,
  currentAgentDwsAccountIdentity,
  inboxMatchesCurrentAccountIdentity,
} from '../dws/agentDwsAccountIdentity.js';
import type {
  OrgAgentChannelBinding,
  OrgGroupAgentStore,
} from '../data/orgGroupAgents/index.js';
import { deriveAgentWorkspaceId } from '../runtime/workspaceIdentity.js';

export function observedGroupOptions(
  inbox: AgentDwsInboxRecord[],
  bindings: OrgAgentChannelBinding[],
  account: AgentDwsAccountRecord,
): Array<{ conversationId: string; lastEventAt: string; bindingId: string | null }> {
  const bindingByConversation = new Map(bindings.map(binding => [
    binding.conversationId,
    binding.bindingId,
  ]));
  const observed = new Map<string, string>();
  for (const item of inbox) {
    if (item.eventType !== 'user_im_message_receive_at'
      || !inboxMatchesCurrentAccountIdentity(item, account)
      || observed.has(item.conversationId)) continue;
    observed.set(item.conversationId, item.eventTimestamp ?? item.createdAt);
  }
  return [...observed].map(([conversationId, lastEventAt]) => ({
    conversationId,
    lastEventAt,
    bindingId: bindingByConversation.get(conversationId) ?? null,
  }));
}

/** Bindings from an earlier authenticated DingTalk identity never enter the current workspace. */
export function currentIdentityBindings(
  bindings: OrgAgentChannelBinding[],
  account: AgentDwsAccountRecord,
): OrgAgentChannelBinding[] {
  return bindings.filter((binding) => bindingMatchesCurrentAccountIdentity(binding, account));
}

export async function hasObservedGroup(
  messageStore: Partial<Pick<AgentDwsMessageStore, 'hasObservedGroup'>>,
  account: AgentDwsAccountRecord,
  conversationId: string,
): Promise<boolean> {
  const identity = currentAgentDwsAccountIdentity(account);
  if (!messageStore.hasObservedGroup || !identity) return false;
  return await messageStore.hasObservedGroup(
    account.tenantId, account.accountId, conversationId, identity,
  );
}

export async function hasStaleIdentityBinding(
  store: OrgGroupAgentStore,
  account: AgentDwsAccountRecord,
  conversationId: string,
): Promise<boolean> {
  const existing = await store.getBinding(account.tenantId, account.accountId, conversationId);
  return Boolean(existing && !bindingMatchesCurrentAccountIdentity(existing, account));
}

/** 只有当前精确账号身份观测到的 conversationId 才能创建 shadow binding。 */
export async function ensureObservedGroupBinding(
  store: OrgGroupAgentStore,
  account: AgentDwsAccountRecord,
  conversationId: string,
): Promise<OrgAgentChannelBinding> {
  const accountIdentity = currentAgentDwsAccountIdentity(account);
  if (!accountIdentity) throw new Error('ORG_AGENT_BINDING_ACCOUNT_IDENTITY_UNAVAILABLE');
  return await store.ensureShadowBinding({
    tenantId: account.tenantId,
    accountId: account.accountId,
    agentId: account.agentId,
    conversationId,
    channelKind: 'group',
    workspaceId: deriveAgentWorkspaceId(account.tenantId, account.agentId),
    accountIdentity,
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

/** 诊断视图不暴露正文，但必须公开回复类型、业务终态与稳定原因码。 */
export function toPublicInboxRecord(record: AgentDwsInboxRecord): Record<string, unknown> {
  return {
    inboxId: record.inboxId,
    eventId: record.eventId,
    eventType: record.eventType,
    conversationId: record.conversationId,
    messageId: record.messageId ?? null,
    state: record.state,
    replyKind: record.replyKind ?? null,
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
