export interface ResourceReference {
  referenceId: string;
  tenantId?: string;
  sourceType: string;
  sourceId: string;
  sourceVersion?: string;
  targetType: string;
  targetId: string;
  targetVersion?: string;
  relation: string;
  createdAt: string;
  createdBy: string;
}

export interface ResourceReferenceInput {
  tenantId?: string;
  targetType: string;
  targetId: string;
  targetVersion?: string;
  relation: string;
}

export interface ReplaceResourceReferencesInput {
  sourceType: string;
  sourceId: string;
  sourceVersion?: string;
  references: ResourceReferenceInput[];
  updatedBy: string;
}

export interface ResourceRetirementImpact {
  targetType: string;
  targetId: string;
  hardDeleteAllowed: boolean;
  referenceCount: number;
  references: ResourceReference[];
}

export class ResourceReferenceInvariantError extends Error {
  constructor(readonly code: 'RESOURCE_REFERENCE_INVALID' | 'RESOURCE_HARD_DELETE_BLOCKED') {
    super(code);
    this.name = 'ResourceReferenceInvariantError';
  }
}
