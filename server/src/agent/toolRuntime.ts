import { exec as execCb, spawn } from 'child_process';
import { existsSync } from 'fs';
import { isAbsolute, relative, resolve } from 'path';
import { promisify } from 'util';
import { z } from 'zod';
import type { AgentRunHooks } from './types.js'; export type SandboxWorkloadWireDescriptor = import('./types.js').SandboxWorkloadWireDescriptor;
import {
  buildToolPresentation,
  extractToolResultMetadata,
  ToolExecutionError,
  type ToolPresentation,
} from './toolPresentationBuilder.js';
import type { MemoryIndexService } from '../memory/index/service.js';
import { atomicWriteTrustedFile } from '../security/trustedFile.js';
import type {
  ToolInvocationRequest,
  ToolInvocationResponse,
} from '../runtime/handProtocol.js';
import type { ArtifactService } from '../runtime/artifactService.js';
import type {
  ExecutionTransport,
  ExecutionTransportRegistry,
} from '../runtime/executionTransport.js';
import { selectRuntimeHandRoute, type HandRecord, type HandStore } from '../runtime/handStore.js';
import type { RuntimeIsolationRequirement } from '../runtime/runtimeIsolationEvidence.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import {
  DefaultExecutionTransportRegistry,
  InProcessTransport,
} from '../runtime/inProcessTransport.js';
import { ClientDaemonTransport } from '../runtime/clientDaemonTransport.js';
import { HttpTransport } from '../runtime/httpTransport.js';
import type { ChannelContext } from '../types/index.js';
import type { ToolControlsConfig } from '../app/config.js';
import type { BackgroundTaskRuntime } from '../runtime/background/backgroundTaskRuntime.js';
import { ContainerExecutionProvider } from './containerExecutionProvider.js';
import { resolveRemoteHandAuthToken, resolveRemoteHandInvokeTimeoutMs } from './handMetadata.js';
import { MemorySearchToolProvider } from './memorySearchToolProvider.js';
import { runLocalShellStreaming } from './localShellExecution.js';
import { loadToolDescription } from './tools/descriptionLoader.js';
import {
  memoryPathFromSuccessfulTool,
  parseToolInput,
  relativeWorkspacePath,
  resolveWorkspacePath,
  shellCommandMentionsMemoryPath,
} from './toolRuntimePaths.js';
import {
  DEFAULT_BACKGROUND_SHELL_TIMEOUT_MS,
  MAX_FILE_BYTES,
  MAX_READ_LINES,
  MAX_READ_OUTPUT_BYTES,
} from './toolOutput.js';
import {
  WORKSPACE_ARTIFACT_PAYLOAD_METADATA_KEY,
  artifactCreateToolDescriptor,
  artifactToolDescriptor,
  createWorkspaceArtifactPayload,
  editToolDescriptor,
  runWorkspaceEdit,
  workspaceArtifactPreparedContent,
  type WorkspaceArtifactPayload,
} from './workspaceHandTools.js';
import { materializeReadToolImage } from './readImageTool.js';
import { createdArtifactToolResult, prepareArtifactInvocation } from './artifactToolRuntime.js';
import { resolveShellConcurrency, shellToolSchema, type ShellToolInput } from './shellToolSchema.js';
import { parseProvablyReadOnlyRgCommand, resolveShellCallPolicy } from './shellReadOnlyPolicy.js';
import { withWorkspaceFileMutationQueue } from './workspaceFileMutationQueue.js';
import { readWorkspaceFile } from './workspaceRead.js';
const exec = promisify(execCb);
const MEMORY_SHELL_MAYBE_CHANGED_INTERVAL_MS = 120_000;
const MEMORY_SHELL_MAYBE_CHANGED_DEBOUNCE_MS = 30_000;

export { MAX_FILE_BYTES, MAX_READ_LINES, MAX_READ_OUTPUT_BYTES };

export type ToolRisk = 'safe' | 'workspace_write' | 'dangerous';
export type ToolApprovalMode = 'never' | 'web';

/**
 * Hand 部署位置维度。
 *
 * - server-local：brain 进程内直接调用 ServerLocalExecutionProvider
 * - server-container：brain 进程内 spawn docker 容器执行
 * - server-remote：跨进程 HTTP 调用独立的 hand-server（PR 1.4+1.5 引入）
 * - client：客户机器 daemon 反向连接（阶段 3 落地，目前仅类型预留）
 */
export type ExecutionTargetKind = 'server-local' | 'server-container' | 'server-remote' | 'client'; // workload type is re-exported above

/**
 * Workspace 引用。
 *
 * PR 1.5 引入 `id`（workspaceId）字段，实施"workspace 三方角色"心智的过渡：
 * - brain 侧仍持 `root` 作 in-process backend 的本地路径（server-local /
 *   server-container 透传给 docker mount）。
 * - server-remote backend 序列化 envelope 时**只传 `id` 不传 `root`**——远端
 *   hand-server 自己有 `workspaceResolver` 把 id 映射到 hand-server 本地路径。
 *
 * 未来阶段 3 客户 daemon 上线时，`root` 字段会彻底消失，只留 `id`。
 */
export interface WorkspaceRef {
  /**
   * Workspace 逻辑标识。brain 端用 sessionId 或 `${userId}:${sessionId}` 之类生成；
   * server-remote 调用时只传 id 不传 root。
   * PR 1.4+1.5 引入；阶段 3 之前不强制（不传时 server-local / server-container
   * 走 `root` 路径）。
   */
  id?: string;
  /**
   * In-process backend 用的本地路径。server-remote backend 不通过本字段定位
   * workspace——远端 hand 自己的 resolver 用 `id` 解析。
   */
  root: string;
  userId?: string;
  username?: string;
  /**
   * 多组织身份槽（P4 防御纵深，2026-06-22 落地）。LocalWorkspaceProvider.resolve
   * 从 ChannelContext.user.tenantId / sessionOwner.tenantId 自动填充。
   * ServerLocal / Container 的 envBuilder 用它装配子进程 env 隔离。
   * server-remote 不序列化此字段到 wire（远端 hand-server 自身只属一个组织）。
   */
  tenantId?: string;
  sessionId?: string;
  /**
   * 顶层会话 ID（per-session Sandbox，2026-08-10 A 方案）。顶层会话＝自身 sessionId；
   * 子 Agent / 孙 Agent / 后台任务**原样继承父值**，因此「父 + 全部后代」恒定落在
   * 同一 sandboxScopeId → 同一 pod（决策 7），无需查库回溯父子链。
   * 缺省时 sandbox 归属退回 workspace 级共享（旧行为，安全 fallback）。
   */
  topLevelSessionId?: string;
  sandboxScopeId?: string; mountSubPath?: string; workload?: SandboxWorkloadWireDescriptor;
  /** Standalone connector ACS resource target; normal Agent calls inherit their profile. */ sandboxResources?: { cpu: string; memoryMb: number };
  executionTarget: ExecutionTargetKind;
  /**
   * Host-path guard for server-local execution. Raw runtime uses this as a
   * portable sandbox fallback so accidental server-local routing cannot read
   * known cross-tenant / secret paths even before an OS sandbox is attached.
   */
  sandboxPolicy?: {
    denyRead: string[];
  };
}
export interface ToolCallContext {
  channelContext: ChannelContext;
  workspace: WorkspaceRef;
  /** 当前任务从能力中心连接器注入的运行态环境变量。 */
  env?: Record<string, string>;
  sessionId?: string;
  runId?: string;
  /** Runtime 内部记忆维护模式；不改变模型可见 descriptor。 */ memoryMaintenanceMode?: 'consolidation';
  runtimeIsolationRequirement?: RuntimeIsolationRequirement;
  toolCallId?: string;
  invocationId?: string; correlation?: import('@agent/shared').CorrelationContext;
  onStreamChunk?: (chunk: import('../runtime/handProtocol.js').ToolInvocationStreamChunk) => Promise<void> | void;
  hooks?: AgentRunHooks;
  signal?: AbortSignal;
  executionAudit?: ExecutionAuditRecorder;
}

/**
 * 平台内建工具的分组。仅用于 admin UI 归类展示，不影响运行时行为。
 * 未列出的 category（如 MCP 工具）默认走 admin 面板的兜底分组。
 */
export type ToolCategory =
  | 'workspace'
  | 'memory'
  | 'skill'
  | 'meta'
  | 'session'
  | 'web'
  | 'media'
  | 'cron'
  | 'core';

