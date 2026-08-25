export type GovernanceChangeJobType = 'tenant_delete' | 'resource_retire' | 'credential_revoke' | 'user_offboarding';
export type GovernanceChangeJobStatus =
  | 'pending' | 'running' | 'retry_wait' | 'succeeded' | 'partial' | 'failed' | 'dead_letter';
export type GovernanceChangeDomainStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface GovernanceChangeJobUnresolvedItem {
  itemType: string;
  itemId: string;
  reasonCode: string;
  retryable: boolean;
}

export interface GovernanceChangeDomainExecutionResult {
  affectedCount: number;
  completedCount: number;
  unresolvedItems: readonly GovernanceChangeJobUnresolvedItem[];
}

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
  /** Number of claims already made; incremented atomically with each claim. */
  attempt: number;
  /** Persisted finite retry budget, observable in every job receipt. */
  maxAttempts: number;
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
  unresolvedItems: GovernanceChangeJobUnresolvedItem[];
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
  | 'CHANGE_JOB_REQUEST_SENSITIVE'
  | 'CHANGE_JOB_TARGET_BUSY'
  | 'IDEMPOTENCY_KEY_REUSE_CONFLICT';

export class GovernanceChangeJobInvariantError extends Error {
  constructor(readonly code: GovernanceChangeJobInvariantCode) {
    super(code);
    this.name = 'GovernanceChangeJobInvariantError';
  }
}
