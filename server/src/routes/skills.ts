import { basename, dirname, join } from 'node:path';
import { existsSync, cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import multer from 'multer';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { requireAdmin, requirePlatformAdmin, isPlatformAdmin } from '../auth/middleware.js';
import { auditLog } from '../data/login-logs/index.js';
import type { SkillConfigStore } from '../data/skills/store.js';
import type { PlatformSkillConfig, TenantSkillRule } from '../data/skills/types.js';
import { scanPoolSkills, scanUserCustomSkills } from '../data/skills/scanner.js';
import { resolveUserCwd, syncSkills } from '../workspace/resolver.js';
import { agentDir, agentPath, agentSkillsDir, resolveAgentPath } from '../workspace/namespace.js';
import { ensureWorkspaceDir, repairWorkspacePath, repairWorkspaceTree } from '../workspace/permissions.js';
import type { UserStore } from '../data/users/store.js';
import type { UserInfo, UserRecord } from '../data/users/types.js';
/** getUserSkillsDir/buildUserSkillsResponse 只用 id/username/role/tenantId，
 * UserInfo（无 passwordHash）与 UserRecord 都满足。 */
type SkillUser = Pick<UserInfo, 'id' | 'username' | 'role' | 'tenantId'>;
import { serverLogger } from '../utils/logger.js';

export interface SkillsRouterDeps {
  skillConfigStore: SkillConfigStore;
  userStore: UserStore;
  agentCwd: string;
  sharedDir: string;
}

export function createSkillsRouter(deps: SkillsRouterDeps): Router {
  const { skillConfigStore, userStore, agentCwd, sharedDir } = deps;
  const router = Router();

  const poolDir = resolveAgentPath(sharedDir, 'skills-pool');
  const skillUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024, files: 300 },
  });

  // ── Helper ─────────────────────────────────────────────

  /**
   * 校验名称：必须 ^[a-zA-Z][a-zA-Z0-9_-]{0,63}$。
   * δ 阶段强化：拒绝以 `.` 开头的隐藏目录（如 `.env`、`.git`）、`_` 开头、任何
   * 包含 path traversal 字符的名字。与 SkillToolProvider.isSafeSkillName 同口径。
   */
  const SAFE_SKILL_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
  function safeName(name: string): string | null {
    return SAFE_SKILL_NAME_RE.test(name) ? name : null;
  }

  function getPoolSkillIds(): Set<string> {
    return new Set(scanPoolSkills(poolDir).map(s => s.id));
  }

  function getKnownSystemSkillIds(): Set<string> {
    return new Set([
      ...getPoolSkillIds(),
      ...Object.keys(skillConfigStore.getPoolVisibility()),
    ]);
  }

  /**
   * 用户的 `.ky-agent/skills` 目录。workspace 物理路径由 resolveUserCwd 统一决定；
   * 本路由原代码仍用旧扁平路径 `<cwd>/<username>`，
   * 导致非默认组织用户读不到自建 skill / 写到错路径。修复方式：要求 caller 传完
   * 整 UserRecord（含 tenantId），用 resolveUserCwd 统一解析。
   */
  function getUserSkillsDir(user: SkillUser): string {
    const userCwd = resolveUserCwd(agentCwd, { id: user.id, username: user.username, role: user.role as 'admin' | 'user', tenantId: user.tenantId });
    return agentSkillsDir(userCwd);
  }

  /**
   * 跨组织访问 target user 校验（与 routes/mcp.ts resolveTargetUser、
   * routes/agents.ts authorizeAgentAccess 同范式）。
   * 平台 admin 任意；组织 admin 仅本组织用户；非 admin 调用方不应到达这里
   * （路由用 requireAdmin 已挡住）。
   */
  function resolveAdminTargetUser(req: Request, res: Response, username: string): UserRecord | null {
    const target = userStore.findByUsername(username);
    if (!target) {
      res.status(404).json({ error: 'User not found' });
      return null;
    }
    if (!isPlatformAdmin(req.user) && target.tenantId !== req.user?.tenantId) {
      res.status(403).json({ error: '跨组织访问被拒绝' });
      return null;
    }
    return target;
  }

  function resolveAdminTargetTenantId(req: Request, res: Response, tenantIdParam: string): string | null {
    const tenantId = safeName(tenantIdParam);
    if (!tenantId) {
      res.status(400).json({ error: 'Invalid tenantId' });
      return null;
    }
    if (!isPlatformAdmin(req.user) && tenantId !== req.user?.tenantId) {
      res.status(403).json({ error: '跨组织访问被拒绝' });
      return null;
    }
    return tenantId;
  }

  function platformPoolSkillsForTenant(tenantId?: string) {
    const poolSkills = scanPoolSkills(poolDir);
    return poolSkills
      .map(s => ({
        ...s,
        settings: skillConfigStore.getPlatformSkillConfig(s.id),
      }))
      .filter(s => skillConfigStore.isPoolSkillAvailableToTenant(s.id, tenantId));
  }

  function getSkillDocPath(skillDir: string, skillId: string): string {
    const skillMdPath = join(skillDir, 'SKILL.md');
    if (existsSync(skillMdPath)) return skillMdPath;

    const namedMdPath = join(skillDir, `${skillId}.md`);
    if (existsSync(namedMdPath)) return namedMdPath;

    try {
      const mdFiles = readdirSync(skillDir).filter((f) => f.endsWith('.md') && !f.startsWith('.'));
      if (mdFiles.length === 1) return join(skillDir, mdFiles[0]);
    } catch {
      /* ignore */
    }

    return skillMdPath;
  }

  async function readSkillDocument(skillDir: string, skillId: string): Promise<{ content: string; fileName: string }> {
    const docPath = getSkillDocPath(skillDir, skillId);
    if (!existsSync(docPath)) return { content: '', fileName: 'SKILL.md' };
    const content = await readFile(docPath, 'utf-8');
    return { content, fileName: basename(docPath) || 'SKILL.md' };
  }


  function validateSkillDocument(content: string): { name: string; description: string } | null {
    const parsed = scanSkillFrontmatter(content);
    if (!parsed?.name || !parsed.description) return null;
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(parsed.name)) return null;
    if (parsed.description.length > 1024) return null;
    return parsed;
  }

  function scanSkillFrontmatter(content: string): { name: string; description: string } | null {
    const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!match) return null;
    let name = '';
    let description = '';
    for (const line of match[1].split('\n')) {
      const nameMatch = line.match(/^name:\s*["']?(.*?)["']?\s*$/);
      if (nameMatch) name = nameMatch[1].trim();
      const descMatch = line.match(/^description:\s*["']?(.*?)["']?\s*$/);
      if (descMatch) description = descMatch[1].trim();
    }
    return name ? { name, description } : null;
  }

  function skillIdFromName(name: string): string | null {
    return safeName(name);
  }

  function safeRelativePath(name: string): string | null {
    const normalized = name.replace(/\\/g, '/').split('/').filter(Boolean).join('/');
    if (!normalized || normalized.startsWith('.') || normalized.includes('../') || normalized.split('/').some(part => part === '..' || part.startsWith('.'))) return null;
    return normalized;
  }

  function findSkillRoot(dir: string): string | null {
    const direct = join(dir, 'SKILL.md');
    if (existsSync(direct) && statSync(direct).isFile()) return dir;
    const entries = readdirSync(dir).filter(name => !name.startsWith('.'));
    const matches = entries
      .map(name => join(dir, name))
      .filter(path => statSync(path).isDirectory() && existsSync(join(path, 'SKILL.md')));
    return matches.length === 1 ? matches[0] : null;
  }

  function installUploadedSkill(req: Request, res: Response, sourceDir: string) {
    const username = req.user?.username;
    if (!username) return res.status(401).json({ error: 'Not authenticated' });
    const user = userStore.findByUsername(username);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const skillRoot = findSkillRoot(sourceDir);
    if (!skillRoot) return res.status(400).json({ error: '上传内容根目录或唯一一级目录中必须包含 SKILL.md' });

    const skillDoc = readFileSync(join(skillRoot, 'SKILL.md'), 'utf-8');
    const meta = validateSkillDocument(skillDoc);
    if (!meta) return res.status(400).json({ error: 'SKILL.md 必须包含 YAML frontmatter，name 需为小写字母/数字/连字符且 description 非空' });

    const skillId = skillIdFromName(meta.name);
    if (!skillId) return res.status(400).json({ error: 'SKILL.md 的 name 不能转换为有效 skill ID' });

    const userSkillsDir = getUserSkillsDir(user);
    const targetDir = join(userSkillsDir, skillId);
    if (existsSync(targetDir)) return res.status(409).json({ error: `Skill '${skillId}' 已存在` });

    ensureWorkspaceDir(userSkillsDir, 0o775);
    renameSync(skillRoot, targetDir);
    repairWorkspaceTree(targetDir);
    auditLog(req, 'skill_custom_uploaded', `${username}/${skillId}`);
    res.json({ ok: true, skill: { id: skillId, name: meta.name, description: meta.description } });
  }

  async function writeSkillDocument(skillDir: string, skillId: string, content: string): Promise<{ fileName: string }> {
    ensureWorkspaceDir(skillDir, 0o775);
    const docPath = getSkillDocPath(skillDir, skillId);
    await writeFile(docPath, content, 'utf-8');
    repairWorkspacePath(docPath, 0o664);
    return { fileName: basename(docPath) || 'SKILL.md' };
  }

  // ── Admin: Pool management ─────────────────────────────

  /** GET /pool — platform admin 列出完整 pool；组织 admin 仅列出可见 skill */
  router.get('/pool', requireAdmin, (req, res) => {
    try {
      const poolSkills = scanPoolSkills(poolDir);
      const platform = isPlatformAdmin(req.user);
      const skills = poolSkills
        .map(s => {
          const settings = skillConfigStore.getPlatformSkillConfig(s.id);
          return {
            ...s,
            enabled: settings.enabled,
            visible: settings.enabled, // 兼容旧前端字段名
            exposure: settings.exposure,
            tenantIds: settings.tenantIds,
          };
        })
        .filter(s => platform || skillConfigStore.isPoolSkillAvailableToTenant(s.id, req.user?.tenantId));
      res.json({ skills });
    } catch (err) {
      serverLogger.error(`GET /pool error: ${err}`);
      res.status(500).json({ error: 'Failed to scan skill pool' });
    }
  });

  /** PATCH /pool/visibility — 批量更新可见性 */
  const visibilitySchema = z.record(z.string(), z.boolean());
  const platformSkillSettingsSchema = z.record(z.string(), z.object({
    enabled: z.boolean(),
    exposure: z.enum(['all', 'allow_tenants', 'deny_tenants']),
    tenantIds: z.array(z.string()).default([]),
  }));
  const tenantSelectionsSchema = z.object({
    enabledSkills: z.array(z.string()),
  });
  const tenantSkillSettingsSchema = z.record(z.string(), z.object({
    enabled: z.boolean(),
    exposure: z.enum(['all', 'allow_users', 'deny_users']),
    usernames: z.array(z.string()).default([]),
  }));
  const skillDocumentSchema = z.object({
    content: z.string().max(300000),
  });

  /** GET /pool/:skillId/document — 读取 pool skill 文档 */
  router.get('/pool/:skillId/document', requireAdmin, async (req, res) => {
    const skillId = safeName(req.params.skillId);
    if (!skillId) return res.status(400).json({ error: 'Invalid skillId' });

    // δ: skillId 必须 ∈ scanPoolSkills 视图，避免 admin 编辑非注册目录（如
    // 误放在 pool 下的 .env/.tmp/READMEs）
    if (!getPoolSkillIds().has(skillId)) {
      return res.status(404).json({ error: `Skill '${skillId}' not registered in pool` });
    }
    const skillDir = join(poolDir, skillId);
    if (!existsSync(skillDir)) {
      return res.status(404).json({ error: `Skill '${skillId}' not found in pool` });
    }

    try {
      const doc = await readSkillDocument(skillDir, skillId);
      res.json({ skillId, source: 'pool', ...doc });
    } catch (err) {
      serverLogger.error(`GET /pool/${skillId}/document error: ${err}`);
      res.status(500).json({ error: 'Failed to read skill document' });
    }
  });

  /**
   * PUT /pool/:skillId/document — 写入 pool skill 文档
   * 多组织改造：pool 是平台共享资源，写操作仅平台 admin。
   * 组织 admin 不能动其他组织也在用的 skill 文档（譬如改 SKILL.md 影响 wain 用户）。
   */
  router.put('/pool/:skillId/document', requirePlatformAdmin, async (req, res) => {
    const skillId = safeName(req.params.skillId);
    if (!skillId) return res.status(400).json({ error: 'Invalid skillId' });

    const parsed = skillDocumentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid document', details: parsed.error.format() });
    }

    if (!getPoolSkillIds().has(skillId)) {
      return res.status(404).json({ error: `Skill '${skillId}' not registered in pool` });
    }
    const skillDir = join(poolDir, skillId);
    if (!existsSync(skillDir)) {
      return res.status(404).json({ error: `Skill '${skillId}' not found in pool` });
    }

    try {
      const doc = await writeSkillDocument(skillDir, skillId, parsed.data.content);
      await skillConfigStore.touchConfigVersion();
      auditLog(req, 'skill_document_updated', `pool/${skillId}`);
      res.json({ ok: true, skillId, source: 'pool', ...doc });
    } catch (err) {
      serverLogger.error(`PUT /pool/${skillId}/document error: ${err}`);
      res.status(500).json({ error: 'Failed to write skill document' });
    }
  });

  /** PATCH /pool/visibility — 全局可见性，仅平台 admin */
  router.patch('/pool/visibility', requirePlatformAdmin, async (req, res) => {
    const parsed = visibilitySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid visibility data', details: parsed.error.format() });
    }
    try {
      await skillConfigStore.setPoolVisibility(parsed.data);
      auditLog(req, 'skill_visibility_updated', JSON.stringify(parsed.data));
      res.json({ ok: true });
    } catch (err) {
      serverLogger.error(`PATCH /pool/visibility error: ${err}`);
      res.status(500).json({ error: 'Failed to update visibility' });
    }
  });

  /** PATCH /pool/settings — 平台级 skill 启用与租户开放范围，仅平台 admin */
  router.patch('/pool/settings', requirePlatformAdmin, async (req, res) => {
    const parsed = platformSkillSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid platform skill settings', details: parsed.error.format() });
    }
    try {
      const poolIds = getPoolSkillIds();
      const updates: Record<string, PlatformSkillConfig> = {};
      for (const [skillId, settings] of Object.entries(parsed.data)) {
        if (!poolIds.has(skillId)) continue;
        const tenantIds = settings.tenantIds.filter((id): id is string => !!safeName(id));
        updates[skillId] = {
          enabled: settings.enabled,
          exposure: settings.exposure,
          tenantIds,
        };
      }
      await skillConfigStore.setPlatformSkillConfigs(updates);
      auditLog(req, 'skill_platform_settings_updated', JSON.stringify(Object.keys(updates)));
      res.json({ ok: true });
    } catch (err) {
      serverLogger.error(`PATCH /pool/settings error: ${err}`);
      res.status(500).json({ error: 'Failed to update platform skill settings' });
    }
  });

  /** GET /tenants/:tenantId/pool — 租户可管理的平台已开放 skill */
  router.get('/tenants/:tenantId/pool', requireAdmin, (req, res) => {
    const tenantId = resolveAdminTargetTenantId(req, res, req.params.tenantId);
    if (!tenantId) return;
    try {
      const platformSkills = platformPoolSkillsForTenant(tenantId);
      const skills = platformSkills.map(s => {
        const rule = skillConfigStore.getTenantSkillRule(tenantId, s.id);
        return {
          id: s.id,
          name: s.name,
          description: s.description,
          enabled: rule.enabled,
          exposure: rule.exposure,
          usernames: rule.usernames,
        };
      });
      res.json({ tenantId, skills });
    } catch (err) {
      serverLogger.error(`GET /tenants/${tenantId}/pool error: ${err}`);
      res.status(500).json({ error: 'Failed to fetch tenant skills' });
    }
  });

  /** PUT /tenants/:tenantId/pool/selections — 更新租户启用的 skill */
  router.put('/tenants/:tenantId/pool/selections', requireAdmin, async (req, res) => {
    const tenantId = resolveAdminTargetTenantId(req, res, req.params.tenantId);
    if (!tenantId) return;
    const parsed = tenantSelectionsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid selections', details: parsed.error.format() });
    }
    try {
      const visibleIds = new Set(platformPoolSkillsForTenant(tenantId).map(s => s.id));
      const enabledSkills = parsed.data.enabledSkills.filter(id => visibleIds.has(id));
      await skillConfigStore.setTenantEnabledSkills(tenantId, enabledSkills);
      auditLog(req, 'skill_tenant_selections_updated', `${tenantId}: ${enabledSkills.length} skills`);
      res.json({ ok: true });
    } catch (err) {
      serverLogger.error(`PUT /tenants/${tenantId}/pool/selections error: ${err}`);
      res.status(500).json({ error: 'Failed to update tenant skills' });
    }
  });

  /** PUT /tenants/:tenantId/pool/settings — 更新租户启用与成员开放范围 */
  router.put('/tenants/:tenantId/pool/settings', requireAdmin, async (req, res) => {
    const tenantId = resolveAdminTargetTenantId(req, res, req.params.tenantId);
    if (!tenantId) return;
    const parsed = tenantSkillSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid tenant skill settings', details: parsed.error.format() });
    }
    try {
      const availableIds = new Set(platformPoolSkillsForTenant(tenantId).map(s => s.id));
      const tenantUsernames = new Set(
        userStore.listAll()
          .filter((u) => u.tenantId === tenantId)
          .map((u) => u.username),
      );
      const updates: Record<string, TenantSkillRule> = {};
      for (const [skillId, settings] of Object.entries(parsed.data)) {
        if (!availableIds.has(skillId)) continue;
        updates[skillId] = {
          enabled: settings.enabled,
          exposure: settings.exposure,
          usernames: settings.usernames.filter((username): username is string => tenantUsernames.has(username)),
        };
      }
      await skillConfigStore.setTenantSkillRules(tenantId, updates);
      auditLog(req, 'skill_tenant_settings_updated', `${tenantId}: ${Object.keys(updates).length} skills`);
      res.json({ ok: true });
    } catch (err) {
      serverLogger.error(`PUT /tenants/${tenantId}/pool/settings error: ${err}`);
      res.status(500).json({ error: 'Failed to update tenant skill settings' });
    }
  });

  // ── Admin: Custom skill management ─────────────────────

  /**
   * GET /custom — 所有用户的自建 skill
   * 多组织改造：platform admin 看全部用户；组织 admin 仅本组织用户。
   */
  router.get('/custom', requireAdmin, (req, res) => {
    try {
      const platform = isPlatformAdmin(req.user);
      const poolIds = getKnownSystemSkillIds();
      const users: Record<string, any[]> = {};
      for (const u of userStore.listAll()) {
        if (!platform && u.tenantId !== req.user?.tenantId) continue;
        const dir = getUserSkillsDir(u);
        const customSkills = scanUserCustomSkills(dir, poolIds);
        if (customSkills.length > 0) {
          users[u.username] = customSkills;
        }
      }
      res.json({ users });
    } catch (err) {
      serverLogger.error(`GET /custom error: ${err}`);
      res.status(500).json({ error: 'Failed to scan custom skills' });
    }
  });

  /**
   * POST /custom/:skillId/promote — 把用户自建 skill 提升到全局 pool
   * 多组织改造：promote 写 pool（平台资源），仅 platform admin。
   * 源用户也必须存在 + 路径按其组织解析。
   */
  const promoteSchema = z.object({ sourceUser: z.string().min(1) });

  router.post('/custom/:skillId/promote', requirePlatformAdmin, async (req, res) => {
    const skillId = safeName(req.params.skillId);
    if (!skillId) return res.status(400).json({ error: 'Invalid skillId' });
    const parsed = promoteSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'sourceUser is required' });
    }

    const sourceUsername = safeName(parsed.data.sourceUser);
    if (!sourceUsername) return res.status(400).json({ error: 'Invalid sourceUser' });
    const sourceUser = userStore.findByUsername(sourceUsername);
    if (!sourceUser) return res.status(404).json({ error: 'Source user not found' });
    const srcDir = join(getUserSkillsDir(sourceUser), skillId);
    const dstDir = join(poolDir, skillId);

    if (!existsSync(srcDir)) {
      return res.status(404).json({ error: `Skill '${skillId}' not found in ${sourceUsername}'s workspace` });
    }
    if (existsSync(dstDir)) {
      return res.status(409).json({ error: `Skill '${skillId}' already exists in pool` });
    }

    try {
      cpSync(srcDir, dstDir, { recursive: true, dereference: false });
      await skillConfigStore.setPoolVisibility({ [skillId]: true });
      auditLog(req, 'skill_promoted', `${skillId} from ${sourceUsername}`);
      res.json({ ok: true });
    } catch (err) {
      serverLogger.error(`POST /custom/${skillId}/promote error: ${err}`);
      res.status(500).json({ error: 'Failed to promote skill' });
    }
  });


  /** GET /custom/:username/:skillId/document — 管理员读取用户自建 skill 文档 */
  router.get('/custom/:username/:skillId/document', requireAdmin, async (req, res) => {
    const usernameParam = safeName(req.params.username);
    const skillId = safeName(req.params.skillId);
    if (!usernameParam || !skillId) return res.status(400).json({ error: 'Invalid username or skillId' });
    const target = resolveAdminTargetUser(req, res, usernameParam);
    if (!target) return;
    if (getKnownSystemSkillIds().has(skillId)) return res.status(400).json({ error: 'Pool skill documents must be managed via /pool' });

    const skillDir = join(getUserSkillsDir(target), skillId);
    if (!existsSync(skillDir)) return res.status(404).json({ error: `Skill '${skillId}' not found in ${target.username}'s workspace` });

    try {
      const doc = await readSkillDocument(skillDir, skillId);
      res.json({ skillId, source: 'custom', username: target.username, ...doc });
    } catch (err) {
      serverLogger.error(`GET /custom/${target.username}/${skillId}/document error: ${err}`);
      res.status(500).json({ error: 'Failed to read custom skill document' });
    }
  });

  /** PUT /custom/:username/:skillId/document — 管理员接管并写入用户自建 skill 文档 */
  router.put('/custom/:username/:skillId/document', requireAdmin, async (req, res) => {
    const usernameParam = safeName(req.params.username);
    const skillId = safeName(req.params.skillId);
    if (!usernameParam || !skillId) return res.status(400).json({ error: 'Invalid username or skillId' });
    const target = resolveAdminTargetUser(req, res, usernameParam);
    if (!target) return;
    if (getKnownSystemSkillIds().has(skillId)) return res.status(400).json({ error: 'Pool skill documents must be managed via /pool' });

    const parsed = skillDocumentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid document', details: parsed.error.format() });
    }
    const meta = validateSkillDocument(parsed.data.content);
    if (!meta) return res.status(400).json({ error: 'SKILL.md 必须包含 YAML frontmatter，name 需为小写字母/数字/连字符且 description 非空' });
    if (meta.name !== skillId) return res.status(400).json({ error: `SKILL.md name 必须与目录 ID '${skillId}' 保持一致` });

    const skillDir = join(getUserSkillsDir(target), skillId);
    if (!existsSync(skillDir)) return res.status(404).json({ error: `Skill '${skillId}' not found in ${target.username}'s workspace` });

    try {
      const doc = await writeSkillDocument(skillDir, skillId, parsed.data.content);
      auditLog(req, 'skill_document_updated', `custom/${target.username}/${skillId}`);
      res.json({ ok: true, skillId, source: 'custom', username: target.username, ...doc });
    } catch (err) {
      serverLogger.error(`PUT /custom/${target.username}/${skillId}/document error: ${err}`);
      res.status(500).json({ error: 'Failed to write custom skill document' });
    }
  });

  /**
   * DELETE /custom/:username/:skillId — 删除用户自建 skill
   * 多组织改造：platform admin 任意；组织 admin 仅本组织用户。
   */
  router.delete('/custom/:username/:skillId', requireAdmin, (req, res) => {
    const usernameParam = safeName(req.params.username);
    const skillId = safeName(req.params.skillId);
    if (!usernameParam || !skillId) return res.status(400).json({ error: 'Invalid username or skillId' });
    const target = resolveAdminTargetUser(req, res, usernameParam);
    if (!target) return;
    const poolIds = getKnownSystemSkillIds();

    if (poolIds.has(skillId)) {
      return res.status(400).json({ error: 'Cannot delete a pool skill via this endpoint' });
    }

    const skillDir = join(getUserSkillsDir(target), skillId);
    if (!existsSync(skillDir)) {
      return res.status(404).json({ error: `Skill '${skillId}' not found in ${target.username}'s workspace` });
    }

    try {
      rmSync(skillDir, { recursive: true, force: true });
      auditLog(req, 'skill_custom_deleted', `${target.username}/${skillId}`);
      res.json({ ok: true });
    } catch (err) {
      serverLogger.error(`DELETE /custom/${target.username}/${skillId} error: ${err}`);
      res.status(500).json({ error: 'Failed to delete custom skill' });
    }
  });

  // ── Admin: Force sync ──────────────────────────────────

  /**
   * POST /sync — 强制重新同步
   * 多组织改造：
   *   - 单用户同步：platform admin 任意；组织 admin 仅本组织
   *   - 全量同步：platform admin 同步全部用户；组织 admin 仅同步本组织用户
   *   - 路径按 user.tenantId 解析（修 PR 4 漏改）
   */
  router.post('/sync', requireAdmin, (req, res) => {
    const rawUsername = typeof req.query.username === 'string' ? req.query.username : undefined;
    const platform = isPlatformAdmin(req.user);
    try {
      const currentPoolIds = getPoolSkillIds();
      if (currentPoolIds.size === 0) {
        return res.status(409).json({ error: 'Skills pool is empty or missing; refusing to sync' });
      }

      const discovered = platform ? skillConfigStore.syncWithPool(currentPoolIds) : 0;
      const syncedWorkspaces: string[] = [];
      const writeVersion = (userCwd: string, configVersion: string) => {
        const vf = agentPath(userCwd, '.skills-version');
        if (existsSync(agentDir(userCwd))) writeFileSync(vf, configVersion, 'utf-8');
      };

      if (rawUsername) {
        const usernameSafe = safeName(rawUsername);
        if (!usernameSafe) return res.status(400).json({ error: 'Invalid username' });
        const user = resolveAdminTargetUser(req, res, usernameSafe);
        if (!user) return;
        const userCwd = resolveUserCwd(agentCwd, { id: user.id, username: user.username, role: user.role as 'admin' | 'user', tenantId: user.tenantId });
        if (!existsSync(agentDir(userCwd))) {
          return res.status(404).json({ error: 'User workspace not initialized' });
        }
        syncSkills(userCwd, sharedDir, { id: user.id, username: user.username, role: user.role as 'admin' | 'user', tenantId: user.tenantId }, skillConfigStore);
        syncedWorkspaces.push(userCwd);
        const configVersion = String(skillConfigStore.getConfigVersion());
        for (const cwd of syncedWorkspaces) writeVersion(cwd, configVersion);
        res.json({ ok: true, synced: [user.username], discovered, pruned: 0 });
      } else {
        const synced: string[] = [];
        for (const u of userStore.listAll()) {
          if (!platform && u.tenantId !== req.user?.tenantId) continue;
          const userCwd = resolveUserCwd(agentCwd, { id: u.id, username: u.username, role: u.role as 'admin' | 'user', tenantId: u.tenantId });
          if (existsSync(agentDir(userCwd))) {
            syncSkills(userCwd, sharedDir, { id: u.id, username: u.username, role: u.role as 'admin' | 'user', tenantId: u.tenantId }, skillConfigStore);
            syncedWorkspaces.push(userCwd);
            synced.push(u.username);
          }
        }
        const pruned = platform ? skillConfigStore.pruneStaleSkills(currentPoolIds) : 0;
        const configVersion = String(skillConfigStore.getConfigVersion());
        for (const cwd of syncedWorkspaces) writeVersion(cwd, configVersion);
        res.json({ ok: true, synced, discovered, pruned });
      }
    } catch (err) {
      serverLogger.error(`POST /sync error: ${err}`);
      res.status(500).json({ error: 'Failed to sync skills' });
    }
  });

  // ── User self-service ──────────────────────────────────

  /** GET /me — 当前用户的 skill 状态 */
  router.get('/me', (req, res) => {
    const username = req.user?.username;
    if (!username) return res.status(401).json({ error: 'Not authenticated' });
    const user = userStore.findByUsername(username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    try {
      res.json(buildUserSkillsResponse(user));
    } catch (err) {
      serverLogger.error(`GET /me error: ${err}`);
      res.status(500).json({ error: 'Failed to fetch skills' });
    }
  });


  router.post('/me/import', skillUpload.array('files', 300), (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) || [];
    if (files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

    const tempRoot = mkdtempSync(join(tmpdir(), 'skill-import-'));
    try {
      const first = files[0];
      const firstName = first.originalname.toLowerCase();
      if (files.length === 1 && firstName.endsWith('.zip')) {
        const zipPath = join(tempRoot, 'upload.zip');
        writeFileSync(zipPath, first.buffer);
        const zipEntries = execFileSync('unzip', ['-Z', '-1', zipPath], { encoding: 'utf-8' }).split('\n').filter(Boolean);
        if (zipEntries.some(entry => !safeRelativePath(entry))) {
          return res.status(400).json({ error: 'zip 内包含不安全路径' });
        }
        const extractDir = join(tempRoot, 'extracted');
        mkdirSync(extractDir, { recursive: true });
        execFileSync('unzip', ['-q', zipPath, '-d', extractDir], { stdio: 'ignore' });
        return installUploadedSkill(req, res, extractDir);
      }

      const uploadDir = join(tempRoot, 'upload');
      for (const file of files) {
        const relPath = safeRelativePath(file.originalname);
        if (!relPath) return res.status(400).json({ error: `Invalid file path: ${file.originalname}` });
        const target = join(uploadDir, relPath);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file.buffer);
      }
      return installUploadedSkill(req, res, uploadDir);
    } catch (err) {
      serverLogger.error(`POST /me/import error: ${err}`);
      return res.status(500).json({ error: 'Failed to import skill' });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  /** PUT /me/selections — 更新当前用户的 skill 选择 */
  const selectionsSchema = z.object({
    selectedSkills: z.array(z.string()),
  });

  router.put('/me/selections', async (req, res) => {
    const username = req.user?.username;
    if (!username) return res.status(401).json({ error: 'Not authenticated' });
    const user = userStore.findByUsername(username);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const parsed = selectionsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid selections', details: parsed.error.format() });
    }

    try {
      const poolIds = getPoolSkillIds();
      const validSkills = parsed.data.selectedSkills.filter(
        id => poolIds.has(id) && skillConfigStore.isTenantSkillAvailableToUser(id, user.tenantId, user.username),
      );
      await skillConfigStore.setUserSelectedSkills(username, validSkills);
      res.json({ ok: true });
    } catch (err) {
      serverLogger.error(`PUT /me/selections error: ${err}`);
      res.status(500).json({ error: 'Failed to update selections' });
    }
  });

  // ── Admin: View/edit other user ────────────────────────

  /**
   * GET /users/:username — 查看指定用户的 skill 状态
   * 多组织改造：跨组织 admin 一律 403
   */
  router.get('/users/:username', requireAdmin, (req, res) => {
    const usernameParam = safeName(req.params.username);
    if (!usernameParam) return res.status(400).json({ error: 'Invalid username' });
    const target = resolveAdminTargetUser(req, res, usernameParam);
    if (!target) return;
    try {
      res.json(buildUserSkillsResponse(target));
    } catch (err) {
      serverLogger.error(`GET /users/${target.username} error: ${err}`);
      res.status(500).json({ error: 'Failed to fetch user skills' });
    }
  });

  /**
   * PUT /users/:username/selections — 更新指定用户的 skill 选择
   * 多组织改造：跨组织 admin 一律 403
   */
  router.put('/users/:username/selections', requireAdmin, async (req, res) => {
    const usernameParam = safeName(req.params.username);
    if (!usernameParam) return res.status(400).json({ error: 'Invalid username' });
    const target = resolveAdminTargetUser(req, res, usernameParam);
    if (!target) return;
    const parsed = selectionsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid selections', details: parsed.error.format() });
    }

    try {
      const poolIds = getPoolSkillIds();
      const validSkills = parsed.data.selectedSkills.filter(
        id => poolIds.has(id) && skillConfigStore.isTenantSkillAvailableToUser(id, target.tenantId, target.username),
      );
      await skillConfigStore.setUserSelectedSkills(target.username, validSkills);
      auditLog(req, 'skill_user_selections_updated', `${target.username}: ${validSkills.length} skills`);
      res.json({ ok: true });
    } catch (err) {
      serverLogger.error(`PUT /users/${target.username}/selections error: ${err}`);
      res.status(500).json({ error: 'Failed to update user selections' });
    }
  });

  // ── Helper ─────────────────────────────────────────────

  function buildUserSkillsResponse(user: SkillUser) {
    const poolSkills = scanPoolSkills(poolDir);
    const selected = new Set(skillConfigStore.getUserSelectedSkills(user.username));
    const poolIds = getKnownSystemSkillIds();

    // Pool skills: 只返回平台授权、租户启用且成员范围允许的
    const visiblePoolSkills = poolSkills
      .filter(s => skillConfigStore.isTenantSkillAvailableToUser(s.id, user.tenantId, user.username))
      .map(s => ({
        ...s,
        selected: selected.has(s.id),
        source: 'pool' as const,
      }));

    // 自建 skills: 始终返回，标记为 selected: true
    // 路径按 user.tenantId 解析（修 PR 4 漏改）
    const userDir = getUserSkillsDir(user);
    const customSkills = scanUserCustomSkills(userDir, poolIds).map(s => ({
      ...s,
      selected: true,
      source: 'custom' as const,
    }));

    return { poolSkills: visiblePoolSkills, customSkills };
  }

  return router;
}
