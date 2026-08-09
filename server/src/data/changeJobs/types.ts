export type GovernanceChangeJobType = 'tenant_delete' | 'resource_retire' | 'credential_revoke';
export type GovernanceChangeJobStatus = 'pending' | 'running' | 'retry_wait' | 'succeeded' | 'failed';
export type GovernanceChangeDomainStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface GovernanceChangeJob {
  jobId: string;
  tenantId: string;
  jobType: GovernanceChangeJobType;
  targetType: string;
  targetId: string;
  idempotencyKey: string;
  request: Record<string, unknown>;
  status: GovernanceChangeJobStatus;
  revision: number;
  attempt: number;
  lastErrorCode?: string;
  nextRetryAt?: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  completedAt?: string;
}

export interface GovernanceChangeJobDomain {
  jobId: string;
  domain: string;
  status: GovernanceChangeDomainStatus;
  totalCount: number;
  completedCount: number;
  failedCount: number;
  revision: number;
  updatedAt: string;
  lastErrorCode?: string;
}

export type GovernanceChangeJobInvariantCode =
  | 'CHANGE_JOB_INVALID'
  | 'CHANGE_JOB_NOT_FOUND'
  | 'CHANGE_JOB_VERSION_CONFLICT'
  | 'CHANGE_JOB_INVALID_TRANSITION'
  | 'CHANGE_JOB_INCOMPLETE'
  | 'CHANGE_JOB_REQUEST_SENSITIVE';

export class GovernanceChangeJobInvariantError extends Error {
  constructor(readonly code: GovernanceChangeJobInvariantCode) {
    super(code);
    this.name = 'GovernanceChangeJobInvariantError';
  }
}
