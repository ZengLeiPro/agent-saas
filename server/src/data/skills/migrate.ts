import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { serverLogger } from '../../utils/logger.js';
import type { SkillConfigStore } from './store.js';

interface OldManifest {
  roles: Record<string, string[]>;
  users: Record<string, { roles: string[] }>;
}

/**
 * 从旧 _manifest.json 迁移到 SkillConfigStore。
 * 仅在 skills-config.json 不存在时调用。
 */
export function migrateFromManifest(
  store: SkillConfigStore,
  poolDir: string,
  allUsernames: string[],
): void {
  const manifestPath = join(poolDir, '_manifest.json');

  // 获取 pool 中所有 skill ID
  const poolSkillIds = new Set<string>();
  if (existsSync(poolDir)) {
    for (const d of readdirSync(poolDir)) {
      if (d.startsWith('_') || d.startsWith('.')) continue;
      try { if (statSync(join(poolDir, d)).isDirectory()) poolSkillIds.add(d); } catch { /* skip */ }
    }
  }

  // poolVisibility: 所有 pool skill 默认 visible
  const poolVisibility: Record<string, boolean> = {};
  for (const id of poolSkillIds) {
    poolVisibility[id] = true;
  }

  // 用户的 selectedSkills
  const users: Record<string, { selectedSkills: string[] }> = {};

  if (existsSync(manifestPath)) {
    try {
      const manifest: OldManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

      // 为 manifest 中列出的用户展开 roles → skills
      for (const [username, config] of Object.entries(manifest.users)) {
        const skills = new Set<string>();
        for (const role of config.roles) {
          const roleSkills = manifest.roles[role];
          if (roleSkills) {
            for (const s of roleSkills) {
              if (poolSkillIds.has(s)) skills.add(s);
            }
          }
        }
        users[username] = { selectedSkills: Array.from(skills).sort() };
      }

      // 不在 manifest 中的用户，按 'core' 角色初始化
      const coreSkills = manifest.roles['core'] ?? [];
      for (const username of allUsernames) {
        if (!users[username]) {
          users[username] = {
            selectedSkills: coreSkills.filter(s => poolSkillIds.has(s)).sort(),
          };
        }
      }

      serverLogger.info(`Migrated skills config from _manifest.json (${Object.keys(users).length} users, ${poolSkillIds.size} pool skills)`);
    } catch (err) {
      serverLogger.warn(`Failed to parse _manifest.json during migration: ${err}`);
      // 回退：所有用户选中全部 visible skill
      for (const username of allUsernames) {
        users[username] = { selectedSkills: Array.from(poolSkillIds).sort() };
      }
    }
  } else {
    // 无 manifest：所有用户选中全部 skill
    for (const username of allUsernames) {
      users[username] = { selectedSkills: Array.from(poolSkillIds).sort() };
    }
    serverLogger.info(`No _manifest.json found, initialized all users with all ${poolSkillIds.size} pool skills`);
  }

  store.initializeFrom(poolVisibility, users);
}