export interface ToolDescriptor<TInput = unknown> {
  id: string;
  name: string;
  displayName: string;
  description: string;
  schema: z.ZodObject;
  /**
   * 可选：在 schema 校验前修复模型常见的可逆参数形态错误。审批、风险分档、
   * 展示与执行均使用 prepare + schema 后的同一份参数。
   * 只允许做别名归一化、JSON 字符串解析、单对象转数组等无歧义转换；
   * 不得补猜业务值或绕过 schema 校验。
   */
  prepareInput?: (input: unknown) => unknown;
  /**
   * 可选：直接提供 JSON Schema 作为模型可见的 parameters。优先级高于
   * schema.toJSONSchema()。MCP 工具用它把 server 上报的 inputSchema 完整透传
   * 给模型——否则只能用 z.object({}).passthrough() 落到空 properties，模型
   * 看不到参数说明，调用时无法准确传参。
   */
  parametersJsonSchema?: Record<string, unknown>;
  risk: ToolRisk;
  approvalMode: ToolApprovalMode;
  /**
   * 同批调用默认串行。无条件并发只允许 safe + never 工具声明 `parallel`；
   * 有风险但可按入参隔离的工具改用 resolveConcurrency，runtime 固化授权后放行。
   */
  concurrency?: 'parallel';
  resolveConcurrency?: (input: unknown) => 'parallel' | undefined;
  auditCategory: string;
  /**
   * 内建工具的 admin UI 分组。缺省视为 MCP / 动态工具，admin 面板归入兜底分组。
   */
  category?: ToolCategory;
  /**
   * admin UI 展示用的中文短标签。缺省时前端 fallback 到 displayName。
   */
  label?: string;
  /**
   * MCP 渐进披露元数据。只有 McpClientToolProvider 产生的动态工具设置；
   * runtime 用它把同一 server 的真实工具定义收进稳定 namespace 能力地图。
   */
  mcp?: {
    serverName: string;
    serverDisplayName: string;
    serverDescription?: string;
  };
  /**
   * 可选：per-call 风险分档（2026-08-03 工具面收敛批次）。
   *
   * 背景：合并型工具（一个 descriptor 内用 action 参数同时承载读/写路径，如
   * CronManage 的 list vs create、CompanyInfo 的 read vs update）无法用单一静态
   * risk 表达真实审批需求。本钩子让 ToolPolicy 在拿到入参后对单次调用降/升档。
   *
   * 约定：静态 `risk` 必须取该工具所有 action 中的**最高档**（fail-safe：任何
   * 忽略本钩子的消费点得到的是「读也要审批」而不是「写不用审批」）；钩子只
   * 允许对具体入参返回更精确的档位。返回 undefined = 沿用静态 risk。
   */
  resolveCallPolicy?: (input: unknown) => { risk: ToolRisk; neverAutoApprove?: boolean } | undefined;
  /**
   * 描述中必须保留的关键片段（运行时行为契约的锚点）。
   *
   * 背景：平台管理员可在后台用 descriptionOverride 覆盖描述，`mode: 'replace'`
   * 会整体替换内置文本。CI 里的 drift guard 只守内置默认值，守不住后台覆盖——
   * 一旦有人把 Read 的字节上限写错、或删掉 Shell 的 rg 优先级，模型会按错误契约
   * 规划动作，而没有任何闸门会红。
   *
   * 因此把"描述必须提到什么"声明为数据，同时服务两处：
   *   1. 保存 override 时校验生效描述仍含全部片段，缺失直接拒绝
   *   2. CI 遍历同一份声明校验内置默认值，不再逐工具硬编码断言
   *
   * 只声明**与运行时行为绑定**的片段（数值上限、必须遵守的命令优先级、schema
   * 默认值），不要把文风偏好写进来——那属于可以自由覆盖的部分。
   */
  descriptionInvariants?: readonly string[];
}
export interface ToolResult {
  content: string; modelImages?: Array<Extract<import('../runtime/types.js').ModelUserContentPart, { type: 'image_attachment' }>>;
  /**
   * 「给人看」摘要。与 content（给模型看的原始输出）并存，**不进入 messages**。
   *
   * provider 可在**截断前**用原始数据自产（信息量更高）；未自产时由
   * `PlatformToolRuntime.invoke` 按 toolPresentationBuilder 的规则兜底补齐。
   */
  presentation?: ToolPresentation;
  /**
   * 截断前的结构化执行事实（exitCode / 字节数 / 耗时 …），白名单见
   * `extractToolResultMetadata`。与 presentation 的分工：这里是给程序判定的原值，
   * presentation 是给人看的中文摘要。**不进入 messages**。
   */
  metadata?: Record<string, unknown>;
}

export interface ExecutionInvocationAudit {
  provider: ExecutionTargetKind;
  operation: string;
  image?: string;
  containerName?: string;
  timeoutMs?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
  exitCode?: number | null;
  signal?: string | null;
  status: 'success' | 'error';
  timedOut?: boolean;
  outputExceeded?: boolean;
  aborted?: boolean;
  error?: string;
}

export interface ExecutionAuditRecorder {
  readonly records: ExecutionInvocationAudit[];
  record(audit: ExecutionInvocationAudit): void;
}

export function createExecutionAuditRecorder(): ExecutionAuditRecorder {
  const records: ExecutionInvocationAudit[] = [];
  return {
    records,
    record(audit) {
      records.push(audit);
    },
  };
}

export interface ToolAuthorization {
  approved: boolean;
  approvalId?: string;
  source: 'policy_auto' | 'human_approval' | 'legacy_adapter';
}

export interface AuthorizedToolCall<TInput = unknown> {
  toolId: string;
  input: TInput;
  authorization: ToolAuthorization;
}

export interface WorkspaceProvider {
  resolve(context: ChannelContext, args: {
    cwd: string;
    sessionId?: string;
    /** 顶层会话组键（per-session Sandbox）。缺省时实现方回落 sessionId。 */
    topLevelSessionId?: string;
    workspaceId?: string;
    sandboxScopeId?: string; mountSubPath?: string; sandboxResources?: WorkspaceRef['sandboxResources']; workload?: WorkspaceRef['workload'];
    executionTarget?: ExecutionTargetKind;
    sandboxPolicy?: WorkspaceRef['sandboxPolicy'];
  }): WorkspaceRef;
}

/**
 * Hand-side execution endpoint.
 *
 * PR 1.2 把原来的分散方法接口收敛为统一的
 * `execute(request)` envelope 形态，是 Managed Agents cattle 路线阶段 1 的核心契约变化。
 *
 * 关键约定：
 * - Provider 自己产生 audit records（如有），随 `response.audit` 一并返回；
 *   调用方再回填给 `ToolCallContext.executionAudit` recorder。这是远程化的前提
 *   （远端 hand 不可能持有 brain 侧的 in-process recorder）。
 * - Provider 不做授权/角色检查——那些留在 brain 侧的 WorkspaceToolProvider。
 * - `listInternalTools()` 公示 hand 暴露的工具描述符；阶段 1 所有 workspace 类
 *   provider 都返回相同的 `WORKSPACE_HAND_TOOLS` 常量。
 */
export interface ExecutionProvider {
  execute(request: ToolInvocationRequest): Promise<ToolInvocationResponse>;
  executeStream?(request: ToolInvocationRequest): import('../runtime/handProtocol.js').ToolInvocationStream;
  listInternalTools(): ToolDescriptor[];
}

export interface ToolRuntime {
  list(context?: ToolCallContext): ToolDescriptor[];
  invoke<TInput>(call: AuthorizedToolCall<TInput>, context: ToolCallContext): Promise<ToolResult>;
}

export interface ToolProvider {
  list(context?: ToolCallContext): ToolDescriptor[];
  invoke<TInput>(call: AuthorizedToolCall<TInput>, context: ToolCallContext): Promise<ToolResult | undefined>;
}

