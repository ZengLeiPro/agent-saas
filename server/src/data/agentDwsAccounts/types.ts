export type AgentDwsAccountStatus = 'draft' | 'authorizing' | 'active' | 'paused' | 'error';
export type AgentDwsRuntimeStatus = 'stopped' | 'starting' | 'ready' | 'error';
export type AgentDwsEventKind = 'at_me' | 'all_direct';
export type AgentDwsContextPolicyMode = 'none' | 'selected' | 'all';

export const AGENT_DWS_CONTEXT_POLICY_MAX_CONVERSATIONS = 100;
export const AGENT_DWS_CONTEXT_POLICY_MAX_LOOKBACK_DAYS = 365;

export interface AgentDwsContextPolicySelection {
  mode: AgentDwsContextPolicyMode;
  conversationIds: string[];
}

export interface AgentDwsHistoricalContextPolicy extends AgentDwsContextPolicySelection {
  lookbackDays: number;
}

export interface AgentDwsContextPolicy {
  historical: AgentDwsHistoricalContextPolicy;
  realtime: AgentDwsContextPolicySelection;
  wiki?: { enabled: boolean };
  minutes?: { enabled: boolean; lookbackDays: number };
  /** Per-scope consent timestamps prevent scope changes from creating hidden backfill. */
  realtimeEffectiveAt?: { all?: string; conversations?: Record<string, string> };
  /** Legacy lower bound retained for compatibility with already persisted rows. */
  effectiveAt?: string;
}

/** Legacy/malformed rows must never implicitly grant chat learning or listening. */
export function failClosedAgentDwsContextPolicy(): AgentDwsContextPolicy {
  return {
    historical: { mode: 'none', conversationIds: [], lookbackDays: 30 },
    realtime: { mode: 'none', conversationIds: [] },
    wiki: { enabled: false },
    minutes: { enabled: false, lookbackDays: 30 },
  };
}

export interface AgentDwsAccountRecord {
  accountId: string;
  tenantId: string;
  agentId: string;
  displayName: string;
  loginId: string;
  corpId?: string;
  corpName?: string;
  dingtalkUserId?: string;
  dingtalkUserName?: string;
  profileId?: string;
  status: AgentDwsAccountStatus;
  runtimeStatus: AgentDwsRuntimeStatus;
  eventKinds: AgentDwsEventKind[];
  /** Optional only for compatibility with callers holding a pre-policy snapshot. */
  contextPolicy?: AgentDwsContextPolicy;
  lastEventAt?: string;
  lastError?: string;
  revision: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface CreateAgentDwsAccountInput {
  tenantId: string;
  agentId: string;
  displayName: string;
  loginId: string;
  corpId?: string;
  eventKinds: AgentDwsEventKind[];
  createdBy: string;
}

export interface AgentDwsAuthorizedProfile {
  profileId: string;
  corpName?: string;
  dingtalkUserId?: string;
  dingtalkUserName?: string;
}

export type AgentDwsAccountInvariantCode =
  | 'AGENT_DWS_ACCOUNT_NOT_FOUND'
  | 'AGENT_DWS_ACCOUNT_CONFLICT'
  | 'AGENT_DWS_ACCOUNT_REVISION_CONFLICT'
  | 'AGENT_DWS_ACCOUNT_AGENT_INVALID'
  | 'AGENT_DWS_ACCOUNT_NOT_AUTHORIZED';

export class AgentDwsAccountInvariantError extends Error {
  constructor(readonly code: AgentDwsAccountInvariantCode) {
    super(code);
    this.name = 'AgentDwsAccountInvariantError';
  }
}
