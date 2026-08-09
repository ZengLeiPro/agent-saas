export type ExecutionProviderStatus = 'enabled' | 'draining' | 'disabled';
export type EnvironmentTemplateStatus = 'draft' | 'published' | 'retired';

export interface ExecutionProvider {
  providerId: string;
  status: ExecutionProviderStatus;
  endpointRef: string;
  networkPolicy: Record<string, unknown>;
  infrastructureCredentialId?: string;
  rolloutPolicy: Record<string, unknown>;
  revision: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface EnvironmentRecipe {
  packages: string[];
  envKeys: string[];
  setupCommands: string[];
  resources: {
    cpu?: string;
    memoryMb?: number;
    diskMb?: number;
    timeoutMs?: number;
  };
}

export interface EnvironmentTemplate {
  templateId: string;
  name: string;
  status: EnvironmentTemplateStatus;
  currentVersionId?: string;
  revision: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface EnvironmentTemplateVersion {
  versionId: string;
  templateId: string;
  versionNumber: number;
  recipe: EnvironmentRecipe;
  digest: string;
  publishedAt: string;
  publishedBy: string;
}

export interface UpsertExecutionProviderInput {
  providerId: string;
  status: ExecutionProviderStatus;
  endpointRef: string;
  networkPolicy?: Record<string, unknown>;
  infrastructureCredentialId?: string;
  rolloutPolicy?: Record<string, unknown>;
  expectedRevision?: number;
  updatedBy: string;
}

export interface PublishEnvironmentTemplateInput {
  templateId: string;
  name: string;
  recipe: EnvironmentRecipe;
  publishedBy: string;
}

export type EnvironmentInvariantCode =
  | 'EXECUTION_PROVIDER_NOT_FOUND'
  | 'EXECUTION_PROVIDER_VERSION_CONFLICT'
  | 'EXECUTION_PROVIDER_INVALID'
  | 'ENVIRONMENT_TEMPLATE_NOT_FOUND'
  | 'ENVIRONMENT_TEMPLATE_RETIRED'
  | 'ENVIRONMENT_TEMPLATE_VERSION_CONFLICT'
  | 'ENVIRONMENT_RECIPE_INVALID'
  | 'ENVIRONMENT_RECIPE_SENSITIVE';

export class EnvironmentInvariantError extends Error {
  constructor(readonly code: EnvironmentInvariantCode) {
    super(code);
    this.name = 'EnvironmentInvariantError';
  }
}
