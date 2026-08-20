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
import { hasPlatformCapability } from '../auth/platformGovernance.js';
import { auditLog } from '../data/login-logs/index.js';
import type { SkillConfigStore } from '../data/skills/store.js';
import type { PgSkillGovernanceStore } from '../data/skillGovernance/index.js';
import { personalSkillResourceId, tenantSkillResourceId } from '../services/tenantSkillGovernanceUpload.js';
import type { PlatformSkillConfig, TenantSkillRule } from '../data/skills/types.js';
import {
  scanPoolSkillsAsync,
  scanUserCustomSkillsAsync,
} from '../data/skills/scanner.js';
import { resolveUserCwd } from '../workspace/resolver.js';
import { createSkillOwnershipResolver } from './skillOwnership.js';
import { agentDir, agentPath, resolveAgentPath } from '../workspace/namespace.js';
import { ensureWorkspaceDir, repairWorkspacePath, repairWorkspaceTreeAsync } from '../workspace/permissions.js';
import type { UserStore } from '../data/users/store.js';
import type { UserInfo, UserRecord } from '../data/users/types.js';
/** getUserSkillsDir/buildUserSkillsResponse 只用 id/username/role/tenantId，
 * UserInfo（无 passwordHash）与 UserRecord 都满足。 */
type SkillUser = Pick<UserInfo, 'id' | 'username' | 'role' | 'tenantId'>;
import { serverLogger } from '../utils/logger.js';
import type { SkillMaterializationCoordinator } from '../workspace/materialization/types.js';
import { isSkillSelectionPreferenceWrite, registerSkillSelectionRoute, setUserSkillSelected, userSkillSelectionState } from './skillSelection.js';
import {
  safeName,
  safeRelativePath,
  skillIdFromName,
  validateSkillDocument,
} from './skillRouteValidation.js';

const execFileAsync = promisify(execFile);

export interface SkillsRouterDeps {
  skillConfigStore: SkillConfigStore;
  userStore: UserStore;
  agentCwd: string;
  sharedDir: string;
  tenantSkillsRootDir?: string;
  skillMaterialization?: SkillMaterializationCoordinator;
  skillGovernanceStore?: Pick<PgSkillGovernanceStore, 'getResource' | 'getVersion'>
    & Partial<Pick<PgSkillGovernanceStore, 'listTenantSkillHistoricalProvenance' | 'listPersonalByOwner'>>;
  legacyWriteGate?: {
    assertLegacyWriteAllowed(input: { actor: 'user' | 'service'; compatibilityProjection: boolean }): Promise<void>;
  };
}

