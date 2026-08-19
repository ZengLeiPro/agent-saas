import { join } from 'node:path';
import type { PgSkillGovernanceStore } from '../data/skillGovernance/index.js';
import { scanTenantOwnSkillIdsAsync } from '../data/skills/scanner.js';
import { resolveTenantSkillsDir, resolveTenantSkillsDirFromRoot } from '../data/tenants/tenantSkillsPath.js';
import { resolveUserCwd } from '../workspace/resolver.js';
import { agentSkillsDir } from '../workspace/namespace.js';
import {
  resolveManagedTenantSkillIds,
  resolveUserPersonalSkillIds,
} from '../workspace/materialization/managedTenantSkills.js';
import type { UserInfo } from '../data/users/types.js';

export type SkillOwnershipUser = Pick<UserInfo, 'id' | 'username' | 'role' | 'tenantId'>;

type SkillGovernanceStore = Pick<PgSkillGovernanceStore, 'getVersion'>
  & Partial<Pick<PgSkillGovernanceStore, 'listTenantSkillHistoricalProvenance' | 'listPersonalByOwner'>>;

export function createSkillOwnershipResolver(input: {
  agentCwd: string;
  sharedDir: string;
  tenantSkillsRootDir?: string;
  getPoolSkillIds: () => Promise<Set<string>>;
  skillGovernanceStore?: SkillGovernanceStore;
}) {
  function getUserCwd(user: SkillOwnershipUser): string {
    return resolveUserCwd(input.agentCwd, user);
  }

  function getUserSkillsDir(user: SkillOwnershipUser): string {
    return agentSkillsDir(getUserCwd(user));
  }

  function tenantSkillsDirFor(tenantId: string): string {
    return input.tenantSkillsRootDir
      ? resolveTenantSkillsDirFromRoot(input.tenantSkillsRootDir, tenantId)
      : resolveTenantSkillsDir(input.sharedDir, tenantId);
  }

  async function getTenantOwnSkillIds(tenantId: string | undefined): Promise<Set<string>> {
    if (!tenantId) return new Set();
    try {
      return scanTenantOwnSkillIdsAsync(tenantSkillsDirFor(tenantId), await input.getPoolSkillIds());
    } catch {
      return new Set();
    }
  }

  const getTenantSkillHistoricalProvenance = (tenantId: string) => (
    input.skillGovernanceStore?.listTenantSkillHistoricalProvenance?.(tenantId)
      ?? Promise.resolve(new Map())
  );

  async function getManagedTenantSkillIdsForUser(user: SkillOwnershipUser): Promise<Set<string>> {
    return resolveManagedTenantSkillIds({
      userCwd: getUserCwd(user),
      userSkillsDir: getUserSkillsDir(user),
      tenantsRootDir: input.tenantSkillsRootDir ?? join(input.sharedDir, 'tenants'),
      currentTenantId: user.tenantId,
      userId: user.id,
      poolSkillIds: await input.getPoolSkillIds(),
      getCurrentTenantSkillIds: () => getTenantOwnSkillIds(user.tenantId),
      resolveTenantSkillHistoricalProvenance: getTenantSkillHistoricalProvenance,
      resolveUserPersonalSkillIds: input.skillGovernanceStore?.listPersonalByOwner
        ? (tenantId, userId) => resolveUserPersonalSkillIds({ id: userId, tenantId }, input.skillGovernanceStore)
        : undefined,
    });
  }

  return {
    getUserCwd,
    getUserSkillsDir,
    tenantSkillsDirFor,
    getTenantOwnSkillIds,
    getManagedTenantSkillIdsForUser,
  };
}
