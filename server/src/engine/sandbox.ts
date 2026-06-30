/**
 * 非 admin 用户沙箱规则：默认清单 + 模板展开工具
 *
 * config.json 的 `dispatch.sandbox.{allowWrite,denyRead,allowRead}` 是真相源。
 * 字段未写（undefined）→ fallback 到此处的 DEFAULT_* 常量。
 * 字段写了（含空数组 `[]`） → 以 config 为准。
 *
 * 模板变量（在注入 SDK 前由 expandSandboxPaths 展开）：
 *   {{USER}}              → 当前用户名
 *   {{USER_CWD}}          → 用户 cwd 绝对路径
 *   {{TENANT_CWD}}        → 当前用户 tenant 物理根（`<workspaceRoot>/<tenantSlug>/`）
 *   {{WORKSPACE_ROOT}}    → 所有用户 workspace 的根（= options.globalAgentCwd）
 *   {{SHARED_DIR}}        → 共享配置目录（= options.sharedDir）
 *   {{AGENT_TRANSCRIPT_DIR}} → 当前用户自己的 transcript 目录（按 PR #31 layout
 *                              `~/.agent-saas/legacy-transcripts/<tenantId>/<userId>/`）。
 *                              ctx 缺 agentTranscriptDir 时这条模板展开为空数组（不开洞）——
 *                              用于 transcript 跨组织/跨用户 carve-out 的安全默认（无身份就读不到任何 transcript）
 *   {{OTHER_USER_WORKSPACES}} → 魔法 token：单条元素展开为多条
 *                              （workspaceRoot 下除当前用户、uploads、dotfile 外的全部子目录）
 *   {{OTHER_TENANT_WORKSPACES}} → 魔法 token：兄弟 tenant 根目录（PR 4 跨组织隔离）
 *   {{OTHER_TENANT_SETTINGS}}   → 魔法 token：兄弟 tenant 的 .ky-agent/settings.json（PR 6 P0-5）
 */

import { readdirSync } from 'fs';
import { basename, resolve } from 'path';
import { agentSettingsPath, legacySettingsPath } from '../workspace/namespace.js';

export const DEFAULT_SANDBOX_ALLOW_WRITE: readonly string[] = [
  '/tmp',
  '~/Library/Caches/ms-playwright',
];

export const DEFAULT_SANDBOX_DENY_READ: readonly string[] = [
  // 所有代码项目（含 Agent 平台机密和其他项目 .env）
  '~/code',

  // 跨用户 workspace 隔离（同 tenant 内）
  '{{OTHER_USER_WORKSPACES}}',
  // PR 4：跨组织 workspace 隔离（兄弟 tenant 根目录全部 deny）
  '{{OTHER_TENANT_WORKSPACES}}',

  // 共享配置中的敏感文件
  '{{SHARED_DIR}}/.ky-agent/settings.json',
  '{{SHARED_DIR}}/.claude/settings.json',
  // PR 6 P0-5：per-tenant settings.json 隔离 — 兄弟 tenant 的 settings 全部 deny
  // （包括自己 tenant 的也 deny，与 .ky-agent/settings.json 一致策略，防止 mcpServers 注入升权）
  '{{OTHER_TENANT_SETTINGS}}',

  // 凭证与密钥
  '~/.ssh',
  '~/.git-credentials',
  '~/.npmrc',
  '~/.netrc',
  '~/.config/gcloud',
  '~/.config/gh',
  '~/.docker',
  '~/.aws',
  // ky-azeroth CLI 全局凭证（admin token 共用漏洞，必须 deny）
  // 非 admin 用户的 ky-azeroth 鉴权改走 dispatch 注入的 AZEROTH_TOKEN env
  '~/.azeroth-cli',

  // 代理/隧道配置
  '~/.config/frp',
  '~/.config/mihomo',
  '~/.config/clash',
  '~/.config/wireguard',
  '~/Library/Application Support/Surge',

  // macOS 系统凭证 + 个人数据
  '~/Library/Keychains',
  '~/Library/Application Support/Google/Chrome',
  '~/Library/Mobile Documents',
  '~/Desktop',
  '~/Documents',
  '~/Downloads',
  '~/Pictures',
  '~/Music',
  '~/Movies',

  // Agent SaaS transcript 主路径（PR #31 起；之前透明放行带跨组织漏洞）：
  // 整目录默认拒，由 {{AGENT_TRANSCRIPT_DIR}} 在 ALLOW_READ 给当前用户自己开洞。
  // 防御目标：user A 的 agent 进程不应能 path traversal 读 user B/跨组织的 transcript。
  '~/.agent-saas/legacy-transcripts',

  // Claude Code 数据 + Shell 历史
  // ~/.claude 下 SDK 多个子目录(shell-snapshots/skills/plugins/agents 等)需默认放行，故只显式 deny 已知敏感项
  '~/.claude/projects',
  '~/.claude/sessions',
  '~/.claude/session-env',
  '~/.claude/settings.json',
  '~/.claude/settings.json.bak',
  '~/.claude/history.jsonl',
  '~/.claude/hooks',
  '~/.claude/teams',
  '~/.claude/chrome',
  '~/.claude/debug',
  '~/.claude/paste-cache',
  '~/.claude/mcp-needs-auth-cache.json',
  '~/.claude/telemetry',
  '~/.claude/statsig',
  '~/.zsh_history',
  '~/.bash_history',

];

