import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
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

async function readSkillMetaAsync(
  skillDir: string,
  dirName: string,
  strict = false,
): Promise<{ name: string; description: string } | null> {
  for (const fileName of ['SKILL.md', `${dirName}.md`]) {
    try {
      const parsed = parseSkillFrontmatter(await readFile(join(skillDir, fileName), 'utf-8'));
      if (parsed) return parsed;
    } catch {
      // 继续尝试下一种历史文档命名。
    }
  }
  try {
    const mdFiles = (await readdir(skillDir))
      .filter((file) => file.endsWith('.md') && !file.startsWith('.'));
    if (mdFiles.length === 1) {
      const parsed = parseSkillFrontmatter(
        await readFile(join(skillDir, mdFiles[0]), 'utf-8'),
      );
      if (parsed) return parsed;
    }
  } catch {
    // 由 strict/fallback 规则统一收口。
  }
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

/** 请求/后台路径使用的非阻塞版本；语义与 scanPoolSkills 完全一致。 */
export async function scanPoolSkillsAsync(poolDir: string): Promise<PoolSkillMeta[]> {
  let entries;
  try {
    entries = await readdir(poolDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const directories = entries
    .filter((entry) => (
      entry.isDirectory()
      && !entry.name.startsWith('_')
      && !entry.name.startsWith('.')
    ))
    .map((entry) => entry.name);
  const skills = await Promise.all(directories.map(async (dirName) => ({
    id: dirName,
    ...(await readSkillMetaAsync(join(poolDir, dirName), dirName))!,
  })));
  return skills.sort((a, b) => a.id.localeCompare(b.id));
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
 * 扫描所有租户的自有 skill ID。
 *
 * 用户 workspace 里的组织 skill 是物化副本；历史版本或迁移异常可能留下不属于
 * 当前租户的副本。调用方可用该集合把这类副本从个人 skill 视图/选择集合中排除，
 * 避免把组织 skill 误判为用户自建 skill。
 */
export function scanAllTenantOwnSkillIds(
  tenantsRootDir: string,
  poolSkillIds: Set<string>,
): Set<string> {
  if (!existsSync(tenantsRootDir)) return new Set();
  const result = new Set<string>();
  let entries;
  try {
    entries = readdirSync(tenantsRootDir, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    for (const skillId of scanTenantOwnSkillIds(join(tenantsRootDir, entry.name, 'skills'), poolSkillIds)) {
      result.add(skillId);
    }
  }
  return result;
}

/** 请求/后台路径使用的非阻塞版本；只扫描一级目录。 */
export async function scanTenantOwnSkillIdsAsync(
  tenantSkillsDir: string,
  poolSkillIds: Set<string>,
): Promise<Set<string>> {
  let entries;
  try {
    entries = await readdir(tenantSkillsDir, { withFileTypes: true });
  } catch {
    return new Set();
  }
  return new Set(entries
    .filter((entry) => (
      entry.isDirectory()
      && !entry.name.startsWith('.')
      && !entry.name.startsWith('_')
      && !poolSkillIds.has(entry.name)
    ))
    .map((entry) => entry.name));
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

/** 请求路径使用的非阻塞版本；严格 frontmatter 规则与同步版本一致。 */
export async function scanUserCustomSkillsAsync(
  userSkillsDir: string,
  poolSkillIds: Set<string>,
): Promise<PoolSkillMeta[]> {
  let entries;
  try {
    entries = await readdir(userSkillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const directories = entries
    .filter((entry) => (
      entry.isDirectory()
      && !entry.name.startsWith('.')
      && !poolSkillIds.has(entry.name)
    ))
    .map((entry) => entry.name);
  const skills = await Promise.all(directories.map(async (dirName) => {
    const meta = await readSkillMetaAsync(join(userSkillsDir, dirName), dirName, true);
    return meta ? { id: dirName, ...meta } : null;
  }));
  return skills
    .filter((item): item is PoolSkillMeta => item !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
}
