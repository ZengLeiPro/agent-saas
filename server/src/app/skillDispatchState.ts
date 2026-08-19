import type { UserInfo } from '../data/users/types.js';
import { resolveUserCwd } from '../workspace/resolver.js';
import { resolveAgentPath } from '../workspace/namespace.js';
import {
  resolveManagedTenantSkillIds,
  type ManagedTenantSkillIdsInput,
} from '../workspace/materialization/managedTenantSkills.js';

interface ScannedPoolSkill {
  id: string;
  name?: string;
  description?: string;
}

interface PoolSkill {
  id: string;
  name: string;
  description: string;
}

type RuntimeUser = Pick<UserInfo, 'id' | 'username' | 'role' | 'tenantId'>;

type PersonalSkillIdsResolver = (user: { id: string; tenantId?: string }) => Promise<ReadonlySet<string> | undefined>;

type HistoricalProvenanceResolver = NonNullable<ManagedTenantSkillIdsInput['resolveTenantSkillHistoricalProvenance']>;

export function createSkillDispatchState(input: {
  findUser: (username: string) => RuntimeUser | undefined;
  agentCwd: string;
  tenantsRootDir: string;
  getConfigVersion: () => number;
  scanPoolSkills: () => ScannedPoolSkill[];
  resolveTenantSkillHistoricalProvenance: HistoricalProvenanceResolver;
  resolveUserPersonalSkillIds: PersonalSkillIdsResolver;
}) {
  let poolCache: { version: number; entries: PoolSkill[] } | undefined;
  const managedTenantIdsByUser = new Map<string, Set<string>>();

  function getAllPoolEntries(): PoolSkill[] {
    const version = input.getConfigVersion();
    if (poolCache?.version === version) return poolCache.entries;
    const entries = input.scanPoolSkills().map((skill) => ({
      id: skill.id,
      name: skill.name || skill.id,
      description: skill.description ?? '',
    }));
    poolCache = { version, entries };
    return entries;
  }

  async function refresh(username: string | undefined): Promise<void> {
    if (!username) return;
    const user = input.findUser(username);
    if (!user) return;
    const userCwd = resolveUserCwd(input.agentCwd, user);
    const managed = await resolveManagedTenantSkillIds({
      userCwd,
      userSkillsDir: resolveAgentPath(userCwd, 'skills'),
      tenantsRootDir: input.tenantsRootDir,
      currentTenantId: user.tenantId,
      userId: user.id,
      poolSkillIds: new Set(getAllPoolEntries().map((skill) => skill.id)),
      resolveTenantSkillHistoricalProvenance: input.resolveTenantSkillHistoricalProvenance,
      resolveUserPersonalSkillIds: (tenantId, userId) =>
        input.resolveUserPersonalSkillIds({ id: userId, tenantId }),
    });
    managedTenantIdsByUser.set(username, managed);
  }

  return {
    getAllPoolEntries,
    refresh,
    getManagedTenantIds: (username: string) => managedTenantIdsByUser.get(username) ?? new Set<string>(),
  };
}