export const DEFAULT_SANDBOX_ALLOW_READ: readonly string[] = [
  // 当前用户自己的 Agent SaaS transcript（PR #31 起的新 layout，按 tenantId/userId 隔离）。
  // ctx.agentTranscriptDir 由调用方算好（见 projectKey.ts#getAgentTranscriptDir），
  // 缺失时此条不展开（安全默认：宁可读不到自己的也不开错洞）。
  '{{AGENT_TRANSCRIPT_DIR}}',
  // 当前用户自己的旧 Claude 会话数据（extract-user-messages.py 脚本需要；迁移期保留）
  '~/.claude/projects/-Users-admin-workspace-{{USER}}',
  '~/.claude/projects/-Users-admin-code-agent-workspace-{{USER}}',
  // 共享脚本目录（skills-pool 不暴露给非 admin，skills 已通过 syncSkills 复制）
  '{{SHARED_DIR}}/.ky-agent/scripts',
];

export interface SandboxExpandContext {
  username: string;
  userCwd: string;
  /**
   * 整个 agent workspace 的物理根（globalAgentCwd）。当前下层布局为
   * `<workspaceRoot>/<tenantSlug>/<userId>/`。
   */
  workspaceRoot: string;
  /**
   * 用户所属 tenant 的物理根（`<workspaceRoot>/<tenantSlug>/`，PR 4 新增）。
   * 用于：
   *   - `{{TENANT_CWD}}` 模板展开
   *   - `{{OTHER_USER_WORKSPACES}}` 限定在同 tenant 内扫描（不再误 deny 跨 tenant 根）
   */
  tenantCwd: string;
  sharedDir: string;
  /**
   * 当前用户自己的 Agent SaaS transcript 目录（PR #31 起 layout：
   * `~/.agent-saas/legacy-transcripts/<tenantId>/<userId>/`）。
   * 调用方按 projectKey.ts#getAgentTranscriptDir({tenantId, userId}) 计算后传入。
   * 缺失（老 session/anonymous 无完整身份）时 `{{AGENT_TRANSCRIPT_DIR}}` 展开为空——
   * 安全降级：宁可不开自己的洞，也不放行任何 transcript（DENY_READ 仍生效）。
   */
  agentTranscriptDir?: string;
}

const OTHER_USER_WORKSPACES_TOKEN = '{{OTHER_USER_WORKSPACES}}';
const OTHER_TENANT_WORKSPACES_TOKEN = '{{OTHER_TENANT_WORKSPACES}}';
const OTHER_TENANT_SETTINGS_TOKEN = '{{OTHER_TENANT_SETTINGS}}';
const AGENT_TRANSCRIPT_DIR_TOKEN = '{{AGENT_TRANSCRIPT_DIR}}';

function expandOtherUserWorkspaces(ctx: SandboxExpandContext): string[] {
  // PR 4 起扫 tenant 根（仅同 tenant 内其他用户），不再扫 globalAgentCwd
  try {
    const ownWorkspaceBase = basename(ctx.userCwd);
    return readdirSync(ctx.tenantCwd)
      .filter((name) => name !== ownWorkspaceBase && name !== ctx.username && name !== 'uploads' && !name.startsWith('.'))
      .map((name) => resolve(ctx.tenantCwd, name));
  } catch {
    return [];
  }
}

/** sharedDir 下不参与 tenant settings 扫描的保留目录名（与 runtime.ts 同步） */
const SHARED_DIR_RESERVED_NAMES = new Set(['skills-pool', 'scripts']);

