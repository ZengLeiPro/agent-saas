export type ConnectorDefinitionStatus = 'draft' | 'published' | 'disabled' | 'retired';

export interface ConnectorDefinition {
  connectorId: string;
  name: string;
  status: ConnectorDefinitionStatus;
  currentVersionId?: string;
  authMethods: string[];
  capabilitySchema: Record<string, unknown>;
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface ConnectorDefinitionVersion {
  versionId: string;
  connectorId: string;
  versionNumber: number;
  definition: Record<string, unknown>;
  digest: string;
  publishedAt: string;
  publishedBy: string;
}

export interface PublishConnectorDefinitionInput {
  connectorId: string;
  name: string;
  authMethods: string[];
  capabilitySchema: Record<string, unknown>;
  definition: Record<string, unknown>;
  publishedBy: string;
}

export type ConnectorCatalogInvariantCode =
  | 'CONNECTOR_NOT_FOUND'
  | 'CONNECTOR_RETIRED'
  | 'CONNECTOR_VERSION_CONFLICT'
  | 'CONNECTOR_DEFINITION_INVALID';

export class ConnectorCatalogInvariantError extends Error {
  constructor(readonly code: ConnectorCatalogInvariantCode) {
    super(code);
    this.name = 'ConnectorCatalogInvariantError';
  }
}

export interface BuiltinConnectorDefinition {
  connectorId: string;
  name: string;
  authMethods: string[];
  capabilitySchema: Record<string, unknown>;
  definition: Record<string, unknown>;
}