export function createSkillsRouter(deps: SkillsRouterDeps): Router {
  const {
    skillConfigStore,
    userStore,
    agentCwd,
    sharedDir,
    tenantSkillsRootDir,
    skillMaterialization,
    skillGovernanceStore,
  } = deps;
  const router = Router();

  router.use(async (req, res, next) => {
    const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
    const isSelectionPreferenceWrite = isSkillSelectionPreferenceWrite(req.method, req.path);
    if (!isMutation || isSelectionPreferenceWrite || req.path === '/sync' || !deps.legacyWriteGate) return next();
    try {
      await deps.legacyWriteGate.assertLegacyWriteAllowed({ actor: 'user', compatibilityProjection: false });
      next();
    } catch {
      res.status(409).json({
        error: '旧版 Skill 写入口已封闭，请使用治理资源 API',
        code: 'MIGRATION_LEGACY_WRITE_SEALED',
      });
    }
  });

  const poolDir = resolveAgentPath(sharedDir, 'skills-pool');
  const skillUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024, files: 300 },
  });

  // ── Helper ─────────────────────────────────────────────

  async function getPoolSkillIds(): Promise<Set<string>> {
    return new Set((await scanPoolSkillsAsync(poolDir)).map(s => s.id));
  }

  async function getKnownSystemSkillIds(): Promise<Set<string>> {
    return new Set([
      ...await getPoolSkillIds(),
      ...Object.keys(skillConfigStore.getPoolVisibility()),
    ]);
  }

  async function governedSkillView(
    resourceId: string,
    tenantId: string,
    scope: 'tenant' | 'personal',
  ) {
    const resource = await skillGovernanceStore?.getResource(resourceId);
    if (!resource || resource.tenantId !== tenantId || resource.scope !== scope) return undefined;
    const version = resource.currentVersionId
      ? await skillGovernanceStore?.getVersion(resource.currentVersionId)
      : undefined;
    return {
      resourceId: resource.skillId,
      tenantId: resource.tenantId,
      scope: resource.scope,
      status: resource.status,
      version: version?.versionNumber,
      source: typeof version?.definition.source === 'string' ? version.definition.source : undefined,
      createdBy: resource.createdBy,
    };
  }

  const {
    getUserCwd,
    getUserSkillsDir,
    tenantSkillsDirFor,
    getTenantOwnSkillIds,
    getManagedTenantSkillIdsForUser,
  } = createSkillOwnershipResolver({
    agentCwd,
    sharedDir,
    tenantSkillsRootDir,
    getPoolSkillIds,
    skillGovernanceStore,
  });

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
    const allowed = new Set(
      (await platformPoolSkillsForTenant(user.tenantId))
        .filter((skill) => skillConfigStore.isTenantSkillAvailableToUser(skill.id, user.tenantId, user.username))
        .map((skill) => skill.id),
    );
    for (const id of await getTenantOwnSkillIds(user.tenantId)) {
      if (skillConfigStore.isTenantOwnSkillAvailableToUser(user.tenantId, id, user.username)) allowed.add(id);
    }
    const excluded = new Set([
      ...await getKnownSystemSkillIds(),
      ...await getManagedTenantSkillIdsForUser(user),
    ]);
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
   * 兼容旧管理员路径，但个人 Skill 内容与选择只能访问调用者本人。
   * owner 使用不可变 userId 判断；username 仅用于定位旧数据。
   */
  function resolveAdminTargetUser(req: Request, res: Response, username: string): UserRecord | null {
    const target = userStore.findByUsername(username);
    if (!target || !req.user) {
      res.status(404).json({ error: 'User not found' });
      return null;
    }
    if (target.id === req.user.sub) return target;
    if (!isPlatformAdmin(req.user) && target.tenantId !== req.user.tenantId) {
      res.status(404).json({ error: 'User not found' });
      return null;
    }
    res.status(403).json({ error: '个人 Skill 仅允许本人访问' });
    return null;
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
      // 选择写入失败时删除刚落盘的目录，不能返回一个需要手动补启用的半成功。
      try {
        await setUserSkillSelected(skillConfigStore, username, skillId, true);
      } catch (error) {
        await rm(dir, { recursive: true, force: true });
        throw error;
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

  /** GET /custom — 兼容旧管理员页面，但只返回调用者本人的自建 Skill。 */
  router.get('/custom', requireAdmin, async (req, res) => {
    const caller = userStore.listAll().find((user) => user.id === req.user?.sub);
    if (!caller) return res.status(404).json({ error: 'User not found' });
    try {
      const excluded = new Set([
        ...await getKnownSystemSkillIds(),
        ...await getManagedTenantSkillIdsForUser(caller),
      ]);
      const customSkills = await scanUserCustomSkillsAsync(getUserSkillsDir(caller), excluded);
      res.json({ users: customSkills.length > 0 ? { [caller.username]: customSkills } : {} });
    } catch (err) {
      serverLogger.error(`GET /custom error: ${err}`);
      res.status(500).json({ error: '扫描自定义技能失败' });
    }
  });

  /**
   * 个人 Skill 不能直接提升到平台池。候选副本、审批与发布链建成前保持 fail closed，
   * 避免管理员借“提升”读取或复制个人工作区内容。
   */
  router.post('/custom/:skillId/promote', requirePlatformAdmin, (req, res) => {
    if (!requirePlatformSkillManage(req, res)) return;
    res.status(409).json({
      error: '个人 Skill 提交流程尚未启用',
      code: 'PERSONAL_SKILL_SUBMISSION_REQUIRED',
    });
  });

  /** GET /custom/:username/:skillId/document — 兼容旧路径，仅允许读取自己的自建 Skill */
  router.get('/custom/:username/:skillId/document', requireAdmin, async (req, res) => {
    const usernameParam = safeName(req.params.username);
    const skillId = safeName(req.params.skillId);
    if (!usernameParam || !skillId) return res.status(400).json({ error: 'Invalid username or skillId' });
    const target = resolveAdminTargetUser(req, res, usernameParam);
    if (!target) return;
    if ((await getKnownSystemSkillIds()).has(skillId)) {
      return res.status(400).json({ error: '技能池文档必须通过 /pool 管理' });
    }
    if ((await getManagedTenantSkillIdsForUser(target)).has(skillId)) {
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

  /** PUT /custom/:username/:skillId/document — 兼容旧路径，仅允许写入自己的自建 Skill */
  router.put('/custom/:username/:skillId/document', requireAdmin, async (req, res) => {
    const usernameParam = safeName(req.params.username);
    const skillId = safeName(req.params.skillId);
    if (!usernameParam || !skillId) return res.status(400).json({ error: 'Invalid username or skillId' });
    const target = resolveAdminTargetUser(req, res, usernameParam);
    if (!target) return;
    if ((await getKnownSystemSkillIds()).has(skillId)) {
      return res.status(400).json({ error: '技能池文档必须通过 /pool 管理' });
    }
    if ((await getManagedTenantSkillIdsForUser(target)).has(skillId)) {
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

  /** DELETE /custom/:username/:skillId — 兼容旧路径，仅允许删除自己的自建 Skill。 */
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
    if ((await getManagedTenantSkillIdsForUser(target)).has(skillId)) {
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
      const scanned = await scanUserCustomSkillsAsync(
        tenantSkillsDirFor(tenantId),
        await getPoolSkillIds(),
      );
      const skills = await Promise.all(scanned.map(async (skill) => {
        const rule = skillConfigStore.getTenantOwnSkillRule(tenantId, skill.id);
        const governance = await governedSkillView(tenantSkillResourceId(tenantId, skill.id), tenantId, 'tenant');
        return {
          ...skill,
          enabled: rule.enabled,
          exposure: rule.exposure,
          usernames: rule.usernames,
          ...(governance ? { governance } : {}),
        };
      }));
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

  /** 个人 Skill 到组织的候选副本与审批链建成前保持 fail closed。 */
  router.post('/tenants/:tenantId/promote', requireAdmin, (req, res) => {
    const tenantId = resolveAdminTargetTenantId(req, res, req.params.tenantId);
    if (!tenantId) return;
    res.status(409).json({
      error: '个人 Skill 提交流程尚未启用',
      code: 'PERSONAL_SKILL_SUBMISSION_REQUIRED',
    });
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
    if ((await getKnownSystemSkillIds()).has(skillId) || (await getManagedTenantSkillIdsForUser(user)).has(skillId)) {
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

  /** 原子启用/停用单个 Skill，避免整组选项覆盖。 */
  registerSkillSelectionRoute(router, { skillConfigStore, userStore, safeName, getSelectableSkillIdsForUser });

  router.put('/me/skills/:skillId/document', async (req, res) => {
    const username = req.user?.username;
    if (!username) return res.status(401).json({ error: 'Not authenticated' });
    const user = userStore.findByUsername(username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const skillId = safeName(req.params.skillId);
    if (!skillId) return res.status(400).json({ error: 'Invalid skillId' });
    if ((await getKnownSystemSkillIds()).has(skillId) || (await getManagedTenantSkillIdsForUser(user)).has(skillId)) {
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
    if ((await getManagedTenantSkillIdsForUser(user)).has(skillId)) {
      return res.status(400).json({ error: '不能通过此接口删除组织技能' });
    }

    const skillDir = join(getUserSkillsDir(user), skillId);
    if (!existsSync(skillDir)) {
      return res.status(404).json({ error: `你的工作区中不存在技能“${skillId}”` });
    }

    try {
      await archiveDeletedDirectory(skillDir);
      // 从 selection 中移除，避免 dispatch listForUser / effective 集合出现孤儿 id
      await setUserSkillSelected(skillConfigStore, username, skillId, false);
      auditLog(req, 'skill_custom_deleted', `${username}/${skillId}`);
      res.json({ ok: true });
    } catch (err) {
      serverLogger.error(`DELETE /me/skills/${skillId} error: ${err}`);
      res.status(500).json({ error: '删除自定义技能失败' });
    }
  });

  // ── Admin: View/edit other user ────────────────────────

  /** GET /users/:username — 兼容旧路径，仅允许查看自己的 Skill 状态。 */
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

  /** PUT /users/:username/selections — 兼容旧路径，仅允许更新自己的 Skill 选择。 */
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
    const selectionState = userSkillSelectionState(skillConfigStore, user.username);
    const poolIds = await getKnownSystemSkillIds();
    const managedTenantIds = await getManagedTenantSkillIdsForUser(user);

    // Pool skills: 只返回平台授权、租户启用且成员范围允许的
    const visiblePoolSkills = poolSkills
      .filter(s => skillConfigStore.isTenantSkillAvailableToUser(s.id, user.tenantId, user.username))
      .map(s => ({
        ...s,
        ...selectionState(s.id),
        source: 'pool' as const,
      }));

    // 组织自有 skills: 只返回租户规则允许该成员使用的
    const tenantSkills = user.tenantId
      ? await Promise.all((await scanUserCustomSkillsAsync(
          tenantSkillsDirSafe(user.tenantId),
          await getPoolSkillIds(),
        ))
        .filter(s => skillConfigStore.isTenantOwnSkillAvailableToUser(user.tenantId!, s.id, user.username))
        .map(async s => {
          const governance = await governedSkillView(tenantSkillResourceId(user.tenantId!, s.id), user.tenantId!, 'tenant');
          return {
            ...s,
            ...selectionState(s.id),
            source: 'tenant' as const,
            ...(governance ? { governance } : {}),
          };
        }))
      : [];

    // 自建 skills: 走用户 selection（2026-07-03 改）；排除系统层与已证明的组织物化副本。
    // 早期版本硬编码 selected:true + 前端 disabled Switch，用户无法关闭已上传的自建 skill；
    // 现在按 selection 状态呈现，前端 Switch 恢复可交互，同时用户可自删（DELETE /me/skills/:id）。
    // 组织副本以当前租户目录或 skills-state.json 的 source=tenant provenance 识别，
    // 不用其他租户的同名 ID 猜测个人目录归属。
    // 路径按 user.tenantId 解析（修 PR 4 漏改）
    const userDir = getUserSkillsDir(user);
    const customExcluded = new Set([...poolIds, ...managedTenantIds]);
    const customSkills = await Promise.all((await scanUserCustomSkillsAsync(userDir, customExcluded)).map(async s => {
      const governance = user.tenantId
        ? await governedSkillView(personalSkillResourceId(user.id, s.id), user.tenantId, 'personal')
        : undefined;
      return {
        ...s,
        ...selectionState(s.id),
        source: 'custom' as const,
        ...(governance ? { governance } : {}),
      };
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
