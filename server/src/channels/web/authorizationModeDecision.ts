/**
 * 授权模式（`autoApproveTools && !lowRiskOnly`）下「沙箱审计后自动裁决」的判定。
 *
 * 从 `channel.ts` 的 `onInteraction` 等行数外提（WP3 施工总则 §3.3）：
 * `channel.ts` 已顶在 `config/max-lines-baseline.txt` 的 4341 行，
 * 加 `app__` 分支只能先把这段判定搬出来。**行为与外提前逐条一致**，
 * 唯一新增的是定制项目能力（`app__`，规范 §6.1/§6.2）的两条分支：
 *
 * - `read_only` 能力：与 `mcp__` 同级放行（外部只读、无写副作用）。
 * - `external_write` 能力：返回 `undefined` = 本判定不表态，
 *   让调用方落到人工审批流 —— 即使授权模式开启也必须弹确认（规范 §6.2-2、WP3 DoD 第三条）。
 *   风险档未知时同样按写能力处理（fail-closed，见 `kyapp/gateway/toolRiskRegistry.ts`）。
 */
import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';

import type { InteractionResponse } from '../../agent/types.js';
import {
  isAppReadOnlyTool,
  requiresAppWriteConfirmation,
} from '../../kyapp/gateway/toolRiskRegistry.js';
import {
  getUserExtraDirs,
  isPathWithinAnyDirectory,
  isPathWithinDirectory,
  type UserOverrides,
} from '../../security/extraDirs.js';
import { resolveAgentPath } from '../../workspace/namespace.js';
import { resolveUserCwd, type WorkspaceUser } from '../../workspace/resolver.js';

/** 授权模式免人工确认的安全工具：无路径/命令风险。 */
const SAFE_AUTO_APPROVE_TOOLS = new Set([
  'Agent',
  'Workflow',
  'WebFetch',
  'WebSearch',
  'Task',
  'Skill',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
  'TaskCreate',
  'TaskUpdate',
  'TaskGet',
  'TaskList',
  'TaskStop',
  'TaskOutput',
  'TodoWrite',
  'ToolSearch',
  'CronCreate',
  'CronDelete',
  'CronList',
  'RemoteTrigger',
]);

/** 文件类工具的路径入参字段映射。 */
const PATH_FIELD_BY_TOOL: Record<string, { field: string; optional?: boolean }> = {
  Read: { field: 'path' },
  Write: { field: 'path' },
  Edit: { field: 'file_path' },
  NotebookEdit: { field: 'notebook_path' },
};

/** 写操作禁止落到的 agent 设置文件（相对用户 cwd）。 */
const PROTECTED_SETTINGS_RELATIVE_PATHS = new Set([
  '.ky-agent/settings.json',
  '.ky-agent/settings.local.json',
  '.claude/settings.json',
  '.claude/settings.local.json',
]);

/** shared agent 目录下允许读写的子目录。 */
const SHARED_AGENT_ALLOWED_SUBDIRS = ['skills', 'extension', 'scripts'];

export type AuthorizationModeUser = WorkspaceUser;

export interface AuthorizationModeDecisionInput {
  toolName?: string;
  toolId?: string;
  toolInput?: Record<string, unknown>;
  /** 全局 agent 工作根目录（`config.agentCwd`，调用方保证非空）。 */
  agentCwd: string;
  /** `config.sharedDir`，缺省回落 `agentCwd`。 */
  sharedDir?: string;
  userOverrides?: UserOverrides;
  user: AuthorizationModeUser;
}

/**
 * 判定结果：
 * - `{ allow: true }` / `{ allow: false, message }` —— 自动裁决完成，调用方直接返回。
 * - `undefined` —— 本判定不表态，调用方继续走人工审批流（当前仅 `app__` 写能力）。
 */
export type AuthorizationModeDecision = InteractionResponse | undefined;

