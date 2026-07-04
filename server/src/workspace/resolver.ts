/**
 * Per-User Workspace Resolver
 *
 * 为每个用户解析并初始化隔离的工作目录。
 * 三层防御：SDK cwd 隔离 + permissionMode default + canUseTool 自动拒绝。
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync, lstatSync, renameSync, readdirSync, cpSync, rmSync, unlinkSync, statSync } from 'fs';
import { join, basename, resolve } from 'path';
import { execSync } from 'child_process';
import { serverLogger } from '../utils/logger.js';
import type { SkillConfigStore } from '../data/skills/store.js';
import { scanTenantOwnSkillIds } from '../data/skills/scanner.js';
import { DEFAULT_TENANT_ID, TENANT_SLUG_PATTERN } from '../data/tenants/types.js';
import { resolveTenantSkillsDir } from '../data/tenants/tenantSkillsPath.js';
import {
  agentDir,
  agentPath,
  agentScriptsDir,
  agentSkillsDir,
  resolveAgentPath,
  WORKSPACE_META_FILE,
} from './namespace.js';
import { ensureWorkspaceRuntimeLayout, repairWorkspacePath, repairWorkspaceTree } from './permissions.js';

export interface WorkspaceUser {
  id: string;
  username: string;
  role: 'admin' | 'user';
  /**
   * Tenant 归属（多组织改造 PR 4）。用于把 workspace 物理路径拆分为
   * `<globalAgentCwd>/<tenantSlug>/<userId>/`，实现跨组织文件系统隔离。
   *
   * 兼容策略：标为 optional 以避免现有 65 处调用方批量重构。未传时
   * `resolveUserCwd` 内部 fallback 到 DEFAULT_TENANT_ID。req.user 来源的调用方
   * （channels/routes）会显式传入；启动迁移 / cleanup / test fixture 等内部
   * 调用走默认 tenant。
   */
  tenantId?: string;
}

/** 创建工作区时可携带的额外用户信息（用于初始化 MEMORY.md 等） */
export interface WorkspaceUserMeta {
  realName?: string;
  /** 岗位（自由文本，如「销售」）。有值时写入 MEMORY.md 当前用户行。 */
  position?: string;
}

/**
 * 解析用户的专属 cwd 路径
 *
 * 当前多组织路径布局：`<globalAgentCwd>/<tenantSlug>/<userId>/`
 *   - 有 user → join(globalAgentCwd, tenantSlug, user.id)
 *   - 无 user（未认证）→ globalAgentCwd（向后兼容）
 *
 * 不安全的 tenantSlug 自动 fallback 到 DEFAULT 防止路径注入（双重防御：
 * UserStore 已校验过 + 这里二次校验）。物理路径不再使用 username，避免
 * 登录名/展示名变化导致 workspace 分叉。
 */
export function resolveUserCwd(globalAgentCwd: string, user?: WorkspaceUser): string {
  if (!user) return globalAgentCwd;
  const candidate = user.tenantId || DEFAULT_TENANT_ID;
  const tenantSlug = TENANT_SLUG_PATTERN.test(candidate) ? candidate : DEFAULT_TENANT_ID;
  return join(globalAgentCwd, tenantSlug, safeUserPathSegment(user.id));
}

/**
 * 解析某个 tenant 的根目录（用于 sandbox 模板 {{TENANT_CWD}} 展开 / 一次性迁移）。
 */
export function resolveTenantCwd(globalAgentCwd: string, tenantSlug: string): string {
  const safe = TENANT_SLUG_PATTERN.test(tenantSlug) ? tenantSlug : DEFAULT_TENANT_ID;
  return join(globalAgentCwd, safe);
}

/**
 * 首次使用时初始化用户工作目录结构
 *
 * 创建目录、同步 skills、建立 scripts symlink、生成配置文件。
 * 幂等操作——目录已存在则跳过。
 */
