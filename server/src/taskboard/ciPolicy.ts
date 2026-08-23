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

export function normalizeIntegrationPolicyCiFallback<T extends TaskBoardIntegrationPolicy>(policy: T): T {
  const ciPolicy = normalizeBoardCiPolicy(policy.ciPolicy);
  return {
    ...policy,
    ...(ciPolicy ? { ciPolicy } : {}),
  };
}

export function repositoryWithBoardCiPolicy(
  repository: TaskBoardRepositoryConfig,
  policy: TaskBoardIntegrationPolicy | undefined,
): TaskBoardRepositoryConfig {
  const ciPolicy = normalizeBoardCiPolicy(policy?.ciPolicy);
  return ciPolicy ? { ...repository, ciPolicy } : repository;
}