/** Bash/Shell 命令审计。 */
function decideShellCommand(
  command: string,
  userCwd: string,
  userExtraDirs: string[],
): InteractionResponse {
  // 环境变量探测命令拦截（纵深防御，主防线是不注入敏感变量 + OS 沙箱）
  if (/(?:^|[;&|]\s*)(?:env|printenv)(?:\s|$|;|\|)/.test(command)) {
    return { allow: false, message: '安全限制：不允许执行环境变量探测命令' };
  }

  const fileOps =
    /\b(?:cat|head|tail|less|more|cp|mv|rm|mkdir|rmdir|touch|chmod|chown|ln|tee|dd)\b/;
  if (fileOps.test(command)) {
    const absPaths =
      command
        .match(/(?:^|\s)(\/[^\s|>&;]+)/g)
        ?.map((p) => p.trim())
        ?.filter((p) => !p.startsWith('/dev/null')) ?? [];
    for (const absPath of absPaths) {
      if (
        !isPathWithinDirectory(absPath, userCwd) &&
        !isPathWithinAnyDirectory(absPath, userExtraDirs)
      ) {
        return {
          allow: false,
          message: `安全限制：不允许对工作目录外的路径执行文件操作。检测到路径: ${absPath}，工作目录: ${userCwd}`,
        };
      }
    }
  }

  const redirects =
    command.match(/>{1,2}\s*(\/[^\s|>&;]+)/g)?.map((m) => m.replace(/^>{1,2}\s*/, '')) ?? [];
  for (const rPath of redirects) {
    if (
      rPath !== '/dev/null' &&
      !isPathWithinDirectory(rPath, userCwd) &&
      !isPathWithinAnyDirectory(rPath, userExtraDirs)
    ) {
      return {
        allow: false,
        message: `安全限制：不允许将输出重定向到工作目录外。检测到路径: ${rPath}，工作目录: ${userCwd}`,
      };
    }
  }

  // 相对路径穿越检测（纵深防御，OS 沙箱是主防线）
  const traversalPaths =
    command
      .match(/(?:^|\s)(\.\.[\w/.~-]*|~[\w/.-]+)/g)
      ?.map((p) => p.trim())
      ?.filter((p) => p.startsWith('..') || p.startsWith('~')) ?? [];
  for (const relPath of traversalPaths) {
    const expanded = relPath.startsWith('~') ? relPath.replace(/^~/, homedir()) : relPath;
    const resolved = resolvePath(userCwd, expanded);
    if (
      !isPathWithinDirectory(resolved, userCwd) &&
      !isPathWithinAnyDirectory(resolved, userExtraDirs)
    ) {
      return {
        allow: false,
        message: `安全限制：不允许对工作目录外的路径执行文件操作。检测到路径: ${relPath}，工作目录: ${userCwd}`,
      };
    }
  }
  return { allow: true };
}

/** 文件类工具的路径审计。 */
function decideFilePath(input: {
  toolName: string;
  filePath: string | undefined;
  optional: boolean;
  userCwd: string;
  userExtraDirs: string[];
  sharedAgentRoot: string;
}): InteractionResponse {
  if (!input.filePath) {
    if (input.optional) return { allow: true };
    return { allow: false, message: 'Access denied: missing file path' };
  }
  const resolved = resolvePath(input.userCwd, input.filePath);
  if (isPathWithinDirectory(resolved, input.userCwd)) {
    const isWrite = input.toolName === 'Write' || input.toolName === 'Edit';
    if (isWrite) {
      const rel = resolved.slice(input.userCwd.length + 1);
      if (PROTECTED_SETTINGS_RELATIVE_PATHS.has(rel)) {
        return { allow: false, message: 'Access denied: cannot modify agent settings files' };
      }
    }
    return { allow: true };
  }
  if (isPathWithinAnyDirectory(resolved, input.userExtraDirs)) {
    return { allow: true };
  }
  // 与外提前一致：`config.agentCwd` 缺失时不启用 shared agent 目录白名单。
  if (input.sharedAgentRoot) {
    const sharedAgentDir = resolveAgentPath(input.sharedAgentRoot);
    for (const sub of SHARED_AGENT_ALLOWED_SUBDIRS) {
      if (isPathWithinDirectory(resolved, resolvePath(sharedAgentDir, sub))) {
        return { allow: true };
      }
    }
  }
  return { allow: false, message: 'Access denied: path outside your workspace' };
}

/**
 * 授权模式自动裁决。免除的是人工确认，不豁免路径/命令安全审计。
 * 返回 `undefined` 表示「交回人工审批流」。
 */
export function decideAuthorizationModeTool(
  input: AuthorizationModeDecisionInput,
): AuthorizationModeDecision {
  const { toolName, toolId } = input;

  // 定制项目写能力：授权模式不表态，回落人工确认（规范 §6.2-2）。
  if (requiresAppWriteConfirmation(toolName, toolId)) return undefined;

  // 安全工具 / 远端 MCP 工具 / 定制项目只读能力：无路径风险，直接放行
  if (
    toolName &&
    (SAFE_AUTO_APPROVE_TOOLS.has(toolName) ||
      toolName.startsWith('mcp__') ||
      isAppReadOnlyTool(toolName, toolId))
  ) {
    return { allow: true };
  }

  const userCwd = resolveUserCwd(input.agentCwd, {
    id: input.user.id,
    username: input.user.username,
    role: input.user.role,
    tenantId: input.user.tenantId,
  });
  const userExtraDirs = getUserExtraDirs(input.userOverrides, input.user.username);

  // Shell/Bash 工具：命令审计
  if (toolName === 'Bash' || toolName === 'Shell') {
    return decideShellCommand((input.toolInput?.command as string) ?? '', userCwd, userExtraDirs);
  }

  // 文件类工具：路径字段映射
  const pathInfo = toolName ? PATH_FIELD_BY_TOOL[toolName] : undefined;
  if (pathInfo !== undefined && toolName) {
    return decideFilePath({
      toolName,
      filePath: input.toolInput?.[pathInfo.field] as string | undefined,
      optional: pathInfo.optional === true,
      userCwd,
      userExtraDirs,
      sharedAgentRoot: input.agentCwd ? input.sharedDir || input.agentCwd : '',
    });
  }

  // 未知工具：拒绝
  return { allow: false, message: 'Operation not permitted' };
}