export async function ensureUserWorkspace(
  userCwd: string,
  globalAgentCwd: string,
  sharedDir: string,
  user?: WorkspaceUser,
  meta?: WorkspaceUserMeta,
  skillConfigStore?: SkillConfigStore,
): Promise<void> {
  // 迁移：历史路径曾用过 <cwd>/<userId>、<cwd>/<username>、
  // <cwd>/<tenant>/<username>。当前统一为 <cwd>/<tenant>/<userId>。
  if (user) {
    const tenantSlug = TENANT_SLUG_PATTERN.test(user.tenantId || '') ? user.tenantId! : DEFAULT_TENANT_ID;
    const legacyCandidates = [
      { path: join(globalAgentCwd, tenantSlug, user.username), label: `${tenantSlug}/${user.username}` },
      { path: join(globalAgentCwd, user.username), label: user.username },
      { path: join(globalAgentCwd, user.id), label: user.id },
    ];
    for (const legacy of legacyCandidates) {
      if (
        legacy.path !== userCwd
        && existsSync(agentDir(legacy.path))
        && !existsSync(userCwd)
      ) {
        serverLogger.info(`Migrating workspace ${legacy.label} → ${tenantSlug}/${safeUserPathSegment(user.id)}`);
        mkdirSync(join(userCwd, '..'), { recursive: true });
        renameSync(legacy.path, userCwd);
        break;
      }
    }
  }

  // 如果用户目录已存在，仍要修复 runtime layout / owner，避免历史 root-owned 目录阻断 ACS。
  if (existsSync(agentDir(userCwd))) {
    writeWorkspaceMeta(userCwd, user);
    ensureWorkspaceRuntimeLayout(userCwd);
    return;
  }

  const isAdmin = user?.role === 'admin';
  serverLogger.info(`Initializing workspace for ${user?.username ?? 'unknown'} (${isAdmin ? 'admin' : 'user'}) at ${userCwd}`);

  // 创建目录结构
  mkdirSync(agentDir(userCwd), { recursive: true });
  mkdirSync(join(userCwd, 'memory'), { recursive: true });
  mkdirSync(join(userCwd, 'memory', 'topics'), { recursive: true });
  mkdirSync(join(userCwd, 'uploads'), { recursive: true });

  // 浏览器 profile 隔离目录（权限 700）
  // CDP 模式下 browser.ts 会用 --user-data-dir 指向此目录
  // 首次创建时从种子模板复制初始指纹（语言、窗口大小、First Run 标记等），避免空白 profile 被反爬拦截
  const browserProfile = agentPath(userCwd, 'runtime', 'browser-profile');
  if (!existsSync(browserProfile)) {
    const seedDir = join(sharedDir, '.browser-profile-seed');
    if (existsSync(seedDir)) {
      cpSync(seedDir, browserProfile, { recursive: true });
    } else {
      mkdirSync(browserProfile, { recursive: true });
    }
  }
  repairWorkspacePath(browserProfile, 0o700);

  // 放置空 package.json 防止 npm install 向上逃逸到项目根目录
  writePackageJson(userCwd);

  // Python venv（所有用户共用同一套规范）
  ensureVenv(userCwd);

  // 新用户：自动继承所有当前可见的 pool skills
  if (skillConfigStore && user) {
    const existing = skillConfigStore.getUserSelectedSkills(user.username);
    if (existing.length === 0) {
      const visibleSkills = Object.entries(skillConfigStore.getPoolVisibility())
        .filter(([, v]) => v !== false)
        .map(([id]) => id);
      const tenantSkills = visibleSkills.filter((id) => skillConfigStore.isTenantSkillAvailableToUser(id, user.tenantId, user.username));
      if (tenantSkills.length > 0) {
        await skillConfigStore.setUserSelectedSkills(user.username, tenantSkills);
      }
    }
  }

  // 同步 skills（从 pool 按配置分配）+ scripts
  syncSkills(userCwd, sharedDir, user, skillConfigStore);
  syncScripts(userCwd, sharedDir);

  // 写入初始版本标记
  if (skillConfigStore) {
    const versionFile = agentPath(userCwd, '.skills-version');
    writeFileSync(versionFile, String(skillConfigStore.getConfigVersion()), 'utf-8');
  }

  // MEMORY.md：创建初始内容
  writeMemory(userCwd, sharedDir, isAdmin, user, meta);

  // PERSONA.md：创建初始人格定义
  writePersona(userCwd, sharedDir, user, meta);

  // memory/questions.md：记忆轮询提问记录
  writeQuestions(userCwd, sharedDir);
  writeWorkspaceMeta(userCwd, user);
  ensureWorkspaceRuntimeLayout(userCwd);
}

// ============================================
// Internal helpers
// ============================================

/**
 * 从 skills-pool 按用户角色同步 skill 到用户目录。
 * 系统 skill 全量覆盖，用户自建 skill 和 .system/ 不触碰。
 */
