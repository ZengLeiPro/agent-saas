export type ManagedAgentKind = 'org_agent' | 'personal_agent' | 'agent_template';
export type ManagedAgentStatus = 'draft' | 'enabled' | 'disabled' | 'archived';

export interface ManagedAgentResource {
  agentId: string;
  tenantId: string;
  kind: ManagedAgentKind;
  ownerUserId: string;
  templateId?: string;
  status: ManagedAgentStatus;
  currentVersionId?: string;
  revision: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  archivedAt?: string;
  archivedBy?: string;
}

export interface ManagedAgentVersion {
  versionId: string;
  agentId: string;
  versionNumber: number;
  definition: Record<string, unknown>;
  digest: string;
  publishedAt: string;
  publishedBy: string;
}

export interface CreateManagedAgentInput {
  agentId?: string;
  tenantId: string;
  kind: ManagedAgentKind;
  ownerUserId: string;
  templateId?: string;
  createdBy: string;
}

export interface PublishManagedAgentVersionInput {
  tenantId: string;
  agentId: string;
  expectedRevision: number;
  definition: Record<string, unknown>;
  publishedBy: string;
}

export type AgentResourceInvariantCode =
  | 'AGENT_RESOURCE_INVALID'
  | 'AGENT_RESOURCE_NOT_FOUND'
  | 'AGENT_RESOURCE_VERSION_CONFLICT'
  | 'AGENT_RESOURCE_INVALID_TRANSITION'
  | 'AGENT_RESOURCE_ARCHIVED'
  | 'AGENT_DEFINITION_SENSITIVE';

export class AgentResourceInvariantError extends Error {
  constructor(readonly code: AgentResourceInvariantCode) {
    super(code);
    this.name = 'AgentResourceInvariantError';
  }
}
