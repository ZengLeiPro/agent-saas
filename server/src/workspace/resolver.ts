/**
 * Per-User Workspace Resolver
 *
 * 为每个用户解析并初始化隔离的工作目录。
 * 三层防御：SDK cwd 隔离 + permissionMode default + canUseTool 自动拒绝。
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync } from 'fs';
import { cp, lstat, mkdir } from 'node:fs/promises';
import { join, resolve } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'node:util';
import { serverLogger } from '../utils/logger.js';
import type { SkillConfigStore } from '../data/skills/store.js';
import { DEFAULT_TENANT_ID, TENANT_SLUG_PATTERN } from '../data/tenants/types.js';
import {
  agentDir,
  agentPath,
  WORKSPACE_META_FILE,
} from './namespace.js';
import { ensureWorkspaceRuntimeLayout, repairWorkspacePath } from './permissions.js';

const execFileAsync = promisify(execFile);

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

/** Agent 模型执行工作区；使用独立目录层级，绝不与真人用户工作区重合。 */
export function resolveAgentCwd(globalAgentCwd: string, tenantId: string, agentId: string): string {
  const tenantSlug = TENANT_SLUG_PATTERN.test(tenantId) ? tenantId : DEFAULT_TENANT_ID;
  return join(globalAgentCwd, tenantSlug, `.agent-${safeUserPathSegment(agentId)}`);
}

/** Agent 连接器凭据工作区；模型执行 workspace 不挂载此目录。 */
export function resolveAgentConnectorCwd(
  globalAgentCwd: string,
  tenantId: string,
  agentId: string,
  connectorId: string,
): string {
  const tenantSlug = TENANT_SLUG_PATTERN.test(tenantId) ? tenantId : DEFAULT_TENANT_ID;
  return join(
    globalAgentCwd,
    tenantSlug,
    `.agent-connectors-${safeUserPathSegment(agentId)}`,
    safeUserPathSegment(connectorId),
  );
}

/**
 * 首次使用时初始化用户工作目录结构
 *
 * 创建目录并生成用户文件。skills/scripts 由独立异步物化 worker 在首次 dispatch
 * 前补齐，避免注册、登录或普通会话路径阻塞 Node 事件循环。
 * 幂等操作——目录已存在则跳过。
 */
export async function ensureUserWorkspace(
  userCwd: string,
  globalAgentCwd: string,
  sharedDir: string,
  user?: WorkspaceUser,
  meta?: WorkspaceUserMeta,
  skillConfigStore?: SkillConfigStore,
  tenantSkillsRootDir?: string,
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

  // 已存在 workspace 的热路径只做浅层目录/owner 校验。递归修复由显式迁移和
  // 异步物化负责，不能在每次 dispatch 上扫 memory/skills/scripts 全树。
  if (existsSync(agentDir(userCwd))) {
    writeWorkspaceMeta(userCwd, user);
    ensureWorkspaceRuntimeLayout(userCwd, { deepRepair: false });
    // 历史 workspace 的轻量一次性补全仍需保留；重型浏览器种子复制和 venv
    // 创建改用异步 I/O，不能为了移除技能同步顺带丢掉既有迁移职责。
    writePersona(userCwd, sharedDir, user, meta);
    writeQuestions(userCwd, sharedDir);
    writePackageJson(userCwd);
    await ensureBrowserProfile(userCwd, sharedDir);
    await ensureVenv(userCwd);
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
  await ensureBrowserProfile(userCwd, sharedDir);

  // 放置空 package.json 防止 npm install 向上逃逸到项目根目录
  writePackageJson(userCwd);

  // Python venv（所有用户共用同一套规范）
  await ensureVenv(userCwd);

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
async function ensureVenv(userCwd: string): Promise<void> {
  if (process.env.AGENT_SAAS_CREATE_WORKSPACE_VENV !== '1') return;
  const venvPath = agentPath(userCwd, 'runtime', 'venv');
  if (existsSync(join(venvPath, 'bin', 'python3'))) return;

  const pythonBin = '/opt/homebrew/bin/python3.13';
  if (!existsSync(pythonBin)) {
    serverLogger.warn(`Python not found at ${pythonBin}, skipping venv creation`);
    return;
  }

  try {
    await execFileAsync(pythonBin, ['-m', 'venv', venvPath], { timeout: 30_000 });
    serverLogger.info(`Created Python venv at ${venvPath}`);
  } catch (err) {
    serverLogger.warn(`Failed to create Python venv at ${venvPath}: ${err}`);
  }
}

async function ensureBrowserProfile(userCwd: string, sharedDir: string): Promise<void> {
  const browserProfile = agentPath(userCwd, 'runtime', 'browser-profile');
  if (!await lstat(browserProfile).then(() => true).catch(() => false)) {
    await mkdir(agentPath(userCwd, 'runtime'), { recursive: true });
    const seedDir = join(sharedDir, '.browser-profile-seed');
    if (await lstat(seedDir).then((info) => info.isDirectory()).catch(() => false)) {
      await cp(seedDir, browserProfile, { recursive: true });
    } else {
      await mkdir(browserProfile, { recursive: true });
    }
  }
  repairWorkspacePath(browserProfile, 0o700);
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
