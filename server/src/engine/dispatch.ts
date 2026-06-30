import { appendFile, mkdir } from 'fs/promises';
import { readFileSync, existsSync, statSync } from 'fs';
import { execFileSync } from 'child_process';
// Browser CDP 端口映射缓存（热加载，文件变更时自动刷新）
let _browserPortsCache: Record<string, number> | null = null;
let _browserPortsCacheMtime = 0;
function getBrowserPort(username: string, serverRoot: string): number | undefined {
  const portsFile = resolve(serverRoot, 'data/browser-ports.json');
  try {
    if (!existsSync(portsFile)) return undefined;
    const mtime = statSync(portsFile).mtimeMs;
    if (!_browserPortsCache || mtime !== _browserPortsCacheMtime) {
      const data = JSON.parse(readFileSync(portsFile, 'utf-8'));
      _browserPortsCache = data.ports ?? {};
      _browserPortsCacheMtime = mtime;
    }
    return _browserPortsCache![username];
  } catch { return undefined; }
}

function hasUsableWorkspaceVenv(userCwd: string): boolean {
  const python = resolve(agentPath(userCwd, 'runtime', 'venv'), 'bin', 'python3');
  if (!existsSync(python)) return false;
  try {
    execFileSync(python, ['--version'], { timeout: 5_000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

import { randomUUID } from 'crypto';
import { dirname, isAbsolute, resolve } from 'path';
import { createLogger, type Logger } from '../utils/logger.js';
import { requestContextStorage } from '../utils/requestContext.js';
import { rotateIfNeeded } from '../utils/fileRotation.js';
import { resolveUserCwd, ensureUserWorkspace, refreshUserWorkspace } from '../workspace/resolver.js';
import { agentPath, resolveAgentPath } from '../workspace/namespace.js';
import type { SkillConfigStore } from '../data/skills/store.js';
import { getUserAllowGhCli, getUserExtraDirs, type UserOverrides } from '../security/extraDirs.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { resolveAzerothInjection } from '../integrations/azeroth/tokens.js';
import { assertGitCredentialEnvHasNoPlaintextSecret, buildIsolatedGitCredentialEnv } from '../security/gitCredentialIsolation.js';
import {
  DEFAULT_SANDBOX_ALLOW_WRITE,
  DEFAULT_SANDBOX_DENY_READ,
  DEFAULT_SANDBOX_ALLOW_READ,
  expandSandboxPaths,
  extractSdkCwdDenyPatterns,
  type SandboxExpandContext,
} from './sandbox.js';
import { getAgentTranscriptDir } from '../data/transcripts/projectKey.js';
import type {
  ChannelContext,
  InboundMessage,
  OutboundEvent,
} from '../types/index.js';
import type {
  AgentRunDispatch,
  AgentRunHooks,
  AgentRunOptions,
  PermissionMode,
} from '../agent/types.js';
import type {
  AuditOptions,
  DispatchEngineOptions,
  DispatchMetrics,
  DispatchMetricsReporter,
  ObservabilityOptions,
  RateLimitOptions,
} from './types.js';

const dispatchLogger = createLogger('Dispatch');

interface DispatchTrace {
  runId: string;
  startedAtMs: number;
  channel: InboundMessage['channel'];
  chatId: string;
  senderId?: string;
  userId?: string;
}

interface DispatchRequest {
  message: InboundMessage;
  context: ChannelContext;
  options?: AgentRunOptions;
  hooks?: AgentRunHooks;
  trace: DispatchTrace;
}

export interface CreateRunDispatchOptions {
  processCwd: string;
  globalAgentCwd?: string;
  sharedDir?: string;
  dispatch?: DispatchEngineOptions;
  observability?: ObservabilityOptions;
  metricsReporter?: DispatchMetricsReporter;
  logger?: Logger;
  skillConfigStore?: SkillConfigStore;
  userOverrides?: UserOverrides;
}

interface RateLimitState {
  maxRequests: number;
  windowMs: number;
  buckets: Map<string, { startedAt: number; count: number }>;
  lastCleanupAt: number;
  cleanupIntervalMs: number;
}

function buildRequest(
  message: InboundMessage,
  context: ChannelContext,
  options?: AgentRunOptions,
  hooks?: AgentRunHooks,
): DispatchRequest {
  return {
    message,
    context,
    options,
    hooks,
    trace: {
      runId: `${Date.now()}-${randomUUID()}`,
      startedAtMs: Date.now(),
      channel: message.channel,
      chatId: message.chatId,
      senderId: message.senderId,
      userId: context.user?.id,
    },
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redactString(value: string | undefined, redact: boolean): string | undefined {
  if (value === undefined) return undefined;
  if (!redact) return value;
  return `[redacted:${value.length}]`;
}

function captureFinalTextChunk(existing: string, event: OutboundEvent): string {
  if (event.type !== 'text_delta' || typeof event.content !== 'string') {
    return existing;
  }

  const next = existing + event.content;
  if (next.length <= 4000) {
    return next;
  }

  return `${next.slice(0, 4000)}...[truncated:${next.length - 4000}]`;
}

function resolveAuditPath(processCwd: string, rawPath?: string): string {
  if (!rawPath) {
    return resolve(processCwd, 'data', 'logs', 'dispatch-audit.jsonl');
  }
  if (isAbsolute(rawPath)) {
    return rawPath;
  }
  return resolve(processCwd, rawPath);
}

function createRateLimitState(options: RateLimitOptions = {}): RateLimitState {
  const maxRequests = options.maxRequests ?? 30;
  const windowMs = options.windowMs ?? 60_000;

  return {
    maxRequests,
    windowMs,
    buckets: new Map<string, { startedAt: number; count: number }>(),
    lastCleanupAt: 0,
    cleanupIntervalMs: Math.max(windowMs, 30_000),
  };
}

function takeRateLimit(
  request: DispatchRequest,
  state: RateLimitState,
  now: number,
): number | null {
  if (now - state.lastCleanupAt >= state.cleanupIntervalMs) {
    for (const [bucketKey, bucket] of state.buckets.entries()) {
      if (now - bucket.startedAt >= state.windowMs) {
        state.buckets.delete(bucketKey);
      }
    }
    state.lastCleanupAt = now;
  }

  const userRL = request.context.user?.permissions?.rateLimit;
  const effectiveMax = userRL?.maxRequests ?? state.maxRequests;
  const effectiveWindow = userRL?.windowMs ?? state.windowMs;

  const key = `${request.trace.channel}:${request.trace.userId || request.trace.senderId || request.trace.chatId || 'anonymous'}`;
  const bucket = state.buckets.get(key);

  if (!bucket || now - bucket.startedAt >= effectiveWindow) {
    state.buckets.set(key, { startedAt: now, count: 1 });
    return null;
  }

  if (bucket.count >= effectiveMax) {
    return Math.ceil((effectiveWindow - (now - bucket.startedAt)) / 1000);
  }

  bucket.count += 1;
  state.buckets.set(key, bucket);
  return null;
}

export function createMiddlewareRunDispatch(
  baseRun: AgentRunDispatch,
  options: CreateRunDispatchOptions,
): AgentRunDispatch {
  const {
    processCwd,
    dispatch,
    observability,
    metricsReporter,
    logger = dispatchLogger,
  } = options;

  const observabilityEnabled = observability?.enabled !== false;
  const loggingRaw = observability?.logging;
  const loggingEnabled = observabilityEnabled && loggingRaw !== false;
  const metricsEnabled = observabilityEnabled && observability?.metrics !== false;
  const auditEnabled = observabilityEnabled && observability?.audit?.enabled === true;
  const auditOptions = observability?.audit;
  const auditPath = resolveAuditPath(processCwd, observability?.audit?.path);

  const rateLimitState = dispatch?.rateLimit?.enabled
    ? createRateLimitState(dispatch.rateLimit)
    : null;

  return async function* runDispatch(
    message: InboundMessage,
    context: ChannelContext,
    runOptions: AgentRunOptions = {},
    hooks?: AgentRunHooks,
  ): AsyncGenerator<OutboundEvent> {
    const request = buildRequest(message, context, runOptions, hooks);
    const trace = request.trace;

    // 注入请求上下文到 AsyncLocalStorage，后续所有日志自动附加 runId / tenantId。
    // sessionId 此层尚未确定（在内层 rawRuntime 才落定），由内层再 enterWith 合并。
    requestContextStorage.enterWith({
      runId: trace.runId,
      channel: trace.channel,
      chatId: trace.chatId,
      userId: context.user?.id,
      username: context.user?.username,
      userRole: context.user?.role as 'admin' | 'user' | undefined,
      tenantId: context.user?.tenantId,
    });

    if (loggingEnabled) {
      logger.info(
        `[start] runId=${trace.runId} channel=${trace.channel} chatId=${trace.chatId}` +
          `${trace.senderId ? ` senderId=${trace.senderId}` : ''}`,
      );
    }

    let eventCount = 0;
    let errorCount = 0;
    let firstEventAtMs: number | null = null;
    const toolNames = new Set<string>();
    let finalText = '';
    let thrownError: string | undefined;

    const trackEvent = (event: OutboundEvent): void => {
      eventCount += 1;
      if (firstEventAtMs === null) {
        firstEventAtMs = Date.now();
      }
      if (event.type === 'error') {
        errorCount += 1;
        if (loggingEnabled) {
          logger.error(`[error] runId=${trace.runId} ${event.error}`);
        }
      }
      if (event.type === 'tool_start' && event.toolName) {
        toolNames.add(event.toolName);
      }
      finalText = captureFinalTextChunk(finalText, event);
    };

    try {
      const retryAfterSeconds = rateLimitState
        ? takeRateLimit(request, rateLimitState, Date.now())
        : null;

      if (retryAfterSeconds !== null) {
        const event: OutboundEvent = {
          type: 'error',
          error: `请求过于频繁，请在 ${retryAfterSeconds}s 后重试`,
        };
        trackEvent(event);
        yield event;
      } else {
        let effectiveOptions = runOptions;
        const userMaxTurns = context.user?.permissions?.maxTurns;
        if (userMaxTurns !== undefined) {
          const currentMax = runOptions.maxTurns ?? Infinity;
          effectiveOptions = {
            ...runOptions,
            maxTurns: Math.min(userMaxTurns, currentMax),
          };
        }

        // Per-user workspace 隔离：将 cwd 指向用户专属目录
        // 当 context.targetCwd 存在时（admin 代操作其他用户会话），使用目标 cwd
        if (options.globalAgentCwd && context.user) {
          if (!options.sharedDir) {
            throw new Error('sharedDir is required when globalAgentCwd is set');
          }
          const userCwd = context.targetCwd || resolveUserCwd(options.globalAgentCwd, {
            id: context.user.id,
            username: context.user.username,
            role: context.user.role as 'admin' | 'user',
            tenantId: context.user.tenantId,
          });
          await ensureUserWorkspace(userCwd, options.globalAgentCwd, options.sharedDir!, {
            id: context.user.id,
            username: context.user.username,
            role: context.user.role as 'admin' | 'user',
            tenantId: context.user.tenantId,
          }, undefined, options.skillConfigStore);

          // 迁移已有用户：确保 symlink 与模板同步 + 版本驱动的 skill 同步
          // 注：refreshUserWorkspace 第 4 参数已废弃（writeMemory 内部 _isAdmin 未使用），
          // 但为了语义清晰仍传 isPlatformAdmin。
          const isPlatformAdmin = context.user.role === 'admin'
            && context.user.tenantId === DEFAULT_TENANT_ID;
          refreshUserWorkspace(
            userCwd,
            options.globalAgentCwd,
            options.sharedDir!,
            isPlatformAdmin,
            {
              id: context.user.id,
              username: context.user.username,
              role: context.user.role as 'admin' | 'user',
              tenantId: context.user.tenantId,
            },
            { realName: context.user.realName },
            options.skillConfigStore,
          );

          effectiveOptions = { ...effectiveOptions, cwd: userCwd };

          // 修 P1 BUG #3（2026-06-21 第二轮端到端测试发现）：
          // 原代码 `const isAdmin = context.user.role === 'admin'` 把组织 admin 跟
          // 平台 admin 一视同仁全部 skip sandbox-exec，导致任意客户组织 admin 可
          // 用 Shell `cat /Users/admin/workspace-openai-runtime/kaiyan/admin/MEMORY.md`
          // 真实读到开沿数据（实测 EXIT=0）。PR 4 `{{OTHER_TENANT_WORKSPACES}}` deny
          // 只对非 admin 生效，但非 admin 又没 Shell（"only enabled for admin"）→
          // sandbox 跨组织保护实际覆盖范围为零。
          //
          // 修法：sandbox / sharedDirs / extraDirs / allowGhCli 四处全部从 role==='admin'
          // 收紧到 isPlatformAdmin（role==='admin' && tenantId===DEFAULT_TENANT_ID）。
          // 组织 admin 跟普通 user 一样走 sandbox + userOverrides，且不能动 skills-pool
          // （skills-pool 是平台资源）。组织 admin 的业务能力（同组织 CRUD 等）由路由层
          // requireAdmin / requirePlatformAdmin 中间件独立管控，不受此处变更影响。
          // 兼容：isPlatformAdmin 已在上方为 refreshUserWorkspace 计算，此处复用。

          // additionalDirectories 授予共享目录的访问权限
          // 平台 admin：skills-pool（直接操作 pool）+ scripts
          // 其他（含组织 admin / 普通 user）：仅 scripts（skills 已通过 syncSkills 复制到用户目录）
          const sharedDirs = isPlatformAdmin
            ? [resolveAgentPath(options.sharedDir!, 'skills-pool'), resolveAgentPath(options.sharedDir!, 'scripts')]
            : [resolveAgentPath(options.sharedDir!, 'scripts')];
          const extraDirs = isPlatformAdmin
            ? []
            : getUserExtraDirs(options.userOverrides, context.user.username);
          const allowGhCli = isPlatformAdmin
            ? false
            : getUserAllowGhCli(options.userOverrides, context.user.username);
          effectiveOptions = {
            ...effectiveOptions,
            additionalDirectories: [
              ...(effectiveOptions.additionalDirectories ?? []),
              ...sharedDirs,
              ...extraDirs,
            ],
          };

          // ── 非平台 admin（含组织 admin + 普通 user）：权限限制 + 沙箱隔离 ──
          // 两层防御：
          //   A. SDK 权限：default 白名单 + path-scoped allow/deny
          //   B. OS 沙箱：sandbox-exec 内核级文件系统隔离
          //     - 含 PR 4 `{{OTHER_TENANT_WORKSPACES}}` 跨组织 deny
          //     - 含 PR 6 `{{OTHER_TENANT_SETTINGS}}` 跨组织 settings deny
          if (!isPlatformAdmin) {
            // 构建共享目录的 Read allow 规则（绝对路径用 // 前缀）
            const sharedReadRules = sharedDirs.map(dir => `Read(//${dir}/**)`);
            const extraDirRwRules = extraDirs.flatMap(dir => [
              `Read(//${dir}/**)`,
              `Edit(//${dir}/**)`,
              `Write(//${dir}/**)`,
            ]);

            // 沙箱规则：config.dispatch.sandbox 为真相源，字段未写则 fallback 到 DEFAULT_*
            // PR 4 多组织：tenantCwd = userCwd 的父目录（globalAgentCwd/<tenant>/）。
            // sandbox 的 OTHER_USER_WORKSPACES 在 tenant 内扫，OTHER_TENANT_WORKSPACES
            // 扫 globalAgentCwd 下其他 tenant 根。
            // PR #31 transcript carve-out：user 完整身份（id + tenantId）齐备时
            // 计算自己的 transcript 目录，给 sandbox carve-out 开洞；缺一个就不开洞，
            // sandbox.ts 端会安全降级到「整个 ~/.agent-saas/legacy-transcripts 都不可读」。
            const ownerTenantId = context.user.tenantId;
            const ownerUserId = context.user.id;
            const agentTranscriptDir = ownerTenantId && ownerUserId
              ? getAgentTranscriptDir({ tenantId: ownerTenantId, userId: ownerUserId })
              : undefined;
            const sandboxCtx: SandboxExpandContext = {
              username: context.user.username,
              userCwd,
              tenantCwd: resolve(userCwd, '..'),
              workspaceRoot: options.globalAgentCwd!,
              sharedDir: options.sharedDir!,
              ...(agentTranscriptDir ? { agentTranscriptDir } : {}),
            };
            const cfgSandbox = options.dispatch?.sandbox;
            const allowWriteTpl = cfgSandbox?.allowWrite ?? DEFAULT_SANDBOX_ALLOW_WRITE;
            const denyReadTpl = cfgSandbox?.denyRead ?? DEFAULT_SANDBOX_DENY_READ;
            const allowReadTpl = cfgSandbox?.allowRead ?? DEFAULT_SANDBOX_ALLOW_READ;
            // 从 denyRead 模板里提取 {{USER_CWD}}/xxx 条目生成 SDK 层 deny（改善 UX，
            // 让 Claude 提前知道别碰，而不是等 OS 沙箱 EPERM）
            const sdkCwdDeny = extractSdkCwdDenyPatterns(denyReadTpl);

            // --- A. SDK 权限（所有非 admin 用户） ---
            // 使用 default 模式而非 dontAsk：
            //   - dontAsk 会禁用 AskUserQuestion（SDK 硬限制）
            //   - default 模式下，非白名单工具走 permission_request → onInteraction
            //   - onInteraction 已完整处理所有非 admin 权限决策（safeTools/Bash审计/路径校验/兜底拒绝）
            effectiveOptions = {
              ...effectiveOptions,
              permissionMode: 'default' as PermissionMode,
              allowDangerouslySkipPermissions: false,
              allowedTools: [
                // 搜索工具
                'Glob', 'Grep',
                // Agent 编排
                'Agent',
                // 动态工作流（dynamic workflows，多 agent 编排）
                // ⚠️ R1 开放前置风险：子 agent 可经 sandboxed Bash（autoAllowBashIfSandboxed 旁路 channel.ts 审计）
                //    dump AZEROTH_TOKEN/GH_TOKEN 外传。详见 assets/20260530/workflow专题待解决问题.md 病灶二
                'Workflow',
                // 任务管理
                'TodoWrite',
                'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskStop', 'TaskOutput',
                // Skill 调用
                'Skill',
                // 用户交互
                'AskUserQuestion',
                // 网络搜索
                'WebSearch', 'WebFetch',
                // 延迟工具加载
                'ToolSearch',
                // 其他内置工具
                'NotebookEdit', 'EnterPlanMode', 'ExitPlanMode',
                'EnterWorktree', 'ExitWorktree',
                // 定时任务（内置）
                'CronCreate', 'CronDelete', 'CronList',
                // 远程触发
                'RemoteTrigger',
                // MCP 工具（server 级通配，新增工具无需手动补白名单）
                'mcp__cron__*',
              ],
              // inline settings 作为 "flag settings" 层，拥有最高优先级
              settings: {
                permissions: {
                  allow: [
                    // 文件工具：仅允许 cwd 内路径（./ 相对于 cwd）
                    'Read(./**)',
                    'Edit(./**)',
                    'Write(./**)',
                    // 共享资源的只读访问
                    ...sharedReadRules,
                    // 用户额外授权目录的读写访问
                    ...extraDirRwRules,
                  ],
                  // 受限目录：deny 优先于 allow，SDK 级阻止 Read/Edit/Write
                  ...(sdkCwdDeny.length > 0 ? { deny: sdkCwdDeny } : {}),
                },
              },
            };

            // --- B. OS 级沙箱（sandbox-exec） ---
            // 网络代理统一指向 Clash Verge，SDK 跳过自建代理
            const sandboxNetwork = {
              httpProxyPort: 7897,            // Clash Verge mixed-port (HTTP)
              socksProxyPort: 7898,           // Clash Verge SOCKS5 代理
              allowLocalBinding: true,
              allowAllUnixSockets: true,      // playwright CDP 需要
            };

            effectiveOptions = {
                ...effectiveOptions,
                sandbox: {
                  enabled: true,
                  autoAllowBashIfSandboxed: true,
                  allowUnsandboxedCommands: false,
                  enableWeakerNetworkIsolation: true,
                  network: sandboxNetwork,
                  // 规则清单由 config.dispatch.sandbox 提供（未配置字段走 DEFAULT_*，见 sandbox.ts）
                  // extraDirs 是 per-user userOverrides 白名单，与全局 sandbox 同级叠加
                  filesystem: {
                    allowWrite: [
                      ...expandSandboxPaths(allowWriteTpl, sandboxCtx),
                      ...extraDirs,
                    ],
                    denyRead: expandSandboxPaths(denyReadTpl, sandboxCtx),
                    allowRead: [
                      ...expandSandboxPaths(allowReadTpl, sandboxCtx),
                      ...extraDirs,
                    ],
                  },
                },
              };

            // npm/pip 缓存重定向 + pnpm 绕过 corepack
            // corepack shim (~/.nvm/.../bin/pnpm) 会向上遍历查找 packageManager 字段，
            // 找到项目根 package.json 但被 sandbox deny → EPERM。
            // ~/Library/pnpm/pnpm 是独立安装的 pnpm，不走 corepack，PATH 前置即可绕过。
            const pnpmStandalone = resolve('/Users/admin/Library/pnpm');
            const currentPath = effectiveOptions.env?.PATH || process.env.PATH || '';
            const ghConfigDir = resolve('/tmp', `gh-${context.user.username}`);
            effectiveOptions = {
              ...effectiveOptions,
              env: {
                ...effectiveOptions.env,
                PATH: `${pnpmStandalone}:${currentPath}`,
                npm_config_cache: agentPath(userCwd, 'runtime', 'cache', 'npm'),
                npm_config_userconfig: resolve(userCwd, '.npmrc'),
                PIP_CACHE_DIR: agentPath(userCwd, 'runtime', 'cache', 'pip'),
                PIP_USER: '0',
                // Git 凭证：不再把 GH_TOKEN/GITHUB_TOKEN 注入 sandbox env，也不把 token
                // 写入 .git/config。git credential.helper 按需调用 host-side gh token
                // 命令取 credential；helper 字符串只包含命令路径，不包含明文 secret。
                ...buildIsolatedGitCredentialEnv({
                  tokenCommand: '/opt/homebrew/bin/gh auth token',
                  allowGhCli,
                  ghConfigDir,
                }),
              },
            };
          }

          // 注入 dispatch.env（API Key 等项目级环境变量）：所有用户共享
          // 早期版本仅给 admin 注入，导致非 admin workspace 的 image-gen / audio-transcribe
          // 等依赖 API key 的 skill 静默失败。env 注入与沙箱/SDK 权限/工具白名单/路径权限/
          // 跨用户隔离等其他防御层完全独立，仅把 config.json `dispatch.env` 中的字符串注入
          // 到子进程 process.env，不改变任何文件读写或网络规则。
          const dispatchEnv = options.dispatch?.env;
          if (dispatchEnv && Object.keys(dispatchEnv).length > 0) {
            effectiveOptions = {
              ...effectiveOptions,
              env: { ...effectiveOptions.env, ...dispatchEnv },
            };
          }

          // 浏览器 CDP 端口：所有用户统一注入，让 playwright-cli 直连 Chrome debugging port
          const browserPort = getBrowserPort(context.user.username, options.processCwd);
          if (browserPort) {
            effectiveOptions = {
              ...effectiveOptions,
              env: {
                ...effectiveOptions.env,
                PLAYWRIGHT_MCP_CDP_ENDPOINT: `http://localhost:${browserPort}`,
                PLAYWRIGHT_MCP_ISOLATED: 'false',
              },
            };
          }

          // Python venv：仅在 workspace 内 venv 真正可执行时注入，避免把
          // macOS/Homebrew 旧 symlink 带进 Linux/ACS 路径。
          const venvPath = agentPath(userCwd, 'runtime', 'venv');
          const venvBin = resolve(venvPath, 'bin');
          if (hasUsableWorkspaceVenv(userCwd)) {
            const prevPath = effectiveOptions.env?.PATH || process.env.PATH || '';
            effectiveOptions = {
              ...effectiveOptions,
              env: {
                ...effectiveOptions.env,
                VIRTUAL_ENV: venvPath,
                PATH: `${venvBin}:${prevPath}`,
              },
            };
          }

          // ky-azeroth PAT 注入：所有用户统一从 server/config/azeroth-tokens.json 查表
          // 配置文件位于 ~/code/agent/server/config/，已被 sandbox `~/code` deny 覆盖，
          // LLM 不可见。查不到则不注入（CLI 会因缺凭证报错，符合"未授权"语义）。
          //
          // 同时把 ky-azeroth CLI 的 cache 目录 (<userCwd>/.ky-agent/runtime/cache/azeroth-cli) 前置到 PATH，
          // 让 LLM 调用 `azeroth ...` 命中 skill ensure-cli.sh 拉下来的 bundle，无需关心路径。
          // ensure 由 skill 自己负责（按需触发，不影响未使用 ky-data-query 的会话）。
          // PR 6 修 P0-6：按 (tenantId, username) 二级查 PAT，防客户组织拿到开沿 admin PAT
          const azerothInjection = resolveAzerothInjection(
            context.user.tenantId || DEFAULT_TENANT_ID,
            context.user.username,
          );
          if (azerothInjection) {
            const azerothCliDir = agentPath(userCwd, 'runtime', 'cache', 'azeroth-cli');
            const prevPath = effectiveOptions.env?.PATH || process.env.PATH || '';
            effectiveOptions = {
              ...effectiveOptions,
              env: {
                ...effectiveOptions.env,
                AZEROTH_TOKEN: azerothInjection.token,
                ...(azerothInjection.apiUrl
                  ? { AZEROTH_API_URL: azerothInjection.apiUrl }
                  : {}),
                PATH: `${azerothCliDir}:${prevPath}`,
              },
            };
          }

          assertGitCredentialEnvHasNoPlaintextSecret(effectiveOptions.env ?? {});
        }

        for await (const event of baseRun(message, context, effectiveOptions, hooks)) {
          trackEvent(event);
          yield event;
        }
      }

      if (loggingEnabled) {
        logger.info(
          `[done] runId=${trace.runId} events=${eventCount} errors=${errorCount}`,
        );
      }
    } catch (error) {
      thrownError = formatError(error);
      if (loggingEnabled) {
        logger.error(
          `[failed] runId=${trace.runId} events=${eventCount} errors=${errorCount} reason=${thrownError}`,
        );
      }
      throw error;
    } finally {
      const endedAtMs = Date.now();

      if (metricsEnabled) {
        const metrics: DispatchMetrics = {
          runId: trace.runId,
          channel: trace.channel,
          chatId: trace.chatId,
          senderId: trace.senderId,
          startedAtMs: trace.startedAtMs,
          endedAtMs,
          durationMs: endedAtMs - trace.startedAtMs,
          firstEventLatencyMs: firstEventAtMs === null ? null : firstEventAtMs - trace.startedAtMs,
          eventCount,
          errorCount,
        };

        metricsReporter?.(metrics);
        logger.debug(
          `[metrics] runId=${metrics.runId} durationMs=${metrics.durationMs} firstEventLatencyMs=${metrics.firstEventLatencyMs ?? 'n/a'} events=${metrics.eventCount} errors=${metrics.errorCount}`,
        );
      }

      if (auditEnabled) {
        const redact = (auditOptions as AuditOptions | undefined)?.redact !== false;
        const auditRecord = {
          at: new Date(endedAtMs).toISOString(),
          runId: trace.runId,
          channel: trace.channel,
          chatId: trace.chatId,
          senderId: trace.senderId,
          userId: trace.userId,
          request: {
            content: redactString(request.message.content, redact),
            hasAttachments: (request.message.attachments?.length ?? 0) > 0,
            resumeSessionId: redactString(request.context.resumeSessionId, redact),
            options: {
              model: request.options?.model,
              maxTurns: request.options?.maxTurns,
            },
          },
          result: {
            durationMs: endedAtMs - trace.startedAtMs,
            eventCount,
            errorCount,
            toolNames: Array.from(toolNames),
            finalText: redactString(finalText || undefined, redact),
            thrownError,
          },
        };

        try {
          await mkdir(dirname(auditPath), { recursive: true });
          await appendFile(auditPath, `${JSON.stringify(auditRecord)}\n`, 'utf-8');
          await rotateIfNeeded(auditPath, {
            maxSizeBytes: auditOptions?.maxSizeBytes ?? 10 * 1024 * 1024,
            maxFiles: auditOptions?.maxFiles ?? 5,
          });
        } catch (error) {
          logger.error(
            `[audit] write failed runId=${trace.runId} path=${auditPath} reason=${formatError(error)}`,
          );
        }
      }
    }
  };
}
