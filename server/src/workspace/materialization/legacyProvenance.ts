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

export interface LegacyTenantSkillDetectionResult {
  /** 可以确认属于外租户的旧目录；不包含个人所有权不确定的候选。 */
  managedIds: Set<string>;
  /** 历史治理查询失败，下一轮必须继续尝试旧目录迁移。 */
  retryable: boolean;
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
): Promise<LegacyTenantSkillDetectionResult> {
  if (!await hasLegacySkillsVersion(input.userCwd)) {
    return { managedIds: new Set(), retryable: false };
  }

  const userIds = await listDirectoryIds(input.userSkillsDir);
  for (const poolSkillId of input.poolSkillIds) userIds.delete(poolSkillId);
  if (userIds.size === 0) return { managedIds: new Set(), retryable: false };

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
  if (userDigests.size === 0) return { managedIds: new Set(), retryable: false };

  const userPackageDigests = new Map<string, string>();
  const managed = new Set<string>();
  let personalSkillIds = new Set<string>();
  let personalOwnershipReliable = false;
  if (input.resolveUserPersonalSkillIds && input.currentTenantId && input.userId) {
    try {
      const resolved = await input.resolveUserPersonalSkillIds(input.currentTenantId, input.userId);
      if (resolved && resolved.size > 0) {
        personalSkillIds = new Set(resolved);
        personalOwnershipReliable = true;
      }
      // 空集不是“没有个人 Skill”的证明：旧个人 Skill 可能从未进入治理表。
      // 只有拿到非空的个人治理 provenance，才允许对未命中的 legacySkillId 使用宽松迁移。
    } catch {
      // 无法确认个人治理 provenance 时，禁止使用旧摘要的宽松迁移兜底。
    }
  }
  let historicalProvenanceUnavailable = false;
  let tenantEntries;
  try {
    tenantEntries = await readdir(input.tenantsRootDir, { withFileTypes: true });
  } catch {
    return { managedIds: managed, retryable: false };
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
      try {
        historicalProvenance = await input.resolveTenantSkillHistoricalProvenance(tenantEntry.name);
      } catch {
        historicalProvenanceUnavailable = true;
        // 不把查询失败伪装成空历史；本轮不做宽松迁移，并通过 retryable 让
        // materializer 保留迁移状态，下一轮继续查询。
      }
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
        // 治理历史中的 legacySkillId + 旧摘要只能在个人治理查询给出正向 provenance
        // 且未占用该 legacySkillId 时作为一次性迁移凭据；空集或未配置都视为不确定。
        if (provenance.legacyDigests.length > 0 && personalOwnershipReliable) {
          managed.add(id);
        }
      } catch {
        // 用户副本含软链接或治理历史摘要无法比对时不作 ownership 推断。
      }
    }
  }

  return {
    managedIds: managed,
    retryable: historicalProvenanceUnavailable,
  };
}
