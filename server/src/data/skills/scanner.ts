import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { serverLogger } from '../../utils/logger.js';
import type { PoolSkillMeta } from './types.js';

/**
 * 解析 SKILL.md 的 YAML frontmatter，提取 name 和 description。
 * 不引入外部依赖，简单正则解析。
 */
export function parseSkillFrontmatter(content: string): { name: string; description: string } | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;

  const block = match[1];
  let name = '';
  let description = '';

  for (const line of block.split('\n')) {
    const nameMatch = line.match(/^name:\s*"?(.*?)"?\s*$/);
    if (nameMatch) {
      name = nameMatch[1];
      continue;
    }
    const descMatch = line.match(/^description:\s*"?(.*?)"?\s*$/);
    if (descMatch) {
      description = descMatch[1];
    }
  }

  return name ? { name, description } : null;
}

/**
 * 从 skill 目录中读取 frontmatter。
 * 优先 SKILL.md，其次 {dirName}.md，最后目录内唯一的 .md 文件。
 *
 * @param strict 严格模式：找不到有效 frontmatter 时返回 null 而非 fallback。
 *               用于 custom skill 扫描，避免把评测目录/临时目录误识别为 skill。
 */
function readSkillMeta(skillDir: string, dirName: string, strict = false): { name: string; description: string } | null {
  // 1. SKILL.md
  const skillMdPath = join(skillDir, 'SKILL.md');
  if (existsSync(skillMdPath)) {
    const parsed = parseSkillFrontmatter(readFileSync(skillMdPath, 'utf-8'));
    if (parsed) return parsed;
  }

  // 2. {dirName}.md
  const namedMdPath = join(skillDir, `${dirName}.md`);
  if (existsSync(namedMdPath)) {
    const parsed = parseSkillFrontmatter(readFileSync(namedMdPath, 'utf-8'));
    if (parsed) return parsed;
  }

  // 3. 唯一 .md 文件
  try {
    const mdFiles = readdirSync(skillDir).filter(f => f.endsWith('.md') && !f.startsWith('.'));
    if (mdFiles.length === 1) {
      const parsed = parseSkillFrontmatter(readFileSync(join(skillDir, mdFiles[0]), 'utf-8'));
      if (parsed) return parsed;
    }
  } catch { /* ignore */ }

  if (strict) {
    serverLogger.debug(`Skipping directory '${dirName}': no valid SKILL.md frontmatter found`);
    return null;
  }
  return { name: dirName, description: '' };
}

/**
 * 扫描 skills-pool 目录，返回所有 pool skill 的元数据。
 */
export function scanPoolSkills(poolDir: string): PoolSkillMeta[] {
  if (!existsSync(poolDir)) return [];

  const entries = readdirSync(poolDir).filter(d => {
    if (d.startsWith('_') || d.startsWith('.')) return false;
    try { return statSync(join(poolDir, d)).isDirectory(); } catch { return false; }
  });

  return entries
    .map(dirName => {
      // strict=false（默认）：pool skill 允许 fallback，不会返回 null
      const meta = readSkillMeta(join(poolDir, dirName), dirName)!;
      return { id: dirName, ...meta };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 扫描租户自有 skill 目录（tenants/<tenantId>/skills/），返回现存 skill ID 集合。
 * 与 pool 同名的目录被 shadow（pool 优先），不返回。
 * 只看目录名，不校验 frontmatter——内容合法性由上传/promote 入口保证。
 */
export function scanTenantOwnSkillIds(tenantSkillsDir: string, poolSkillIds: Set<string>): Set<string> {
  if (!existsSync(tenantSkillsDir)) return new Set();
  return new Set(readdirSync(tenantSkillsDir).filter(d => {
    if (d.startsWith('.') || d.startsWith('_')) return false;
    if (poolSkillIds.has(d)) return false;
    try { return statSync(join(tenantSkillsDir, d)).isDirectory(); } catch { return false; }
  }));
}

/**
 * 扫描用户的 .ky-agent/skills/ 目录，找出不在 pool 中的自建 skill。
 * 严格模式：要求有效 SKILL.md frontmatter，避免评测目录/临时目录被误识别。
 */
export function scanUserCustomSkills(
  userSkillsDir: string,
  poolSkillIds: Set<string>,
): PoolSkillMeta[] {
  if (!existsSync(userSkillsDir)) return [];

  const entries = readdirSync(userSkillsDir).filter(d => {
    if (d.startsWith('.')) return false;
    if (poolSkillIds.has(d)) return false;
    try { return statSync(join(userSkillsDir, d)).isDirectory(); } catch { return false; }
  });

  return entries
    .map(dirName => {
      const meta = readSkillMeta(join(userSkillsDir, dirName), dirName, true);
      if (!meta) return null;
      return { id: dirName, ...meta };
    })
    .filter((item): item is PoolSkillMeta => item !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
}
