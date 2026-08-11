import { governanceDigest } from '../governance-audit/index.js';
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
  type GovernanceOffboardingManifest,
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

function assertManifest(manifest: GovernanceOffboardingManifest): void {
  if (!manifest || !hasText(manifest.baselineDigest) || !asRecord(manifest.baseline)
    || governanceDigest(manifest.baseline) !== manifest.baselineDigest) {
    throw new GovernanceOffboardingError('OFFBOARDING_MANIFEST_INVALID');
  }
}

function assertInput(input: CreateGovernanceOffboardingInput): void {
  if (![input.tenantId, input.userId, input.handoffTargetUserId, input.idempotencyKey, input.requestedBy, input.reasonCode]
    .every(hasText)
    || input.userId === input.handoffTargetUserId
    || (input.retentionPolicy !== undefined && input.retentionPolicy !== DEFAULT_RETENTION_POLICY)) {
    throw new GovernanceOffboardingError('OFFBOARDING_INVALID_REQUEST');
  }
  assertManifest(input.manifest);
}

function requestManifest(job: GovernanceOffboardingChangeJob): GovernanceOffboardingManifest {
  const raw = asRecord(job.request.manifest);
  const baseline = raw ? asRecord(raw.baseline) : undefined;
  const manifest = raw && baseline && typeof raw.baselineDigest === 'string'
    ? { baselineDigest: raw.baselineDigest, baseline }
    : undefined;
  if (!manifest) throw new GovernanceOffboardingError('OFFBOARDING_MANIFEST_INVALID');
  assertManifest(manifest);
  return manifest;
}

function requestIdentity(job: GovernanceOffboardingChangeJob): {
  handoffTargetUserId: string;
  reasonCode: string;
  retentionPolicy: GovernanceOffboardingRetentionPolicy;
  manifest: GovernanceOffboardingManifest;
} {
  const handoffTarget = asRecord(job.request.handoffTarget);
  if (job.jobType !== 'user_offboarding' || job.targetType !== 'user'
    || job.request.action !== 'user_offboarding'
    || job.request.retentionPolicy !== DEFAULT_RETENTION_POLICY
    || handoffTarget?.type !== 'user' || typeof handoffTarget.userId !== 'string'
    || typeof job.request.reasonCode !== 'string') {
    throw new GovernanceOffboardingError('OFFBOARDING_CHANGE_JOB_MISMATCH');
  }
  return {
    handoffTargetUserId: handoffTarget.userId,
    reasonCode: job.request.reasonCode,
    retentionPolicy: DEFAULT_RETENTION_POLICY,
    manifest: requestManifest(job),
  };
}

function assertReusableJob(
  job: GovernanceOffboardingChangeJob,
  input: CreateGovernanceOffboardingInput,
  retentionPolicy: GovernanceOffboardingRetentionPolicy,
): void {
  const identity = requestIdentity(job);
  if (job.tenantId !== input.tenantId || job.targetId !== input.userId
    || job.idempotencyKey !== input.idempotencyKey
    || identity.retentionPolicy !== retentionPolicy
    || identity.handoffTargetUserId !== input.handoffTargetUserId
    || identity.reasonCode !== input.reasonCode
    || governanceDigest(identity.manifest) !== governanceDigest(input.manifest)) {
    throw new GovernanceOffboardingError('OFFBOARDING_CHANGE_JOB_MISMATCH');
  }
}

function assertDomainResult(domain: GovernanceOffboardingDomain, result: GovernanceOffboardingDomainResult): void {
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
      schemaVersion: 2,
      action: 'user_offboarding',
      reasonCode: input.reasonCode,
      retentionPolicy,
      handoffTarget: { type: 'user', userId: input.handoffTargetUserId },
      manifest: input.manifest,
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
      domainHandlers: this.buildDomainHandlers(job, input.requestedBy),
    };
  }

  resume(job: GovernanceOffboardingChangeJob, requestedBy: string): GovernanceOffboardingPlan {
    if (!hasText(requestedBy)) throw new GovernanceOffboardingError('OFFBOARDING_INVALID_REQUEST');
    requestIdentity(job);
    return { job, created: false, domainHandlers: this.buildDomainHandlers(job, requestedBy) };
  }

  private buildDomainHandlers(
    job: GovernanceOffboardingChangeJob,
    requestedBy: string,
  ): GovernanceOffboardingWorkerHandlerMap {
    const identity = requestIdentity(job);
    return Object.fromEntries(GOVERNANCE_OFFBOARDING_DOMAINS.map(domain => [
      domain,
      async (): Promise<GovernanceOffboardingDomainResult> => {
        const executor = this.executorFor(domain);
        const context: GovernanceOffboardingDomainContext = {
          tenantId: job.tenantId,
          userId: job.targetId,
          handoffTargetUserId: identity.handoffTargetUserId,
          retentionPolicy: identity.retentionPolicy,
          requestedBy,
          jobId: job.jobId,
          jobIdempotencyKey: job.idempotencyKey,
          operationIdempotencyKey: `${job.jobId}:${domain}:v1`,
          domain,
          manifest: identity.manifest,
        };
        let result: GovernanceOffboardingDomainResult;
        try {
          result = await executor.offboard(context);
        } catch (error) {
          if (error instanceof GovernanceOffboardingError) throw error;
          throw new GovernanceOffboardingError('OFFBOARDING_DOMAIN_FAILED', domain, [], { cause: error });
        }
        assertDomainResult(domain, result);
        return result;
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
