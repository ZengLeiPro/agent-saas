export type GovernanceMigrationMode = 'shadow' | 'enforce' | 'rollback';
export type GovernanceWriteAuthority = 'legacy' | 'dual' | 'governance';
export type GovernanceMigrationDomain =
  | 'membership'
  | 'entitlement_policy'
  | 'assignment'
  | 'agent_skill'
  | 'connector_credential'
  | 'environment'
  | 'run_snapshot';

export const GOVERNANCE_MIGRATION_DOMAINS: readonly GovernanceMigrationDomain[] = [
  'membership', 'entitlement_policy', 'assignment', 'agent_skill',
  'connector_credential', 'environment', 'run_snapshot',
];

export interface GovernanceMigrationControl {
  controlId: 'global';
  mode: GovernanceMigrationMode;
  writeAuthority: GovernanceWriteAuthority;
  legacyWritesSealed: boolean;
  compatibilityProjectionEnabled: boolean;
  rollbackEnabled: boolean;
  revision: number;
  updatedAt: string;
  updatedBy: string;
  updateReason: string;
}

export interface GovernanceMigrationDomainState {
  domain: GovernanceMigrationDomain;
  status: 'shadow' | 'ready' | 'enforced' | 'rollback';
  comparedCount: number;
  matchedCount: number;
  differenceCount: number;
  unresolvedBlockingCount: number;
  lastBatchTotal: number;
  lastBatchMatched: number;
  lastBatchDifferences: number;
  lastBatchAt?: string;
  revision: number;
  lastComparedAt?: string;
  updatedAt: string;
  updatedBy: string;
}

export type GovernanceDifferenceCategory =
  | 'missing_legacy'
  | 'missing_governance'
  | 'value_mismatch'
  | 'ambiguous_identity'
  | 'comparison_error';

export interface GovernanceShadowDifference {
  differenceId: string;
  domain: GovernanceMigrationDomain;
  tenantId?: string;
  resourceType: string;
  resourceId: string;
  category: GovernanceDifferenceCategory;
  legacyDigest?: string;
  governanceDigest?: string;
  blocking: boolean;
  status: 'open' | 'accepted' | 'resolved';
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolutionReason?: string;
}

export type GovernanceMigrationControlInvariantCode =
  | 'MIGRATION_CONTROL_NOT_FOUND'
  | 'MIGRATION_CONTROL_VERSION_CONFLICT'
  | 'MIGRATION_CONTROL_INVALID_TRANSITION'
  | 'MIGRATION_DOMAIN_NOT_READY'
  | 'MIGRATION_BLOCKING_DIFFERENCES'
  | 'MIGRATION_DOMAIN_VERSION_CONFLICT'
  | 'MIGRATION_DIFFERENCE_NOT_FOUND'
  | 'MIGRATION_LEGACY_WRITE_SEALED';

export class GovernanceMigrationControlInvariantError extends Error {
  constructor(readonly code: GovernanceMigrationControlInvariantCode) {
    super(code);
    this.name = 'GovernanceMigrationControlInvariantError';
  }
}
