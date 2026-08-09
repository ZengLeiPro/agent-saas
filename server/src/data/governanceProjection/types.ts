export type GovernanceProjectionStatus =
  | 'pending'
  | 'running'
  | 'retry_wait'
  | 'succeeded'
  | 'failed';

export type GovernanceProjectionPayload = Record<string, unknown>;

export interface GovernanceProjectionOutboxItem {
  outboxId: string;
  tenantId: string;
  projector: string;
  idempotencyKey: string;
  payload: GovernanceProjectionPayload;
  status: GovernanceProjectionStatus;
  attempt: number;
  maxAttempts: number;
  leaseFence: number;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  nextAttemptAt?: string;
  lastErrorCode?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface GovernanceProjectionEnqueueInput {
  tenantId: string;
  projector: string;
  idempotencyKey: string;
  payload: GovernanceProjectionPayload;
  availableAt?: string;
  maxAttempts?: number;
}

export interface GovernanceProjectionClaimInput {
  leaseOwner: string;
  leaseMs: number;
  limit?: number;
}

export interface GovernanceProjectionLeaseInput {
  outboxId: string;
  leaseOwner: string;
  leaseFence: number;
}

export interface GovernanceProjectionFailInput extends GovernanceProjectionLeaseInput {
  errorCode: string;
  retryAt?: string;
}

export interface GovernanceProjectionOutboxStore {
  enqueue(input: GovernanceProjectionEnqueueInput): Promise<GovernanceProjectionOutboxItem>;
  claim(input: GovernanceProjectionClaimInput): Promise<GovernanceProjectionOutboxItem[]>;
  renewLease(input: GovernanceProjectionLeaseInput & { leaseMs: number }): Promise<boolean>;
  complete(input: GovernanceProjectionLeaseInput): Promise<GovernanceProjectionOutboxItem>;
  fail(input: GovernanceProjectionFailInput): Promise<GovernanceProjectionOutboxItem>;
}

export type GovernanceProjector = (
  payload: GovernanceProjectionPayload,
  item: Readonly<GovernanceProjectionOutboxItem>,
) => Promise<void>;

export type GovernanceProjectorMap = Readonly<Record<string, GovernanceProjector>>;

export type GovernanceProjectionInvariantCode =
  | 'GOVERNANCE_PROJECTION_INVALID'
  | 'GOVERNANCE_PROJECTION_PAYLOAD_SENSITIVE'
  | 'GOVERNANCE_PROJECTION_LEASE_LOST';

export class GovernanceProjectionInvariantError extends Error {
  constructor(readonly code: GovernanceProjectionInvariantCode) {
    super(code);
    this.name = 'GovernanceProjectionInvariantError';
  }
}
