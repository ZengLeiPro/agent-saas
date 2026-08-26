import type {
  TaskBoardCiPolicy,
  TaskBoardIntegrationPolicy,
  TaskBoardRepositoryConfig,
} from '../../../shared/src/types/taskboard.js';

import { TaskboardValidationError } from './types.js';

export function normalizeBoardCiPolicy(value: TaskBoardCiPolicy | undefined): TaskBoardCiPolicy | undefined {
  if (!value) return undefined;
  if (!Array.isArray(value.requiredChecks) || value.requiredChecks.length === 0 || value.requiredChecks.length > 50) {
    throw new TaskboardValidationError('Board CI policy must contain between 1 and 50 required checks');
  }
  const identities = new Map<string, { name: string; appId?: number }>();
  for (const check of value.requiredChecks) {
    const name = typeof check?.name === 'string' ? check.name.trim() : '';
    if (!name || name.length > 256) {
      throw new TaskboardValidationError('Board CI check name must be between 1 and 256 characters');
    }
    const appId = check.appId;
    if (appId !== undefined && (!Number.isSafeInteger(appId) || appId <= 0)) {
      throw new TaskboardValidationError('Board CI check appId must be a positive integer');
    }
    const key = `${name}\u0000${appId ?? '*'}`;
    if (identities.has(key)) throw new TaskboardValidationError(`Board CI check is duplicated: ${name}`);
    identities.set(key, { name, ...(appId !== undefined ? { appId } : {}) });
  }
  return { requiredChecks: [...identities.values()].sort((a, b) => `${a.name}\u0000${a.appId ?? '*'}`.localeCompare(`${b.name}\u0000${b.appId ?? '*'}`)) };
}

export function normalizeIntegrationPolicyCiFallback(policy: TaskBoardIntegrationPolicy): TaskBoardIntegrationPolicy {
  const ciPolicy = normalizeBoardCiPolicy(policy.ciPolicy);
  const { featureFlags: _ignored, ...persisted } = policy as TaskBoardIntegrationPolicy & { featureFlags?: unknown };
  return {
    ...persisted,
    workflowVersion: 3,
    ...(ciPolicy ? { ciPolicy } : {}),
  };
}

export function ciUnconfiguredError(): TaskboardValidationError {
  return new TaskboardValidationError(
    'CI gate is not configured: add GitHub required checks or this board\'s explicit CI fallback',
    'TASKBOARD_CI_UNCONFIGURED',
  );
}

export function clearBoardCiPolicyForRepositoryChange(
  currentRepository: TaskBoardRepositoryConfig | undefined,
  nextRepository: TaskBoardRepositoryConfig | undefined,
  policy: TaskBoardIntegrationPolicy | undefined,
): { policy: TaskBoardIntegrationPolicy | undefined; cleared: boolean } {
  if (!currentRepository || currentRepository.repositoryId === nextRepository?.repositoryId || !policy?.ciPolicy) {
    return { policy, cleared: false };
  }
  const policyWithoutCiFallback = { ...policy };
  delete policyWithoutCiFallback.ciPolicy;
  return { policy: policyWithoutCiFallback, cleared: true };
}

export function repositoryWithBoardCiPolicy(
  repository: TaskBoardRepositoryConfig,
  policy: TaskBoardIntegrationPolicy | undefined,
): TaskBoardRepositoryConfig {
  const ciPolicy = normalizeBoardCiPolicy(policy?.ciPolicy);
  return ciPolicy ? { ...repository, ciPolicy } : repository;
}
