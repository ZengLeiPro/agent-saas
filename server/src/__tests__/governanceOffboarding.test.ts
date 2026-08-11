import { describe, expect, it, vi } from 'vitest';

import { createSafeCronOffboardingExecutor } from '../app/governanceOffboarding.js';
import { governanceDigest } from '../data/governance-audit/index.js';
import {
  GOVERNANCE_OFFBOARDING_DOMAINS,
  GovernanceOffboardingCoordinator,
  GovernanceOffboardingError,
  type GovernanceOffboardingChangeJobCreator,
  type GovernanceOffboardingDependencies,
  type GovernanceOffboardingDomainExecutor,
} from '../data/offboarding/index.js';

const input = {
  tenantId: 'acme',
  userId: 'departing-user',
  handoffTargetUserId: 'new-owner',
  idempotencyKey: 'offboard:acme:departing-user:v1',
  requestedBy: 'org-admin',
  reasonCode: 'employment_ended',
  manifest: { baselineDigest: governanceDigest({ inventory: 'fixed' }), baseline: { inventory: 'fixed' } },
};

function successfulExecutor(): GovernanceOffboardingDomainExecutor {
  return {
    offboard: vi.fn().mockResolvedValue({
      affectedCount: 1,
      completedCount: 1,
      unresolvedItems: [],
    }),
  };
}

function dependencies(overrides: Partial<GovernanceOffboardingDependencies> = {}): GovernanceOffboardingDependencies {
  return {
    runsSessions: successfulExecutor(),
    assignmentsPreferences: successfulExecutor(),
    credentialsConnectors: successfulExecutor(),
    cronOwnership: successfulExecutor(),
    personalResources: successfulExecutor(),
    membership: successfulExecutor(),
    ...overrides,
  };
}

function jobCreator(options: { created?: boolean; targetId?: string } = {}): GovernanceOffboardingChangeJobCreator {
  return {
    create: vi.fn(async request => ({
      created: options.created ?? true,
      job: {
        jobId: 'job-offboarding-1',
        tenantId: request.tenantId,
        jobType: request.jobType,
        targetType: request.targetType,
        targetId: options.targetId ?? request.targetId,
        idempotencyKey: request.idempotencyKey,
        request: request.request,
        status: 'pending',
      },
    })),
  };
}