export function syncSkills(userCwd: string, sharedDir: string, user?: WorkspaceUser, skillConfigStore?: SkillConfigStore): void {
  const poolDir = resolveAgentPath(sharedDir, 'skills-pool');
  const userSkillsDir = agentSkillsDir(userCwd);

  if (!existsSync(poolDir)) {
    serverLogger.warn(`Skills pool not found: ${poolDir}`);
    return;
  }

  // 确保用户 skills 目录存在（可能是首次创建，也可能已是真实目录）
  mkdirSync(userSkillsDir, { recursive: true });

  const username = user?.username || basename(userCwd);

  // 获取 pool 中所有 skill 名（排除 _ 开头的文件如 _manifest.json）
  const poolSkills = new Set(
    readdirSync(poolDir).filter(d => {
      if (d.startsWith('_') || d.startsWith('.')) return false;
      try { return statSync(join(poolDir, d)).isDirectory(); } catch { return false; }
    })
  );

  // 租户自有 skill 源目录与现存 ids（与 pool 同名的被 shadow，pool 优先）
  let tenantSkillsSrcDir: string | null = null;
  let tenantOwnIds = new Set<string>();
  if (skillConfigStore && user?.tenantId) {
    try {
      tenantSkillsSrcDir = resolveTenantSkillsDir(sharedDir, user.tenantId);
      tenantOwnIds = scanTenantOwnSkillIds(tenantSkillsSrcDir, poolSkills);
    } catch {
      // 非法 tenantId → 视为无租户层
    }
  }

  // 计算该用户应有的 skill 集合
  const targetSkills = new Set<string>();

  if (skillConfigStore) {
    // 新模式：从 SkillConfigStore 读取（pool + 租户自有两层）
    for (const id of skillConfigStore.getUserEffectivePoolSkills(username, user?.tenantId)) {
      targetSkills.add(id);
    }
    for (const id of skillConfigStore.getUserEffectiveTenantOwnSkills(username, user?.tenantId, tenantOwnIds)) {
      targetSkills.add(id);
    }
  } else {
    // 兼容回退：从旧 _manifest.json 读取
    const manifestPath = join(poolDir, '_manifest.json');
    if (!existsSync(manifestPath)) {
      serverLogger.warn(`Skills manifest not found: ${manifestPath}`);
      return;
    }
    let manifest: any;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    } catch (err) {
      serverLogger.warn(`Failed to parse skills manifest: ${err}`);
      return;
    }
    const userConfig = manifest.users[username];
    const userRoles: string[] = userConfig?.roles || ['core'];
    for (const role of userRoles) {
      const skills = manifest.roles[role];
      if (skills) {
        for (const s of skills) targetSkills.add(s);
      }
    }
  }

  // 扫描用户当前 skills 目录
  const existingDirs = readdirSync(userSkillsDir).filter(d => {
    const p = join(userSkillsDir, d);
    try { return statSync(p).isDirectory(); } catch { return false; }
  });

  // 已知的系统 skill ID 集合（pool 中存在的 + 曾经在配置中注册过的 + 本租户自有的）
  const knownSystemSkills = new Set(poolSkills);
  if (skillConfigStore) {
    for (const id of Object.keys(skillConfigStore.getPoolVisibility())) {
      knownSystemSkills.add(id);
    }
    for (const id of tenantOwnIds) knownSystemSkills.add(id);
    if (user?.tenantId) {
      // 已删除但规则条目尚未 prune 的租户自有 skill，也要清理用户残留副本
      for (const id of Object.keys(skillConfigStore.getTenantOwnSkillRules(user.tenantId))) {
        knownSystemSkills.add(id);
      }
    }
  }

  // 1. 删除多余的系统 skill：
  //    - 在 pool 中存在但用户不该有的（角色/选择变更）
  //    - pool 中已删除但用户残留的（通过 poolVisibility 历史记录识别）
  for (const dir of existingDirs) {
    if (knownSystemSkills.has(dir) && !targetSkills.has(dir)) {
      rmSync(join(userSkillsDir, dir), { recursive: true, force: true });
      serverLogger.info(`Removed skill '${dir}' from ${username} (not in target set)`);
    }
  }

  // 2. 复制/覆盖系统 skill（源查找 pool 优先，其次租户自有目录）
  for (const skill of targetSkills) {
    const poolSrc = join(poolDir, skill);
    const tenantSrc = tenantSkillsSrcDir ? join(tenantSkillsSrcDir, skill) : null;
    const src = existsSync(poolSrc) ? poolSrc : (tenantSrc && existsSync(tenantSrc) ? tenantSrc : null);
    const dst = join(userSkillsDir, skill);
    if (!src) {
      // pool 与租户目录都已不存在，删除用户残留副本
      if (existsSync(dst)) {
        rmSync(dst, { recursive: true, force: true });
        serverLogger.info(`Removed stale skill '${skill}' from ${username} (no longer in pool/tenant dir)`);
      }
      continue;
    }
    // 删除旧的再复制（确保干净覆盖）
    if (existsSync(dst)) {
      rmSync(dst, { recursive: true, force: true });
    }
    cpSync(src, dst, {
      recursive: true,
      filter: (source) => {
        const name = basename(source);
        return name !== '__pycache__' && name !== '.DS_Store' && name !== 'node_modules';
      },
    });
    repairWorkspaceTree(dst);
  }

  serverLogger.info(`Synced ${targetSkills.size} skills for ${username}`);
}

