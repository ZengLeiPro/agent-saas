import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveTenantSkillsDirFromRoot } from '../../data/tenants/tenantSkillsPath.js';
import { agentPath } from '../namespace.js';
import {
  computeDirectoryFingerprint,
  computeSkillPackageFingerprint,
} from './fingerprint.js';

export interface LegacyTenantSkillDetectionInput {
  userCwd: string;
  userSkillsDir: string;
  tenantsRootDir: string;
  currentTenantId?: string;
  poolSkillIds: ReadonlySet<string>;
  /** 返回该租户 Skill 的所有可靠历史 contentDigest/fingerprint。 */
  resolveTenantSkillHistoricalDigests?: (
    tenantId: string,
    skillId: string,
  ) => Promise<readonly string[]>;
}

async function listDirectoryIds(root: string): Promise<Set<string>> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return new Set(
      entries
        .filter((entry) => (
          entry.isDirectory()
          && !entry.name.startsWith('.')
          && !entry.name.startsWith('_')
        ))
        .map((entry) => entry.name),
    );
  } catch {
    return new Set();
  }
}

async function hasLegacySkillsVersion(userCwd: string): Promise<boolean> {
  try {
    const value = Number.parseInt(
      (await readFile(agentPath(userCwd, '.skills-version'), 'utf-8')).trim(),
      10,
    );
    return Number.isInteger(value) && value >= 0;
  } catch {
    return false;
  }
}

/**
 * 迁移没有 skills-state.json 的旧 workspace 时，优先用当前源 fingerprint；源已更新时，
 * 只有治理历史中明确包含用户副本 digest 才认定为组织残留。绝不按跨租户同名 ID
 * 推断，无法证明来源的目录保留为个人 Skill，避免迁移过程误伤同名个人 Skill。
 */
export async function detectLegacyTenantSkillIds(
  input: LegacyTenantSkillDetectionInput,
): Promise<Set<string>> {
  if (!await hasLegacySkillsVersion(input.userCwd)) return new Set();

  const userIds = await listDirectoryIds(input.userSkillsDir);
  for (const poolSkillId of input.poolSkillIds) userIds.delete(poolSkillId);
  if (userIds.size === 0) return new Set();

  const userDigests = new Map<string, string>();
  for (const id of userIds) {
    try {
      const info = await lstat(join(input.userSkillsDir, id));
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      userDigests.set(id, await computeDirectoryFingerprint(join(input.userSkillsDir, id)));
    } catch {
      // 损坏目录或旧软链接没有可靠 provenance，交给既有 workspace 修复流程处理。
    }
  }
  if (userDigests.size === 0) return new Set();

  const userPackageDigests = new Map<string, string>();
  const managed = new Set<string>();
  let tenantEntries;
  try {
    tenantEntries = await readdir(input.tenantsRootDir, { withFileTypes: true });
  } catch {
    return managed;
  }

  for (const tenantEntry of tenantEntries) {
    if (
      !tenantEntry.isDirectory()
      || tenantEntry.name.startsWith('.')
      || tenantEntry.name.startsWith('_')
      || tenantEntry.name === input.currentTenantId
    ) continue;

    let tenantSkillsDir: string;
    try {
      tenantSkillsDir = resolveTenantSkillsDirFromRoot(input.tenantsRootDir, tenantEntry.name);
    } catch {
      continue;
    }
    const sourceIds = await listDirectoryIds(tenantSkillsDir);
    for (const id of sourceIds) {
      const userDigest = userDigests.get(id);
      if (input.poolSkillIds.has(id) || !userDigest) continue;
      try {
        const sourceDigest = await computeDirectoryFingerprint(join(tenantSkillsDir, id));
        if (sourceDigest === userDigest) {
          managed.add(id);
          continue;
        }

        // 当前源可能已从 v1 更新为 v2；只有治理历史中明确记录了用户副本
        // 的 digest，才允许把不再等于当前源的旧副本认定为组织残留。
        if (!input.resolveTenantSkillHistoricalDigests) continue;
        let packageDigest = userPackageDigests.get(id);
        if (!packageDigest) {
          packageDigest = await computeSkillPackageFingerprint(join(input.userSkillsDir, id));
          userPackageDigests.set(id, packageDigest);
        }
        const historicalDigests = await input.resolveTenantSkillHistoricalDigests(tenantEntry.name, id);
        if (historicalDigests.includes(userDigest) || historicalDigests.includes(packageDigest)) {
          managed.add(id);
        }
      } catch {
        // 源目录不完整、含软链接或治理历史不可读时不作 ownership 推断。
      }
    }
  }

  return managed;
}
