export type AgentDwsAccountStatus = 'draft' | 'authorizing' | 'active' | 'paused' | 'error';
export type AgentDwsRuntimeStatus = 'stopped' | 'starting' | 'ready' | 'error';
export type AgentDwsEventKind = 'at_me' | 'all_direct';

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