/**
 * 如果用户的 .ky-agent/skills 仍是软链接，迁移为真实目录。
 * 返回 true 表示发生了迁移（调用方应执行 syncSkills）。
 */
function migrateSkillsSymlink(userCwd: string): boolean {
  const skillsPath = agentSkillsDir(userCwd);
  try {
    if (existsSync(skillsPath) && lstatSync(skillsPath).isSymbolicLink()) {
      unlinkSync(skillsPath); // 删除软链接
      mkdirSync(skillsPath, { recursive: true }); // 创建真实目录
      serverLogger.info(`Migrated skills symlink to real directory: ${skillsPath}`);
      return true;
    }
  } catch (err) {
    serverLogger.warn(`Failed to migrate skills symlink: ${err}`);
  }
  return false;
}

function syncScripts(userCwd: string, sharedDir: string): void {
  const targetDir = resolveAgentPath(sharedDir, 'scripts');
  const scriptsPath = agentScriptsDir(userCwd);

  if (!existsSync(targetDir)) return;

  try {
    const existing = lstatSync(scriptsPath);
    if (existing.isSymbolicLink()) {
      unlinkSync(scriptsPath);
    } else if (!existing.isDirectory()) {
      serverLogger.warn(`Skip syncing scripts because path is not a directory: ${scriptsPath}`);
      return;
    }
  } catch {
    // scriptsPath 不存在，继续复制
  }

  try {
    cpSync(targetDir, scriptsPath, { recursive: true, force: true });
    repairWorkspaceTree(scriptsPath);
  } catch (err) {
    serverLogger.warn(`Failed to sync scripts: ${err}`);
  }
}

function writeMemory(
  userCwd: string,
  sharedDir: string,
  _isAdmin: boolean,
  user?: WorkspaceUser,
  meta?: WorkspaceUserMeta,
): void {
  const userMemoryPath = join(userCwd, 'MEMORY.md');
  if (existsSync(userMemoryPath)) return;

  const templatePath = join(sharedDir, 'MEMORY.template.md');
  if (!existsSync(templatePath)) {
    serverLogger.warn(`MEMORY template not found: ${templatePath}`);
    return;
  }

  const displayName = meta?.realName || user?.username || 'unknown';
  const createdDate = new Date().toISOString().slice(0, 10);
  // 岗位有值时拼进当前用户行（「张三（岗位：销售）：账号创建于…」），无值时占位符移除
  const positionNote = meta?.position?.trim() ? `（岗位：${meta.position.trim()}）` : '';
  const content = readFileSync(templatePath, 'utf-8')
    .replace(/\{\{displayName\}\}/g, displayName)
    .replace(/\{\{positionNote\}\}/g, positionNote)
    .replace(/\{\{createdDate\}\}/g, createdDate);
  writeFileSync(userMemoryPath, content, 'utf-8');
}

function writePersona(
  userCwd: string,
  sharedDir: string,
  user?: WorkspaceUser,
  meta?: WorkspaceUserMeta,
): void {
  const personaPath = join(userCwd, 'PERSONA.md');
  if (existsSync(personaPath)) return;

  const templatePath = join(sharedDir, 'PERSONA.template.md');
  if (!existsSync(templatePath)) {
    serverLogger.warn(`PERSONA template not found: ${templatePath}`);
    return;
  }

  const displayName = meta?.realName || user?.username || '用户';
  const content = readFileSync(templatePath, 'utf-8')
    .replace(/\{\{displayName\}\}/g, displayName);
  writeFileSync(personaPath, content, 'utf-8');
}

function writeQuestions(userCwd: string, sharedDir: string): void {
  const questionsPath = join(userCwd, 'memory', 'questions.md');
  if (existsSync(questionsPath)) return;

  const templatePath = join(sharedDir, 'questions.template.md');
  if (existsSync(templatePath)) {
    writeFileSync(questionsPath, readFileSync(templatePath, 'utf-8'), 'utf-8');
  } else {
    // fallback：无模板时直接写入默认内容
    writeFileSync(questionsPath, '# Agent 提问记录\n\n## 待回答\n\n## 拒绝回答\n\n## 已回答\n', 'utf-8');
  }
}

