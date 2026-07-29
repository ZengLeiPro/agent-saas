import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import multer from 'multer';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { requireAdmin, requirePlatformAdmin, isPlatformAdmin } from '../auth/middleware.js';
import { hasPlatformCapability, isSuperAdmin } from '../auth/platformGovernance.js';
import { auditLog } from '../data/login-logs/index.js';
import type { SkillConfigStore } from '../data/skills/store.js';
import type { PlatformSkillConfig, TenantSkillRule } from '../data/skills/types.js';
import {
  scanPoolSkillsAsync,
  scanTenantOwnSkillIdsAsync,
  scanUserCustomSkillsAsync,
} from '../data/skills/scanner.js';
import { resolveTenantSkillsDir, resolveTenantSkillsDirFromRoot } from '../data/tenants/tenantSkillsPath.js';
import { resolveUserCwd } from '../workspace/resolver.js';
import { agentDir, agentPath, agentSkillsDir, resolveAgentPath } from '../workspace/namespace.js';
import { ensureWorkspaceDir, repairWorkspacePath, repairWorkspaceTreeAsync } from '../workspace/permissions.js';
import type { UserStore } from '../data/users/store.js';
import type { UserInfo, UserRecord } from '../data/users/types.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
/** getUserSkillsDir/buildUserSkillsResponse 只用 id/username/role/tenantId，
 * UserInfo（无 passwordHash）与 UserRecord 都满足。 */
type SkillUser = Pick<UserInfo, 'id' | 'username' | 'role' | 'tenantId'>;
import { serverLogger } from '../utils/logger.js';
import type { SkillMaterializationCoordinator } from '../workspace/materialization/types.js';

const execFileAsync = promisify(execFile);

export interface SkillsRouterDeps {
  skillConfigStore: SkillConfigStore;
  userStore: UserStore;
  agentCwd: string;
  sharedDir: string;
  tenantSkillsRootDir?: string;
  skillMaterialization?: SkillMaterializationCoordinator;
}

