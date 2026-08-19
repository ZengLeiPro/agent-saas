import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveTenantSkillsDirFromRoot } from '../../data/tenants/tenantSkillsPath.js';
import { agentPath } from '../namespace.js';
import { computeDirectoryFingerprint } from './fingerprint.js';

export interface LegacyTenantSkillDetectionInput {
  userCwd: string;
  userSkillsDir: string;
  tenantsRootDir: string;
  currentTenantId?: string;
  poolSkillIds: ReadonlySet<string>;
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
 * 迁移没有 skills-state.json 的旧 workspace 时，只把“用户副本内容与外租户源
 * 完全一致”的 ID 视为组织残留。绝不按跨租户同名 ID 推断，无法证明来源的目录
 * 保留为个人 Skill，避免迁移过程误伤同名个人 Skill。
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
      if (input.poolSkillIds.has(id) || !userDigests.has(id)) continue;
      try {
        const sourceDigest = await computeDirectoryFingerprint(join(tenantSkillsDir, id));
        if (sourceDigest === userDigests.get(id)) managed.add(id);
      } catch {
        // 源目录不完整或含软链接时不作 ownership 推断。
      }
    }
  }

  return managed;
}