function writeWorkspaceMeta(userCwd: string, user?: WorkspaceUser): void {
  const metaPath = agentPath(userCwd, WORKSPACE_META_FILE);
  if (existsSync(metaPath)) return;
  const now = new Date().toISOString();
  const meta = {
    schemaVersion: 1,
    namespace: '.ky-agent',
    createdAt: now,
    updatedAt: now,
    tenantId: user?.tenantId || DEFAULT_TENANT_ID,
    userId: user?.id,
    username: user?.username,
  };
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf-8');
}

// writePlaywrightConfig 已移除：CDP 模式下由 dispatch.ts 在 env 中注入 PLAYWRIGHT_MCP_CDP_ENDPOINT，
// 不再需要 .playwright/cli.config.json 和 browser-token 文件。

/**
 * 确保用户 workspace 内有可用的 Python venv。
 * 幂等——venv 已存在则跳过。
 */
function ensureVenv(userCwd: string): void {
  if (process.env.AGENT_SAAS_CREATE_WORKSPACE_VENV !== '1') return;
  const venvPath = agentPath(userCwd, 'runtime', 'venv');
  if (existsSync(join(venvPath, 'bin', 'python3'))) return;

  const pythonBin = '/opt/homebrew/bin/python3.13';
  if (!existsSync(pythonBin)) {
    serverLogger.warn(`Python not found at ${pythonBin}, skipping venv creation`);
    return;
  }

  try {
    execSync(`"${pythonBin}" -m venv "${venvPath}"`, { timeout: 30_000 });
    serverLogger.info(`Created Python venv at ${venvPath}`);
  } catch (err) {
    serverLogger.warn(`Failed to create Python venv at ${venvPath}: ${err}`);
  }
}

function writePackageJson(userCwd: string): void {
  const pkgPath = join(userCwd, 'package.json');
  if (existsSync(pkgPath)) return;

  try {
    writeFileSync(pkgPath, JSON.stringify({ private: true }, null, 2) + '\n', 'utf-8');
  } catch (err) {
    serverLogger.warn(`Failed to create package.json fence: ${err}`);
  }
}

const USER_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;

function safeUserPathSegment(userId: string): string {
  if (USER_PATH_SEGMENT_PATTERN.test(userId) && !userId.includes('..') && !userId.startsWith('.')) {
    return userId;
  }
  const digest = createHash('sha256').update(userId).digest('base64url').slice(0, 20);
  return `u_${digest}`;
}

/**
 * 迁移已有用户工作目录：确保 symlink 与最新模板同步。
 */
export function refreshUserWorkspace(
  userCwd: string,
  _globalAgentCwd: string,
  sharedDir: string,
  _isAdmin: boolean,
  user?: WorkspaceUser,
  meta?: WorkspaceUserMeta,
  skillConfigStore?: SkillConfigStore,
): void {
  ensureWorkspaceRuntimeLayout(userCwd);

  // 迁移旧的 skills 软链接为真实目录
  const migrated = migrateSkillsSymlink(userCwd);

  if (skillConfigStore) {
    // 版本检查驱动的 skill 同步
    const versionFile = agentPath(userCwd, '.skills-version');
    const currentVersion = skillConfigStore.getConfigVersion();
    let localVersion = 0;
    try {
      localVersion = parseInt(readFileSync(versionFile, 'utf-8').trim(), 10) || 0;
    } catch { /* file not found or unreadable */ }

    if (migrated || localVersion < currentVersion) {
      syncSkills(userCwd, sharedDir, user, skillConfigStore);
      writeFileSync(versionFile, String(currentVersion), 'utf-8');
    }
  } else if (migrated) {
    // 兼容回退
    syncSkills(userCwd, sharedDir, user);
  }
  syncScripts(userCwd, sharedDir);
  writePersona(userCwd, sharedDir, user, meta);
  writeQuestions(userCwd, sharedDir);
  // 补全浏览器 profile 目录（老用户迁移：目录不存在时从种子模板复制）
  const browserProfile = agentPath(userCwd, 'runtime', 'browser-profile');
  if (!existsSync(browserProfile)) {
    const seedDir = join(sharedDir, '.browser-profile-seed');
    if (existsSync(seedDir)) {
      cpSync(seedDir, browserProfile, { recursive: true });
    } else {
      mkdirSync(browserProfile, { recursive: true });
    }
    repairWorkspacePath(browserProfile, 0o700);
  }
  // Python venv（已有则跳过，existsSync 开销可忽略）
  ensureVenv(userCwd);
  writeWorkspaceMeta(userCwd, user);
  ensureWorkspaceRuntimeLayout(userCwd);
}
