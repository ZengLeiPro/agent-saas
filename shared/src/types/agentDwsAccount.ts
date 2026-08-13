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