export function createSkillsRouter(deps: SkillsRouterDeps): Router {
  const {
    skillConfigStore,
    userStore,
    agentCwd,
    sharedDir,
    tenantSkillsRootDir,
    skillMaterialization,
  } = deps;
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

  async function getPoolSkillIds(): Promise<Set<string>> {
    return new Set((await scanPoolSkillsAsync(poolDir)).map(s => s.id));
  }

  async function getKnownSystemSkillIds(): Promise<Set<string>> {
    return new Set([
      ...await getPoolSkillIds(),
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

  /** 租户自有 skill 目录（tenants/<tenantId>/skills/）；tenantId 非法时抛错 */
  function tenantSkillsDirFor(tenantId: string): string {
    return tenantSkillsRootDir
      ? resolveTenantSkillsDirFromRoot(tenantSkillsRootDir, tenantId)
      : resolveTenantSkillsDir(sharedDir, tenantId);
  }

  /** 租户自有 skill 现存 ID（与 pool 同名的被 shadow，不返回） */
  async function getTenantOwnSkillIds(tenantId: string | undefined): Promise<Set<string>> {
    if (!tenantId) return new Set();
    try {
      return scanTenantOwnSkillIdsAsync(
        tenantSkillsDirFor(tenantId),
        await getPoolSkillIds(),
      );
    } catch {
      return new Set();
    }
  }

  async function getAllTenantOwnSkillIds(): Promise<Record<string, Set<string>>> {
    const tenantsRoot = tenantSkillsRootDir ?? join(sharedDir, 'tenants');
    const result: Record<string, Set<string>> = {};
    if (!existsSync(tenantsRoot)) return result;
    for (const tenantId of await readdir(tenantsRoot).catch(() => [] as string[])) {
      const id = safeName(tenantId);
      if (!id) continue;
      const ids = await getTenantOwnSkillIds(id);
      if (ids.size > 0) result[id] = ids;
    }
    return result;
  }

  async function findLowerScopeSkillConflicts(skillId: string): Promise<string[]> {
    const conflicts: string[] = [];
    const tenantOwnByTenant = await getAllTenantOwnSkillIds();
    for (const [tenantId, ids] of Object.entries(tenantOwnByTenant)) {
      if (ids.has(skillId)) conflicts.push(`组织 ${tenantId}`);
    }
    for (const user of userStore.listAll()) {
      if (tenantOwnByTenant[user.tenantId]?.has(skillId)) continue;
      if (existsSync(join(getUserSkillsDir(user), skillId))) conflicts.push(`用户 ${user.username}`);
    }
    return conflicts;
  }

  async function getSelectableSkillIdsForUser(user: SkillUser): Promise<Set<string>> {
    const allowed = new Set((await platformPoolSkillsForTenant(user.tenantId)).map(skill => skill.id));
    for (const id of await getTenantOwnSkillIds(user.tenantId)) {
      if (skillConfigStore.isTenantOwnSkillAvailableToUser(user.tenantId, id, user.username)) allowed.add(id);
    }
    const excluded = new Set([...await getKnownSystemSkillIds(), ...await getTenantOwnSkillIds(user.tenantId)]);
    for (const skill of await scanUserCustomSkillsAsync(getUserSkillsDir(user), excluded)) allowed.add(skill.id);
    return allowed;
  }

  function requirePlatformSkillManage(req: Request, res: Response): boolean {
    if (!isPlatformAdmin(req.user) || !hasPlatformCapability(req.user, 'skill.platform.manage')) {
      res.status(403).json({
        error: '当前平台管理员未获授权：skill.platform.manage',
        code: 'PLATFORM_CAPABILITY_REQUIRED',
        capability: 'skill.platform.manage',
      });
      return false;
    }
    return true;
  }

  /**
   * 跨组织访问 target user 校验（与 routes/mcp.ts resolveTargetUser、
   * routes/agents.ts authorizeAgentAccess 同范式）。
   * 超级管理员可跨组织；受委托平台管理员只能操作客户组织用户，不能触达平台内部员工；
   * 组织 admin 仅本组织用户；非 admin 调用方不应到达这里
   * （路由用 requireAdmin 已挡住）。
   */
  function resolveAdminTargetUser(req: Request, res: Response, username: string): UserRecord | null {
    const target = userStore.findByUsername(username);
    if (!target) {
      res.status(404).json({ error: 'User not found' });
      return null;
    }
    if (!isPlatformAdmin(req.user) && target.tenantId !== req.user?.tenantId) {
      // 404 隐藏（与上面「目标不存在」同口径）：返回 403 会让组织 admin
      // 借状态码差异（404=不存在 / 403=存在于他租户）探测跨租户用户名存在性
      res.status(404).json({ error: 'User not found' });
      return null;
    }
    if (isPlatformAdmin(req.user) && !isSuperAdmin(req.user) && target.tenantId === DEFAULT_TENANT_ID) {
      // 与用户管理、租户配置的治理边界一致：受委托管理员不能借技能配置接口
      // 读取或改写平台内部员工配置。继续使用 404，避免泄露内部用户名。
      res.status(404).json({ error: 'User not found' });
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

  async function platformPoolSkillsForTenant(tenantId?: string) {
    const poolSkills = await scanPoolSkillsAsync(poolDir);
    return poolSkills
      .map(s => ({
        ...s,
        settings: skillConfigStore.getPlatformSkillConfig(s.id),
      }))
      .filter(s => skillConfigStore.isPoolSkillAvailableToTenant(s.id, tenantId));
  }

  async function getSkillDocPath(skillDir: string, skillId: string): Promise<string> {
    const skillMdPath = join(skillDir, 'SKILL.md');
    if (await stat(skillMdPath).then((info) => info.isFile()).catch(() => false)) {
      return skillMdPath;
    }

    const namedMdPath = join(skillDir, `${skillId}.md`);
    if (await stat(namedMdPath).then((info) => info.isFile()).catch(() => false)) {
      return namedMdPath;
    }

    try {
      const mdFiles = (await readdir(skillDir))
        .filter((f) => f.endsWith('.md') && !f.startsWith('.'));
      if (mdFiles.length === 1) return join(skillDir, mdFiles[0]);
    } catch {
      /* ignore */
    }

    return skillMdPath;
  }

  async function readSkillDocument(skillDir: string, skillId: string): Promise<{ content: string; fileName: string }> {
    const docPath = await getSkillDocPath(skillDir, skillId);
    try {
      const content = await readFile(docPath, 'utf-8');
      return { content, fileName: basename(docPath) || 'SKILL.md' };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return { content: '', fileName: 'SKILL.md' };
      }
      throw err;
    }
  }


  function validateSkillDocument(content: string, opts?: { allowName?: string }): { name: string; description: string } | null {
    const parsed = scanSkillFrontmatter(content);
    if (!parsed?.name || !parsed.description) return null;
    // 常规命名约定：小写字母/数字/连字符（上传创建路径一律执行此规则）。
    // allowName 例外放行：目录 ID 本身经 safeName 校验（允许大写/下划线、拒绝
    // 路径穿越与特殊字符），agent 直建/历史存量的下划线 id skill 的 frontmatter
    // name 只要与目录 ID 完全一致就必须可编辑，否则 PUT document 永远 400。
    if (
      !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(parsed.name) &&
      !(opts?.allowName !== undefined && parsed.name === opts.allowName)
    ) return null;
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

  async function archiveDeletedDirectory(targetDir: string): Promise<void> {
    const parentDir = dirname(targetDir);
    const archiveDir = join(parentDir, '.deleted-skills');
    await mkdir(archiveDir, { recursive: true });
    await rename(
      targetDir,
      join(archiveDir, `${basename(targetDir)}-${Date.now()}-${randomUUID()}`),
    );
  }

  /**
   * 递归探测目录内是否存在符号链接条目。
   * safeRelativePath 只校验 zip 条目名，无法拦截 zip 内的符号链接条目
   * （unix mode 0o120xxx，链接目标写在文件内容里）——unzip 会如实创建活链接，
   * 随后被 moveSkillIntoPlace 原样搬入 agent 可读的 skills 目录，造成沙箱外文件读取。
   * 用 lstat（不跟随链接）逐项检查，命中任何 symlink 即判定不安全。
   */
  async function containsSymlink(dir: string): Promise<boolean> {
    for (const entry of await readdir(dir)) {
      const full = join(dir, entry);
      const st = await lstat(full);
      if (st.isSymbolicLink()) return true;
      if (st.isDirectory() && await containsSymlink(full)) return true;
    }
    return false;
  }

  async function findSkillRoot(dir: string): Promise<string | null> {
    const direct = join(dir, 'SKILL.md');
    if ((await stat(direct).catch(() => null))?.isFile()) return dir;
    const entries = (await readdir(dir)).filter(name => !name.startsWith('.'));
    const matches: string[] = [];
    for (const name of entries) {
      const path = join(dir, name);
      if (
        (await stat(path).catch(() => null))?.isDirectory()
        && (await stat(join(path, 'SKILL.md')).catch(() => null))?.isFile()
      ) {
        matches.push(path);
      }
    }
    return matches.length === 1 ? matches[0] : null;
  }

  type SkillInstallTarget =
    | { kind: 'user' }
    | { kind: 'tenant'; tenantId: string }
    | { kind: 'pool' };

  /** 把临时目录中的 skill 移入目标目录；返回 targetDir，冲突/校验失败时已响应并返回 null */
  async function moveSkillIntoPlace(
    res: Response,
    skillRoot: string,
    parentDir: string,
    skillId: string,
    workspaceManaged: boolean,
  ): Promise<string | null> {
    const targetDir = join(parentDir, skillId);
    if (existsSync(targetDir)) {
      res.status(409).json({ error: `技能“${skillId}”已存在` });
      return null;
    }
    if (workspaceManaged) {
      ensureWorkspaceDir(parentDir, 0o775);
    } else {
      await mkdir(parentDir, { recursive: true });
    }
    try {
      await rename(skillRoot, targetDir);
    } catch (err) {
      // 生产上 /tmp（本地盘）与目标（NAS 挂载）跨文件系统，rename 抛 EXDEV，退化为复制。
      if ((err as NodeJS.ErrnoException)?.code !== 'EXDEV') throw err;
      try {
        await cp(skillRoot, targetDir, { recursive: true, errorOnExist: true });
      } catch (copyErr) {
        // 复制中途失败不物理删除：移到带时间戳的失败隔离目录，重传不会误报 409，
        // 同时保留人工取证/恢复可能。
        if (existsSync(targetDir)) {
          await rename(
            targetDir,
            join(parentDir, `.failed-${skillId}-${Date.now()}`),
          ).catch(() => undefined);
        }
        throw copyErr;
      }
    }
    if (workspaceManaged) await repairWorkspaceTreeAsync(targetDir);
    return targetDir;
  }

  async function installUploadedSkill(req: Request, res: Response, sourceDir: string, target: SkillInstallTarget) {
    const username = req.user?.username;
    if (!username) return res.status(401).json({ error: 'Not authenticated' });
    const skillRoot = await findSkillRoot(sourceDir);
    if (!skillRoot) return res.status(400).json({ error: '上传内容根目录或唯一一级目录中必须包含 SKILL.md' });

    const skillDoc = await readFile(join(skillRoot, 'SKILL.md'), 'utf-8');
    const meta = validateSkillDocument(skillDoc);
    if (!meta) return res.status(400).json({ error: 'SKILL.md 必须包含 YAML frontmatter，name 需为小写字母/数字/连字符且 description 非空' });

    const skillId = skillIdFromName(meta.name);
    if (!skillId) return res.status(400).json({ error: 'SKILL.md 的 name 不能转换为有效技能 ID' });

    if (target.kind === 'user') {
      // 仅 user 目标需要 UserRecord（解析 workspace 路径）；pool/tenant 目标写共享目录，不依赖调用者记录
      const user = userStore.findByUsername(username);
      if (!user) return res.status(404).json({ error: 'User not found' });
      // 与系统层（pool + 已注册 + 本租户自有）撞名会被 shadow 且下次 sync 时被覆盖删除，直接拒绝
      if (
        (await getKnownSystemSkillIds()).has(skillId)
        || (await getTenantOwnSkillIds(user.tenantId)).has(skillId)
      ) {
        return res.status(409).json({ error: `技能“${skillId}”与系统或组织技能同名，请改名后重试` });
      }
      const dir = await moveSkillIntoPlace(res, skillRoot, getUserSkillsDir(user), skillId, true);
      if (!dir) return;
      // 上传即启用：把新 skillId 追加到用户 selection，保持"上传立刻可用"的直觉体验。
      // 与前端「导入后 refresh 拉回列表看到 Switch 已开」呼应；用户之后仍可自由关闭。
      const currentSelection = skillConfigStore.getUserSelectedSkills(username);
      if (!currentSelection.includes(skillId)) {
        await skillConfigStore.setUserSelectedSkills(username, [...currentSelection, skillId]);
      }
      auditLog(req, 'skill_custom_uploaded', `${username}/${skillId}`);
      return res.json({ ok: true, skill: { id: skillId, name: meta.name, description: meta.description } });
    }

    if (target.kind === 'tenant') {
      if ((await getKnownSystemSkillIds()).has(skillId)) {
        return res.status(409).json({ error: `技能“${skillId}”与平台技能同名，请改名后重试` });
      }
      // 与本租户成员的自建 skill 撞名会静默覆盖删除用户数据，拒绝
      for (const u of userStore.listAll()) {
        if (u.tenantId !== target.tenantId) continue;
        if (existsSync(join(getUserSkillsDir(u), skillId))) {
          return res.status(409).json({ error: `技能“${skillId}”与成员 ${u.username} 的自建技能同名，请改名后重试` });
        }
      }
      const dir = await moveSkillIntoPlace(res, skillRoot, tenantSkillsDirFor(target.tenantId), skillId, false);
      if (!dir) return;
      auditLog(req, 'skill_tenant_uploaded', `${target.tenantId}/${skillId}`);
      return res.json({ ok: true, skill: { id: skillId, name: meta.name, description: meta.description } });
    }

    // pool 是最高优先级；若与任一组织或用户自建 skill 同名，后续物化会接管并覆盖下层目录。
    const conflicts = await findLowerScopeSkillConflicts(skillId);
    if (conflicts.length > 0) {
      return res.status(409).json({ error: `技能“${skillId}”与${conflicts.join('、')}的技能同名，请先改名或清理冲突` });
    }
    const dir = await moveSkillIntoPlace(res, skillRoot, poolDir, skillId, false);
    if (!dir) return;
    await skillConfigStore.setPoolVisibility({ [skillId]: true });
    auditLog(req, 'skill_pool_uploaded', skillId);
    return res.json({ ok: true, skill: { id: skillId, name: meta.name, description: meta.description } });
  }

  /** 解析 multipart 上传（zip / 多文件）到临时目录并执行安装；三级上传入口共用 */
  async function handleSkillUploadRequest(req: Request, res: Response, target: SkillInstallTarget) {
    const files = (req.files as Express.Multer.File[] | undefined) || [];
    if (files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

    const tempRoot = await mkdtemp(join(tmpdir(), 'skill-import-'));
    try {
      const first = files[0];
      const firstName = first.originalname.toLowerCase();
      if (files.length === 1 && firstName.endsWith('.zip')) {
        const zipPath = join(tempRoot, 'upload.zip');
        await writeFile(zipPath, first.buffer);
        const listed = await execFileAsync('unzip', ['-Z', '-1', zipPath], { encoding: 'utf-8' });
        const zipEntries = listed.stdout.split('\n').filter(Boolean);
        if (zipEntries.some(entry => !safeRelativePath(entry))) {
          return res.status(400).json({ error: 'zip 内包含不安全路径' });
        }
        const extractDir = join(tempRoot, 'extracted');
        await mkdir(extractDir, { recursive: true });
        await execFileAsync('unzip', ['-q', zipPath, '-d', extractDir]);
        // 解压后二次防线：拒绝符号链接条目（条目名过滤挡不住 mode 0o120xxx 的 symlink）
        if (await containsSymlink(extractDir)) {
          return res.status(400).json({ error: 'zip 内包含不安全路径' });
        }
        return await installUploadedSkill(req, res, extractDir, target);
      }

      const uploadDir = join(tempRoot, 'upload');
      for (const file of files) {
        const relPath = safeRelativePath(file.originalname);
        if (!relPath) return res.status(400).json({ error: `Invalid file path: ${file.originalname}` });
        const targetPath = join(uploadDir, relPath);
        await mkdir(dirname(targetPath), { recursive: true });
        await writeFile(targetPath, file.buffer);
      }
      return await installUploadedSkill(req, res, uploadDir, target);
    } catch (err) {
      serverLogger.error(`Skill import (${target.kind}) error: ${err}`);
      return res.status(500).json({ error: '导入技能失败' });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }

  async function writeSkillDocument(skillDir: string, skillId: string, content: string): Promise<{ fileName: string }> {
    ensureWorkspaceDir(skillDir, 0o775);
    const docPath = await getSkillDocPath(skillDir, skillId);
    await writeFile(docPath, content, 'utf-8');
    repairWorkspacePath(docPath, 0o664);
    return { fileName: basename(docPath) || 'SKILL.md' };
  }

  // ── Admin: Pool management ─────────────────────────────

  /** GET /pool — platform admin 列出完整 pool；组织 admin 仅列出可见 skill */
  router.get('/pool', requireAdmin, async (req, res) => {
    try {
      const poolSkills = await scanPoolSkillsAsync(poolDir);
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
      res.status(500).json({ error: '扫描技能池失败' });
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

  /** GET /pool/:skillId/delete-impact — 删除前影响范围；平台技能必须先停用（退役）再删除 */
  router.get('/pool/:skillId/delete-impact', requirePlatformAdmin, async (req, res) => {
    const skillId = safeName(req.params.skillId);
    if (!skillId) return res.status(400).json({ error: 'Invalid skillId' });
    if (!(await getPoolSkillIds()).has(skillId)) return res.status(404).json({ error: `技能“${skillId}”未在技能池中注册` });
    const usersSelected = Object.values(skillConfigStore.getAllUserConfigs())
      .filter(config => config.selectedSkills.includes(skillId)).length;
    const tenantsConfigured = Object.values(skillConfigStore.getAllTenantConfigs())
      .filter(config => config.enabledSkills?.includes(skillId) || !!config.skills?.[skillId]).length;
    const config = skillConfigStore.getPlatformSkillConfig(skillId);
    res.json({ skillId, retired: !config.enabled, usersSelected, tenantsConfigured });
  });

  /** DELETE /pool/:skillId?confirm=true — 删除已退役的平台 skill，引用与副本由异步物化队列收敛 */
  router.delete('/pool/:skillId', requirePlatformAdmin, async (req, res) => {
    if (!requirePlatformSkillManage(req, res)) return;
    const skillId = safeName(req.params.skillId);
    if (!skillId) return res.status(400).json({ error: 'Invalid skillId' });
    if (req.query.confirm !== 'true') return res.status(400).json({ error: '删除平台技能必须显式传 confirm=true' });
    if (!(await getPoolSkillIds()).has(skillId)) return res.status(404).json({ error: `技能“${skillId}”未在技能池中注册` });
    if (skillConfigStore.getPlatformSkillConfig(skillId).enabled) {
      return res.status(409).json({ error: '请先停用（退役）该平台技能，再执行删除' });
    }
    try {
      await archiveDeletedDirectory(join(poolDir, skillId));
      const refs = await skillConfigStore.removeSkillReferences(skillId);
      const requests = userStore.listAll().flatMap(user => {
        const userCwd = resolveUserCwd(agentCwd, { id: user.id, username: user.username, role: user.role as 'admin' | 'user', tenantId: user.tenantId });
        return existsSync(agentDir(userCwd)) ? [{
          user: { id: user.id, username: user.username, role: user.role as 'admin' | 'user', tenantId: user.tenantId },
          userCwd,
          reason: 'admin' as const,
          priority: 50,
          force: true,
        }] : [];
      });
      const materialization = skillMaterialization ? await skillMaterialization.enqueue(requests) : undefined;
      auditLog(req, 'skill_pool_deleted', `${skillId}: ${JSON.stringify({ ...refs, materialization })}`);
      res.json({ ok: true, ...refs, materialization });
    } catch (err) {
      serverLogger.error(`DELETE /pool/${skillId} error: ${err}`);
      res.status(500).json({ error: '删除平台技能失败' });
    }
  });

  /** GET /pool/:skillId/document — 读取 pool skill 文档 */
  router.get('/pool/:skillId/document', requireAdmin, async (req, res) => {
    const skillId = safeName(req.params.skillId);
    if (!skillId) return res.status(400).json({ error: 'Invalid skillId' });

    // δ: skillId 必须 ∈ scanPoolSkills 视图，避免 admin 编辑非注册目录（如
    // 误放在 pool 下的 .env/.tmp/READMEs）
    if (!(await getPoolSkillIds()).has(skillId)) {
      return res.status(404).json({ error: `技能“${skillId}”未在技能池中注册` });
    }
    if (!isPlatformAdmin(req.user) && !skillConfigStore.isPoolSkillAvailableToTenant(skillId, req.user?.tenantId)) {
      return res.status(404).json({ error: `技能“${skillId}”未在技能池中注册` });
    }
    const skillDir = join(poolDir, skillId);
    if (!existsSync(skillDir)) {
      return res.status(404).json({ error: `技能池中不存在技能“${skillId}”` });
    }

    try {
      const doc = await readSkillDocument(skillDir, skillId);
      res.json({ skillId, source: 'pool', ...doc });
    } catch (err) {
      serverLogger.error(`GET /pool/${skillId}/document error: ${err}`);
      res.status(500).json({ error: '读取技能文档失败' });
    }
  });

  /**
   * PUT /pool/:skillId/document — 写入 pool skill 文档
   * 多组织改造：pool 是平台共享资源，写操作仅平台 admin。
   * 组织 admin 不能动其他组织也在用的 skill 文档（譬如改 SKILL.md 影响 wain 用户）。
   */
  router.put('/pool/:skillId/document', requirePlatformAdmin, async (req, res) => {
    if (!requirePlatformSkillManage(req, res)) return;
    const skillId = safeName(req.params.skillId);
    if (!skillId) return res.status(400).json({ error: 'Invalid skillId' });

    const parsed = skillDocumentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid document', details: parsed.error.format() });
    }

    if (!(await getPoolSkillIds()).has(skillId)) {
      return res.status(404).json({ error: `技能“${skillId}”未在技能池中注册` });
    }
    const skillDir = join(poolDir, skillId);
    if (!existsSync(skillDir)) {
      return res.status(404).json({ error: `技能池中不存在技能“${skillId}”` });
    }

    try {
      const doc = await writeSkillDocument(skillDir, skillId, parsed.data.content);
      await skillConfigStore.touchConfigVersion();
      auditLog(req, 'skill_document_updated', `pool/${skillId}`);
      res.json({ ok: true, skillId, source: 'pool', ...doc });
    } catch (err) {
      serverLogger.error(`PUT /pool/${skillId}/document error: ${err}`);
      res.status(500).json({ error: '写入技能文档失败' });
    }
  });

  /** PATCH /pool/visibility — 全局可见性，仅平台 admin */
  router.patch('/pool/visibility', requirePlatformAdmin, async (req, res) => {
    if (!requirePlatformSkillManage(req, res)) return;
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
    if (!requirePlatformSkillManage(req, res)) return;
    const parsed = platformSkillSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: '平台技能设置无效', details: parsed.error.format() });
    }
    try {
      const poolIds = await getPoolSkillIds();
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
      res.status(500).json({ error: '更新平台技能设置失败' });
    }
  });

  /** POST /pool/import — 平台 admin 上传 skill 到全局 pool */
  router.post('/pool/import', requirePlatformAdmin, skillUpload.array('files', 300), (req, res) => {
    if (!requirePlatformSkillManage(req, res)) return;
    void handleSkillUploadRequest(req, res, { kind: 'pool' });
  });

  /** GET /tenants/:tenantId/pool — 租户可管理的平台已开放 skill */
  router.get('/tenants/:tenantId/pool', requireAdmin, async (req, res) => {
    const tenantId = resolveAdminTargetTenantId(req, res, req.params.tenantId);
    if (!tenantId) return;
    try {
      const platformSkills = await platformPoolSkillsForTenant(tenantId);
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
      res.status(500).json({ error: '获取组织技能失败' });
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
      const visibleIds = new Set(
        (await platformPoolSkillsForTenant(tenantId)).map(s => s.id),
      );
      const enabledSkills = parsed.data.enabledSkills.filter(id => visibleIds.has(id));
      await skillConfigStore.setTenantEnabledSkills(tenantId, enabledSkills);
      auditLog(req, 'skill_tenant_selections_updated', `${tenantId}: ${enabledSkills.length} skills`);
      res.json({ ok: true });
    } catch (err) {
      serverLogger.error(`PUT /tenants/${tenantId}/pool/selections error: ${err}`);
      res.status(500).json({ error: '更新组织技能失败' });
    }
  });

  /** PUT /tenants/:tenantId/pool/settings — 更新租户启用与成员开放范围 */
  router.put('/tenants/:tenantId/pool/settings', requireAdmin, async (req, res) => {
    const tenantId = resolveAdminTargetTenantId(req, res, req.params.tenantId);
    if (!tenantId) return;
    const parsed = tenantSkillSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: '组织技能设置无效', details: parsed.error.format() });
    }
    try {
      const availableIds = new Set(
        (await platformPoolSkillsForTenant(tenantId)).map(s => s.id),
      );
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
      res.status(500).json({ error: '更新组织技能设置失败' });
    }
  });

  // ── Admin: Custom skill management ─────────────────────

  /**
   * GET /custom — 所有用户的自建 skill
   * 多组织改造：platform admin 看全部用户；组织 admin 仅本组织用户。
   */
  router.get('/custom', requireAdmin, async (req, res) => {
    try {
      const platform = isPlatformAdmin(req.user);
      const poolIds = await getKnownSystemSkillIds();
      const ownIdsByTenant = new Map<string, Set<string>>();
      const users: Record<string, any[]> = {};
      for (const u of userStore.listAll()) {
        if (!platform && u.tenantId !== req.user?.tenantId) continue;
        const dir = getUserSkillsDir(u);
        if (u.tenantId && !ownIdsByTenant.has(u.tenantId)) {
          ownIdsByTenant.set(u.tenantId, await getTenantOwnSkillIds(u.tenantId));
        }
        const excluded = new Set([...poolIds, ...(u.tenantId ? ownIdsByTenant.get(u.tenantId)! : [])]);
        const customSkills = await scanUserCustomSkillsAsync(dir, excluded);
        if (customSkills.length > 0) {
          users[u.username] = customSkills;
        }
      }
      res.json({ users });
    } catch (err) {
      serverLogger.error(`GET /custom error: ${err}`);
      res.status(500).json({ error: '扫描自定义技能失败' });
    }
  });

  /**
   * POST /custom/:skillId/promote — 把用户自建 skill 提升到全局 pool
   * 多组织改造：promote 写 pool（平台资源），仅 platform admin。
   * 源用户也必须存在 + 路径按其组织解析。
   */
  const promoteSchema = z.object({ sourceUser: z.string().min(1) });

  router.post('/custom/:skillId/promote', requirePlatformAdmin, async (req, res) => {
    if (!requirePlatformSkillManage(req, res)) return;
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
      return res.status(404).json({ error: `用户 ${sourceUsername} 的工作区中不存在技能“${skillId}”` });
    }
    if (existsSync(dstDir)) {
      return res.status(409).json({ error: `技能“${skillId}”已存在于技能池` });
    }
    const conflicts = (await findLowerScopeSkillConflicts(skillId)).filter(conflict => conflict !== `用户 ${sourceUsername}`);
    if (conflicts.length > 0) {
      return res.status(409).json({ error: `技能“${skillId}”与${conflicts.join('、')}的技能同名，请先处理冲突` });
    }

    try {
      await cp(srcDir, dstDir, { recursive: true, dereference: false, errorOnExist: true });
      await skillConfigStore.setPoolVisibility({ [skillId]: true });
      auditLog(req, 'skill_promoted', `${skillId} from ${sourceUsername}`);
      res.json({ ok: true });
    } catch (err) {
      serverLogger.error(`POST /custom/${skillId}/promote error: ${err}`);
      res.status(500).json({ error: '发布技能失败' });
    }
  });


  /** GET /custom/:username/:skillId/document — 管理员读取用户自建 skill 文档 */
  router.get('/custom/:username/:skillId/document', requireAdmin, async (req, res) => {
    const usernameParam = safeName(req.params.username);
    const skillId = safeName(req.params.skillId);
    if (!usernameParam || !skillId) return res.status(400).json({ error: 'Invalid username or skillId' });
    const target = resolveAdminTargetUser(req, res, usernameParam);
    if (!target) return;
    if ((await getKnownSystemSkillIds()).has(skillId)) {
      return res.status(400).json({ error: '技能池文档必须通过 /pool 管理' });
    }
    if ((await getTenantOwnSkillIds(target.tenantId)).has(skillId)) {
      return res.status(400).json({ error: '组织技能文档必须通过 /tenants 管理' });
    }

    const skillDir = join(getUserSkillsDir(target), skillId);
    if (!existsSync(skillDir)) return res.status(404).json({ error: `用户 ${target.username} 的工作区中不存在技能“${skillId}”` });

    try {
      const doc = await readSkillDocument(skillDir, skillId);
      res.json({ skillId, source: 'custom', username: target.username, ...doc });
    } catch (err) {
      serverLogger.error(`GET /custom/${target.username}/${skillId}/document error: ${err}`);
      res.status(500).json({ error: '读取自定义技能文档失败' });
    }
  });

  /** PUT /custom/:username/:skillId/document — 管理员接管并写入用户自建 skill 文档 */
  router.put('/custom/:username/:skillId/document', requireAdmin, async (req, res) => {
    const usernameParam = safeName(req.params.username);
    const skillId = safeName(req.params.skillId);
    if (!usernameParam || !skillId) return res.status(400).json({ error: 'Invalid username or skillId' });
    const target = resolveAdminTargetUser(req, res, usernameParam);
    if (!target) return;
    if ((await getKnownSystemSkillIds()).has(skillId)) {
      return res.status(400).json({ error: '技能池文档必须通过 /pool 管理' });
    }
    if ((await getTenantOwnSkillIds(target.tenantId)).has(skillId)) {
      return res.status(400).json({ error: '组织技能文档必须通过 /tenants 管理' });
    }

    const parsed = skillDocumentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid document', details: parsed.error.format() });
    }
    // allowName=skillId：已存在的下划线 id 自建 skill（agent 直建/历史存量）
    // 必须能原样编辑；skillId 已过 safeName，安全边界不放松
    const meta = validateSkillDocument(parsed.data.content, { allowName: skillId });
    if (!meta) return res.status(400).json({ error: 'SKILL.md 必须包含 YAML frontmatter，name 需为小写字母/数字/连字符且 description 非空' });
    if (meta.name !== skillId) return res.status(400).json({ error: `SKILL.md name 必须与目录 ID '${skillId}' 保持一致` });

    const skillDir = join(getUserSkillsDir(target), skillId);
    if (!existsSync(skillDir)) return res.status(404).json({ error: `用户 ${target.username} 的工作区中不存在技能“${skillId}”` });

    try {
      const doc = await writeSkillDocument(skillDir, skillId, parsed.data.content);
      auditLog(req, 'skill_document_updated', `custom/${target.username}/${skillId}`);
      res.json({ ok: true, skillId, source: 'custom', username: target.username, ...doc });
    } catch (err) {
      serverLogger.error(`PUT /custom/${target.username}/${skillId}/document error: ${err}`);
      res.status(500).json({ error: '写入自定义技能文档失败' });
    }
  });

  /**
   * DELETE /custom/:username/:skillId — 删除用户自建 skill
   * 多组织改造：platform admin 任意；组织 admin 仅本组织用户。
   */
  router.delete('/custom/:username/:skillId', requireAdmin, async (req, res) => {
    const usernameParam = safeName(req.params.username);
    const skillId = safeName(req.params.skillId);
    if (!usernameParam || !skillId) return res.status(400).json({ error: 'Invalid username or skillId' });
    const target = resolveAdminTargetUser(req, res, usernameParam);
    if (!target) return;
    const poolIds = await getKnownSystemSkillIds();

    if (poolIds.has(skillId)) {
      return res.status(400).json({ error: '不能通过此接口删除技能池中的技能' });
    }
    if ((await getTenantOwnSkillIds(target.tenantId)).has(skillId)) {
      return res.status(400).json({ error: '不能通过此接口删除组织技能' });
    }

    const skillDir = join(getUserSkillsDir(target), skillId);
    if (!existsSync(skillDir)) {
      return res.status(404).json({ error: `用户 ${target.username} 的工作区中不存在技能“${skillId}”` });
    }

    try {
      await archiveDeletedDirectory(skillDir);
      auditLog(req, 'skill_custom_deleted', `${target.username}/${skillId}`);
      res.json({ ok: true });
    } catch (err) {
      serverLogger.error(`DELETE /custom/${target.username}/${skillId} error: ${err}`);
      res.status(500).json({ error: '删除自定义技能失败' });
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
  router.get('/sync-jobs/:jobId', requireAdmin, async (req, res) => {
    if (!skillMaterialization) {
      return res.status(503).json({ error: '技能物化服务未启用' });
    }
    const jobId = z.string().uuid().safeParse(req.params.jobId);
    if (!jobId.success) return res.status(404).json({ error: '同步任务不存在' });
    try {
      const batch = await skillMaterialization.getBatch(jobId.data);
      if (!batch) return res.status(404).json({ error: '同步任务不存在' });
      if (!isPlatformAdmin(req.user) && (
        batch.tenantIds.length !== 1
        || batch.tenantIds[0] !== req.user?.tenantId
      )) {
        return res.status(404).json({ error: '同步任务不存在' });
      }
      res.json(batch);
    } catch (err) {
      serverLogger.error(`GET /sync-jobs/${req.params.jobId} error: ${err}`);
      res.status(500).json({ error: '读取同步进度失败' });
    }
  });

  router.post('/sync', requireAdmin, async (req, res) => {
    const rawUsername = typeof req.query.username === 'string' ? req.query.username : undefined;
    const platform = isPlatformAdmin(req.user);
    try {
      const currentPoolIds = await getPoolSkillIds();
      if (currentPoolIds.size === 0) {
        return res.status(409).json({ error: '技能池为空或不存在，已拒绝同步' });
      }

      const discovered = platform ? skillConfigStore.syncWithPool(currentPoolIds) : 0;
      // 不在请求线程 prune：旧注册表正是首次 manifest 迁移时识别“曾经的系统技能”
      // 并安全移入备份的依据。启动 warmup 会在全员物化完成后统一 prune。
      const pruned = 0;
      const requests = [];

      if (rawUsername) {
        const usernameSafe = safeName(rawUsername);
        if (!usernameSafe) return res.status(400).json({ error: 'Invalid username' });
        const user = resolveAdminTargetUser(req, res, usernameSafe);
        if (!user) return;
        const userCwd = resolveUserCwd(agentCwd, { id: user.id, username: user.username, role: user.role as 'admin' | 'user', tenantId: user.tenantId });
        if (!existsSync(agentDir(userCwd))) {
          return res.status(404).json({ error: 'User workspace not initialized' });
        }
        requests.push({
          user: { id: user.id, username: user.username, role: user.role as 'admin' | 'user', tenantId: user.tenantId },
          userCwd,
          reason: 'admin' as const,
          priority: 50,
          force: true,
        });
      } else {
        for (const u of userStore.listAll()) {
          if (!platform && u.tenantId !== req.user?.tenantId) continue;
          const userCwd = resolveUserCwd(agentCwd, { id: u.id, username: u.username, role: u.role as 'admin' | 'user', tenantId: u.tenantId });
          if (existsSync(agentDir(userCwd))) {
            requests.push({
              user: { id: u.id, username: u.username, role: u.role as 'admin' | 'user', tenantId: u.tenantId },
              userCwd,
              reason: 'admin' as const,
              priority: 50,
              force: true,
            });
          }
        }
      }
      if (!skillMaterialization) {
        return res.status(503).json({ error: '技能物化服务未启用' });
      }
      const batch = await skillMaterialization.enqueue(requests);
      res.status(202).json({ ...batch, discovered, pruned });
    } catch (err) {
      serverLogger.error(`POST /sync error: ${err}`);
      res.status(500).json({ error: '同步技能失败' });
    }
  });

  // ── Tenant own skills（租户自有 skill）─────────────────

  /** POST /tenants/:tenantId/import — 上传组织自有 skill（平台 admin 任意租户；组织 admin 仅本组织） */
  router.post('/tenants/:tenantId/import', requireAdmin, skillUpload.array('files', 300), (req, res) => {
    const tenantId = resolveAdminTargetTenantId(req, res, req.params.tenantId);
    if (!tenantId) return;
    void handleSkillUploadRequest(req, res, { kind: 'tenant', tenantId });
  });

  /** GET /tenants/:tenantId/skills — 组织自有 skill 列表 + 治理规则 */
  router.get('/tenants/:tenantId/skills', requireAdmin, async (req, res) => {
    const tenantId = resolveAdminTargetTenantId(req, res, req.params.tenantId);
    if (!tenantId) return;
    try {
      const skills = (await scanUserCustomSkillsAsync(
        tenantSkillsDirFor(tenantId),
        await getPoolSkillIds(),
      )).map(s => {
        const rule = skillConfigStore.getTenantOwnSkillRule(tenantId, s.id);
        return { ...s, enabled: rule.enabled, exposure: rule.exposure, usernames: rule.usernames };
      });
      res.json({ tenantId, skills });
    } catch (err) {
      serverLogger.error(`GET /tenants/${tenantId}/skills error: ${err}`);
      res.status(500).json({ error: '获取组织自有技能失败' });
    }
  });

  /** PUT /tenants/:tenantId/skills/settings — 更新组织自有 skill 的启用与成员范围 */
  router.put('/tenants/:tenantId/skills/settings', requireAdmin, async (req, res) => {
    const tenantId = resolveAdminTargetTenantId(req, res, req.params.tenantId);
    if (!tenantId) return;
    const parsed = tenantSkillSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: '组织自有技能设置无效', details: parsed.error.format() });
    }
    try {
      const ownIds = await getTenantOwnSkillIds(tenantId);
      const tenantUsernames = new Set(
        userStore.listAll().filter((u) => u.tenantId === tenantId).map((u) => u.username),
      );
      const updates: Record<string, TenantSkillRule> = {};
      for (const [skillId, settings] of Object.entries(parsed.data)) {
        if (!ownIds.has(skillId)) continue;
        updates[skillId] = {
          enabled: settings.enabled,
          exposure: settings.exposure,
          usernames: settings.usernames.filter((username): username is string => tenantUsernames.has(username)),
        };
      }
      await skillConfigStore.setTenantOwnSkillRules(tenantId, updates);
      auditLog(req, 'skill_tenant_own_settings_updated', `${tenantId}: ${Object.keys(updates).length} skills`);
      res.json({ ok: true });
    } catch (err) {
      serverLogger.error(`PUT /tenants/${tenantId}/skills/settings error: ${err}`);
      res.status(500).json({ error: '更新组织自有技能设置失败' });
    }
  });

  /** GET /tenants/:tenantId/skills/:skillId/document — 读取组织自有 skill 文档 */
  router.get('/tenants/:tenantId/skills/:skillId/document', requireAdmin, async (req, res) => {
    const tenantId = resolveAdminTargetTenantId(req, res, req.params.tenantId);
    if (!tenantId) return;
    const skillId = safeName(req.params.skillId);
    if (!skillId) return res.status(400).json({ error: 'Invalid skillId' });
    const skillDir = join(tenantSkillsDirFor(tenantId), skillId);
    if (!existsSync(skillDir)) return res.status(404).json({ error: `组织 ${tenantId} 中不存在技能“${skillId}”` });
    try {
      const doc = await readSkillDocument(skillDir, skillId);
      res.json({ skillId, source: 'tenant', tenantId, ...doc });
    } catch (err) {
      serverLogger.error(`GET /tenants/${tenantId}/skills/${skillId}/document error: ${err}`);
      res.status(500).json({ error: '读取组织技能文档失败' });
    }
  });

  /** PUT /tenants/:tenantId/skills/:skillId/document — 写入组织自有 skill 文档 */
  router.put('/tenants/:tenantId/skills/:skillId/document', requireAdmin, async (req, res) => {
    const tenantId = resolveAdminTargetTenantId(req, res, req.params.tenantId);
    if (!tenantId) return;
    const skillId = safeName(req.params.skillId);
    if (!skillId) return res.status(400).json({ error: 'Invalid skillId' });
    const parsed = skillDocumentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid document', details: parsed.error.format() });
    }
    const meta = validateSkillDocument(parsed.data.content);
    if (!meta) return res.status(400).json({ error: 'SKILL.md 必须包含 YAML frontmatter，name 需为小写字母/数字/连字符且 description 非空' });
    if (meta.name !== skillId) return res.status(400).json({ error: `SKILL.md name 必须与目录 ID '${skillId}' 保持一致` });
    const skillDir = join(tenantSkillsDirFor(tenantId), skillId);
    if (!existsSync(skillDir)) return res.status(404).json({ error: `组织 ${tenantId} 中不存在技能“${skillId}”` });
    try {
      const doc = await writeSkillDocument(skillDir, skillId, parsed.data.content);
      // 已物化到成员 workspace 的副本按 configVersion 重新同步
      await skillConfigStore.touchConfigVersion();
      auditLog(req, 'skill_document_updated', `tenant/${tenantId}/${skillId}`);
      res.json({ ok: true, skillId, source: 'tenant', tenantId, ...doc });
    } catch (err) {
      serverLogger.error(`PUT /tenants/${tenantId}/skills/${skillId}/document error: ${err}`);
      res.status(500).json({ error: '写入组织技能文档失败' });
    }
  });

  /** DELETE /tenants/:tenantId/skills/:skillId — 删除组织自有 skill */
  router.delete('/tenants/:tenantId/skills/:skillId', requireAdmin, async (req, res) => {
    const tenantId = resolveAdminTargetTenantId(req, res, req.params.tenantId);
    if (!tenantId) return;
    const skillId = safeName(req.params.skillId);
    if (!skillId) return res.status(400).json({ error: 'Invalid skillId' });
    const skillDir = join(tenantSkillsDirFor(tenantId), skillId);
    if (!existsSync(skillDir)) return res.status(404).json({ error: `组织 ${tenantId} 中不存在技能“${skillId}”` });
    try {
      await archiveDeletedDirectory(skillDir);
      // ownSkills 规则条目保留作为「曾存在」记忆，驱动成员 workspace 清理残留副本；prune 时按目录现状清掉
      await skillConfigStore.touchConfigVersion();
      auditLog(req, 'skill_tenant_deleted', `${tenantId}/${skillId}`);
      res.json({ ok: true });
    } catch (err) {
      serverLogger.error(`DELETE /tenants/${tenantId}/skills/${skillId} error: ${err}`);
      res.status(500).json({ error: '删除组织技能失败' });
    }
  });

  /** POST /tenants/:tenantId/promote — 把成员自建 skill 提升为组织自有 skill */
  const tenantPromoteSchema = z.object({ skillId: z.string().min(1), sourceUser: z.string().min(1) });

  router.post('/tenants/:tenantId/promote', requireAdmin, async (req, res) => {
    const tenantId = resolveAdminTargetTenantId(req, res, req.params.tenantId);
    if (!tenantId) return;
    const parsed = tenantPromoteSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'skillId and sourceUser are required' });
    const skillId = safeName(parsed.data.skillId);
    const sourceUsername = safeName(parsed.data.sourceUser);
    if (!skillId || !sourceUsername) return res.status(400).json({ error: 'Invalid skillId or sourceUser' });
    const sourceUser = userStore.findByUsername(sourceUsername);
    if (!sourceUser) return res.status(404).json({ error: 'Source user not found' });
    if (sourceUser.tenantId !== tenantId) return res.status(400).json({ error: 'Source user 不属于该组织' });

    const srcDir = join(getUserSkillsDir(sourceUser), skillId);
    if (!existsSync(srcDir)) {
      return res.status(404).json({ error: `用户 ${sourceUsername} 的工作区中不存在技能“${skillId}”` });
    }
    if ((await getKnownSystemSkillIds()).has(skillId)) {
      return res.status(409).json({ error: `技能“${skillId}”与平台技能同名` });
    }
    const dstDir = join(tenantSkillsDirFor(tenantId), skillId);
    if (existsSync(dstDir)) {
      return res.status(409).json({ error: `技能“${skillId}”已存在于组织技能中` });
    }

    try {
      await mkdir(tenantSkillsDirFor(tenantId), { recursive: true });
      await cp(srcDir, dstDir, { recursive: true, dereference: false, errorOnExist: true });
      // 源用户的自建份将被组织份 shadow 并在下次 sync 中被系统接管；
      // 自动为其勾选该 skill，避免「promote 后 skill 突然消失」
      const selected = skillConfigStore.getUserSelectedSkills(sourceUsername);
      if (!selected.includes(skillId)) {
        await skillConfigStore.setUserSelectedSkills(sourceUsername, [...selected, skillId]);
      } else {
        await skillConfigStore.touchConfigVersion();
      }
      auditLog(req, 'skill_promoted_to_tenant', `${tenantId}/${skillId} from ${sourceUsername}`);
      res.json({ ok: true });
    } catch (err) {
      serverLogger.error(`POST /tenants/${tenantId}/promote error: ${err}`);
      res.status(500).json({ error: '发布技能到组织失败' });
    }
  });

  /** POST /tenants/:tenantId/skills/:skillId/promote — 把组织自有 skill 提升到全局 pool（仅平台 admin） */
  router.post('/tenants/:tenantId/skills/:skillId/promote', requirePlatformAdmin, async (req, res) => {
    if (!requirePlatformSkillManage(req, res)) return;
    const tenantId = resolveAdminTargetTenantId(req, res, req.params.tenantId);
    if (!tenantId) return;
    const skillId = safeName(req.params.skillId);
    if (!skillId) return res.status(400).json({ error: 'Invalid skillId' });
    const srcDir = join(tenantSkillsDirFor(tenantId), skillId);
    if (!existsSync(srcDir)) return res.status(404).json({ error: `组织 ${tenantId} 中不存在技能“${skillId}”` });
    const dstDir = join(poolDir, skillId);
    if (existsSync(dstDir)) return res.status(409).json({ error: `技能“${skillId}”已存在于技能池` });
    const conflicts = (await findLowerScopeSkillConflicts(skillId)).filter(conflict => conflict !== `组织 ${tenantId}`);
    if (conflicts.length > 0) {
      return res.status(409).json({ error: `技能“${skillId}”与${conflicts.join('、')}的技能同名，请先处理冲突` });
    }

    try {
      await cp(srcDir, dstDir, { recursive: true, dereference: false, errorOnExist: true });
      await skillConfigStore.setPoolVisibility({ [skillId]: true });
      auditLog(req, 'skill_promoted', `${skillId} from tenant ${tenantId}`);
      res.json({ ok: true });
    } catch (err) {
      serverLogger.error(`POST /tenants/${tenantId}/skills/${skillId}/promote error: ${err}`);
      res.status(500).json({ error: '发布组织技能到技能池失败' });
    }
  });

  // ── User self-service ──────────────────────────────────

  /** GET /me — 当前用户的 skill 状态 */
  router.get('/me', async (req, res) => {
    const username = req.user?.username;
    if (!username) return res.status(401).json({ error: 'Not authenticated' });
    const user = userStore.findByUsername(username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    try {
      res.json(await buildUserSkillsResponse(user));
    } catch (err) {
      serverLogger.error(`GET /me error: ${err}`);
      res.status(500).json({ error: '获取技能失败' });
    }
  });


  router.post('/me/import', skillUpload.array('files', 300), (req, res) => {
    void handleSkillUploadRequest(req, res, { kind: 'user' });
  });

  /** GET /me/skills/:skillId/document — 当前用户读取自己的自建 skill 文档 */
  router.get('/me/skills/:skillId/document', async (req, res) => {
    const username = req.user?.username;
    if (!username) return res.status(401).json({ error: 'Not authenticated' });
    const user = userStore.findByUsername(username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const skillId = safeName(req.params.skillId);
    if (!skillId) return res.status(400).json({ error: 'Invalid skillId' });
    if ((await getKnownSystemSkillIds()).has(skillId) || (await getTenantOwnSkillIds(user.tenantId)).has(skillId)) {
      return res.status(400).json({ error: '只能编辑自己的自建技能' });
    }
    const skillDir = join(getUserSkillsDir(user), skillId);
    if (!existsSync(skillDir)) return res.status(404).json({ error: `你的工作区中不存在技能“${skillId}”` });
    try {
      const doc = await readSkillDocument(skillDir, skillId);
      res.json({ skillId, source: 'custom', username, ...doc });
    } catch (err) {
      serverLogger.error(`GET /me/skills/${skillId}/document error: ${err}`);
      res.status(500).json({ error: '读取自定义技能文档失败' });
    }
  });

  /** PUT /me/skills/:skillId/document — 当前用户编辑自己的自建 skill 文档 */
  router.put('/me/skills/:skillId/document', async (req, res) => {
    const username = req.user?.username;
    if (!username) return res.status(401).json({ error: 'Not authenticated' });
    const user = userStore.findByUsername(username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const skillId = safeName(req.params.skillId);
    if (!skillId) return res.status(400).json({ error: 'Invalid skillId' });
    if ((await getKnownSystemSkillIds()).has(skillId) || (await getTenantOwnSkillIds(user.tenantId)).has(skillId)) {
      return res.status(400).json({ error: '只能编辑自己的自建技能' });
    }
    const parsed = skillDocumentSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid document', details: parsed.error.format() });
    const meta = validateSkillDocument(parsed.data.content, { allowName: skillId });
    if (!meta || meta.name !== skillId) {
      return res.status(400).json({ error: `SKILL.md name 必须与目录 ID '${skillId}' 保持一致，且 description 非空` });
    }
    const skillDir = join(getUserSkillsDir(user), skillId);
    if (!existsSync(skillDir)) return res.status(404).json({ error: `你的工作区中不存在技能“${skillId}”` });
    try {
      const doc = await writeSkillDocument(skillDir, skillId, parsed.data.content);
      auditLog(req, 'skill_document_updated', `custom/${username}/${skillId}`);
      res.json({ ok: true, skillId, source: 'custom', username, ...doc });
    } catch (err) {
      serverLogger.error(`PUT /me/skills/${skillId}/document error: ${err}`);
      res.status(500).json({ error: '写入自定义技能文档失败' });
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
      const allowed = await getSelectableSkillIdsForUser(user);
      const validSkills = parsed.data.selectedSkills.filter(id => allowed.has(id));
      await skillConfigStore.setUserSelectedSkills(username, validSkills);
      res.json({ ok: true });
    } catch (err) {
      serverLogger.error(`PUT /me/selections error: ${err}`);
      res.status(500).json({ error: 'Failed to update selections' });
    }
  });

  /**
   * DELETE /me/skills/:skillId — 用户自删自建 skill
   * 不需要 admin，但严格限定：仅能删自己 workspace 里、未被系统/组织层 shadow 的 skill；
   * 同步从 selection 里移除，避免下一次会话读到「已选但已不存在」的孤儿 id。
   */
  router.delete('/me/skills/:skillId', async (req, res) => {
    const username = req.user?.username;
    if (!username) return res.status(401).json({ error: 'Not authenticated' });
    const user = userStore.findByUsername(username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const skillId = safeName(req.params.skillId);
    if (!skillId) return res.status(400).json({ error: 'Invalid skillId' });

    // 与 admin DELETE /custom/:username/:skillId 同口径：拒绝删除系统 pool / 组织自有 skill。
    if ((await getKnownSystemSkillIds()).has(skillId)) {
      return res.status(400).json({ error: '不能通过此接口删除技能池中的技能' });
    }
    if ((await getTenantOwnSkillIds(user.tenantId)).has(skillId)) {
      return res.status(400).json({ error: '不能通过此接口删除组织技能' });
    }

    const skillDir = join(getUserSkillsDir(user), skillId);
    if (!existsSync(skillDir)) {
      return res.status(404).json({ error: `你的工作区中不存在技能“${skillId}”` });
    }

    try {
      await archiveDeletedDirectory(skillDir);
      // 从 selection 中移除，避免 dispatch listForUser / effective 集合出现孤儿 id
      const current = skillConfigStore.getUserSelectedSkills(username);
      if (current.includes(skillId)) {
        await skillConfigStore.setUserSelectedSkills(username, current.filter(id => id !== skillId));
      }
      auditLog(req, 'skill_custom_deleted', `${username}/${skillId}`);
      res.json({ ok: true });
    } catch (err) {
      serverLogger.error(`DELETE /me/skills/${skillId} error: ${err}`);
      res.status(500).json({ error: '删除自定义技能失败' });
    }
  });

  // ── Admin: View/edit other user ────────────────────────

  /**
   * GET /users/:username — 查看指定用户的 skill 状态
   * 多组织改造：跨组织 admin 一律 403
   */
  router.get('/users/:username', requireAdmin, async (req, res) => {
    const usernameParam = safeName(req.params.username);
    if (!usernameParam) return res.status(400).json({ error: 'Invalid username' });
    const target = resolveAdminTargetUser(req, res, usernameParam);
    if (!target) return;
    try {
      res.json(await buildUserSkillsResponse(target));
    } catch (err) {
      serverLogger.error(`GET /users/${target.username} error: ${err}`);
      res.status(500).json({ error: '获取用户技能失败' });
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
      const allowed = await getSelectableSkillIdsForUser(target);
      const validSkills = parsed.data.selectedSkills.filter(id => allowed.has(id));
      await skillConfigStore.setUserSelectedSkills(target.username, validSkills);
      auditLog(req, 'skill_user_selections_updated', `${target.username}: ${validSkills.length} skills`);
      res.json({ ok: true });
    } catch (err) {
      serverLogger.error(`PUT /users/${target.username}/selections error: ${err}`);
      res.status(500).json({ error: 'Failed to update user selections' });
    }
  });

  // ── Helper ─────────────────────────────────────────────

  async function buildUserSkillsResponse(user: SkillUser) {
    const poolSkills = await scanPoolSkillsAsync(poolDir);
    const selected = new Set(skillConfigStore.getUserSelectedSkills(user.username));
    const poolIds = await getKnownSystemSkillIds();
    const tenantOwnIds = await getTenantOwnSkillIds(user.tenantId);

    // Pool skills: 只返回平台授权、租户启用且成员范围允许的
    const visiblePoolSkills = poolSkills
      .filter(s => skillConfigStore.isTenantSkillAvailableToUser(s.id, user.tenantId, user.username))
      .map(s => ({
        ...s,
        selected: selected.has(s.id),
        source: 'pool' as const,
      }));

    // 组织自有 skills: 只返回租户规则允许该成员使用的
    const tenantSkills = user.tenantId
      ? (await scanUserCustomSkillsAsync(
          tenantSkillsDirSafe(user.tenantId),
          await getPoolSkillIds(),
        ))
        .filter(s => skillConfigStore.isTenantOwnSkillAvailableToUser(user.tenantId!, s.id, user.username))
        .map(s => ({
          ...s,
          selected: selected.has(s.id),
          source: 'tenant' as const,
        }))
      : [];

    // 自建 skills: 走用户 selection（2026-07-03 改）；排除系统层与组织层（被 shadow）。
    // 早期版本硬编码 selected:true + 前端 disabled Switch，用户无法关闭已上传的自建 skill；
    // 现在按 selection 状态呈现，前端 Switch 恢复可交互，同时用户可自删（DELETE /me/skills/:id）。
    // 路径按 user.tenantId 解析（修 PR 4 漏改）
    const userDir = getUserSkillsDir(user);
    const customExcluded = new Set([...poolIds, ...tenantOwnIds]);
    const customSkills = (await scanUserCustomSkillsAsync(userDir, customExcluded)).map(s => ({
      ...s,
      selected: selected.has(s.id),
      source: 'custom' as const,
    }));

    return { poolSkills: visiblePoolSkills, tenantSkills, customSkills };
  }

  /** tenantId 非法时返回不存在的空路径（scan 会返回空），避免响应构建被单个坏值打断 */
  function tenantSkillsDirSafe(tenantId: string): string {
    try {
      return tenantSkillsDirFor(tenantId);
    } catch {
      return join(tenantSkillsRootDir ?? join(sharedDir, 'tenants'), '.invalid', 'skills');
    }
  }

  return router;
}
