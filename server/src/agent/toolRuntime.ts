import { exec as execCb, spawn } from 'child_process';
import { createReadStream } from 'fs';
import { mkdir, open, readdir, stat, writeFile } from 'fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'path';
import { createInterface } from 'readline';
import { promisify } from 'util';

import { z } from 'zod';

import type { AgentRunHooks } from './types.js';
import type { MemoryIndexService } from '../memory/index/service.js';
import type {
  ToolInvocationRequest,
  ToolInvocationResponse,
} from '../runtime/handProtocol.js';
import type { ArtifactService } from '../runtime/artifactService.js';
import type {
  ExecutionTransport,
  ExecutionTransportRegistry,
} from '../runtime/executionTransport.js';
import { pickSoleReadyTenantHandId, type HandRecord, type HandStore } from '../runtime/handStore.js';
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
import { MemorySearchToolProvider } from './memorySearchToolProvider.js';
import { persistShellOutputFiles } from './shellOutputFiles.js';
import { loadToolDescription } from './tools/descriptionLoader.js';
import {
  DEFAULT_SHELL_TIMEOUT_MS,
  DEFAULT_BACKGROUND_SHELL_TIMEOUT_MS,
  MAX_BACKGROUND_SHELL_TIMEOUT_MS,
  MAX_SHELL_TIMEOUT_MS,
  MAX_FILE_BYTES,
  MAX_LIST_ENTRIES,
  MAX_READ_LINES,
  MAX_READ_OUTPUT_BYTES,
  MAX_SHELL_CAPTURE_BYTES,
  MAX_SHELL_STREAM_BYTES,
  formatShellOutput,
  truncateUtf8Prefix,
} from './toolOutput.js';
import {
  WORKSPACE_ARTIFACT_PAYLOAD_METADATA_KEY,
  artifactCreateToolDescriptor,
  createWorkspaceArtifactPayload,
  editToolDescriptor,
  globToolDescriptor,
  grepToolDescriptor,
  runWorkspaceEdit,
  runWorkspaceGlob,
  runWorkspaceGrep,
  workspaceArtifactPreparedContent,
  type WorkspaceArtifactPayload,
} from './workspaceHandTools.js';

const exec = promisify(execCb);

const MEMORY_SHELL_MAYBE_CHANGED_INTERVAL_MS = 120_000;
const MEMORY_SHELL_MAYBE_CHANGED_DEBOUNCE_MS = 30_000;

export { MAX_FILE_BYTES, MAX_LIST_ENTRIES, MAX_READ_LINES, MAX_READ_OUTPUT_BYTES };

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
export type ExecutionTargetKind = 'server-local' | 'server-container' | 'server-remote' | 'client';

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
  sandboxScopeId?: string;
  mountSubPath?: string;
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
  sessionId?: string;
  runId?: string;
  toolCallId?: string;
  invocationId?: string;
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
   * 可选：直接提供 JSON Schema 作为模型可见的 parameters。优先级高于
   * schema.toJSONSchema()。MCP 工具用它把 server 上报的 inputSchema 完整透传
   * 给模型——否则只能用 z.object({}).passthrough() 落到空 properties，模型
   * 看不到参数说明，调用时无法准确传参。
   */
  parametersJsonSchema?: Record<string, unknown>;
  risk: ToolRisk;
  approvalMode: ToolApprovalMode;
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
}

export interface ToolResult {
  content: string;
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
    workspaceId?: string;
    sandboxScopeId?: string;
    mountSubPath?: string;
    executionTarget?: ExecutionTargetKind;
    sandboxPolicy?: WorkspaceRef['sandboxPolicy'];
  }): WorkspaceRef;
}

