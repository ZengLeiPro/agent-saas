export const CONTENT_ACCESS_GRANT_SCOPES = [
  'qa_read',
  'session_export',
  'guardrail_read',
] as const;

export type ContentAccessGrantScope = typeof CONTENT_ACCESS_GRANT_SCOPES[number];
export type ContentAccessGrantStatus = 'active' | 'revoked';

export interface ContentAccessGrant {
  grantId: string;
  tenantId: string;
  subjectUserId: string;
  targetType: 'session' | 'guardrail_collection';
  targetId: string;
  scopes: ContentAccessGrantScope[];
  purpose: string;
  reasonCode: string;
  expiresAt: string;
  status: ContentAccessGrantStatus;
  revision: number;
  createdBy: string;
  revokedBy?: string;
}

export interface CreateContentAccessGrantInput {
  tenantId: string;
  subjectUserId: string;
  targetType: 'session' | 'guardrail_collection';
  targetId: string;
  scopes: ContentAccessGrantScope[];
  purpose: string;
  reasonCode: string;
  expiresAt: string;
  createdBy: string;
}

export interface ListContentAccessGrantsInput {
  tenantId: string;
  subjectUserId?: string;
  status?: ContentAccessGrantStatus;
}

export interface AuthorizeContentAccessInput {
  tenantId: string;
  subjectUserId: string;
  targetType: 'session' | 'guardrail_collection';
  targetId: string;
  scope: ContentAccessGrantScope;
  at?: string | Date;
}

export interface RevokeContentAccessGrantInput {
  tenantId: string;
  grantId: string;
  expectedRevision: number;
  revokedBy: string;
}

export type ContentAccessGrantInvariantCode =
  | 'CONTENT_ACCESS_GRANT_INVALID'
  | 'CONTENT_ACCESS_GRANT_VERSION_CONFLICT';

export class ContentAccessGrantInvariantError extends Error {
  constructor(readonly code: ContentAccessGrantInvariantCode) {
    super(code);
    this.name = 'ContentAccessGrantInvariantError';
  }
}
