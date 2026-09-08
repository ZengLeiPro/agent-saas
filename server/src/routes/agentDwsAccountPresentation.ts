import {
  failClosedAgentDwsContextPolicy,
  type AgentDwsAccountRecord,
  type AgentDwsContextPolicy,
} from '../data/agentDwsAccounts/index.js';
import type { DwsDeliveryIntent } from '../data/orgGroupAgents/index.js';
import type { DwsAuthSessionRecord } from '../dws/authStore.js';

export function toPublicAccountDelivery(delivery: DwsDeliveryIntent): Record<string, unknown> {
  return {
    deliveryId: delivery.deliveryId,
    inboxId: delivery.inboxId ?? null,
    conversationId: delivery.conversationId,
    channelKind: delivery.destination.kind,
    deliveryKind: delivery.deliveryKind,
    deliveryState: delivery.deliveryState,
    disposition: delivery.disposition,
    attempt: delivery.attempt,
    providerAttemptPhase: delivery.providerAttemptPhase,
    createdAt: delivery.createdAt,
    updatedAt: delivery.updatedAt,
    completedAt: delivery.completedAt ?? null,
  };
}

export function withRealtimeConsentTimestamps(
  policy: AgentDwsContextPolicy,
  previous: AgentDwsContextPolicy | undefined,
  now = new Date().toISOString(),
): AgentDwsContextPolicy {
  const previousPolicy = previous ?? failClosedAgentDwsContextPolicy();
  const previousMarkers = previousPolicy.realtimeEffectiveAt;
  if (policy.realtime.mode === 'none') return { ...policy, realtimeEffectiveAt: {} };
  if (policy.realtime.mode === 'all') {
    const alreadyAllowed = previousPolicy.realtime.mode === 'all';
    return {
      ...policy,
      realtimeEffectiveAt: {
        all: alreadyAllowed ? (previousMarkers?.all ?? previousPolicy.effectiveAt ?? now) : now,
      },
    };
  }
  const conversations: Record<string, string> = {};
  for (const conversationId of policy.realtime.conversationIds) {
    const inherited =
      previousPolicy.realtime.mode === 'all'
        ? (previousMarkers?.all ?? previousPolicy.effectiveAt)
        : previousPolicy.realtime.mode === 'selected' &&
            previousPolicy.realtime.conversationIds.includes(conversationId)
          ? (previousMarkers?.conversations?.[conversationId] ?? previousPolicy.effectiveAt)
          : undefined;
    conversations[conversationId] = inherited ?? now;
  }
  return { ...policy, realtimeEffectiveAt: { conversations } };
}

export function contextPolicyAllowsConversation(
  account: AgentDwsAccountRecord,
  conversationId: string,
): boolean {
  const policy = account.contextPolicy ?? failClosedAgentDwsContextPolicy();
  const allows = (selection: AgentDwsContextPolicy['realtime']) =>
    selection.mode === 'all' ||
    (selection.mode === 'selected' && selection.conversationIds.includes(conversationId));
  return allows(policy.historical) || allows(policy.realtime);
}

export function toPublicAuthSession(row: DwsAuthSessionRecord): Record<string, unknown> {
  const expired =
    Date.parse(row.expiresAt) <= Date.now() &&
    (row.status === 'starting' || row.status === 'awaiting_user');
  const status = expired ? 'expired' : row.status;
  return {
    sessionId: row.sessionId,
    status,
    authorizationUrl: status === 'awaiting_user' ? (row.authorizationUrl ?? null) : null,
    userCode: status === 'awaiting_user' ? (row.userCode ?? null) : null,
    expiresAt: row.expiresAt,
    message: authMessage(status, row.errorMessage),
  };
}

function authMessage(status: string, error?: string): string {
  if (status === 'starting') return '正在生成 Agent 专属钉钉账号授权页面';
  if (status === 'awaiting_user') return '请用 Agent 专属钉钉账号确认授权';
  if (status === 'connected') return 'Agent 钉钉账号已连接，Personal Stream 将自动启动';
  if (status === 'expired') return '授权码已过期，请重新授权';
  return error || '钉钉授权未完成，请重试';
}