/**
 * Hand-side execution endpoint.
 *
 * PR 1.2 把原来的 4 方法接口（readFile/writeFile/listFiles/runShell）收敛为统一的
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
  auditCategory: 'filesystem.read',
  category: 'workspace',
  label: '读取文件',
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
};

export const listFilesToolDescriptor: ToolDescriptor<{ path: string; recursive: boolean }> = {
  id: 'List',
  name: 'List',
  displayName: 'List Files',
  description: loadToolDescription('List'),
  schema: z.object({
    path: z.string().default('.').describe('工作区内的目录。'),
    recursive: z.boolean().default(false),
  }),
  risk: 'safe',
  approvalMode: 'never',
  auditCategory: 'filesystem.list',
  category: 'workspace',
  label: '列出文件',
};

const shellToolSchema = z.object({
  command: z.string(),
  mode: z.enum(['foreground', 'background']).optional(),
  timeoutMs: z.number().int().positive().max(MAX_BACKGROUND_SHELL_TIMEOUT_MS).optional(),
}).superRefine((value, ctx) => {
  if (value.mode !== 'background' && value.timeoutMs !== undefined && value.timeoutMs > MAX_SHELL_TIMEOUT_MS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['timeoutMs'],
      message: `前台 Shell timeoutMs 不能超过 ${MAX_SHELL_TIMEOUT_MS}`,
    });
  }
});

export const runShellToolDescriptor: ToolDescriptor<{
  command: string;
  mode?: 'foreground' | 'background';
  timeoutMs?: number;
}> = {
  id: 'Shell',
  name: 'Shell',
  displayName: 'Run Shell',
  description: loadToolDescription('Shell'),
  schema: shellToolSchema,
  risk: 'dangerous',
  approvalMode: 'web',
  auditCategory: 'process.shell',
  category: 'workspace',
  label: '执行 Shell',
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
  description: loadToolDescription('BashOutput'),
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
  description: loadToolDescription('KillBash'),
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
  listFilesToolDescriptor,
  runShellToolDescriptor,
  bashOutputToolDescriptor,
  killBashToolDescriptor,
  editToolDescriptor,
  globToolDescriptor,
  grepToolDescriptor,
  artifactCreateToolDescriptor,
];

export class LocalWorkspaceProvider implements WorkspaceProvider {
  constructor(private readonly defaultExecutionTarget: ExecutionTargetKind = 'server-local') {}

  resolve(context: ChannelContext, args: {
    cwd: string;
    sessionId?: string;
    workspaceId?: string;
    sandboxScopeId?: string;
    mountSubPath?: string;
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
      sandboxScopeId: args.sandboxScopeId,
      mountSubPath: args.mountSubPath,
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
          const content = await this._readFile(workspace, args.path, { offset: args.offset, limit: args.limit });
          return { status: 'success', content };
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
        case 'List': {
          const args = input as { path: string; recursive: boolean };
          const content = await this._listFiles(workspace, args.path, args.recursive);
          return { status: 'success', content };
        }
        case 'Shell': {
          const args = input as { command: string; timeoutMs?: number };
          const content = await this._runShell(workspace, args.command, args.timeoutMs, signal, context.invocationId);
          return { status: 'success', content };
        }
        case 'Edit': {
          const result = await runWorkspaceEdit(input as Parameters<typeof runWorkspaceEdit>[0], workspace, (fullPath) => assertSandboxReadAllowed(workspace, fullPath));
          return { status: 'success', content: result.content };
        }
        case 'Glob': {
          const result = await runWorkspaceGlob(input as Parameters<typeof runWorkspaceGlob>[0], workspace, (fullPath) => assertSandboxReadAllowed(workspace, fullPath));
          return { status: 'success', content: result.content };
        }
        case 'Grep': {
          const result = await runWorkspaceGrep(input as Parameters<typeof runWorkspaceGrep>[0], workspace, (fullPath) => assertSandboxReadAllowed(workspace, fullPath));
          return { status: 'success', content: result.content };
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
    this._runShellStreaming(workspace, args.command, args.timeoutMs, signal, (chunk) => { queue.push(chunk); wake(); }, request.context.invocationId)
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
  ): Promise<string> {
    const fullPath = resolveWorkspacePath(workspace.root, path);
    assertSandboxReadAllowed(workspace, fullPath);
    const fileStat = await stat(fullPath);
    if (!fileStat.isFile()) throw new Error(`Read: path is not a file (${path})`);
    const relPath = relativeWorkspacePath(workspace.root, fullPath);
    if (options.offset !== undefined || options.limit !== undefined) {
      return await readLineRange(fullPath, relPath, {
        offset: options.offset ?? 1,
        limit: options.limit ?? MAX_READ_LINES,
      });
    }
    if (fileStat.size <= MAX_FILE_BYTES) {
      const handle = await open(fullPath, 'r');
      try {
        const buffer = Buffer.alloc(fileStat.size);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return buffer.toString('utf-8', 0, bytesRead);
      } finally {
        await handle.close();
      }
    }
    const prefix = await readFilePrefix(fullPath, MAX_FILE_BYTES);
    return `${prefix}\n...[truncated: file ${relPath} is ${fileStat.size} bytes; showing first ${MAX_FILE_BYTES} bytes. Use Read with {"path":"${relPath}","offset":1,"limit":${MAX_READ_LINES}} to continue by line chunks.]`;
  }

  private async _writeFile(workspace: WorkspaceRef, path: string, content: string): Promise<string> {
    const fullPath = resolveWorkspacePath(workspace.root, path);
    assertSandboxReadAllowed(workspace, fullPath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, 'utf-8');
    return relativeWorkspacePath(workspace.root, fullPath);
  }

  private async _listFiles(workspace: WorkspaceRef, dir: string, recursive: boolean): Promise<string> {
    const root = resolveWorkspacePath(workspace.root, dir || '.');
    assertSandboxReadAllowed(workspace, root);
    const results: string[] = [];

    const walk = async (current: string): Promise<void> => {
      if (results.length >= MAX_LIST_ENTRIES) return;
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const full = resolve(current, entry.name);
        results.push(`${entry.isDirectory() ? 'dir ' : 'file'} ${relativeWorkspacePath(workspace.root, full)}`);
        if (recursive && entry.isDirectory()) await walk(full);
        if (results.length >= MAX_LIST_ENTRIES) break;
      }
    };

    await walk(root);
    const suffix = results.length >= MAX_LIST_ENTRIES ? `\n...[truncated at ${MAX_LIST_ENTRIES} entries]` : '';
    return results.join('\n') + suffix;
  }

  private async _runShell(
    workspace: WorkspaceRef,
    command: string,
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined,
    invocationId?: string,
  ): Promise<string> {
    const response = await this._runShellStreaming(workspace, command, timeoutMs, signal, undefined, invocationId);
    if (response.status === 'error') throw new Error(response.error);
    return response.content;
  }

  private async _runShellStreaming(
    workspace: WorkspaceRef,
    command: string,
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined,
    onChunk?: (chunk: import('../runtime/handProtocol.js').ToolInvocationStreamChunk) => void | Promise<void>,
    invocationId?: string,
  ): Promise<ToolInvocationResponse> {
    return await new Promise<ToolInvocationResponse>((resolvePromise) => {
      const deniedPath = findDeniedPathMention(workspace, command);
      if (deniedPath) {
        resolvePromise({
          status: 'error',
          error: `server-local sandbox denied command referencing protected path: ${deniedPath}`,
          metadata: { sandboxDenied: true, path: deniedPath },
        });
        return;
      }
      // P4 防御纵深：spawn 子进程 env 走 envBuilder（按 workspace.tenantId 隔离敏感凭据）。
      // envBuilder 未注入时（旧测试 / 内部直调 ServerLocalExecutionProvider）保持 process.env
      // 旧行为，避免破坏向后兼容；生产路径通过 createDefaultExecutionTransportRegistry({ envBuilder })
      // 在 app/runtime.ts 装配时强制注入。
      const childEnv = this.envBuilder
        ? this.envBuilder(workspace)
        : (process.env as Record<string, string>);
      const child = spawn(command, {
        cwd: workspace.root,
        env: childEnv,
        shell: true,
        detached: process.platform !== 'win32',
      });
      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let streamedBytes = 0;
      let streamSuppressed = false;
      let outputExceeded = false;
      const startedAt = Date.now();
      let settled = false;
      let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
      let killStarted = false;
      const finish = (response: ToolInvocationResponse) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          if (sigkillTimer) clearTimeout(sigkillTimer);
          resolvePromise(response);
        }
      };
      const killWithSignal = (signalName: NodeJS.Signals) => {
        if (child.pid && process.platform !== 'win32') {
          try { process.kill(-child.pid, signalName); return; } catch { /* fallback below */ }
        }
        if (!child.killed) child.kill(signalName);
      };
      const kill = () => {
        if (killStarted) return;
        killStarted = true;
        killWithSignal('SIGTERM');
        sigkillTimer = setTimeout(() => {
          if (!settled) killWithSignal('SIGKILL');
        }, 2_000);
        sigkillTimer.unref();
      };
      const onAbort = () => { kill(); finish({ status: 'error', error: 'Shell aborted', metadata: { aborted: true } }); };
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => { kill(); finish({ status: 'error', error: `Shell timed out after ${timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS}ms`, metadata: { timedOut: true } }); }, timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS);
      timer.unref?.();
      const emitStreamChunk = (channel: 'stdout' | 'stderr', text: string, chunkBytes: number) => {
        if (!onChunk || streamSuppressed) return;
        const remainingBytes = MAX_SHELL_STREAM_BYTES - streamedBytes;
        if (remainingBytes <= 0) {
          streamSuppressed = true;
          void onChunk({ type: 'progress', message: `Shell stream output truncated after ${MAX_SHELL_STREAM_BYTES} bytes; final result keeps a head/tail summary.` });
          return;
        }
        if (chunkBytes <= remainingBytes) {
          streamedBytes += chunkBytes;
          void onChunk({ type: 'output', channel, content: text });
          return;
        }
        streamedBytes = MAX_SHELL_STREAM_BYTES;
        streamSuppressed = true;
        void onChunk({ type: 'output', channel, content: text.slice(0, remainingBytes) });
        void onChunk({ type: 'progress', message: `Shell stream output truncated after ${MAX_SHELL_STREAM_BYTES} bytes; final result keeps a head/tail summary.` });
      };
      const emit = (channel: 'stdout' | 'stderr', chunk: Buffer) => {
        if (settled || outputExceeded) return;
        const text = chunk.toString('utf-8');
        if (channel === 'stdout') { stdoutBytes += chunk.length; stdout += text; } else { stderrBytes += chunk.length; stderr += text; }
        if (stdoutBytes + stderrBytes > MAX_SHELL_CAPTURE_BYTES) {
          outputExceeded = true;
          kill();
          void onChunk?.({ type: 'progress', message: `Shell output exceeded hard capture limit ${MAX_SHELL_CAPTURE_BYTES} bytes; terminating command.` });
          return;
        }
        emitStreamChunk(channel, text, chunk.length);
      };
      child.stdout?.on('data', (chunk: Buffer) => emit('stdout', chunk));
      child.stderr?.on('data', (chunk: Buffer) => emit('stderr', chunk));
      child.on('error', (err: Error) => finish({ status: 'error', error: err.message }));
      child.on('close', async (code: number | null, sig: NodeJS.Signals | null) => {
        signal?.removeEventListener('abort', onAbort);
        const durationMs = Date.now() - startedAt;
        let outputFiles: import('./toolOutput.js').ShellOutputFileRef[] = [];
        let outputFileError: string | undefined;
        try {
          outputFiles = await persistShellOutputFiles({
            workspaceRoot: workspace.root,
            invocationId,
            stdout,
            stderr,
          });
        } catch (err) {
          outputFileError = err instanceof Error ? err.message : String(err);
        }
        const content = formatShellOutput({
          stdout,
          stderr,
          stdoutBytes,
          stderrBytes,
          exitCode: code,
          signal: sig,
          durationMs,
          captureLimitExceeded: outputExceeded,
          outputFiles,
          outputFileError,
        });
        const metadata = {
          exitCode: code,
          signal: sig,
          stdoutBytes,
          stderrBytes,
          durationMs,
          ...(outputFiles.length > 0 ? { outputFiles } : {}),
          ...(outputFileError ? { outputFileError } : {}),
          ...(outputExceeded ? { outputExceeded: true } : {}),
        };
        if (outputExceeded) {
          finish({ status: 'error', error: `Shell output exceeded hard capture limit ${MAX_SHELL_CAPTURE_BYTES} bytes\n\n${content}`, metadata });
          return;
        }
        finish(code === 0
          ? { status: 'success', content, metadata }
          : { status: 'error', error: `command exited ${code ?? sig}\n\n${content}`, metadata });
      });
    });
  }
}

