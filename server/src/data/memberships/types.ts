export type MembershipPersona = 'member' | 'org_admin';
export type GovernanceIdentityStatus = 'active' | 'disabled';
export type GovernanceIdentitySource = 'legacy_projection' | 'governance';

export interface TenantMembership {
  tenantId: string;
  userId: string;
  persona: MembershipPersona;
  isOwner: boolean;
  status: GovernanceIdentityStatus;
  source: GovernanceIdentitySource;
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface PlatformAdmin {
  userId: string;
  status: GovernanceIdentityStatus;
  source: GovernanceIdentitySource;
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface MembershipIdentityPatch {
  persona?: MembershipPersona;
  isOwner?: boolean;
  status?: GovernanceIdentityStatus;
  expectedVersion: number;
  updatedBy: string;
  authorization: {
    kind: 'tenant_member' | 'platform_recovery';
    actorTenantId: string;
    reason?: string;
  };
}

export interface PlatformAdminPatch {
  status: GovernanceIdentityStatus;
  expectedVersion: number;
  updatedBy: string;
}

export type MembershipInvariantCode =
  | 'MEMBERSHIP_NOT_FOUND'
  | 'PLATFORM_ADMIN_NOT_FOUND'
  | 'MEMBERSHIP_VERSION_CONFLICT'
  | 'PLATFORM_ADMIN_VERSION_CONFLICT'
  | 'OWNER_MUST_BE_ORG_ADMIN'
  | 'LAST_EFFECTIVE_OWNER_PROTECTED'
  | 'LAST_PLATFORM_ADMIN_PROTECTED'
  | 'PLATFORM_TENANT_MEMBERSHIP_FORBIDDEN'
  | 'MEMBERSHIP_CHANGE_FORBIDDEN'
  | 'PLATFORM_RECOVERY_SCOPE_REQUIRED'
  | 'MEMBERSHIP_IDENTITY_INVALID';

export class MembershipInvariantError extends Error {
  constructor(readonly code: MembershipInvariantCode) {
    super(code);
    this.name = 'MembershipInvariantError';
  }
}

export interface LegacyMembershipUser {
  id: string;
  role: 'admin' | 'user';
  tenantId: string;
  disabled?: boolean;
}

export interface LegacyMembershipTenant {
  id: string;
}

export interface LegacyMembershipBackfillInput {
  users: LegacyMembershipUser[];
  tenants: LegacyMembershipTenant[];
  projectedBy: string;
  platformTenantId: string;
}

export interface MembershipBackfillResult {
  membershipsProjected: number;
  platformAdminsProjected: number;
  issuesRecorded: number;
}
