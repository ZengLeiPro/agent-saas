export const GOVERNANCE_OFFBOARDING_DOMAINS = [
  'runs_sessions',
  'assignments_preferences',
  'credentials_connectors',
  'cron_ownership',
  'personal_resources',
  'membership',
] as const;

export type GovernanceOffboardingDomain = typeof GOVERNANCE_OFFBOARDING_DOMAINS[number];
export type GovernanceOffboardingRetentionPolicy = 'retain_and_disable';

export interface GovernanceOffboardingUnresolvedItem {
  itemType: string;
  itemId: string;
  reasonCode: string;
  retryable: boolean;
}

export interface GovernanceOffboardingDomainResult {
  affectedCount: number;
  completedCount: number;
  unresolvedItems: readonly GovernanceOffboardingUnresolvedItem[];
}

export interface GovernanceOffboardingDomainContext {
  tenantId: string;
  userId: string;
  handoffTargetUserId: string;
  retentionPolicy: GovernanceOffboardingRetentionPolicy;
  requestedBy: string;
  jobId: string;
  jobIdempotencyKey: string;
  operationIdempotencyKey: string;
  domain: GovernanceOffboardingDomain;
}

export interface GovernanceOffboardingDomainExecutor {
  offboard(context: GovernanceOffboardingDomainContext): Promise<GovernanceOffboardingDomainResult>;
}

export interface GovernanceOffboardingDependencies {
  runsSessions: GovernanceOffboardingDomainExecutor;
  assignmentsPreferences: GovernanceOffboardingDomainExecutor;
  credentialsConnectors: GovernanceOffboardingDomainExecutor;
  cronOwnership: GovernanceOffboardingDomainExecutor;
  personalResources: GovernanceOffboardingDomainExecutor;
  membership: GovernanceOffboardingDomainExecutor;
}

export interface GovernanceOffboardingChangeJob {
  jobId: string;
  tenantId: string;
  jobType: string;
  targetType: string;
  targetId: string;
  idempotencyKey: string;
  request: Record<string, unknown>;
  status?: string;
}

export interface GovernanceOffboardingChangeJobCreator {
  create(input: {
    tenantId: string;
    jobType: 'user_offboarding';
    targetType: 'user';
    targetId: string;
    idempotencyKey: string;
    request: Record<string, unknown>;
    domains: string[];
    createdBy: string;
  }): Promise<{ job: GovernanceOffboardingChangeJob; created: boolean }>;
}

export interface CreateGovernanceOffboardingInput {
  tenantId: string;
  userId: string;
  handoffTargetUserId: string;
  idempotencyKey: string;
  requestedBy: string;
  reasonCode: string;
  retentionPolicy?: GovernanceOffboardingRetentionPolicy;
}

export type GovernanceOffboardingWorkerHandlerMap = Record<GovernanceOffboardingDomain, () => Promise<void>>;

export interface GovernanceOffboardingPlan {
  job: GovernanceOffboardingChangeJob;
  created: boolean;
  domainHandlers: GovernanceOffboardingWorkerHandlerMap;
}

export type GovernanceOffboardingErrorCode =
  | 'OFFBOARDING_INVALID_REQUEST'
  | 'OFFBOARDING_CHANGE_JOB_MISMATCH'
  | 'OFFBOARDING_INVALID_DOMAIN_RESULT'
  | 'OFFBOARDING_UNRESOLVED_ITEMS'
  | 'OFFBOARDING_DOMAIN_FAILED';

export class GovernanceOffboardingError extends Error {
  constructor(
    readonly code: GovernanceOffboardingErrorCode,
    readonly domain?: GovernanceOffboardingDomain,
    readonly unresolvedItems: readonly GovernanceOffboardingUnresolvedItem[] = [],
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = 'GovernanceOffboardingError';
  }
}