async function readFilePrefix(fullPath: string, maxBytes: number): Promise<string> {
  const handle = await open(fullPath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.toString('utf-8', 0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function readLineRange(
  fullPath: string,
  relPath: string,
  options: { offset: number; limit: number },
): Promise<string> {
  const offset = Math.max(1, Math.trunc(options.offset));
  const limit = Math.min(MAX_READ_LINES, Math.max(1, Math.trunc(options.limit)));
  const stream = createReadStream(fullPath, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  const lines: string[] = [];
  let lineNo = 0;
  let hasMore = false;
  let returnedBytes = 0;
  let byteLimitReached = false;
  // 为说明性 suffix 预留空间，保证最终 tool_result 仍落在硬上限内。
  const contentByteBudget = MAX_READ_OUTPUT_BYTES - 512;
  try {
    for await (const line of rl) {
      lineNo += 1;
      if (lineNo < offset) continue;
      if (lines.length >= limit) {
        hasMore = true;
        break;
      }
      const separatorBytes = lines.length > 0 ? 1 : 0;
      const remainingBytes = contentByteBudget - returnedBytes - separatorBytes;
      if (remainingBytes <= 0) {
        hasMore = true;
        byteLimitReached = true;
        break;
      }
      const bounded = truncateUtf8Prefix(line, remainingBytes);
      lines.push(bounded.text);
      returnedBytes += separatorBytes + Buffer.byteLength(bounded.text, 'utf8');
      if (bounded.truncated) {
        hasMore = true;
        byteLimitReached = true;
        break;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  if (lines.length === 0) {
    return `...[no content: offset ${offset} is beyond EOF for ${relPath}; total lines=${lineNo}]`;
  }
  const endLine = offset + lines.length - 1;
  const suffix = byteLimitReached
    ? `\n...[truncated: Read output reached ${MAX_READ_OUTPUT_BYTES} UTF-8 bytes while showing ${relPath} lines ${offset}-${endLine}; narrow the line range or use Search/Shell for targeted inspection]`
    : hasMore
      ? `\n...[truncated: showing ${relPath} lines ${offset}-${endLine}; next Read offset=${endLine + 1}, limit=${limit}]`
    : `\n...[EOF: showing ${relPath} lines ${offset}-${endLine}; total lines=${lineNo}]`;
  return `${lines.join('\n')}${suffix}`;
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
    const workspaceTools = this.artifactService
      ? WORKSPACE_HAND_TOOLS
      : WORKSPACE_HAND_TOOLS.filter((tool) => tool.id !== artifactCreateToolDescriptor.id);
    return [waitForWorkspaceReadyToolDescriptor, ...workspaceTools];
  }

  async invoke<TInput>(call: AuthorizedToolCall<TInput>, context: ToolCallContext): Promise<ToolResult | undefined> {
    if (call.toolId === waitForWorkspaceReadyToolDescriptor.id) {
      const input = waitForWorkspaceReadyToolDescriptor.schema.parse(call.input) as { timeoutMs?: number };
      return await this.waitForWorkspaceReady(context, input.timeoutMs ?? 15_000);
    }

    const descriptor = WORKSPACE_HAND_TOOLS.find((tool) => tool.id === call.toolId);
    if (!descriptor) return undefined;
    if (call.toolId === artifactCreateToolDescriptor.id && !this.artifactService) {
      throw new Error('CreateArtifact: artifact service is not configured.');
    }

    // brain 侧授权 / 角色 gate（hand 端不感知）。Shell 的最终放行需要先
    // 解析当前默认 hand，因为组织 agent 是否能执行 shell 取决于**执行环境是否隔离**，
    // 而不是只取决于用户角色。
    if (descriptor.risk === 'workspace_write' && !call.authorization?.approved) {
      throw new Error(`Tool ${call.toolId} requires prior authorization.`);
    }

    // 解析入参用 hand 端公示的 schema（校验 + 应用 default）
    let parsedInput: unknown = parseToolInput(descriptor, call.input);
    // 普通 workspace 工具不接受 handId 参数。当前 hand 由 harness/session 状态决定；
    // 后续如果需要切换 hand，应通过专门的 hand-switch 工具改变会话默认值。
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
    let reservedTaskId: string | undefined;
    if (isBackgroundShellStart) {
      if (!this.backgroundTasks) throw new Error('Shell(mode=background) 需要 PG durable background runtime。');
      const reservation = await this.backgroundTasks.reserveCommand(context, {
        command: shellInput.command,
        timeoutMs: shellInput.timeoutMs ?? DEFAULT_BACKGROUND_SHELL_TIMEOUT_MS,
      });
      reservedTaskId = reservation.taskId;
      parsedInput = { ...shellInput, taskId: reservation.taskId };
    }

    const request = {
      toolName: call.toolId,
      input: parsedInput,
      context: {
        ...(context.invocationId ? { invocationId: context.invocationId } : {}),
        ...(handId ? { handId } : {}),
        workspace: workspaceForHand,
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
      response = routed.transport.invokeStream && call.toolId === 'Shell' && !isBackgroundShellStart && context.invocationId
        ? await consumeToolStream(routed.transport.invokeStream(request), context.onStreamChunk)
        : await routed.transport.invoke(request);
    } catch (err) {
      if (reservedTaskId && this.backgroundTasks) {
        await killReservedBackgroundShell();
        await this.backgroundTasks.failCommandStart(
          context,
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
        await this.backgroundTasks.failCommandStart(context, reservedTaskId, response.error).catch(() => undefined);
      }
      throw new Error(response.error);
    }
    if (reservedTaskId && this.backgroundTasks) {
      try {
        await this.backgroundTasks.activateCommand(context, reservedTaskId);
      } catch (err) {
        await killReservedBackgroundShell();
        await this.backgroundTasks.failCommandStart(
          context,
          reservedTaskId,
          err instanceof Error ? err.message : String(err),
        ).catch(() => undefined);
        throw err;
      }
    }
    this.notifyMemoryIndexIfNeeded(call.toolId, parsedInput, workspaceForHand, response);
    if (call.toolId === artifactCreateToolDescriptor.id) {
      const artifact = await this.createArtifactFromHandResponse(response, context, call.input);
      const fileName = typeof artifact.metadata?.fileName === 'string' ? artifact.metadata.fileName : undefined;
      const sourcePath = typeof artifact.metadata?.sourcePath === 'string' ? artifact.metadata.sourcePath : undefined;
      return {
        content: JSON.stringify({
          artifactId: artifact.artifactId,
          kind: artifact.kind,
          ...(fileName ? { fileName } : {}),
          ...(sourcePath ? { sourcePath } : {}),
          sizeBytes: artifact.sizeBytes,
          sha256: artifact.sha256,
          mimeType: artifact.mimeType,
          userVisible: false,
          ...(sourcePath ? { fileCardMarker: `[FILE]${JSON.stringify({ filePath: sourcePath })}[/FILE]` } : {}),
          deliveryInstruction: sourcePath
            ? 'This artifact has been registered but is not automatically shown to the user. To show it to the user, include fileCardMarker exactly in your final answer.'
            : 'This artifact has been registered but is not automatically shown to the user.',
        }, null, 2),
      };
    }
    return { content: response.content };
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

  /**
   * B2: 自动选择当前 session 内"唯一" ready 的 tenant remote hand。条件：
   * HandStore 存在 + session 内仅 1 个 ready 状态、type=server-remote 且
   * metadata.tenantRemoteHandId 存在的 hand。多于 1 个或 0 个时返回 undefined
   *（保持原默认 transport 行为）。
   *
   * 如果当前 session 已经挂了 tenant remote hand 但尚未 ready，则 fail closed。
   * 这避免 ACS/NAS 还在启动时误回退到 server-local/server-container 读写错执行面。
   */
  private async resolveTenantHandRoute(context: ToolCallContext): Promise<
    | { kind: 'none' }
    | { kind: 'ready'; handId: string }
    | { kind: 'blocked'; message: string }
  > {
    if (!this.handStore) return { kind: 'none' };
    const sessionId = context.sessionId ?? context.workspace.sessionId;
    if (!sessionId) return { kind: 'none' };
    try {
      const hands = await this.handStore.listBySession(sessionId);
      const readyHandId = pickSoleReadyTenantHandId(hands);
      if (readyHandId) return { kind: 'ready', handId: readyHandId };
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
      const readyHandId = pickSoleReadyTenantHandId(lastHands);
      if (readyHandId) {
        const hand = tenantHands.find((candidate) => candidate.handId === readyHandId);
        return workspaceReadyStatusResponse({
          status: 'ready',
          workspaceId: hand?.workspaceId,
          executionTarget: hand?.type ?? 'server-remote',
          message: 'Current workspace runtime is ready. Workspace tools can now be used.',
        });
      }
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
      if (hand.type === 'server-remote' && hand.endpoint) {
        const authToken = await this.resolveHandAuthToken?.(hand) ?? resolveRemoteHandAuthToken(hand.metadata);
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

function resolveRemoteHandAuthToken(metadata: Record<string, unknown>): string | undefined {
  const value = metadata.serverRemoteAuthToken ?? metadata.authToken;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function resolveRemoteHandInvokeTimeoutMs(metadata: Record<string, unknown>): number | undefined {
  const value = metadata.invokeTimeoutMs ?? metadata.serverRemoteInvokeTimeoutMs;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
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
      if (result) return result;
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
  return byId !== false && byName !== false;
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

function parseToolInput<TInput>(descriptor: ToolDescriptor<TInput>, input: unknown): TInput {
  return descriptor.schema.parse(input) as TInput;
}

export { hasMemorySearchTool } from './memorySearchToolProvider.js';

function isInside(baseDir: string, candidate: string): boolean {
  const rel = relative(baseDir, candidate);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

function resolveWorkspacePath(cwd: string, inputPath: string): string {
  const fullPath = isAbsolute(inputPath) ? resolve(inputPath) : resolve(cwd, inputPath);
  if (!isInside(cwd, fullPath)) {
    throw new Error(`Access denied: path outside workspace (${inputPath})`);
  }
  return fullPath;
}

function relativeWorkspacePath(cwd: string, fullPath: string): string {
  const rel = relative(cwd, fullPath);
  return (rel || '.').replace(/\\/g, '/');
}

function memoryPathFromSuccessfulTool(
  toolId: string,
  input: unknown,
  workspace: WorkspaceRef,
  response: Extract<ToolInvocationResponse, { status: 'success' }>,
): string | null {
  if (toolId !== 'Write' && toolId !== 'Edit') return null;
  const metadataPath = typeof response.metadata?.path === 'string'
    ? response.metadata.path
    : undefined;
  const inputPath = input && typeof input === 'object'
    ? (input as { path?: unknown; file_path?: unknown }).path ?? (input as { file_path?: unknown }).file_path
    : undefined;
  const candidate = metadataPath ?? (typeof inputPath === 'string' ? inputPath : undefined);
  if (!candidate) return null;
  const relPath = normalizeWorkspaceRelativePath(workspace.root, candidate);
  return relPath && isMemorySourcePath(relPath) ? relPath : null;
}

function normalizeWorkspaceRelativePath(workspaceRoot: string, candidate: string): string | null {
  try {
    const fullPath = isAbsolute(candidate)
      ? resolve(candidate)
      : resolve(workspaceRoot, candidate);
    if (!isInside(workspaceRoot, fullPath)) return null;
    return relativeWorkspacePath(workspaceRoot, fullPath);
  } catch {
    return null;
  }
}

function isMemorySourcePath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/');
  return normalized === 'MEMORY.md'
    || (normalized.startsWith('memory/') && normalized.endsWith('.md'));
}

function shellCommandMentionsMemoryPath(command: string): boolean {
  return /(^|[\s"'`=;:&|(<])(?:\.\/)?MEMORY\.md($|[\s"'`);:&|>])/.test(command)
    || /(^|[\s"'`=;:&|(<])(?:\.\/)?memory\/[^"'`\s;&|<>]*\.md($|[\s"'`);:&|>])/.test(command)
    || /\/MEMORY\.md($|[\s"'`);:&|>])/.test(command)
    || /\/memory\/[^"'`\s;&|<>]*\.md($|[\s"'`);:&|>])/.test(command);
}

function workspaceRelativeInputPath(cwd: string, inputPath: string): string {
  const fullPath = resolveWorkspacePath(cwd, inputPath);
  return relativeWorkspacePath(cwd, fullPath);
}

export function isExecutionTargetKind(value: unknown): value is ExecutionTargetKind {
  return value === 'server-local'
    || value === 'server-container'
    || value === 'server-remote'
    || value === 'client';
}


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