function expandOtherTenantSettings(ctx: SandboxExpandContext): string[] {
  // PR 6 P0-5：扫 sharedDir 下所有 <tenantSlug>/.ky-agent/settings.json，全部 deny
  // 迁移期同时 deny legacy .claude/settings.json；运行态不再读取 legacy，但残留敏感文件不能暴露给 LLM。
  // （含自己 tenant 的 — settings.json 不该被 LLM 读，与全局 SHARED_DIR/.ky-agent/settings.json 同策略）
  try {
    return readdirSync(ctx.sharedDir)
      .filter((name) => /^[a-z][a-z0-9-]{1,30}$/.test(name))
      .filter((name) => !SHARED_DIR_RESERVED_NAMES.has(name))
      .flatMap((name) => {
        const tenantSharedDir = resolve(ctx.sharedDir, name);
        return [agentSettingsPath(tenantSharedDir), legacySettingsPath(tenantSharedDir)];
      });
  } catch {
    return [];
  }
}

function expandOtherTenantWorkspaces(ctx: SandboxExpandContext): string[] {
  // 扫 globalAgentCwd 直接子目录，剔除自己 tenant + 非目录类（uploads/.xxx）
  // PR 5 修 P1-8：用 basename() 取 own tenant slug，防 tenantCwd 末尾 '/' 导致
  // split('/').pop() 返回空字符串，进而把自己 tenant 也加进 denyRead 自锁。
  try {
    const ownTenantBase = basename(ctx.tenantCwd);
    return readdirSync(ctx.workspaceRoot)
      .filter((name) => name !== ownTenantBase && name !== 'uploads' && !name.startsWith('.'))
      .map((name) => resolve(ctx.workspaceRoot, name));
  } catch {
    return [];
  }
}

function substituteVariables(template: string, ctx: SandboxExpandContext): string {
  return template
    .replace(/\{\{USER\}\}/g, ctx.username)
    .replace(/\{\{USER_CWD\}\}/g, ctx.userCwd)
    .replace(/\{\{TENANT_CWD\}\}/g, ctx.tenantCwd)
    .replace(/\{\{WORKSPACE_ROOT\}\}/g, ctx.workspaceRoot)
    .replace(/\{\{SHARED_DIR\}\}/g, ctx.sharedDir);
}

/** 展开模板清单为最终路径列表 */
export function expandSandboxPaths(
  templates: readonly string[],
  ctx: SandboxExpandContext,
): string[] {
  return templates.flatMap((t) => {
    if (t === OTHER_USER_WORKSPACES_TOKEN) return expandOtherUserWorkspaces(ctx);
    if (t === OTHER_TENANT_WORKSPACES_TOKEN) return expandOtherTenantWorkspaces(ctx);
    if (t === OTHER_TENANT_SETTINGS_TOKEN) return expandOtherTenantSettings(ctx);
    // {{AGENT_TRANSCRIPT_DIR}} 单独走魔法 token 路径而非 substituteVariables，
    // 这样缺失时返回空数组（不开洞），而不是把字面 placeholder 字符串塞进 sandbox profile。
    if (t === AGENT_TRANSCRIPT_DIR_TOKEN) {
      return ctx.agentTranscriptDir ? [ctx.agentTranscriptDir] : [];
    }
    return [substituteVariables(t, ctx)];
  });
}

/**
 * 从 denyRead 模板清单里筛出以 `{{USER_CWD}}/` 开头的条目，
 * 生成 SDK 层 permissions.deny 规则（Read/Edit/Write）。
 *
 * 目的：让 Claude 在尝试前就知道"别碰"，UX 优于等 OS 沙箱 EPERM。
 * 只处理 cwd 内路径因为 SDK permissions 用 cwd-relative 形式（./xxx/**）；
 * 家目录级路径表达不便，由 OS 沙箱兜底。
 */
export function extractSdkCwdDenyPatterns(
  denyReadTemplates: readonly string[],
): string[] {
  const prefix = '{{USER_CWD}}/';
  const patterns: string[] = [];
  for (const t of denyReadTemplates) {
    if (!t.startsWith(prefix)) continue;
    const rel = t.slice(prefix.length);
    if (!rel) continue;
    patterns.push(`Read(./${rel}/**)`, `Edit(./${rel}/**)`, `Write(./${rel}/**)`);
  }
  return patterns;
}
