export type AgentDwsAccountStatus =
  | "draft"
  | "authorizing"
  | "active"
  | "paused"
  | "error";

export type AgentDwsRuntimeStatus =
  | "stopped"
  | "starting"
  | "ready"
  | "error";

export type AgentDwsEventKind = "at_me" | "all_direct";
export type AgentDwsContextPolicyMode = "none" | "selected" | "all";

export interface AgentDwsContextPolicySelection {
  mode: AgentDwsContextPolicyMode;
  conversationIds: string[];
}

export interface AgentDwsContextPolicy {
  historical: AgentDwsContextPolicySelection & { lookbackDays: number };
  realtime: AgentDwsContextPolicySelection;
  wiki: { enabled: boolean };
  minutes: { enabled: boolean; lookbackDays: number };
  realtimeEffectiveAt?: { all?: string; conversations?: Record<string, string> };
  effectiveAt?: string;
}

export interface AgentDwsAccount {
  accountId: string;
  tenantId: string;
  agentId: string;
  displayName: string;
  loginIdMasked: string;
  corpId: string | null;
  corpName: string | null;
  dingtalkUserId: string | null;
  dingtalkUserName: string | null;
  profileId: string | null;
  status: AgentDwsAccountStatus;
  runtimeStatus: AgentDwsRuntimeStatus;
  eventKinds: AgentDwsEventKind[];
  contextPolicy: AgentDwsContextPolicy;
  lastEventAt: string | null;
  lastError: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentDwsAuthSession {
  sessionId: string;
  status: "starting" | "awaiting_user" | "connected" | "failed" | "expired";
  authorizationUrl: string | null;
  userCode: string | null;
  expiresAt: string;
  message: string;
}

export interface CreateAgentDwsAccountInput {
  tenantId?: string;
  agentId: string;
  displayName: string;
  loginId: string;
  corpId?: string;
  eventKinds?: AgentDwsEventKind[];
}

export interface UpdateAgentDwsAccountInput {
  expectedRevision: number;
  enabled: boolean;
}

export interface UpdateAgentDwsContextPolicyInput extends AgentDwsContextPolicy {
  expectedRevision: number;
}
