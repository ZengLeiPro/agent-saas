import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { resolveUserCwd } from '../workspace/resolver.js';
import { resolveAgentPath } from '../workspace/namespace.js';
import { SAFE_SKILL_NAME_RE } from './runtimeSetupHelpers.js';
import { resolveTenantSkillsDirFromRoot } from '../data/tenants/tenantSkillsPath.js';
import { TENANT_SLUG_PATTERN } from '../data/tenants/types.js';
import { scanUserCustomSkillsAsync } from '../data/skills/scanner.js';

interface SkillPruneUser {
  id: string;
  username: string;
  role: string;
  tenantId?: string;
}

export async function collectSkillPruneInventory(input: {
  users: readonly SkillPruneUser[];
  agentCwd: string;
  tenantSkillsRootDir: string;
  currentPoolIds: Set<string>;
}): Promise<{
  tenantOwnIdsByTenant: Record<string, Set<string>>;
  personalSkillIdsByUsername: Record<string, Set<string>>;
}> {
  const { users, agentCwd, tenantSkillsRootDir, currentPoolIds } = input;
  const tenantOwnIdsByTenant: Record<string, Set<string>> = {};
  if (existsSync(tenantSkillsRootDir)) {
    for (const entry of await readdir(tenantSkillsRootDir, { withFileTypes: true })) {
      try {
        if (!entry.isDirectory() || !TENANT_SLUG_PATTERN.test(entry.name)) continue;
        const tenantSkillDir = resolveTenantSkillsDirFromRoot(tenantSkillsRootDir, entry.name);
        tenantOwnIdsByTenant[entry.name] = new Set(
          (await readdir(tenantSkillDir, { withFileTypes: true }))
            .filter((skill) => (
              skill.isDirectory()
              && SAFE_SKILL_NAME_RE.test(skill.name)
              && !currentPoolIds.has(skill.name)
            ))
            .map((skill) => skill.name),
        );
      } catch {
        // 非法目录名或读取失败，跳过。
      }
    }
  }

  const personalSkillIdsByUsername: Record<string, Set<string>> = {};
  for (const user of users) {
    const userCwd = resolveUserCwd(agentCwd, {
      ...user,
      role: user.role as 'admin' | 'user',
    });
    const excluded = new Set([
      ...currentPoolIds,
      ...(user.tenantId ? (tenantOwnIdsByTenant[user.tenantId] ?? new Set<string>()) : []),
    ]);
    personalSkillIdsByUsername[user.username] = new Set(
      (await scanUserCustomSkillsAsync(resolveAgentPath(userCwd, 'skills'), excluded))
        .map((skill) => skill.id),
    );
  }
  return { tenantOwnIdsByTenant, personalSkillIdsByUsername };
}