export interface PlatformToolRuntimeOptions {
  memoryIndexService?: MemoryIndexService | null;
  workspaceProvider?: WorkspaceProvider;
  /**
   * 单一 transport 覆盖默认 server-local。
   * 等价于 `executionTransportRegistry.register('server-local', transport)`。
   */
  executionTransport?: ExecutionTransport;
  /**
   * 完整 transport 注册表覆盖。优先级高于 `executionTransport`，但本 option
   * 会被后者再 `register` 覆写 server-local 槽位。
   */
  executionTransportRegistry?: ExecutionTransportRegistry;
  handStore?: HandStore;
  resolveHandAuthToken?: (hand: import('../runtime/handStore.js').HandRecord) => string | undefined | Promise<string | undefined>;
  /**
   * 每次为 tenant-remote hand 现场构造 HttpTransport 时，把 workspace 传给这个
   * resolver 拿到要透传远端的 env（wire.context.env）。返回值会被 pickHandEnv
   * 二次 allowlist 过滤。典型用途：按 workspace.tenantId + workspace.username
   * 查 tokens.json 得到 `{ AZEROTH_TOKEN, AZEROTH_API_URL }`。
   * 见 `runtime/handEnvAllowlist.ts` 与 `rawRuntimeRunDispatch.ts` 装配点。
   */
  resolveWireEnv?: (workspace: WorkspaceRef) => Record<string, string | undefined>;
  artifactService?: ArtifactService;
  providers?: ToolProvider[];
  toolControls?: ToolControlsConfig;
  /** PG durable 后台任务；存在时 Shell(mode=background) 才可启动并自动完成唤醒。 */
  backgroundTasks?: BackgroundTaskRuntime;
}

export const readFileToolDescriptor: ToolDescriptor<{ path: string; offset?: number; limit?: number }> = {
  id: 'Read',
  name: 'Read',
  displayName: 'Read File',
  description: loadToolDescription('Read'),
  schema: z.object({
    path: z.string().describe('工作区相对路径，或工作区内的绝对路径。'),
    offset: z.number().int().positive().optional().describe('可选，起始行号（1-based）。'),
    limit: z.number().int().positive().max(MAX_READ_LINES).optional().describe(`可选，返回的行数，最多 ${MAX_READ_LINES} 行。`),
  }),
  risk: 'safe',
  approvalMode: 'never',
  concurrency: 'parallel',
  auditCategory: 'filesystem.read',
  category: 'workspace',
  label: '读取文件',
  // 两个上限必须留在描述里：模型按它规划分片读取，写错会导致反复截断或超限重试。
  descriptionInvariants: [String(MAX_FILE_BYTES), String(MAX_READ_LINES), 'Unicode', 'sed | head'],
};

export const writeFileToolDescriptor: ToolDescriptor<{ path: string; content: string }> = {
  id: 'Write',
  name: 'Write',
  displayName: 'Write File',
  description: loadToolDescription('Write'),
  schema: z.object({
    path: z.string().describe('工作区相对路径，或工作区内的绝对路径。'),
    content: z.string(),
  }),
  risk: 'workspace_write',
  approvalMode: 'web',
  auditCategory: 'filesystem.write',
  category: 'workspace',
  label: '写入文件',
  descriptionInvariants: ['原子', '串行', 'fsync', 'rename'],
};

export const runShellToolDescriptor: ToolDescriptor<ShellToolInput> = {
  id: 'Shell',
  name: 'Shell',
  displayName: 'Run Shell',
  description: loadToolDescription('Shell'),
  schema: shellToolSchema,
  risk: 'dangerous',
  approvalMode: 'web',
  resolveCallPolicy: resolveShellCallPolicy,
  resolveConcurrency: resolveShellConcurrency,
  auditCategory: 'process.shell',
  category: 'workspace',
  label: '执行 Shell',
  // 运行时事实与搜索契约：执行环境认知错误会让模型误判可操作范围；rg 优先级是
  // Shell-first 搜索改造（2026-07-25）的落点，删掉会退回全目录 grep。
  descriptionInvariants: ['当前工作区运行时', 'rg --no-config --files', 'rg --no-config -n', '按 argv 直接执行', 'python3'],
};

export const bashOutputToolDescriptor: ToolDescriptor<{
  task_id: string;
  stdout_offset?: number;
  stderr_offset?: number;
  limit_bytes?: number;
  wait_ms?: number;
}> = {
  id: 'BashOutput',
  name: 'BashOutput',
  displayName: 'Read Background Shell Output',
  // 2026-08-03 工具面收敛批次起不再进入模型可见工具面（模型入口=BackgroundTask
  // action=output），仅作为 hand 端执行协议契约保留；description 不再走 md loader。
  description: '内部协议：读取后台命令的增量输出（模型入口为 BackgroundTask action=output）。',
  schema: z.object({
    task_id: z.string().min(1),
    stdout_offset: z.number().int().min(0).optional().default(0),
    stderr_offset: z.number().int().min(0).optional().default(0),
    limit_bytes: z.number().int().min(1).max(64 * 1024).optional().default(20_000),
    wait_ms: z.number().int().min(0).max(30_000).optional().default(0),
  }),
  risk: 'safe',
  approvalMode: 'never',
  auditCategory: 'process.shell.background.output',
  category: 'workspace',
  label: '读取后台命令输出',
};

export const killBashToolDescriptor: ToolDescriptor<{ task_id: string }> = {
  id: 'KillBash',
  name: 'KillBash',
  displayName: 'Kill Background Shell',
  // 同 BashOutput：仅 hand 端执行协议契约，模型入口为 BackgroundTask action=cancel。
  description: '内部协议：终止后台命令（模型入口为 BackgroundTask action=cancel）。',
  schema: z.object({ task_id: z.string().min(1) }),
  risk: 'safe',
  approvalMode: 'never',
  auditCategory: 'process.shell.background.cancel',
  category: 'workspace',
  label: '终止后台命令',
};

export const waitForWorkspaceReadyToolDescriptor: ToolDescriptor<{ timeoutMs?: number }> = {
  id: 'WaitForWorkspaceReady',
  name: 'WaitForWorkspaceReady',
  displayName: 'Wait for Workspace Ready',
  description: loadToolDescription('WaitForWorkspaceReady'),
  schema: z.object({
    timeoutMs: z.number().int().min(0).max(30_000).optional(),
  }),
  risk: 'safe',
  approvalMode: 'never',
  auditCategory: 'workspace.status',
  category: 'workspace',
  label: '等待工作区就绪',
};

/**
 * Workspace hand 暴露的固定工具集合。
 *
 * 所有 workspace 类 ExecutionProvider（ServerLocal / Container / 未来的 ServerRemote）
 * 都通过 `listInternalTools()` advertise 同一份契约；WorkspaceToolProvider 同样从这里
 * 公示给 brain 侧。
 *
 * PR 1.5 workspace 模型改造后，"workspace 类 hand 暴露什么"才可能因部署形态分化——
 * 在那之前保持单一常量来源。
 */
export const WORKSPACE_HAND_TOOLS: ToolDescriptor[] = [
  readFileToolDescriptor,
  writeFileToolDescriptor,
  runShellToolDescriptor,
  bashOutputToolDescriptor,
  killBashToolDescriptor,
  editToolDescriptor,
  artifactCreateToolDescriptor,
];

export class LocalWorkspaceProvider implements WorkspaceProvider {
  constructor(private readonly defaultExecutionTarget: ExecutionTargetKind = 'server-local') {}

  resolve(context: ChannelContext, args: {
    cwd: string;
    sessionId?: string;
    topLevelSessionId?: string;
    workspaceId?: string;
    sandboxScopeId?: string; mountSubPath?: string; sandboxResources?: WorkspaceRef['sandboxResources']; workload?: WorkspaceRef['workload'];
    executionTarget?: ExecutionTargetKind;
    sandboxPolicy?: WorkspaceRef['sandboxPolicy'];
  }): WorkspaceRef {
    // workspaceId 由 server runtime 基于 tenant/user 派生；server-remote
    // 底层执行面可用 sandboxScopeId 复用同一用户 workspace 的 warm Sandbox。
    // tenantId 优先取 context.user（首跑 fresh request），fallback context.sessionOwner
    // （wake / resume 路径）。两者都缺时返回 undefined → 下游 buildTenantScopedEnv
    // 按"匿名/平台兼容路径"走，保持向后兼容；ServerLocal Shell gate 也会因
    // identity 缺失自然 fail-closed（toolRuntime.ts:620）。
    const identity = context.user ?? context.sessionOwner;
    const tenantId = context.user?.tenantId ?? context.sessionOwner?.tenantId;
    return {
      id: args.workspaceId ?? args.sessionId,
      root: resolve(args.cwd),
      userId: identity?.id,
      username: identity?.username,
      ...(tenantId ? { tenantId } : {}),
      sessionId: args.sessionId,
      // 顶层会话组归属：显式传入优先；缺省时退回自身 sessionId（顶层会话的自然语义）。
      // 子 Agent 路径由调用方显式传入父的 topLevelSessionId，故不会误取子会话 ID。
      topLevelSessionId: args.topLevelSessionId ?? args.sessionId,
      sandboxScopeId: args.sandboxScopeId, mountSubPath: args.mountSubPath,
      sandboxResources: args.sandboxResources, ...(args.workload ? { workload: args.workload } : {}),
      executionTarget: args.executionTarget ?? this.defaultExecutionTarget,
      ...(args.sandboxPolicy ? { sandboxPolicy: args.sandboxPolicy } : {}),
    };
  }
}

