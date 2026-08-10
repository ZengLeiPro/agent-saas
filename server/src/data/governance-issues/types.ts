export type GovernanceMigrationIssueStatus = 'open' | 'resolved' | 'ignored';
export type GovernanceMigrationIssueDetail = Record<string, string | number | boolean | null>;

export interface GovernanceMigrationIssueIdentity {
  issueType: string;
  tenantId?: string;
  resourceType?: string;
  resourceId?: string;
  legacyKey?: string;
}

export interface GovernanceMigrationIssue extends GovernanceMigrationIssueIdentity {
  issueId: string;
  detail: GovernanceMigrationIssueDetail;
  status: GovernanceMigrationIssueStatus;
  version: number;
  createdAt: string;
  createdBy: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

export interface OpenGovernanceMigrationIssueInput extends GovernanceMigrationIssueIdentity {
  detail?: GovernanceMigrationIssueDetail;
  createdBy: string;
}
