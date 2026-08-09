export type CredentialSource = 'legacy_projection' | 'governance';
export type CredentialKind = 'org_shared' | 'personal_grant' | 'infrastructure';
export type CredentialStatus =
  | 'active'
  | 'rotation_due'
  | 'expired'
  | 'suspended'
  | 'revoked'
  | 'validation_failed';

export interface GovernanceCredential {
  credentialId: string;
  tenantId: string;
  connectorId?: string;
  kind: CredentialKind;
  ownerUserId?: string;
  custodianUserId?: string;
  ownerUsername?: string;
  alias?: string;
  purpose: string;
  scopeSummary: Record<string, unknown>;
  status: CredentialStatus;
  generation: number;
  /** 仅服务端字段；普通 DTO 与审计响应禁止返回。 */
  secretRef: string;
  expiresAt?: string;
  lastValidatedAt?: string;
  source: CredentialSource;
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface CredentialInput {
  tenantId: string;
  connectorId?: string;
  kind: CredentialKind;
  ownerUserId?: string;
  custodianUserId?: string;
  ownerUsername?: string;
  alias?: string;
  purpose: string;
  scopeSummary?: Record<string, unknown>;
  secretRef: string;
  expiresAt?: string;
  createdBy: string;
}

export interface CredentialStatusPatch {
  status: Exclude<CredentialStatus, 'active'>;
  expectedVersion: number;
  updatedBy: string;
  updateReason: string;
}

export type CredentialInvariantCode =
  | 'CREDENTIAL_NOT_FOUND'
  | 'CREDENTIAL_VERSION_CONFLICT'
  | 'CREDENTIAL_SECRET_REF_MISSING'
  | 'CREDENTIAL_SECRET_REF_CONFLICT'
  | 'CREDENTIAL_PERSONAL_OWNER_MISSING'
  | 'CREDENTIAL_ORG_CUSTODIAN_MISSING'
  | 'CREDENTIAL_PURPOSE_MISSING'
  | 'CREDENTIAL_KIND_INVALID'
  | 'CREDENTIAL_ALREADY_SUSPENDED'
  | 'CREDENTIAL_ALREADY_REVOKED'
  | 'CREDENTIAL_REVOKED_NO_REUSE'
  | 'CREDENTIAL_GENERATION_INVALID';

export class CredentialInvariantError extends Error {
  constructor(readonly code: CredentialInvariantCode) {
    super(code);
    this.name = 'CredentialInvariantError';
  }
}

export interface LegacyCredentialConnection {
  connectorId: string;
  username: string;
  userId?: string;
  tenantId: string;
  status: 'connected' | 'disconnected';
  credentialRefs: Record<string, string>;
  capabilities?: Record<string, boolean>;
}

export interface LegacyCredentialUser {
  id: string;
  username: string;
  tenantId: string;
}

export interface LegacyCredentialBackfillInput {
  users: LegacyCredentialUser[];
  connections: LegacyCredentialConnection[];
  platformTenantId: string;
  projectedBy: string;
}

export interface CredentialBackfillResult {
  credentialsProjected: number;
  issuesRecorded: number;
}
