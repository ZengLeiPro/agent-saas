import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { SkillHistoricalProvenance } from '../../data/skillGovernance/types.js';
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
  userId?: string;
  poolSkillIds: ReadonlySet<string>;
  /** 返回该租户所有历史组织 Skill 的 legacySkillId → provenance，包含已删除资源。 */
  resolveTenantSkillHistoricalProvenance?: (
    tenantId: string,
  ) => Promise<ReadonlyMap<string, SkillHistoricalProvenance | readonly string[]>>;
  /** 返回当前用户已有个人 Skill 的 legacySkillId，用于保护同名个人目录。 */
  resolveUserPersonalSkillIds?: (
    tenantId: string,
    userId: string,
  ) => Promise<ReadonlySet<string> | undefined>;
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

function normalizeHistoricalProvenance(
  value: SkillHistoricalProvenance | readonly string[],
): SkillHistoricalProvenance {
  // 兼容旧 resolver：未带算法标记的数组来自历史 contentDigest，按旧上传摘要迁移。
  if (Array.isArray(value)) return { digests: [], legacyDigests: value };
  const provenance = value as SkillHistoricalProvenance;
  return {
    digests: provenance.digests ?? [],
    legacyDigests: provenance.legacyDigests ?? [],
  };
}

/**
 * 迁移没有 skills-state.json 的旧 workspace 时，优先用当前源 fingerprint；源已更新或删除时，
 * 优先匹配治理历史摘要。旧上传摘要若包含已被物化过滤的文件，无法反推出新摘要，
 * 则使用带 tenant/legacySkillId 的治理历史作为一次性迁移凭据；已可靠读取的个人治理
 * provenance 优先保护同名个人目录，无法证明来源且没有旧治理凭据的目录仍保留为个人 Skill。
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
  let personalSkillIds = new Set<string>();
  let personalOwnershipReliable = true;
  if (input.resolveUserPersonalSkillIds && input.currentTenantId && input.userId) {
    try {
      const resolved = await input.resolveUserPersonalSkillIds(input.currentTenantId, input.userId);
      if (!resolved) personalOwnershipReliable = false;
      else personalSkillIds = new Set(resolved);
    } catch {
      // 无法确认个人治理 provenance 时，禁止使用旧摘要的宽松迁移兜底。
      personalOwnershipReliable = false;
    }
  }
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
    let historicalProvenance: ReadonlyMap<string, SkillHistoricalProvenance | readonly string[]> = new Map();
    if (input.resolveTenantSkillHistoricalProvenance) {
      historicalProvenance = await input.resolveTenantSkillHistoricalProvenance(tenantEntry.name)
        .catch(() => new Map<string, SkillHistoricalProvenance | readonly string[]>());
    }
    const candidateIds = new Set([...sourceIds, ...historicalProvenance.keys()]);
    for (const id of candidateIds) {
      const userDigest = userDigests.get(id);
      if (input.poolSkillIds.has(id) || !userDigest || personalSkillIds.has(id)) continue;

      // 当前源仍存在且副本完全一致时，可以直接确认组织 provenance。
      if (sourceIds.has(id)) {
        try {
          const sourceDigest = await computeDirectoryFingerprint(join(tenantSkillsDir, id));
          if (sourceDigest === userDigest) {
            managed.add(id);
            continue;
          }
        } catch {
          // 当前源不完整或含软链接时，继续尝试治理历史证据。
        }
      }

      // 当前源可能已从 v1 更新为 v2，或已经删除归档；先尝试精确摘要匹配。
      const rawProvenance = historicalProvenance.get(id);
      if (!rawProvenance) continue;
      const provenance = normalizeHistoricalProvenance(rawProvenance);
      try {
        let packageDigest = userPackageDigests.get(id);
        if (!packageDigest) {
          packageDigest = await computeSkillPackageFingerprint(join(input.userSkillsDir, id));
          userPackageDigests.set(id, packageDigest);
        }
        const allDigests = [...provenance.digests, ...provenance.legacyDigests];
        if (allDigests.includes(userDigest) || allDigests.includes(packageDigest)) {
          managed.add(id);
          continue;
        }

        // 旧版 contentDigest 把 node_modules/__pycache__/.DS_Store 也纳入哈希，
        // 而旧副本物化时已丢弃这些文件，无法从旧 SHA-256 反推出新的摘要。
        // 治理历史中的 legacySkillId + 旧摘要是可信的租户归属凭据，因此仅在
        // 个人治理 provenance 已可靠读取且未占用该 legacySkillId 时做一次性迁移。
        if (provenance.legacyDigests.length > 0 && personalOwnershipReliable) {
          managed.add(id);
        }
      } catch {
        // 用户副本含软链接或治理历史摘要无法比对时不作 ownership 推断。
      }
    }
  }

  return managed;
}