describe('GovernanceOffboardingCoordinator', () => {
  it('创建 retain_and_disable Job，并为全部治理域执行真实回调', async () => {
    const jobs = jobCreator();
    const domains = dependencies();
    const coordinator = new GovernanceOffboardingCoordinator({ jobs, domains });

    const plan = await coordinator.createOrReuse(input);

    expect(jobs.create).toHaveBeenCalledWith({
      tenantId: 'acme',
      jobType: 'user_offboarding',
      targetType: 'user',
      targetId: 'departing-user',
      idempotencyKey: input.idempotencyKey,
      createdBy: 'org-admin',
      domains: [...GOVERNANCE_OFFBOARDING_DOMAINS],
      request: {
        schemaVersion: 2,
        action: 'user_offboarding',
        reasonCode: 'employment_ended',
        retentionPolicy: 'retain_and_disable',
        handoffTarget: { type: 'user', userId: 'new-owner' },
        manifest: input.manifest,
      },
    });
    expect(Object.keys(plan.domainHandlers)).toEqual([...GOVERNANCE_OFFBOARDING_DOMAINS]);

    for (const domain of GOVERNANCE_OFFBOARDING_DOMAINS) {
      await expect(plan.domainHandlers[domain]()).resolves.toMatchObject({
        affectedCount: 1, completedCount: 1, unresolvedItems: [],
      });
    }

    const executors = Object.values(domains) as GovernanceOffboardingDomainExecutor[];
    expect(executors.every(executor => vi.mocked(executor.offboard).mock.calls.length === 1)).toBe(true);
    expect(vi.mocked(domains.personalResources.offboard)).toHaveBeenCalledWith(expect.objectContaining({
      retentionPolicy: 'retain_and_disable',
      handoffTargetUserId: 'new-owner',
      jobId: 'job-offboarding-1',
      operationIdempotencyKey: 'job-offboarding-1:personal_resources:v1',
      manifest: input.manifest,
    }));
  });

  it('任一 unresolvedItems 使 handler fail closed，不能被 Worker 视为 clean success', async () => {
    const unresolved = {
      itemType: 'connector',
      itemId: 'connector-7',
      reasonCode: 'HANDOFF_TARGET_NOT_AUTHORIZED',
      retryable: true,
    };
    const credentialsConnectors: GovernanceOffboardingDomainExecutor = {
      offboard: vi.fn().mockResolvedValue({
        affectedCount: 2,
        completedCount: 1,
        unresolvedItems: [unresolved],
      }),
    };
    const coordinator = new GovernanceOffboardingCoordinator({
      jobs: jobCreator(),
      domains: dependencies({ credentialsConnectors }),
    });
    const plan = await coordinator.createOrReuse(input);

    await expect(plan.domainHandlers.credentials_connectors()).resolves.toEqual({
      affectedCount: 2,
      completedCount: 1,
      unresolvedItems: [unresolved],
    });
  });

  it('真实域回调失败和不完整结果均 fail closed，并输出稳定错误码', async () => {
    const cronOwnership: GovernanceOffboardingDomainExecutor = {
      offboard: vi.fn().mockRejectedValue(new Error('database detail must not become a worker status')),
    };
    const personalResources: GovernanceOffboardingDomainExecutor = {
      offboard: vi.fn().mockResolvedValue({
        affectedCount: 2,
        completedCount: 1,
        unresolvedItems: [],
      }),
    };
    const coordinator = new GovernanceOffboardingCoordinator({
      jobs: jobCreator(),
      domains: dependencies({ cronOwnership, personalResources }),
    });
    const plan = await coordinator.createOrReuse(input);

    await expect(plan.domainHandlers.cron_ownership()).rejects.toMatchObject({
      code: 'OFFBOARDING_DOMAIN_FAILED',
      message: 'OFFBOARDING_DOMAIN_FAILED',
      domain: 'cron_ownership',
    });
    await expect(plan.domainHandlers.personal_resources()).rejects.toMatchObject({
      code: 'OFFBOARDING_INVALID_DOMAIN_RESULT',
      domain: 'personal_resources',
    });
  });

  it('复用同一 Job 时以稳定 operation key 幂等重试 unresolved 域', async () => {
    const seenOperationKeys: string[] = [];
    const membership: GovernanceOffboardingDomainExecutor = {
      offboard: vi.fn(async context => {
        seenOperationKeys.push(context.operationIdempotencyKey);
        if (seenOperationKeys.length === 1) {
          return {
            affectedCount: 1,
            completedCount: 0,
            unresolvedItems: [{
              itemType: 'membership', itemId: context.userId,
              reasonCode: 'DEPENDENCY_NOT_READY', retryable: true,
            }],
          };
        }
        return { affectedCount: 1, completedCount: 1, unresolvedItems: [] };
      }),
    };
    const jobs = jobCreator({ created: false });
    const coordinator = new GovernanceOffboardingCoordinator({
      jobs,
      domains: dependencies({ membership }),
    });

    const firstPlan = await coordinator.createOrReuse(input);
    await expect(firstPlan.domainHandlers.membership()).resolves.toMatchObject({ completedCount: 0 });
    const retryPlan = await coordinator.createOrReuse(input);
    await expect(retryPlan.domainHandlers.membership()).resolves.toMatchObject({ completedCount: 1 });

    expect(firstPlan.created).toBe(false);
    expect(retryPlan.job.jobId).toBe(firstPlan.job.jobId);
    expect(seenOperationKeys).toEqual([
      'job-offboarding-1:membership:v1',
      'job-offboarding-1:membership:v1',
    ]);
    expect(jobs.create).toHaveBeenCalledTimes(2);
  });

  it('拒绝删除策略、自交接及幂等键复用到不同主体', async () => {
    const coordinator = new GovernanceOffboardingCoordinator({
      jobs: jobCreator(),
      domains: dependencies(),
    });
    await expect(coordinator.createOrReuse({
      ...input,
      retentionPolicy: 'delete' as 'retain_and_disable',
    })).rejects.toMatchObject({ code: 'OFFBOARDING_INVALID_REQUEST' });
    await expect(coordinator.createOrReuse({
      ...input,
      handoffTargetUserId: input.userId,
    })).rejects.toMatchObject({ code: 'OFFBOARDING_INVALID_REQUEST' });

    const mismatched = new GovernanceOffboardingCoordinator({
      jobs: jobCreator({ targetId: 'another-user' }),
      domains: dependencies(),
    });
    await expect(mismatched.createOrReuse(input)).rejects.toMatchObject({
      code: 'OFFBOARDING_CHANGE_JOB_MISMATCH',
    });
  });

  it('Cron executor 先 disable fence、再 stop、最后 transfer，并使用稳定 operation id', async () => {
    const calls: string[] = [];
    const executor = createSafeCronOffboardingExecutor({
      get: vi.fn().mockResolvedValue({
        id: 'cron-1', ownerUserId: 'departing-user', enabled: true, running: true,
      }),
      disable: vi.fn(async (id, operationId) => { calls.push(`disable:${id}:${operationId}`); }),
      stop: vi.fn(async (id, operationId) => { calls.push(`stop:${id}:${operationId}`); }),
      transfer: vi.fn(async (id, target, operationId) => { calls.push(`transfer:${id}:${target}:${operationId}`); }),
    });
    await expect(executor({
      cronIds: ['cron-1'], departingUserId: 'departing-user', handoffTargetUserId: 'new-owner',
      operationIdempotencyKey: 'job-1:cron_ownership:v1',
    })).resolves.toEqual({ affectedCount: 1, completedCount: 1, unresolvedItems: [] });
    expect(calls).toEqual([
      'disable:cron-1:job-1:cron_ownership:v1:cron-1:disable',
      'stop:cron-1:job-1:cron_ownership:v1:cron-1:stop',
      'transfer:cron-1:new-owner:job-1:cron_ownership:v1:cron-1:transfer',
    ]);
  });
});