function isTenantRemoteHand(hand: import('../runtime/handStore.js').HandRecord): boolean {
  return hand.type === 'server-remote'
    && hand.status !== 'destroyed'
    && typeof hand.metadata?.tenantRemoteHandId === 'string'
    && (hand.metadata.tenantRemoteHandId as string).length > 0;
}

function selectCurrentTenantRemoteHand(hands: ReadonlyArray<HandRecord>): HandRecord | undefined {
  return hands.find((hand) => hand.status === 'ready')
    ?? hands.find((hand) => hand.status === 'provisioning')
    ?? hands[0];
}

function workspaceReadyStatusResponse(input: {
  status: 'ready' | 'provisioning' | 'failed' | 'unavailable';
  message: string;
  workspaceId?: string;
  executionTarget?: ExecutionTargetKind;
}): ToolResult {
  return { content: JSON.stringify(input, null, 2) };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(new Error('WaitForWorkspaceReady aborted'));
  return new Promise((resolveSleep, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolveSleep();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('WaitForWorkspaceReady aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * envBuilder：按 workspace 装配子进程 env（P4 防御纵深，2026-06-22 落地）。
 * 由 createDefaultExecutionTransportRegistry 注入；未注入时 ServerLocal /
 * Container 都 fallback 到当前 process.env（向后兼容旧测试 / 内部直调路径）。
 */
export type EnvBuilder = (workspace: WorkspaceRef) => Record<string, string>;

export interface ServerLocalExecutionProviderOptions {
  envBuilder?: EnvBuilder;
}

export class ServerLocalExecutionProvider implements ExecutionProvider {
  private readonly envBuilder?: EnvBuilder;

  constructor(options: ServerLocalExecutionProviderOptions = {}) {
    this.envBuilder = options.envBuilder;
  }

  listInternalTools(): ToolDescriptor[] {
    return WORKSPACE_HAND_TOOLS;
  }

  async execute(request: ToolInvocationRequest): Promise<ToolInvocationResponse> {
    const { toolName, input, context } = request;
    const { workspace, signal } = context;
    try {
      switch (toolName) {
        case 'Read': {
          const args = input as { path: string; offset?: number; limit?: number };
          const read = await this._readFile(workspace, args.path, { offset: args.offset, limit: args.limit });
          return { status: 'success', content: read.content, metadata: read.metadata };
        }
        case 'Write': {
          const args = input as { path: string; content: string };
          const relPath = await this._writeFile(workspace, args.path, args.content);
          return {
            status: 'success',
            content: `wrote ${relPath} (${args.content.length} chars)`,
            metadata: { path: relPath, bytesWritten: args.content.length },
          };
        }
        case 'Shell': {
          const args = input as { command: string; timeoutMs?: number };
          return await this._runShellStreaming(
            workspace,
            args.command,
            args.timeoutMs,
            signal,
            undefined,
            context.invocationId,
            context.env,
            parseProvablyReadOnlyRgCommand(args.command),
          );
        }
        case 'Edit': {
          const result = await runWorkspaceEdit(input as Parameters<typeof runWorkspaceEdit>[0], workspace, (fullPath) => assertSandboxReadAllowed(workspace, fullPath));
          return { status: 'success', content: result.content, ...(result.metadata ? { metadata: result.metadata } : {}) };
        }
        case 'CreateArtifact': {
          const payload = await createWorkspaceArtifactPayload(input as Parameters<typeof createWorkspaceArtifactPayload>[0], workspace, (fullPath) => assertSandboxReadAllowed(workspace, fullPath));
          return {
            status: 'success',
            content: workspaceArtifactPreparedContent(payload),
            metadata: { [WORKSPACE_ARTIFACT_PAYLOAD_METADATA_KEY]: payload },
          };
        }
        default:
          return {
            status: 'error',
            error: `ServerLocalExecutionProvider: unknown tool ${toolName}`,
          };
      }
    } catch (err) {
      return {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async *executeStream(request: ToolInvocationRequest): import('../runtime/handProtocol.js').ToolInvocationStream {
    if (request.toolName !== 'Shell') {
      yield { type: 'completed', response: await this.execute(request) };
      return;
    }
    const { workspace, signal } = request.context;
    const args = request.input as { command: string; timeoutMs?: number };
    const queue: import('../runtime/handProtocol.js').ToolInvocationStreamChunk[] = [];
    let done = false;
    let notify: (() => void) | undefined;
    const wake = () => { notify?.(); notify = undefined; };
    this._runShellStreaming(
      workspace,
      args.command,
      args.timeoutMs,
      signal,
      (chunk) => { queue.push(chunk); wake(); },
      request.context.invocationId,
      request.context.env,
      parseProvablyReadOnlyRgCommand(args.command),
    )
      .then((response) => queue.push({ type: 'completed', response }))
      .catch((err) => queue.push({ type: 'completed', response: { status: 'error', error: err instanceof Error ? err.message : String(err) } }))
      .finally(() => { done = true; wake(); });
    while (!done || queue.length > 0) {
      const chunk = queue.shift();
      if (chunk) { yield chunk; continue; }
      await new Promise<void>((resolve) => { notify = resolve; });
    }
  }

  private async _readFile(
    workspace: WorkspaceRef,
    path: string,
    options: { offset?: number; limit?: number } = {},
  ): Promise<{ content: string; metadata: Record<string, unknown> }> {
    assertSandboxReadAllowed(workspace, resolveWorkspacePath(workspace.root, path));
    return await readWorkspaceFile(workspace.root, path, options, (fullPath) => {
      assertSandboxReadAllowed(workspace, fullPath);
    });
  }

  private async _writeFile(workspace: WorkspaceRef, path: string, content: string): Promise<string> {
    const fullPath = resolveWorkspacePath(workspace.root, path);
    assertSandboxReadAllowed(workspace, fullPath);
    const relPath = relativeWorkspacePath(workspace.root, fullPath);
    await withWorkspaceFileMutationQueue(workspace.root, relPath, async () => {
      await atomicWriteTrustedFile(workspace.root, relPath, content, {
        encoding: 'utf-8',
        createParents: true,
      });
    });
    return relPath;
  }

  private async _runShellStreaming(
    workspace: WorkspaceRef,
    command: string,
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined,
    onChunk?: (chunk: import('../runtime/handProtocol.js').ToolInvocationStreamChunk) => void | Promise<void>,
    invocationId?: string,
    runtimeEnv?: Record<string, string>,
    directArgv?: string[],
  ): Promise<ToolInvocationResponse> {
    return await runLocalShellStreaming({
      workspace,
      command,
      timeoutMs,
      signal,
      onChunk,
      invocationId,
      runtimeEnv,
      directArgv,
      envBuilder: this.envBuilder,
      findDeniedPathMention,
    });
  }
}

function assertSandboxReadAllowed(workspace: WorkspaceRef, fullPath: string): void {
  const deniedPath = workspace.sandboxPolicy?.denyRead.find((entry) => isPathInside(resolve(entry), fullPath));
  if (deniedPath) {
    throw new Error(`server-local sandbox denied path: ${deniedPath}`);
  }
}

/**
 * server-local Shell 的字符串级 sandbox 防御（P5 升级，2026-06-22）。
 *
 * 历史实现：`command.includes(resolve(entry))` 只挡"字面完整路径"命中，对常见
 * 路径变形（双斜杠 //、单点 /./、尾随斜杠）一刀不挡。
 *
 * 本升级覆盖：
 *   - 字面完整路径（baseline）
 *   - 双斜杠变形：/Users//admin/workspace 等同于 /Users/admin/workspace
 *   - 单点 /./ 变形：/Users/./admin/workspace 等同
 *   - 尾随斜杠
 *
 * 已知**未挡**的 bypass（honest limitations，需要更深防御才能挡，详见
 * docs/tenant-isolation-e2e-test-2026-06-21.md 疑点 2）：
 *   - 动态构造：`cat $HOME/../kaiyan/admin/MEMORY.md` / `cat $(echo /Users/...)`
 *     / `P=/path; cat $P/...` —— 需要 shell parse + 变量展开后再 normalize
 *   - 引号分段：`cat "/Users"/admin/workspace` —— 需要 shell-quote tokenize
 *   - symlink：`ln -s /Users/admin/... /tmp/x; cat /tmp/x/MEMORY.md` —— 需要
 *     realpath 二次校验子进程访问的真实路径
 *   - base64/heredoc/find -exec 等
 *
 * 当前 toolRuntime gate（toolRuntime.ts:608-626）已经把非平台用户挡在
 * server-local 之外（fail-closed），所以这条 guard 实际是给平台 admin 自防
 * prompt-injection 的兜底——平台 admin 是开沿员工，跨组织读取在产品语义下合规。
 * 完整覆盖动态构造 bypass 需要 shell-quote / realpath + sandbox 重设计，
 * 留作后续 ticket。
 */
function findDeniedPathMention(workspace: WorkspaceRef, command: string): string | undefined {
  const denyEntries = workspace.sandboxPolicy?.denyRead ?? [];
  for (const entry of denyEntries) {
    const normalized = resolve(entry);
    for (const variant of pathBypassVariants(normalized)) {
      if (command.includes(variant)) return entry;
    }
  }
  return undefined;
}

/**
 * 生成一个 path 的常见变形列表，覆盖 normalize 后等价但字面不同的 bypass。
 *
 * 注意只生成 path 本身的变形，不做 shell 语义展开（那需要 shell-quote）。
 * 任何"动态构造路径"bypass（$VAR、$(...)、symlink）这一层挡不住。
 */
function pathBypassVariants(normalized: string): string[] {
  const variants = new Set<string>();
  variants.add(normalized);
  // 1. 双斜杠：/Users/admin/workspace → /Users//admin//workspace
  //    cat /Users//admin/workspace 在 shell 下与 cat /Users/admin/workspace 等同
  variants.add(normalized.replace(/\//g, '//'));
  // 2. 单点 /./：/Users/admin/workspace → /Users/./admin/./workspace
  //    cat /Users/./admin/./workspace 在 shell 下与 cat /Users/admin/workspace 等同
  const segments = normalized.split('/').filter((s) => s.length > 0);
  if (segments.length > 0) {
    variants.add(`/${segments.map((s) => `./${s}`).join('/')}`);
    variants.add(`/${segments.join('/./')}`);
  }
  // 3. 尾随斜杠：cat /Users/admin/workspace/MEMORY.md 与 cat /Users/admin/workspace//MEMORY.md
  //    虽然 includes 字面命中已挡，但若 deny entry 是目录形态而命令访问其下文件，加 / 触发更多匹配场景
  variants.add(`${normalized}/`);
  return [...variants];
}

function isPathInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

export { ServerLocalExecutionProvider as LocalExecutionProvider };

export { ContainerExecutionProvider } from './containerExecutionProvider.js';
export type { ContainerExecutionProviderOptions } from './containerExecutionProvider.js';

/**
 * 默认 transport 注册表：把 server-local / server-container 两个 ExecutionProvider
 * 各自 wrap 成 InProcessTransport 注册进去。
 *
 * PR 1.3 起取代原 `createDefaultExecutionProviderRegistry()`。具体 transport class
 * 装配在本文件完成，避免 `runtime/inProcessTransport.ts` 反向依赖 provider 实现
 * （否则形成 import 循环）。
 */
export interface ExecutionTransportRegistryOptions {
  /**
   * P4 防御纵深（2026-06-22 落地）：按 workspace tenant 装配子进程 env。
   * 同时给 server-local（ServerLocalExecutionProvider）和 server-container
   * （ContainerExecutionProvider）使用，保证两条路径走同一身份装配规则。
   * 未注入时两个 provider 都保持向后兼容（ServerLocal 继承 process.env；
   * Container 用旧的 options.env 模式）。
   */
  envBuilder?: EnvBuilder;
}

export function createDefaultExecutionTransportRegistry(
  options: ExecutionTransportRegistryOptions = {},
): ExecutionTransportRegistry {
  return new DefaultExecutionTransportRegistry([
    ['server-local', new InProcessTransport(new ServerLocalExecutionProvider({ envBuilder: options.envBuilder }))],
    ['server-container', new InProcessTransport(new ContainerExecutionProvider({ envBuilder: options.envBuilder }))],
    ['client', new ClientDaemonTransport()],
  ]);
}

class WorkspaceToolProvider implements ToolProvider {
  private readonly executionTransportRegistry: ExecutionTransportRegistry;
  private readonly handStore?: HandStore;
  private readonly resolveHandAuthToken?: PlatformToolRuntimeOptions['resolveHandAuthToken'];
  private readonly resolveWireEnv?: PlatformToolRuntimeOptions['resolveWireEnv'];
  private readonly artifactService?: ArtifactService;
  private readonly memoryIndexService?: MemoryIndexService | null;
  private readonly backgroundTasks?: BackgroundTaskRuntime;

  constructor(
    executionTransportRegistry: ExecutionTransportRegistry,
    handStore?: HandStore,
    resolveHandAuthToken?: PlatformToolRuntimeOptions['resolveHandAuthToken'],
    artifactService?: ArtifactService,
    memoryIndexService?: MemoryIndexService | null,
    resolveWireEnv?: PlatformToolRuntimeOptions['resolveWireEnv'],
    backgroundTasks?: BackgroundTaskRuntime,
  ) {
    this.executionTransportRegistry = executionTransportRegistry;
    this.handStore = handStore;
    this.resolveHandAuthToken = resolveHandAuthToken;
    this.resolveWireEnv = resolveWireEnv;
    this.artifactService = artifactService;
    this.memoryIndexService = memoryIndexService;
    this.backgroundTasks = backgroundTasks;
  }

  list(_context?: ToolCallContext): ToolDescriptor[] {
    // BashOutput/KillBash 不再进入模型可见工具面（2026-08-03 工具面收敛批次）：
    // 后台命令的续读/取消统一收口到 BackgroundTask(action=output|cancel)。
    // WORKSPACE_HAND_TOOLS 常量保持完整——它同时是 hand 端执行契约，
    // DurableBackgroundTaskService.invokeCommandControl 仍按原协议名内部调用。
    const workspaceTools = WORKSPACE_HAND_TOOLS.filter((tool) => {
      if (tool.id === bashOutputToolDescriptor.id || tool.id === killBashToolDescriptor.id) return false;
      // CreateArtifact 是 hand 内部协议名；模型只看到合并后的 Artifact。
      if (tool.id === artifactCreateToolDescriptor.id) return false;
      return true;
    });
    return [waitForWorkspaceReadyToolDescriptor, ...workspaceTools, ...(this.artifactService ? [artifactToolDescriptor] : [])];
  }

  async invoke<TInput>(call: AuthorizedToolCall<TInput>, context: ToolCallContext): Promise<ToolResult | undefined> {
    if (call.toolId === waitForWorkspaceReadyToolDescriptor.id) {
      const input = waitForWorkspaceReadyToolDescriptor.schema.parse(call.input) as { timeoutMs?: number };
      return await this.waitForWorkspaceReady(context, input.timeoutMs ?? 15_000);
    }

    const descriptor = call.toolId === artifactToolDescriptor.id ? artifactToolDescriptor : WORKSPACE_HAND_TOOLS.find((tool) => tool.id === call.toolId);
    if (!descriptor) return undefined;
    if ((call.toolId === artifactToolDescriptor.id || call.toolId === artifactCreateToolDescriptor.id) && !this.artifactService) {
      throw new Error('Artifact: artifact service is not configured.');
    }

    if (descriptor.risk === 'workspace_write' && !call.authorization?.approved) {
      throw new Error(`Tool ${call.toolId} requires prior authorization.`);
    }

    // 解析入参用模型/hand 公示的 schema（校验 + 应用 default）。Artifact 是
    // brain 侧合并工具：deliver 完全在服务端完成；create 再翻译为 hand 的
    // CreateArtifact 兼容协议，避免 remote hand 滚动升级期间 contract drift。
    let parsedInput: unknown = parseToolInput(descriptor, call.input);
    let transportToolName = call.toolId;
    let transportInput = parsedInput;
    if (call.toolId === artifactToolDescriptor.id) {
      const prepared = await prepareArtifactInvocation(parsedInput as Parameters<typeof prepareArtifactInvocation>[0], this.artifactService!, context);
      if (prepared.action === 'deliver') return prepared.result;
      transportToolName = artifactCreateToolDescriptor.id;
      transportInput = prepared.transportInput;
    }
    const route = await this.resolveTenantHandRoute(context);
    if (route.kind === 'blocked') {
      throw new Error(route.message);
    }
    const handId = route.kind === 'ready' ? route.handId : undefined;

    const routed = await this.transportFor(context, handId);
    const workspaceForHand = routed.workspace ?? context.workspace;

    if (call.toolId === 'Shell') {
      // 多组织产品化语义（2026-06-21）：Shell 是 agent 操作自己
      // sandbox/hand 的基础能力，不能长期按用户角色一刀切禁用；但在
      // server-local/raw host 路径上仍会直接触达宿主可见文件系统，曾实测
      // wain_admin 可 cat kaiyan/admin/MEMORY.md。因此授权条件改为：
      //   1) platform admin 可在 server-local 执行；
      //   2) 任何已授权用户可在隔离执行环境（server-container/server-remote/client）执行。
      // 非平台用户如果没有可用隔离 hand/container，继续 fail-closed。
      const identity = context.channelContext.user ?? context.channelContext.sessionOwner;
      const isPlatformAdmin = identity?.role === 'admin'
        && identity?.tenantId === DEFAULT_TENANT_ID;
      const hasIsolatedExecution = workspaceForHand.executionTarget !== 'server-local';
      if (!identity || (!isPlatformAdmin && !hasIsolatedExecution)) {
        throw new Error('Shell requires an isolated hand/container for non-platform users.');
      }
      if (!call.authorization?.approved) {
        throw new Error('Tool Shell requires prior authorization.');
      }
    }
    const shellInput = call.toolId === 'Shell' && parsedInput && typeof parsedInput === 'object'
      ? parsedInput as { command: string; mode?: 'foreground' | 'background'; timeoutMs?: number }
      : undefined;
    const isBackgroundShellStart = shellInput?.mode === 'background';
    if ((isBackgroundShellStart || call.toolId === 'BashOutput' || call.toolId === 'KillBash')
      && workspaceForHand.executionTarget !== 'server-remote') {
      throw new Error(`${call.toolId} 的后台命令能力仅支持 ACS server-remote 隔离运行时。`);
    }
    // durable 命令必须持久化自动选择的 remote workspace，不能记录会话默认 container。
    const effectiveContext = workspaceForHand === context.workspace ? context : { ...context, workspace: workspaceForHand };
    let reservedTaskId: string | undefined;
    if (isBackgroundShellStart) {
      if (!this.backgroundTasks) throw new Error('Shell(mode=background) 需要 PG durable background runtime。');
      const reservation = await this.backgroundTasks.reserveCommand(effectiveContext, {
        command: shellInput.command,
        timeoutMs: shellInput.timeoutMs ?? DEFAULT_BACKGROUND_SHELL_TIMEOUT_MS,
      });
      reservedTaskId = reservation.taskId;
      parsedInput = { ...shellInput, taskId: reservation.taskId };
      transportInput = parsedInput;
    }

    const request = {
      toolName: transportToolName,
      input: transportInput,
      context: {
        ...(context.invocationId ? { invocationId: context.invocationId } : {}),
        ...(handId ? { handId } : {}), ...(context.correlation ? { correlation: context.correlation } : {}),
        workspace: workspaceForHand,
        env: context.env,
        signal: context.signal,
      },
    };
    const killReservedBackgroundShell = async (): Promise<void> => {
      if (!reservedTaskId) return;
      await routed.transport.invoke({
        toolName: 'KillBash',
        input: { task_id: reservedTaskId },
        // 原请求可能正是因 signal abort 失败；补偿终止必须脱离该 signal/invocationId。
        context: {
          ...(handId ? { handId } : {}),
          workspace: workspaceForHand,
        },
      }).catch(() => undefined);
    };
    let response: ToolInvocationResponse;
    try {
      response = routed.transport.invokeStream && call.toolId === 'Shell' && !isBackgroundShellStart && (context.invocationId ?? context.correlation?.invocationId)
        ? await consumeToolStream(routed.transport.invokeStream(request), context.onStreamChunk)
        : await routed.transport.invoke(request);
    } catch (err) {
      if (reservedTaskId && this.backgroundTasks) {
        await killReservedBackgroundShell();
        await this.backgroundTasks.failCommandStart(
          effectiveContext,
          reservedTaskId,
          err instanceof Error ? err.message : String(err),
        ).catch(() => undefined);
      }
      throw err;
    }

    // 把 hand 端产生的 audit 记录回填到 brain 侧 recorder（远程化时同一形态）
    if (response.audit && context.executionAudit) {
      for (const record of response.audit) {
        context.executionAudit.record(record);
      }
    }

    if (response.status === 'error') {
      if (reservedTaskId && this.backgroundTasks) {
        await killReservedBackgroundShell();
        await this.backgroundTasks.failCommandStart(effectiveContext, reservedTaskId, response.error).catch(() => undefined);
      }
      // 失败路径同样带上摘要：error 分支的 metadata 里有 exitCode/timedOut/aborted
      // 等真实信号，丢掉它等于让客户在最该看清楚的时刻只看到一行「有异常」
      throw new ToolExecutionError(
        response.error,
        buildToolPresentation(call.toolId, parsedInput, undefined, response.metadata, response.error, context.workspace.tenantId),
        extractToolResultMetadata(call.toolId, response.metadata),
      );
    }
    if (reservedTaskId && this.backgroundTasks) {
      try {
        await this.backgroundTasks.activateCommand(effectiveContext, reservedTaskId);
      } catch (err) {
        await killReservedBackgroundShell();
        await this.backgroundTasks.failCommandStart(
          effectiveContext,
          reservedTaskId,
          err instanceof Error ? err.message : String(err),
        ).catch(() => undefined);
        throw err;
      }
    }
    this.notifyMemoryIndexIfNeeded(call.toolId, parsedInput, workspaceForHand, response);
    if (call.toolId === artifactToolDescriptor.id || call.toolId === artifactCreateToolDescriptor.id) {
      return createdArtifactToolResult(await this.createArtifactFromHandResponse(response, context, transportInput));
    }
    const modelImages = call.toolId === readFileToolDescriptor.id ? await materializeReadToolImage(response, context.workspace.root) : undefined;
    // 在这里产出摘要而不是等收口点兜底：response.metadata 是**截断前**的真实
    // 执行结果（Shell 的 exitCode/字节数/耗时、Write 的写入字节数），
    // 到了收口点只剩截断后的 content，再数就会静默错报。
    // response.content 是 formatShellOutput 的信封（本地/远端 hand 同形态），
    // 连接器命令的 stdout 段就从这里取——摘要产出时机能拿到的最接近一手的形态
    const presentation = buildToolPresentation(
      call.toolId,
      parsedInput,
      undefined,
      response.metadata,
      response.content,
      context.workspace.tenantId,
    );
    // 同一份截断前 metadata 的第二个出口：白名单收敛后随 tool_result 事件落库，
    // 让 exitCode 之类的事实以字段而非「Exit code: N」文本行的形态存活
    const resultMetadata = extractToolResultMetadata(call.toolId, response.metadata);
    // 后台命令启动成功时在 brain 侧追加续读/取消引导：hand 端返回文案仍指向
    // 协议名 BashOutput/KillBash（ACS 零改动），但模型可见工具已收敛为
    // BackgroundTask——不在这里纠偏，模型会按 hand 文案调用已下线的工具名。
    if (isBackgroundShellStart && reservedTaskId) {
      return {
        content: `${response.content}\n\n续读输出用 BackgroundTask(action="output", task_id="${reservedTaskId}")，取消用 BackgroundTask(action="cancel", task_id="${reservedTaskId}")。`,
        ...(presentation ? { presentation } : {}),
        ...(resultMetadata ? { metadata: resultMetadata } : {}),
      };
    }
    return {
      content: response.content, ...(modelImages ? { modelImages } : {}),
      ...(presentation ? { presentation } : {}),
      ...(resultMetadata ? { metadata: resultMetadata } : {}),
    };
  }

  private notifyMemoryIndexIfNeeded(
    toolId: string,
    input: unknown,
    workspace: WorkspaceRef,
    response: Extract<ToolInvocationResponse, { status: 'success' }>,
  ): void {
    if (!this.memoryIndexService) return;
    const relPath = memoryPathFromSuccessfulTool(toolId, input, workspace, response);
    if (relPath) {
      this.memoryIndexService.enqueueSync(workspace.root, `tool:${toolId}:${relPath}`);
      return;
    }
    if (toolId === 'Shell') {
      const command = input && typeof input === 'object'
        ? (input as { command?: unknown }).command
        : undefined;
      if (typeof command === 'string' && shellCommandMentionsMemoryPath(command)) {
        this.memoryIndexService.noteMaybeChanged(workspace.root, 'tool:Shell:memory-path', {
          debounceMs: MEMORY_SHELL_MAYBE_CHANGED_DEBOUNCE_MS,
          minIntervalMs: MEMORY_SHELL_MAYBE_CHANGED_INTERVAL_MS,
        });
      }
    }
  }

  private async createArtifactFromHandResponse(
    response: Extract<ToolInvocationResponse, { status: 'success' }>,
    context: ToolCallContext,
    input: unknown,
  ) {
    if (!this.artifactService) {
      throw new Error('CreateArtifact: artifact service is not configured.');
    }
    const sessionId = context.workspace.sessionId;
    if (!sessionId) {
      throw new Error('CreateArtifact: workspace.sessionId required.');
    }
    const payload = response.metadata?.[WORKSPACE_ARTIFACT_PAYLOAD_METADATA_KEY] as WorkspaceArtifactPayload | undefined;
    if (!payload || typeof payload.dataBase64 !== 'string' || typeof payload.fileName !== 'string') {
      throw new Error('CreateArtifact: hand response missing artifact payload.');
    }
    const parsedInput = input && typeof input === 'object' ? input as { metadata?: Record<string, unknown> } : {};
    return this.artifactService.createFromBytes({
      sessionId,
      workspaceId: context.workspace.id,
      kind: payload.kind,
      data: Buffer.from(payload.dataBase64, 'base64'),
      fileName: payload.fileName,
      mimeType: payload.mimeType,
      metadata: {
        source: 'workspace_file',
        sourcePath: payload.sourcePath,
        ...(parsedInput.metadata ?? {}),
      },
    });
  }

  /** Resolve the shared run-bound route; pending legacy tenant hands remain fail closed. */
  private async resolveTenantHandRoute(context: ToolCallContext): Promise<
    { kind: 'none' } | { kind: 'ready'; handId: string } | { kind: 'blocked'; message: string }
  > {
    if (!this.handStore) return { kind: 'none' };
    const sessionId = context.sessionId ?? context.workspace.sessionId;
    if (!sessionId) return { kind: 'none' };
    try {
      const hands = await this.handStore.listBySession(sessionId);
      const decision = selectRuntimeHandRoute(hands, { runId: context.runId, executionTarget: context.workspace.executionTarget, runtimeIsolationRequirement: context.runtimeIsolationRequirement });
      if (decision.kind === 'ready') return { kind: 'ready', handId: decision.handId };
      if (decision.kind === 'blocked') return decision;
      const tenantHands = hands.filter(isTenantRemoteHand);
      if (tenantHands.length === 0) return { kind: 'none' };
      const currentRuntime = selectCurrentTenantRemoteHand(tenantHands);
      const currentStatus = currentRuntime?.status ?? 'unavailable';
      const hasProvisioning = currentStatus === 'provisioning';
      return {
        kind: 'blocked',
        message: hasProvisioning
          ? 'Current workspace runtime is still preparing. Call WaitForWorkspaceReady before using workspace tools.'
          : `Current workspace runtime is not ready (status=${currentStatus}). Call WaitForWorkspaceReady to inspect the current status.`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        kind: 'blocked',
        message: `Workspace runtime registry is unavailable (${message}). Wait for the session to recover before using workspace tools.`,
      };
    }
  }

  private async waitForWorkspaceReady(context: ToolCallContext, timeoutMs: number): Promise<ToolResult> {
    if (!this.handStore) {
      return workspaceReadyStatusResponse({
        status: 'unavailable',
        executionTarget: context.workspace.executionTarget,
        message: 'No durable runtime registry is configured; workspace tools will use the session default runtime.',
      });
    }
    const sessionId = context.sessionId ?? context.workspace.sessionId;
    if (!sessionId) {
      return workspaceReadyStatusResponse({
        status: 'unavailable',
        executionTarget: context.workspace.executionTarget,
        message: 'No session id is available, so no dedicated workspace runtime can be resolved.',
      });
    }

    const deadline = Date.now() + Math.max(0, timeoutMs);
    let lastHands: import('../runtime/handStore.js').HandRecord[] = [];
    do {
      try {
        lastHands = await this.handStore.listBySession(sessionId);
      } catch (err) {
        return workspaceReadyStatusResponse({
          status: 'unavailable',
          executionTarget: context.workspace.executionTarget,
          message: `Workspace runtime registry is unavailable: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      const tenantHands = lastHands.filter(isTenantRemoteHand);
      const decision = selectRuntimeHandRoute(lastHands, { runId: context.runId, executionTarget: context.workspace.executionTarget, runtimeIsolationRequirement: context.runtimeIsolationRequirement });
      if (decision.kind === 'ready') {
        const hand = lastHands.find((candidate) => candidate.handId === decision.handId);
        return workspaceReadyStatusResponse({
          status: 'ready',
          workspaceId: hand?.workspaceId,
          executionTarget: hand?.type ?? 'server-remote',
          message: 'Current workspace runtime is ready. Workspace tools can now be used.',
        });
      }
      if (decision.kind === 'blocked') return workspaceReadyStatusResponse({
        status: 'failed', executionTarget: context.workspace.executionTarget, message: decision.message,
      });
      if (tenantHands.length === 0) {
        return workspaceReadyStatusResponse({
          status: 'unavailable',
          executionTarget: context.workspace.executionTarget,
          message: 'No dedicated workspace runtime is attached to this session; workspace tools will use the session default runtime.',
        });
      }
      const currentRuntime = selectCurrentTenantRemoteHand(tenantHands);
      if (tenantHands.every((hand) => hand.status === 'unhealthy')) {
        return workspaceReadyStatusResponse({
          status: 'failed',
          workspaceId: currentRuntime?.workspaceId,
          executionTarget: currentRuntime?.type,
          message: 'Current workspace runtime failed to start.',
        });
      }
      if (Date.now() >= deadline) {
        return workspaceReadyStatusResponse({
          status: 'provisioning',
          workspaceId: currentRuntime?.workspaceId,
          executionTarget: currentRuntime?.type,
          message: 'Current workspace runtime is still preparing.',
        });
      }
      await sleep(Math.min(100, Math.max(0, deadline - Date.now())), context.signal);
    } while (Date.now() <= deadline);

    const currentRuntime = selectCurrentTenantRemoteHand(lastHands.filter(isTenantRemoteHand));
    return workspaceReadyStatusResponse({
      status: 'provisioning',
      workspaceId: currentRuntime?.workspaceId,
      executionTarget: currentRuntime?.type,
      message: 'Current workspace runtime is still preparing.',
    });
  }

  private async transportFor(context: ToolCallContext, handId?: string): Promise<{
    transport: ExecutionTransport;
    workspace?: WorkspaceRef;
  }> {
    if (handId) {
      if (!this.handStore) {
        throw new Error(`handId routing requested but no HandStore is configured: ${handId}`);
      }
      const hand = await this.handStore.get(handId);
      if (!hand) {
        throw new Error(`hand not found: ${handId}`);
      }
      if (hand.status !== 'ready') {
        throw new Error(`hand is not ready: ${handId} (${hand.status})`);
      }
      if (context.runtimeIsolationRequirement) {
        const boundary = selectRuntimeHandRoute([hand], {
          runId: context.runId, runtimeIsolationRequirement: context.runtimeIsolationRequirement,
        });
        if (boundary.kind !== 'ready' || boundary.handId !== handId) throw new Error('RUNTIME_ISOLATION_ROUTE_BINDING_MISMATCH');
      }
      const currentSessionId = context.sessionId ?? context.workspace.sessionId;
      if (hand.sessionId && currentSessionId && hand.sessionId !== currentSessionId) {
        throw new Error('hand is not available in the current session');
      }
      if (hand.workspaceId && context.workspace.id && hand.workspaceId !== context.workspace.id) {
        throw new Error('hand workspace does not match the current workspace');
      }
      const handMountSubPath = recipeMountSubPath(hand.metadata?.recipe);
      if (handMountSubPath && context.workspace.mountSubPath && handMountSubPath !== context.workspace.mountSubPath) {
        throw new Error('hand mountSubPath does not match the current workspace');
      }
      const workspace: WorkspaceRef = {
        ...context.workspace,
        id: hand.workspaceId || context.workspace.id,
        sandboxScopeId: recipeSandboxScopeId(hand.metadata?.recipe) ?? context.workspace.sandboxScopeId,
        mountSubPath: handMountSubPath ?? context.workspace.mountSubPath,
        executionTarget: hand.type,
      };
      if (hand.type === 'server-remote' && typeof hand.metadata?.tenantRemoteHandId !== 'string'
        && this.executionTransportRegistry.has('server-remote'))
        return { transport: this.executionTransportRegistry.get('server-remote'), workspace };
      if (hand.type === 'server-remote' && hand.endpoint) {
        const tenantHand = typeof hand.metadata?.tenantRemoteHandId === 'string'
          && hand.metadata.tenantRemoteHandId.trim().length > 0;
        const resolvedToken = await this.resolveHandAuthToken?.(hand);
        const authToken = resolvedToken ?? (tenantHand ? undefined : resolveRemoteHandAuthToken(hand.metadata));
        if (!authToken) {
          throw new Error(`server-remote hand ${handId} is missing an auth token`);
        }
        return {
          transport: new HttpTransport({
            baseUrl: hand.endpoint,
            authToken,
            invokeTimeoutMs: resolveRemoteHandInvokeTimeoutMs(hand.metadata),
            // 07-05：把 AZEROTH_TOKEN 等 allowlist env 透传到远端 pod。
            // envResolver 内部按 workspace.tenantId + workspace.username 查 tokens.json，
            // 见 rawRuntimeRunDispatch.ts 装配点与 runtime/handEnvAllowlist.ts。
            ...(this.resolveWireEnv ? { envResolver: this.resolveWireEnv } : {}),
          }),
          workspace,
        };
      }
      if (!this.executionTransportRegistry.has(hand.type)) {
        throw new Error(`execution transport not registered for hand ${handId}: ${hand.type}`);
      }
      return { transport: this.executionTransportRegistry.get(hand.type), workspace };
    }
    return { transport: this.executionTransportRegistry.get(context.workspace.executionTarget) };
  }
}

function recipeMountSubPath(recipe: unknown): string | undefined {
  if (!recipe || typeof recipe !== 'object') return undefined;
  const raw = (recipe as { mountSubPath?: unknown }).mountSubPath;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

function recipeSandboxScopeId(recipe: unknown): string | undefined {
  if (!recipe || typeof recipe !== 'object') return undefined;
  const raw = (recipe as { sandboxScopeId?: unknown }).sandboxScopeId;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

export class PlatformToolRuntime implements ToolRuntime {
  private readonly providers: ToolProvider[];
  private readonly toolControls?: ToolControlsConfig;

  constructor(options: PlatformToolRuntimeOptions = {}) {
    const executionTransportRegistry = options.executionTransportRegistry ?? createDefaultExecutionTransportRegistry();
    if (options.executionTransport) {
      executionTransportRegistry.register('server-local', options.executionTransport);
    }
    this.providers = [
      new WorkspaceToolProvider(
        executionTransportRegistry,
        options.handStore,
        options.resolveHandAuthToken,
        options.artifactService,
        options.memoryIndexService,
        options.resolveWireEnv,
        options.backgroundTasks,
      ),
      ...(options.memoryIndexService ? [new MemorySearchToolProvider(options.memoryIndexService)] : []),
      ...(options.providers ?? []),
    ];
    this.toolControls = options.toolControls;
  }

  list(context?: ToolCallContext): ToolDescriptor[] {
    return this.providers
      .flatMap((provider) => provider.list(context))
      .filter((descriptor) => isToolEnabled(this.toolControls, descriptor))
      .map((descriptor) => applyToolDescriptionOverride(descriptor, this.toolControls));
  }

  async invoke<TInput>(call: AuthorizedToolCall<TInput>, context: ToolCallContext): Promise<ToolResult> {
    if (!isToolEnabled(this.toolControls, call.toolId)) {
      throw new Error(`Tool ${call.toolId} is disabled by platform config.`);
    }
    for (const provider of this.providers) {
      const result = await provider.invoke(call, context);
      if (!result) continue;
      // 全仓唯一的工具执行收口点：builtin / MCP / Skill / hand / subagent / cron
      // 等所有 provider 都经过这里，故摘要兜底放在此处覆盖率最高。
      // provider 已自产的不覆盖——它拿得到截断前的原始数据，信息量更高。
      const presentation = buildToolPresentation(
        call.toolId, call.input, result.presentation, undefined, undefined, context.workspace?.tenantId,
      );
      return presentation ? { ...result, presentation } : result;
    }
    throw new Error(`Unknown tool: ${call.toolId}`);
  }
}

export function isToolEnabled(
  controls: ToolControlsConfig | undefined,
  tool: Pick<ToolDescriptor, 'id' | 'name'> | string,
): boolean {
  if (controls?.enabled === false) return false;
  const id = typeof tool === 'string' ? tool : tool.id;
  const name = typeof tool === 'string' ? tool : tool.name;
  const byId = controls?.tools?.[id]?.enabled;
  const byName = name !== id ? controls?.tools?.[name]?.enabled : undefined;
  // 工具合并迁移安全：曾显式禁用 CreateArtifact 的平台不能在升级后意外重新
  // 开启 Artifact(create|deliver)。旧键仅继承 enabled=false；旧描述不继承，避免
  // 把 fileCardMarker 等已退休契约重新注入模型。
  const legacyDisabled = id === 'Artifact' && controls?.tools?.CreateArtifact?.enabled === false;
  return byId !== false && byName !== false && !legacyDisabled;
}

/**
 * 把 toolControls 里的 descriptionOverride 打进 descriptor.description。
 *
 * append 模式：md 原描述 + " " + 归一化 override，供给 LLM 时是单行连续文本。
 * replace 模式：完全用 override 覆盖（危险，UI 已弹二次确认）。
 *
 * 归一化沿用 descriptionLoader 的规则：split('\n') → trim → filter 空 → join(' ')。
 * 保证 md 里的多行段落和 override 里的多行输入行为一致，模型看到的 description
 * 永远是单行连续字符串。
 */
/**
 * 校验覆盖后的生效描述仍保留全部 descriptionInvariants。
 *
 * 只对声明了 invariants 的工具生效；`mode: 'append'` 天然保留原文，这里仍统一
 * 校验，避免将来 append 语义变化后出现无人看守的缺口。
 *
 * 返回违规明细而不是直接抛错——调用方（admin 保存接口）要把工具名和缺失片段
 * 一并回给操作者，"保存失败"三个字帮不上忙。
 */
export function findToolDescriptionInvariantViolations(
  descriptors: readonly ToolDescriptor[],
  controls: ToolControlsConfig | undefined,
): Array<{ toolId: string; missing: string[] }> {
  const violations: Array<{ toolId: string; missing: string[] }> = [];
  for (const descriptor of descriptors) {
    const invariants = descriptor.descriptionInvariants;
    if (!invariants?.length) continue;
    const effective = applyToolDescriptionOverride(descriptor, controls).description;
    const missing = invariants.filter((fragment) => !effective.includes(fragment));
    if (missing.length) violations.push({ toolId: descriptor.id, missing });
  }
  return violations;
}

export function applyToolDescriptionOverride(
  descriptor: ToolDescriptor,
  controls: ToolControlsConfig | undefined,
): ToolDescriptor {
  const override = controls?.tools?.[descriptor.id]?.descriptionOverride
    ?? controls?.tools?.[descriptor.name]?.descriptionOverride;
  if (!override || !override.text || !override.text.trim()) return descriptor;
  const normalized = override.text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
  if (!normalized) return descriptor;
  const nextDescription = override.mode === 'replace'
    ? normalized
    : `${descriptor.description} ${normalized}`;
  return { ...descriptor, description: nextDescription };
}

export { hasMemorySearchTool } from './memorySearchToolProvider.js';

// 路径解析与记忆判定纯函数已迁至 ./toolRuntimePaths.ts，这里按既有 import 路径继续对外转发。
export { isExecutionTargetKind } from './toolRuntimePaths.js';

async function consumeToolStream(
  stream: import('../runtime/handProtocol.js').ToolInvocationStream,
  onChunk?: (chunk: import('../runtime/handProtocol.js').ToolInvocationStreamChunk) => Promise<void> | void,
): Promise<ToolInvocationResponse> {
  let finalResponse: ToolInvocationResponse | null = null;
  for await (const chunk of stream) {
    await onChunk?.(chunk);
    if (chunk.type === 'completed') finalResponse = chunk.response;
  }
  return finalResponse ?? { status: 'error', error: 'tool stream ended without completed chunk' };
}
