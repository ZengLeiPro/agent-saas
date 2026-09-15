export type OAuthGrantStatus = 'active' | 'expired' | 'revoked' | 'error';
export type OAuthApprovalAction = 'approved' | 'revoked' | 'expired' | 'refreshed';

export interface OAuthGrant {
  grantId: string;
  tenantId: string;
  subjectUserId: string;
  provider: string;
  connectorId?: string;
  status: OAuthGrantStatus;
  scopeSummary: string[];
  approvedAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  version: number;
  revocationStage?: 'local_blocked' | 'provider_revoking' | 'provider_revoked' | 'local_finalized';
  revocationAttempt?: number;
  revocationNextRetryAt?: string;
  revocationLastErrorCode?: string;
}

export interface OAuthApprovalRecord {
  approvalId: string;
  grantId: string;
  action: OAuthApprovalAction;
  scopeSummary: string[];
  purpose: string;
  actorUserId: string;
  occurredAt: string;
}

export interface OAuthGrantProjectionInput {
  grantId: string;
  tenantId: string;
  subjectUserId: string;
  provider: string;
  connectorId?: string;
  status: OAuthGrantStatus;
  scopeSummary: string[];
  approvedAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  action: OAuthApprovalAction;
  purpose: string;
  actorUserId: string;
}

/** Runtime may inject connector tokens only for grants that are active and not mid-revocation. */
export function isOAuthGrantRuntimeUsable(
  grant: Pick<OAuthGrant, 'status' | 'revocationStage' | 'expiresAt'> | null | undefined,
  now = Date.now(),
): boolean {
  return Boolean(
    grant
    && grant.status === 'active'
    && !grant.revocationStage
    && (!grant.expiresAt || new Date(grant.expiresAt).getTime() > now),
  );
}
