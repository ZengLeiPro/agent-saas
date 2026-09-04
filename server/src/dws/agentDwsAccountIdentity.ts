import {
  hasExactAgentDwsProfile,
  type AgentDwsAccountRecord,
} from '../data/agentDwsAccounts/index.js';
import type {
  AgentDwsCurrentAccountIdentity,
  AgentDwsInboxRecord,
} from '../data/agentDwsMessages/index.js';
import type { OrgAgentChannelBinding } from '../data/orgGroupAgents/index.js';

export function currentAgentDwsAccountIdentity(
  account: AgentDwsAccountRecord,
): AgentDwsCurrentAccountIdentity | undefined {
  if (!hasExactAgentDwsProfile(account) || !validTimestamp(account.identityUpdatedAt)) return undefined;
  return {
    profileId: account.profileId!,
    corpId: account.corpId!,
    dingtalkUserId: account.dingtalkUserId!,
    identityUpdatedAt: account.identityUpdatedAt!,
  };
}

export function inboxMatchesCurrentAccountIdentity(
  item: AgentDwsInboxRecord,
  account: AgentDwsAccountRecord,
): boolean {
  const current = currentAgentDwsAccountIdentity(account);
  const raw = item.payload.accountIdentity;
  if (!current || !raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const identity = raw as Record<string, unknown>;
  return identity.profileId === current.profileId
    && identity.corpId === current.corpId
    && identity.dingtalkUserId === current.dingtalkUserId
    && Date.parse(item.createdAt) >= Date.parse(current.identityUpdatedAt);
}

export function bindingMatchesCurrentAccountIdentity(
  binding: OrgAgentChannelBinding,
  account: AgentDwsAccountRecord,
): boolean {
  const current = currentAgentDwsAccountIdentity(account);
  const bound = binding.accountIdentity;
  return Boolean(current && bound
    && bound.profileId === current.profileId
    && bound.corpId === current.corpId
    && bound.dingtalkUserId === current.dingtalkUserId
    && Date.parse(bound.identityUpdatedAt) === Date.parse(current.identityUpdatedAt));
}

function validTimestamp(value?: string): value is string {
  return Boolean(value && Number.isFinite(Date.parse(value)));
}
