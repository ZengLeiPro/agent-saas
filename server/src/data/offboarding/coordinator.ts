import {
  GOVERNANCE_OFFBOARDING_DOMAINS,
  GovernanceOffboardingError,
  type CreateGovernanceOffboardingInput,
  type GovernanceOffboardingChangeJob,
  type GovernanceOffboardingChangeJobCreator,
  type GovernanceOffboardingDependencies,
  type GovernanceOffboardingDomain,
  type GovernanceOffboardingDomainContext,
  type GovernanceOffboardingDomainExecutor,
  type GovernanceOffboardingDomainResult,
  type GovernanceOffboardingPlan,
  type GovernanceOffboardingRetentionPolicy,
  type GovernanceOffboardingWorkerHandlerMap,
} from './types.js';

const DEFAULT_RETENTION_POLICY: GovernanceOffboardingRetentionPolicy = 'retain_and_disable';

function hasText(value: string): boolean {
  return value.trim().length > 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function assertInput(input: CreateGovernanceOffboardingInput): void {
  if (![input.tenantId, input.userId, input.handoffTargetUserId, input.idempotencyKey, input.requestedBy, input.reasonCode]
    .every(hasText)
    || input.userId === input.handoffTargetUserId
    || (input.retentionPolicy !== undefined && input.retentionPolicy !== DEFAULT_RETENTION_POLICY)) {
    throw new GovernanceOffboardingError('OFFBOARDING_INVALID_REQUEST');
  }
}

function assertReusableJob(
  job: GovernanceOffboardingChangeJob,
  input: CreateGovernanceOffboardingInput,
  retentionPolicy: GovernanceOffboardingRetentionPolicy,
): void {
  const handoffTarget = asRecord(job.request.handoffTarget);
  if (job.tenantId !== input.tenantId
    || job.jobType !== 'user_offboarding'
    || job.targetType !== 'user'
    || job.targetId !== input.userId
    || job.idempotencyKey !== input.idempotencyKey
    || job.request.action !== 'user_offboarding'
    || job.request.retentionPolicy !== retentionPolicy
    || handoffTarget?.type !== 'user'
    || handoffTarget.userId !== input.handoffTargetUserId) {
    throw new GovernanceOffboardingError('OFFBOARDING_CHANGE_JOB_MISMATCH');
  }
}

function assertDomainResult(
  domain: GovernanceOffboardingDomain,
  result: GovernanceOffboardingDomainResult,
): void {
  if (!result || typeof result !== 'object'
    || !Number.isInteger(result.affectedCount) || result.affectedCount < 0
    || !Number.isInteger(result.completedCount) || result.completedCount < 0
    || result.completedCount > result.affectedCount
    || !Array.isArray(result.unresolvedItems)
    || (result.completedCount < result.affectedCount && result.unresolvedItems.length === 0)) {
    throw new GovernanceOffboardingError('OFFBOARDING_INVALID_DOMAIN_RESULT', domain);
  }
}

export class GovernanceOffboardingCoordinator {
  constructor(private readonly options: {
    jobs: GovernanceOffboardingChangeJobCreator;
    domains: GovernanceOffboardingDependencies;
  }) {}

  async createOrReuse(input: CreateGovernanceOffboardingInput): Promise<GovernanceOffboardingPlan> {
    assertInput(input);
    const retentionPolicy = input.retentionPolicy ?? DEFAULT_RETENTION_POLICY;
    const request: Record<string, unknown> = {
      schemaVersion: 1,
      action: 'user_offboarding',
      reasonCode: input.reasonCode,
      retentionPolicy,
      handoffTarget: { type: 'user', userId: input.handoffTargetUserId },
    };
    const { job, created } = await this.options.jobs.create({
      tenantId: input.tenantId,
      jobType: 'user_offboarding',
      targetType: 'user',
      targetId: input.userId,
      idempotencyKey: input.idempotencyKey,
      request,
      domains: [...GOVERNANCE_OFFBOARDING_DOMAINS],
      createdBy: input.requestedBy,
    });
    assertReusableJob(job, input, retentionPolicy);

    return {
      job,
      created,
      domainHandlers: this.buildDomainHandlers(input, job, retentionPolicy),
    };
  }

  private buildDomainHandlers(
    input: CreateGovernanceOffboardingInput,
    job: GovernanceOffboardingChangeJob,
    retentionPolicy: GovernanceOffboardingRetentionPolicy,
  ): GovernanceOffboardingWorkerHandlerMap {
    return Object.fromEntries(GOVERNANCE_OFFBOARDING_DOMAINS.map(domain => [
      domain,
      async (): Promise<void> => {
        const executor = this.executorFor(domain);
        const context: GovernanceOffboardingDomainContext = {
          tenantId: input.tenantId,
          userId: input.userId,
          handoffTargetUserId: input.handoffTargetUserId,
          retentionPolicy,
          requestedBy: input.requestedBy,
          jobId: job.jobId,
          jobIdempotencyKey: input.idempotencyKey,
          operationIdempotencyKey: `${input.idempotencyKey}:${domain}`,
          domain,
        };
        let result: GovernanceOffboardingDomainResult;
        try {
          result = await executor.offboard(context);
        } catch (error) {
          if (error instanceof GovernanceOffboardingError) throw error;
          throw new GovernanceOffboardingError('OFFBOARDING_DOMAIN_FAILED', domain, [], { cause: error });
        }
        assertDomainResult(domain, result);
        if (result.unresolvedItems.length > 0) {
          throw new GovernanceOffboardingError(
            'OFFBOARDING_UNRESOLVED_ITEMS',
            domain,
            [...result.unresolvedItems],
          );
        }
      },
    ])) as GovernanceOffboardingWorkerHandlerMap;
  }

  private executorFor(domain: GovernanceOffboardingDomain): GovernanceOffboardingDomainExecutor {
    switch (domain) {
      case 'runs_sessions': return this.options.domains.runsSessions;
      case 'assignments_preferences': return this.options.domains.assignmentsPreferences;
      case 'credentials_connectors': return this.options.domains.credentialsConnectors;
      case 'cron_ownership': return this.options.domains.cronOwnership;
      case 'personal_resources': return this.options.domains.personalResources;
      case 'membership': return this.options.domains.membership;
    }
  }
}
