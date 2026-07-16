import { randomUUID } from 'crypto';
import { mkdir } from 'fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'path';

import type {
  AgentRunDispatch,
  AgentRunHooks,
  AgentRunOptions,
  InteractionResponse,
  ToolApprovalPolicyOptions,
} from '../agent/types.js';
import type { AgentStore } from '../data/agents/store.js';
import type { OrgAgentStore } from '../data/orgAgents/store.js';
import type { OrgAgentRecord } from '../data/orgAgents/types.js';
import type { BillingService } from '../data/billing/service.js';
import type { TenantStore } from '../data/tenants/store.js';
import type { TokenUsageStore } from '../data/usage/store.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { resolveAzerothInjection } from '../integrations/azeroth/tokens.js';
import type { WorkspaceRef } from '../agent/toolRuntime.js';
import { readTenantCompanyInfoSync } from '../data/tenants/companyInfo.js';
import { getTranscriptPath } from '../data/transcripts/store.js';
import type { MemoryIndexService } from '../memory/index/service.js';
import type { UserOverrides } from '../security/extraDirs.js';
import type { DispatchConfig } from '../app/config.js';
import type { ArtifactService } from './artifactService.js';
import type { ChannelContext, InboundMessage, ModelProviderOptions, OutboundEvent } from '../types/index.js';
import { loadMemoryContext, loadPersona } from '../agent/memory.js';
import { buildPrompt, isCompactCommand } from '../agent/prompt.js';
import {
  createDefaultExecutionTransportRegistry,
  hasMemorySearchTool,
  isToolEnabled,
  LocalWorkspaceProvider,
  PlatformToolRuntime,
  type ExecutionTargetKind,
  type ToolDescriptor,
} from '../agent/toolRuntime.js';
import {
  SkillToolProvider,
  type EffectiveSkillsResolver,
  type SkillEntry,
} from '../agent/skillToolProvider.js';
import { createBuiltinTools, type BuiltinToolsConfig } from '../agent/builtinTools.js';
import { WebToolProvider, type ResolvedWebToolsConfig } from '../agent/webToolProvider.js';
import {
  ImageGenToolProvider,
  listAvailableImageGenEngineIds,
  type ResolvedImageGenToolsConfig,
} from '../agent/imageGenToolProvider.js';
import { CronToolProvider } from '../agent/cronToolProvider.js';
import { TenantCompanyInfoToolProvider } from '../agent/tenantCompanyInfoToolProvider.js';
import { UserActivityToolProvider } from '../agent/userActivityToolProvider.js';
import type { UserActivityService } from './userActivityService.js';
import { applyToolProfile, normalizeToolProfile } from './toolProfiles.js';
import { McpClientToolProvider } from '../mcp/clientToolProvider.js';
import type { McpClientManager } from '../mcp/clientManager.js';
import type { McpProxy } from '../mcp/proxy.js';
import type { ToolProvider } from '../agent/toolRuntime.js';
import type { ExecutionTransportRegistry } from './executionTransport.js';
import { EventBackedApprovalStore } from './approvalStore.js';
import { ChatCompletionsModelAdapter } from './chatCompletionsAdapter.js';
import { ResponsesApiAdapter } from './responsesApiAdapter.js';
import type { ModelAdapter } from './types.js';
import {
  createExecutionConfig,
  resolveExecutionTarget,
  type ExecutionConfig,
} from './executionConfig.js';
import { FileEventStore, getRuntimeEventLogPath } from './fileEventStore.js';
import { HttpTransport } from './httpTransport.js';
import { LegacyTranscriptProjection } from './legacyTranscriptProjection.js';
import { createLogger } from '../utils/logger.js';
import { getRequestContext, requestContextStorage } from '../utils/requestContext.js';
import { RawAgentLoop } from './rawAgentLoop.js';
import { modelSupportsImage, resolveInboundAttachments } from './imageAttachments.js';
import {
  analyzeImagesWithFallback,
  type ImageUnderstandingModelConfig,
} from './imageUnderstanding.js';

const logger = createLogger('RawRuntime');

/**
 * 把 sessionId + runId 合并进当前 AsyncLocalStorage 请求上下文,
 * 后续所有 logger 调用自动附加 (runId13/sess8) trace 前缀。
 *
 * 必须传入真实 runId：enqueue-only 异步路径（chat 主流）绕过外层
 * dispatch wrapper,此时 prev 为 undefined; 若 runId 兜底成 randomUUID,
 * 与 EventStore 里记录的真实 runId 不一致,运维跨日志聚合时找不到。
 *
 * 调用约定：三个 raw runtime 入口必须在自己生成完 runId 之后再调,
 * 而不是 sessionId 一确定就调。
 */
function enterSessionContext(sessionId: string, runId: string): void {
  const prev = getRequestContext();
  requestContextStorage.enterWith({
    ...(prev ?? {}),
    runId,
    sessionId,
  });
}
import type { ContextReconstructionPolicy } from './contextProjection.js';
import { SessionContextService, SessionToolProvider } from './sessionContext.js';
import { buildRuntimeReplayState, type RuntimeReplayState } from './replay.js';
import {
  createRuntimeSessionRecord,
  FileSessionCatalog,
  type RuntimeSessionRecord,
  type SessionCatalog,
} from './sessionCatalog.js';
import type { ApprovalRecord, ApprovalStore, EventStore, ModelAttachmentRef, PlatformEvent } from './types.js';
import type { RunRecord, RunStatus, RunStore } from './runStore.js';
import { HandManager } from './handManager.js';
import type { HandCapability, HandRecord, HandStore, WorkspaceRecipe } from './handStore.js';
import {
  createTenantRemoteHandAuthTokenResolver,
  selectTenantRemoteHandsForRegistration,
  type TenantRemoteHandAuthTokenResolver,
} from './tenantRemoteHandResolver.js';
import type { SecretVault } from '../security/secretVault.js';
import type { NetworkPolicyConfig } from './networkPolicy.js';
import { runtimeRunController } from './runController.js';
import { waitAcquireSessionLock } from './autoCompaction.js';
import type { ToolInvocationStore } from './toolInvocationStore.js';
import {
  buildPendingInteractionsFromEvents,
  getInteractionResolution,
  normalizeInteractionResponse,
} from './interactionProjection.js';
import { loadAndRenderPrompt, loadPrompt, type PromptVars } from './promptRenderer.js';
import {
  DEFAULT_SANDBOX_DENY_READ,
  expandSandboxPaths,
  type SandboxExpandContext,
} from '../engine/sandbox.js';
import { getAgentTranscriptDir } from '../data/transcripts/projectKey.js';
import { deriveStableWorkspaceId } from './workspaceIdentity.js';
// 注意：subagent/agentToolProvider.js 反向 import 本文件的装配小件（ESM 循环依赖，
// 仅函数级引用、无模块求值期访问，安全）。
import { AgentToolProvider } from './subagent/agentToolProvider.js';

export interface ServerRemoteDispatchConfig {
  baseUrl: string;
  authToken: string;
  invokeTimeoutMs?: number;
  recipe?: Partial<WorkspaceRecipe>;
}

/**
 * Session-level mutual exclusion handle 接口。
 * `PgSessionLock` 是 PG advisory lock 的默认实现，但 dispatch 层不直接依赖该
 * 实现 — 任何提供 `tryAcquire(sessionId) → handle | null`、`handle.release()`
 * 的对象都可以注入。null 表示锁已被其他持有者占用（dispatch 退让）。
 */
export interface SessionLockHandle {
  release(): Promise<void>;
}

export interface SessionLockAcquirer {
  tryAcquire(sessionId: string): Promise<SessionLockHandle | null>;
}

const DEFAULT_MODEL = 'gpt-5.4-mini';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/**
 * RFC v1 P0.2：按 modelProviderOptions.protocol 路由 ModelAdapter。
 * - protocol="responses" → ResponsesApiAdapter（火山 /responses 端点，previous_response_id 接力）
 * - 其它（含 undefined） → ChatCompletionsModelAdapter（保留默认行为）
 *
 * 启动时静态决定，运行时不切换；config 改回 chat_completions 即回滚。
 */
export function createModelAdapterForProtocol(
  connection: { apiKey: string; baseUrl: string },
  modelProviderOptions: ModelProviderOptions | undefined,
): ModelAdapter {
  if (modelProviderOptions?.protocol === 'responses') {
    return new ResponsesApiAdapter(connection, modelProviderOptions);
  }
  return new ChatCompletionsModelAdapter(connection, modelProviderOptions ?? {});
}

export function resolveRuntimeModelOptions(
  config: Pick<RawRuntimeRunDispatchConfig, 'modelResolver'>,
  requestedModel: string | undefined,
  explicitConnection?: { apiKey?: string; baseUrl?: string },
  explicitProviderOptions?: ModelProviderOptions,
): { model: string; modelConnection?: { apiKey?: string; baseUrl?: string }; modelProviderOptions?: ModelProviderOptions } {
  if (explicitConnection) {
    return {
      model: requestedModel || DEFAULT_MODEL,
      modelConnection: explicitConnection,
      ...(explicitProviderOptions ? { modelProviderOptions: explicitProviderOptions } : {}),
    };
  }
  if (requestedModel && config.modelResolver) {
    const resolved = config.modelResolver(requestedModel);
    if (resolved) {
      return {
        model: resolved.model,
        ...(resolved.connection ? { modelConnection: resolved.connection } : {}),
        ...(resolved.providerOptions ? { modelProviderOptions: resolved.providerOptions } : {}),
      };
    }
  }
  return { model: requestedModel || DEFAULT_MODEL };
}

/**
 * Skills wiring：dispatch 不知道 SkillConfigStore，只知道"给我 username/skill 名字，
 * 我返回有效 skill 集合或物理路径"。runtime.ts 在装配时把 SkillConfigStore + sharedDir
 * 缝进来。
 */
export interface SkillsDispatchConfig {
  /** requiredSkillIds 由专职 Agent 提供，是独立于成员个人勾选的固有能力。 */
  listForUser(username: string | undefined, requiredSkillIds?: readonly string[]): SkillEntry[];
  resolveSkillDir(username: string | undefined, skill: string, requiredSkillIds?: readonly string[]): string | null;
}

export interface RawRuntimeRunDispatchConfig {
  agentCwd: string;
  /**
   * `workspace-shared` 绝对路径。`buildInstructions()` 从 `${sharedDir}/prompts/*.md`
   * 加载 system prompt 片段；同时 `${sharedDir}/tenants/<tenantId>/company.md` 作为 `{{COMPANY_INFO}}` 注入。
   */
  sharedDir: string;
  memory?: { enabled?: boolean; maxLines?: number };
  memoryIndexService?: MemoryIndexService | null;
  agentStore?: AgentStore;
  /** 公司级专职 Agent store。orgAgentId 会话解析限定提示语 + skill 白名单用；未配置时 orgAgentId 会话 fail-closed。 */
  orgAgentStore?: OrgAgentStore;
  tenantStore?: TenantStore;
  resolveUserRole?: (identity: { userId?: string; username?: string }) => 'admin' | 'user' | undefined;
  /** Resolve the account profile full name for scheduler wake identity injection. */
  resolveUserRealName?: (identity: { userId?: string; username?: string }) => string | undefined;
  /** Default raw loop turn budget when a run does not specify maxTurns. */
  defaultMaxTurns?: number;
  /** Optional per-user cap; applied even when scheduler wake bypasses engine/dispatch. */
  resolveUserMaxTurns?: (identity: { userId?: string; username?: string }) => number | undefined;
  /**
   * B1: Resolve the requesting user's `tenantId` from `userStore.findById/Username`.
   * Used by `ensureRuntimeHandRegistered` to evaluate `tenantRemoteHand.tenantIds`
   * auto-attach policy. Return `undefined` when the user has no tenant assignment.
   */
  resolveUserTenantId?: (identity: { userId?: string; username?: string }) => string | undefined;
  userOverrides?: UserOverrides;
  /** Raw runtime server-local host-path guard uses dispatch.sandbox denyRead templates. */
  dispatch?: Pick<DispatchConfig, 'sandbox'>;
  /** Skills L1 注入 + Skill 工具的来源。未配置时 Skill 工具不挂载、instructions 不列 skill 名单。 */
  skills?: SkillsDispatchConfig;
  /** MCP client manager；未配置时 MCP 工具发现不接入。 */
  mcpClientManager?: McpClientManager;
  /** Capability-scoped MCP proxy；配置后 MCP 工具调用不直接触达 manager。 */
  mcpProxy?: McpProxy;
  /** 内置 brain-only 工具配置（TodoWrite/AskUserQuestion）。 */
  builtinTools?: BuiltinToolsConfig;
  /**
   * 定时任务服务惰性 getter（CronList/CronManage 内置工具）。cronRuntime 在
   * dispatch 构造之后才创建，因此传 getter 而非实例；返回 undefined 时工具不挂载。
   */
  cronService?: () => import('../cron/service.js').CronService | undefined;
  /**
   * 计费服务惰性 getter（子 agent spawn 前置 hard cap 检查，D6）。与 cronService
   * 同款惰性形态：billingService 在 app/runtime.ts 中晚于 dispatch config 可用。
   * 未配置时子 agent 跳过 billing 闸门（file backend / 测试场景）。
   */
  billingService?: () => BillingService | undefined;
  /**
   * Token 用量存储惰性 getter（子 agent 收尾 channel:'subagent' 独立记账，D7）。
   * tokenUsageStore 在 app/runtime.ts 中晚于 dispatch config 实例化，必须走惰性闭包。
   */
  tokenUsageStore?: () => TokenUsageStore | undefined;
  /** 当前模型不支持 image 输入时使用的独立图片理解模型链。 */
  getImageUnderstandingModelConfigs?: () => readonly ImageUnderstandingModelConfig[];
  /** 图片理解模型单次尝试超时；默认 30 秒。 */
  getImageUnderstandingTimeoutMs?: () => number | undefined;
  /** 平台级模型可见工具开关。 */
  toolControls?: import('../app/config.js').ToolControlsConfig;
  /** Platform-managed web access tools (`WebSearch` / `WebFetch`). */
  webTools?: ResolvedWebToolsConfig;
  /**
   * 平台托管生图工具（GenerateImage，2026-07-15）。API key 已在装配层经
   * secretVault 解析，只存在于 server 进程内——绝不进 sandbox env、绝不上 wire。
   */
  imageGenTools?: ResolvedImageGenToolsConfig;
  /**
   * 平台计费事件直写入口（metered_tool_usage 等）。PG runtime 注入
   * pgEventStore.append；file backend / 测试不配置时按次扣费静默跳过。
   */
  appendPlatformEvent?: (
    event: import('./types.js').PlatformEventInput,
    ctx?: import('./types.js').EventAppendContext,
  ) => Promise<unknown>;
  /**
   * 用户活动聚合服务（2026-07-14 记忆轮询批次）。配置后挂载 UserActivityList
   * safe 只读工具；未配置（file backend / 测试）时工具不挂载。
   */
  userActivityService?: UserActivityService;
  /** Artifact service used by hand-backed CreateArtifact. */
  artifactService?: ArtifactService;
  /**
   * 自动上下文压缩（/compact v2）。配置后：post-run 超阈值 enqueue 压缩 run；
   * 用户消息抢锁失败时抢占进行中的自动压缩；自动压缩 wake 时向排队用户消息让路。
   */
  autoCompaction?: import('./autoCompaction.js').AutoCompactionService;
  /**
   * @deprecated 使用 executionConfig.defaultTarget。
   * 旧字段仍接受，当 executionConfig 未传时作为 default 兜底，避免破坏调用方。
   */
  executionTarget?: ExecutionTargetKind;
  /** Runtime-level execution config；未传则使用 DEFAULT_EXECUTION_CONFIG */
  executionConfig?: ExecutionConfig;
  /**
   * Resolve UI model refs (group/model) into provider model names and connection settings.
   * 可选第二参 tenantId：传入时按该组织的模型白名单校验（子 agent 的 model 参数
   * 必须显式传父 tenantId 过白名单——dispatch 主路径的调用点历史上只传 ref，
   * app 装配的闭包对 undefined tenantId 走「不加组织过滤」的旧行为，保持兼容）。
   */
  modelResolver?: (ref: string, tenantId?: string) => {
    model: string;
    connection?: { apiKey?: string; baseUrl?: string };
    providerOptions?: ModelProviderOptions;
  } | null;
  executionTransportRegistry?: ExecutionTransportRegistry;
  sessionCatalog?: SessionCatalog;
  eventStoreFactory?: (session: RuntimeSessionRecord) => EventStore;
  approvalStoreFactory?: (session: RuntimeSessionRecord, eventStore: EventStore) => ApprovalStore;
  /** Durable run state backend. PG runtime wires PgRunStore here for P0 wake/recovery state. */
  runStore?: RunStore;
  /** Durable hand registry backend. PG runtime wires PgHandStore here for P1 hand lifecycle. */
  handStore?: HandStore;
  /** Durable tool invocation index. PG runtime wires PgToolInvocationStore for recovery. */
  toolInvocationStore?: ToolInvocationStore;
  /** Session-as-context projection policy. Defaults to full_replay inside RawAgentLoop. */
  contextPolicy?: ContextReconstructionPolicy;
  /**
   * Server-remote hand 配置。配置后会自动注册 `server-remote` transport，admin
   * 可通过 `executionTarget=server-remote` 切到远端 hand-server；未配置则该 target
   * 不在 registry 内，PlatformToolRuntime 调用会 throw "transport not registered"。
   */
  serverRemote?: ServerRemoteDispatchConfig;
  /**
   * Static tenant ECS / Docker hand appliances. These are session-attached as
   * server-remote hands so the harness can route workspace tools to the current
   * default hand while the platform remains source-of-truth for run/session/events.
   */
  tenantRemoteHands?: TenantRemoteHandsSource;
  /**
   * Optional SecretVault for resolving `tenantRemoteHands[].authTokenRef`.
   * Required when any tenant hand entry uses `authTokenRef` instead of inline
   * `authToken`. Tenant hand tokens flow through this vault with caller actor
   * `'system'`, so plaintext never lives in app config or HandStore metadata.
   */
  secretVault?: SecretVault;
  /**
   * Shared tenant remote hand auth token resolver. When omitted, the dispatch
   * builds one from `tenantRemoteHands` + `secretVault`; callers that want a
   * single resolver shared with cancel-delivery / scheduler should construct it
   * once and inject it here.
   */
  tenantRemoteHandResolver?: TenantRemoteHandAuthTokenResolver;
  /**
   * Session-level lock：dispatch 入口 tryAcquire(sessionId)，dispatch 退出
   * (success/error/abort) 时 release。未注入则不加锁（file backend / 单 brain
   * 场景）。PG backend 下注入 `PgSessionLock` 防止跨 brain 同 sessionId 并发。
   */
  sessionLock?: SessionLockAcquirer;
  /**
   * Wake-time workspace provisioner.
   *
   * `wakeRuntimeSession()` 在调用模型/工具之前调用这个回调，确保用户的物理
   * workspace 目录已就绪（PR 4 扁平→tenant 层 mkdir + 迁移、首次 skills 同步等）。
   *
   * 背景：Web 入站走 PR 8 enqueue-only → scheduler wake，**完全绕过**了
   * `engine/dispatch.ts` 那段 `ensureUserWorkspace` 调用。如果 wake 路径不补，
   * 新 tenant / 新用户首跑会因 `cwd` 物理目录不存在导致 hand-server spawn ENOENT。
   *
   * 实现由 `app/runtime.ts` 装配——内部用 userStore 查 user、resolveUserCwd
   * 算路径、调 ensureUserWorkspace。raw runtime 本身保持跟物理 workspace 解耦。
   *
   * 未配置时跳过 provisioning，适合 file backend / 测试 fixture 场景。
   */
  workspaceProvisioner?: (input: { userId?: string; username?: string }) => Promise<void>;
  logger?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

export interface TenantRemoteHandDispatchConfig {
  id: string;
  description?: string;
  /** Username allow-list (B1 legacy baseline). */
  users?: string[];
  /**
   * B1: Tenant identity allow-list. Attach when the requesting user's
   * `tenantId` matches any entry. `users` and `tenantIds` are independently
   * permissive: either set, attach if any matches. Omitting both = attach to
   * every authenticated user/session.
   */
  tenantIds?: string[];
  rollout?: {
    mode: 'disabled' | 'drain' | 'allowlist' | 'tenant' | 'all';
    userIds?: string[];
    usernames?: string[];
    tenantIds?: string[];
  };
  baseUrl: string;
  networkPolicy?: NetworkPolicyConfig;
  /**
   * Inline bearer token. Dev/staging only. Production should set `authTokenRef`
   * so the plaintext lives in a SecretVault instead of process config.
   */
  authToken?: string;
  /**
   * SecretVault ref id. Resolved at register/dispatch/cancel time via
   * `tenantRemoteHandResolver`. The ref id itself is safe to log.
   */
  authTokenRef?: string;
  invokeTimeoutMs?: number;
  recipe?: Partial<WorkspaceRecipe>;
}

export type TenantRemoteHandsSource =
  | TenantRemoteHandDispatchConfig[]
  | (() => TenantRemoteHandDispatchConfig[] | undefined);

export interface RawApprovalResumeRequest {
  approvalId: string;
  response: InteractionResponse;
  sessionId: string;
  transcriptPath?: string;
  cwd?: string;
  context: ChannelContext;
  model?: string;
  modelConnection?: { apiKey?: string; baseUrl?: string };
  modelProviderOptions?: ModelProviderOptions;
  executionTarget?: ExecutionTargetKind;
  approvalPolicy?: ToolApprovalPolicyOptions;
  /** run.metadata.toolProfile 恢复（wake 路径传入；resume 后维持受限工具集）。 */
  toolProfile?: 'memory_poll';
  hooks?: AgentRunHooks;
  abortController?: AbortController;
  maxTurns?: number;
  runtimeWorkerId?: string;
}

export interface RawInteractionResumeRequest {
  interactionId: string;
  response: InteractionResponse;
  sessionId: string;
  transcriptPath?: string;
  cwd?: string;
  context: ChannelContext;
  model?: string;
  modelConnection?: { apiKey?: string; baseUrl?: string };
  modelProviderOptions?: ModelProviderOptions;
  executionTarget?: ExecutionTargetKind;
  approvalPolicy?: ToolApprovalPolicyOptions;
  /** run.metadata.toolProfile 恢复（wake 路径传入；resume 后维持受限工具集）。 */
  toolProfile?: 'memory_poll';
  hooks?: AgentRunHooks;
  abortController?: AbortController;
  maxTurns?: number;
  runtimeWorkerId?: string;
}

export interface RawRuntimeWakeState {
  session: RuntimeSessionRecord;
  events: PlatformEvent[];
  approvals: ApprovalRecord[];
  replayState: RuntimeReplayState;
}

export interface RuntimeWakeLease {
  runId: string;
  workerId?: string;
  renew(): Promise<void>;
  release(finalStatus?: RunStatus, reason?: string): Promise<void>;
}

export interface WakeRuntimeSessionOptions {
  lease?: RuntimeWakeLease;
  renewIntervalMs?: number;
  onOutboundEvent?: (event: OutboundEvent, context: { runId: string; sessionId: string }) => void | Promise<void>;
}

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };


function normalizePositiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function resolveEffectiveMaxTurns(
  config: RawRuntimeRunDispatchConfig,
  requested: unknown,
  identity: { userId?: string; username?: string },
): number {
  const requestedMaxTurns = normalizePositiveInt(requested);
  const defaultMaxTurns = normalizePositiveInt(config.defaultMaxTurns) ?? 20;
  const userMaxTurns = normalizePositiveInt(config.resolveUserMaxTurns?.(identity));
  return Math.min(requestedMaxTurns ?? defaultMaxTurns, userMaxTurns ?? Infinity);
}

export function resolveSessionCatalog(config: RawRuntimeRunDispatchConfig): SessionCatalog {
  return config.sessionCatalog ?? new FileSessionCatalog({ agentCwd: config.agentCwd });
}

export function createEventStoreForSession(
  config: RawRuntimeRunDispatchConfig,
  session: RuntimeSessionRecord,
): EventStore {
  return config.eventStoreFactory
    ? config.eventStoreFactory(session)
    : new FileEventStore(getRuntimeEventLogPath(session.transcriptPath));
}

export function createApprovalStoreForSession(
  config: RawRuntimeRunDispatchConfig,
  session: RuntimeSessionRecord,
  eventStore: EventStore,
): ApprovalStore {
  return config.approvalStoreFactory
    ? config.approvalStoreFactory(session, eventStore)
    : new EventBackedApprovalStore(eventStore, session.sessionId);
}

async function appendRunStateChanged(
  eventStore: EventStore,
  sessionId: string,
  runId: string,
  status: RunStatus,
  previousStatus?: RunStatus,
  reason?: string,
  ctx?: Parameters<EventStore['append']>[1],
): Promise<void> {
  await eventStore.append({
    type: 'run_state_changed',
    runId,
    sessionId,
    status,
    ...(previousStatus ? { previousStatus } : {}),
    ...(reason ? { reason } : {}),
  }, ctx);
}

export async function markRunState(
  runStore: RunStore | undefined,
  eventStore: EventStore,
  sessionId: string,
  runId: string,
  status: RunStatus,
  reason?: string,
): Promise<void> {
  const before = runStore ? await runStore.get(runId) : null;
  if (runStore) await runStore.markStatus(runId, status, reason);
  await appendRunStateChanged(eventStore, sessionId, runId, status, before?.status, reason);
}

// cron/web fallback 直跑路径也会写 runtime_runs；不占 lease 时，scheduler 会把
// 正在跑的 run 误判为可恢复并二次 wake。
const DIRECT_RUNTIME_LEASE_MS = 120_000;
const DIRECT_RUNTIME_LEASE_RENEW_INTERVAL_MS = 30_000;

export interface DirectRuntimeLeaseHandle {
  workerId: string;
  release(): Promise<void>;
}

export async function acquireDirectRuntimeRunLease(input: {
  runStore: RunStore | undefined;
  runId: string;
  runtimeWorkerId?: string;
  logger?: RawRuntimeRunDispatchConfig['logger'];
}): Promise<DirectRuntimeLeaseHandle | null> {
  if (input.runtimeWorkerId || !input.runStore?.acquireLease) return null;

  const workerId = `direct-${process.pid}-${randomUUID()}`;
  const acquired = await input.runStore.acquireLease(input.runId, workerId, DIRECT_RUNTIME_LEASE_MS).catch((err) => {
    input.logger?.warn(`Direct runtime lease acquire failed run=${input.runId}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  });
  if (!acquired) {
    input.logger?.warn(`Direct runtime lease not acquired run=${input.runId}; continuing without scheduler recovery guard`);
    return null;
  }

  let renewTimer: ReturnType<typeof setInterval> | null = null;
  if (input.runStore.renewLease) {
    renewTimer = setInterval(() => {
      void input.runStore?.renewLease?.(input.runId, workerId, DIRECT_RUNTIME_LEASE_MS)
        .then((renewed) => {
          if (!renewed && renewTimer) {
            clearInterval(renewTimer);
            renewTimer = null;
            input.logger?.warn(`Direct runtime lease lost run=${input.runId} worker=${workerId}`);
          }
        })
        .catch((err) => {
          input.logger?.warn(`Direct runtime lease renew failed run=${input.runId}: ${err instanceof Error ? err.message : String(err)}`);
        });
    }, DIRECT_RUNTIME_LEASE_RENEW_INTERVAL_MS);
    renewTimer.unref?.();
  }

  return {
    workerId,
    async release() {
      if (renewTimer) {
        clearInterval(renewTimer);
        renewTimer = null;
      }
      await input.runStore?.releaseLease?.(input.runId, workerId).catch((err) => {
        input.logger?.warn(`Direct runtime lease release failed run=${input.runId}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      });
    },
  };
}



function buildWorkspaceRecipe(
  workspaceId: string,
  override?: Partial<WorkspaceRecipe>,
  sessionId?: string,
  mountSubPath?: string,
): WorkspaceRecipe {
  const effectiveMountSubPath = override?.mountSubPath ?? mountSubPath;
  return {
    ...(override ?? {}),
    workspaceId,
    sandboxScopeId: override?.sandboxScopeId ?? deriveSandboxScopeId({ workspaceId, mountSubPath: effectiveMountSubPath }),
    ...(sessionId ? { sessionId } : {}),
    ...(!override?.mountSubPath && mountSubPath ? { mountSubPath } : {}),
  };
}

function deriveWorkspaceMountSubPath(input: { agentCwd: string; cwd?: string }): string | undefined {
  if (!input.cwd) return undefined;
  const mountRoot = resolve(input.agentCwd, '..');
  const workspaceRoot = resolve(input.cwd);
  const rel = relative(mountRoot, workspaceRoot);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return rel.split(sep).join('/');
}

function deriveSandboxScopeId(input: { workspaceId: string; mountSubPath?: string }): string {
  return input.mountSubPath ? `${input.workspaceId}__${input.mountSubPath.replace(/[^A-Za-z0-9_-]+/g, '_')}` : input.workspaceId;
}

function deriveRuntimeWorkspaceId(params: {
  existingSession?: RuntimeSessionRecord | null;
  fallbackSessionId: string;
  identity?: { id?: string; tenantId?: string };
}): string {
  return params.existingSession?.workspaceId
    ?? deriveStableWorkspaceId(params.identity, params.fallbackSessionId);
}

export async function ensureRuntimeHandRegistered(params: {
  handStore?: HandStore;
  eventStore: EventStore;
  executionTransportRegistry: ExecutionTransportRegistry;
  executionTarget: ExecutionTargetKind;
  sessionId: string;
  workspaceId: string;
  workspaceMountSubPath?: string;
  endpoint?: string;
  serverRemoteRecipe?: Partial<WorkspaceRecipe>;
  tenantRemoteHands?: TenantRemoteHandDispatchConfig[];
  tenantRemoteHandResolver?: TenantRemoteHandAuthTokenResolver;
  userId?: string;
  username?: string;
  /**
   * B1: Resolved requesting-user `tenantId`. When present, tenantRemoteHand
   * entries with a `tenantIds` allow-list attach if `userTenantId ∈ tenantIds`.
   * Combined with `users`: independently permissive (any match attaches).
   */
  userTenantId?: string;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}): Promise<void> {
  if (!params.handStore) return;
  const transport = params.executionTransportRegistry.has(params.executionTarget)
    ? params.executionTransportRegistry.get(params.executionTarget)
    : undefined;
  const tools = transport?.listInternalTools() ?? [];
  const capabilities: HandCapability[] = [workspaceCapability(
    'Workspace filesystem and shell hand',
    tools,
    params.executionTarget === 'server-remote'
      ? ['workspace.root is never serialized to the remote hand']
      : ['in-process compatibility hand'],
  )];
  const manager = new HandManager({
    handStore: params.handStore,
    transportRegistry: params.executionTransportRegistry,
    eventStore: params.eventStore,
  });
  const recipe = buildWorkspaceRecipe(
    params.workspaceId,
    params.executionTarget === 'server-remote' ? params.serverRemoteRecipe : undefined,
    params.sessionId,
    params.workspaceMountSubPath,
  );
  const defaultHandId = `${params.sessionId}:${params.executionTarget}`;
  if (transport && typeof (transport as { provision?: unknown }).provision === 'function') {
    const result = await (transport as unknown as { provision(recipe: { workspaceId: string }): Promise<{ status: 'ok' | 'error'; error?: string; metadata?: Record<string, unknown> }> }).provision(recipe);
    // B3: persist provisioning logs (workspace_ensure / setup_command#N / skipped
    // repo+artifact placeholders) emitted by hand-server so audit can correlate.
    await appendProvisioningLogs({
      eventStore: params.eventStore,
      sessionId: params.sessionId,
      handId: defaultHandId,
      workspaceId: params.workspaceId,
      metadata: result.metadata,
    });
    if (result.status === 'error') {
      await params.eventStore.append({
        type: 'hand_failure',
        sessionId: params.sessionId,
        workspaceId: params.workspaceId,
        error: result.error ?? 'hand provision failed',
        classifiedAs: 'unhealthy',
      });
    }
  }
  await manager.provision({
    handId: defaultHandId,
    sessionId: params.sessionId,
    workspaceId: params.workspaceId,
    type: params.executionTarget,
    status: 'ready',
    endpoint: params.endpoint,
    capabilities,
    recipe,
    metadata: { registeredBy: 'rawRuntimeRunDispatch' },
  });

  for (const hand of selectTenantRemoteHandsForRegistration(params.tenantRemoteHands, {
    userId: params.userId,
    username: params.username,
    userTenantId: params.userTenantId,
  })) {
    const remoteWorkspaceId = params.workspaceId;
    const handId = `${params.sessionId}:${hand.id}`;

    let status: 'provisioning' | 'unhealthy' = 'provisioning';
    let failure: string | undefined;
    let resolvedToken: string | undefined;
    let tokenRef: string | undefined;
    let tokenSource: 'inline' | 'vault' | 'unresolved' = 'unresolved';

    try {
      const resolved = await params.tenantRemoteHandResolver!.resolveForRegister(hand);
      resolvedToken = resolved.authToken;
      tokenRef = resolved.authTokenRef;
      tokenSource = resolved.source;
    } catch (err) {
      status = 'unhealthy';
      failure = `vault_resolve_failed: ${err instanceof Error ? err.message : String(err)}`;
      await params.eventStore.append({
        type: 'hand_failure',
        sessionId: params.sessionId,
        workspaceId: remoteWorkspaceId,
        handId,
        error: failure,
        classifiedAs: 'unhealthy',
      });
    }

    if (!resolvedToken && !failure) {
      status = 'unhealthy';
      failure = 'tenant remote hand auth token was not resolved';
      await params.eventStore.append({
        type: 'hand_failure',
        sessionId: params.sessionId,
        workspaceId: remoteWorkspaceId,
        handId,
        error: failure,
        classifiedAs: 'auth',
      });
    }

    const tenantRecipe = buildWorkspaceRecipe(remoteWorkspaceId, hand.recipe, params.sessionId, params.workspaceMountSubPath);
    await manager.provision({
      handId,
      sessionId: params.sessionId,
      workspaceId: remoteWorkspaceId,
      type: 'server-remote',
      status,
      endpoint: hand.baseUrl,
      capabilities: tenantRemoteHandCapabilities(hand, tools),
      recipe: tenantRecipe,
      metadata: {
        registeredBy: 'tenantRemoteHands',
        tenantRemoteHandId: hand.id,
        tenantRemoteHandTokenSource: tokenSource,
        ...(tokenRef ? { authTokenRef: tokenRef } : {}),
        ...(hand.invokeTimeoutMs ? { invokeTimeoutMs: hand.invokeTimeoutMs } : {}),
        ...(hand.networkPolicy ? { networkPolicy: hand.networkPolicy } : {}),
        ...(failure ? { provisionFailure: failure } : {}),
      },
    });

    if (resolvedToken) {
      const tenantTransport = new HttpTransport({
        baseUrl: hand.baseUrl,
        authToken: resolvedToken,
        invokeTimeoutMs: hand.invokeTimeoutMs,
      });
      void provisionTenantRemoteHand({
        handStore: params.handStore,
        eventStore: params.eventStore,
        transport: tenantTransport,
        recipe: tenantRecipe,
        sessionId: params.sessionId,
        handId,
        workspaceId: remoteWorkspaceId,
        logger: params.logger,
      });
    }

    if (tokenSource !== 'unresolved') {
      params.logger?.info(
        `tenant_hand_registered handId=${handId} source=${tokenSource}${tokenRef ? ` authTokenRef=${tokenRef}` : ''}`,
      );
    }
  }
}

function workspaceCapability(description: string, tools: ToolDescriptor[], constraints: string[]): HandCapability {
  return {
    name: 'workspace',
    description,
    tools,
    constraints,
    risk: tools.some((tool) => tool.risk === 'dangerous')
      ? 'dangerous'
      : tools.some((tool) => tool.risk === 'workspace_write')
        ? 'workspace_write'
        : 'safe',
  };
}

function tenantRemoteHandCapabilities(
  hand: TenantRemoteHandDispatchConfig,
  tools: ToolDescriptor[],
): HandCapability[] {
  const capabilities: HandCapability[] = [workspaceCapability(
    hand.description ?? `Tenant Agent hand appliance (${hand.id})`,
    tools,
    [
      'tenant Agent hand appliance',
      'workspace.root is never serialized to the remote hand',
      'platform EventStore/RunStore remains the source of truth',
    ],
  )];

  if (hand.id === 'agent-saas-acs') {
    capabilities.push(
      {
        name: 'browser',
        description: 'Browser automation and web page rendering are available in the ACS production Agent hand.',
        tools: [],
        constraints: ['Chromium/Playwright runtime is provided by the sandbox image'],
        risk: 'workspace_write',
      },
      {
        name: 'media',
        description: 'Media processing tools are available in the ACS production Agent hand.',
        tools: [],
        constraints: ['ffmpeg/ffprobe are provided by the sandbox image; ImageMagick is extension-only'],
        risk: 'workspace_write',
      },
      {
        name: 'document-conversion',
        description: 'Office, PDF, OCR, and document conversion tools are available in the ACS production Agent hand.',
        tools: [],
        constraints: ['Minimal LibreOffice, Poppler, QPDF, Ghostscript, Tesseract and CJK fonts are provided by the sandbox image; Pandoc is extension-only'],
        risk: 'workspace_write',
      },
    );
  }

  return capabilities;
}

/**
 * B3: Persist provisioning step logs returned by hand-server `/provision` (in
 * the response body, surfaced as `metadata.logs`). Each entry becomes a single
 * `hand_provisioning_log` event. Returns silently when logs are absent or
 * malformed — provisioning still succeeds when the brain can't parse the body.
 */
async function appendProvisioningLogs(args: {
  eventStore: EventStore;
  sessionId: string;
  handId: string;
  workspaceId: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const logs = args.metadata?.logs;
  if (!Array.isArray(logs)) return;
  for (const raw of logs) {
    if (!raw || typeof raw !== 'object') continue;
    const log = raw as Record<string, unknown>;
    const step = typeof log.step === 'string' ? log.step : undefined;
    const status = log.status === 'ok' || log.status === 'error' || log.status === 'skipped'
      ? log.status
      : undefined;
    if (!step || !status) continue;
    await args.eventStore.append({
      type: 'hand_provisioning_log',
      sessionId: args.sessionId,
      handId: args.handId,
      workspaceId: args.workspaceId,
      step,
      status,
      ...(typeof log.command === 'string' ? { command: log.command } : {}),
      ...(typeof log.stdout === 'string' ? { stdout: log.stdout } : {}),
      ...(typeof log.stderr === 'string' ? { stderr: log.stderr } : {}),
      ...(typeof log.exitCode === 'number' ? { exitCode: log.exitCode } : {}),
      ...(typeof log.durationMs === 'number' ? { durationMs: log.durationMs } : {}),
      ...(typeof log.note === 'string' ? { note: log.note } : {}),
    }).catch(() => undefined);
  }
}

async function provisionTenantRemoteHand(args: {
  handStore?: HandStore;
  eventStore: EventStore;
  transport: HttpTransport;
  recipe: WorkspaceRecipe;
  sessionId: string;
  handId: string;
  workspaceId: string;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}): Promise<void> {
  try {
    const result = await args.transport.provision(args.recipe);
    await appendProvisioningLogs({
      eventStore: args.eventStore,
      sessionId: args.sessionId,
      handId: args.handId,
      workspaceId: args.workspaceId,
      metadata: result.metadata,
    });

    if (result.status === 'error') {
      const error = result.error ?? 'tenant remote hand provision failed';
      await args.handStore?.updateStatus(args.handId, 'unhealthy', {
        provisionFailure: error,
        lastProvisionedAt: new Date().toISOString(),
      });
      await args.eventStore.append({
        type: 'hand_failure',
        sessionId: args.sessionId,
        workspaceId: args.workspaceId,
        handId: args.handId,
        error,
        classifiedAs: 'unhealthy',
      });
      await args.eventStore.append({
        type: 'hand_health_changed',
        sessionId: args.sessionId,
        workspaceId: args.workspaceId,
        handId: args.handId,
        status: 'unhealthy',
        detail: error,
      });
      return;
    }

    await args.handStore?.updateStatus(args.handId, 'ready', {
      provisionFailure: null,
      lastProvisionedAt: new Date().toISOString(),
      ...(result.metadata ? { lastProvisionMetadata: result.metadata } : {}),
    });
    await args.eventStore.append({
      type: 'hand_health_changed',
      sessionId: args.sessionId,
      workspaceId: args.workspaceId,
      handId: args.handId,
      status: 'ready',
      detail: 'provisioned',
    });
    args.logger?.info(`tenant_hand_ready handId=${args.handId}`);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await args.handStore?.updateStatus(args.handId, 'unhealthy', {
      provisionFailure: error,
      lastProvisionedAt: new Date().toISOString(),
    }).catch(() => undefined);
    await args.eventStore.append({
      type: 'hand_failure',
      sessionId: args.sessionId,
      workspaceId: args.workspaceId,
      handId: args.handId,
      error,
      classifiedAs: 'unknown',
    }).catch(() => undefined);
    await args.eventStore.append({
      type: 'hand_health_changed',
      sessionId: args.sessionId,
      workspaceId: args.workspaceId,
      handId: args.handId,
      status: 'unhealthy',
      detail: error,
    }).catch(() => undefined);
    args.logger?.warn(`tenant_hand_provision_failed handId=${args.handId}: ${error}`);
  }
}

function getTenantRemoteHandResolver(
  config: RawRuntimeRunDispatchConfig,
): TenantRemoteHandAuthTokenResolver {
  if (config.tenantRemoteHandResolver) return config.tenantRemoteHandResolver;
  return createTenantRemoteHandAuthTokenResolver({
    tenantRemoteHands: config.tenantRemoteHands,
    vault: config.secretVault,
    logger: config.logger,
  });
}

export function resolveTenantRemoteHandsSource(
  source: TenantRemoteHandsSource | undefined,
): TenantRemoteHandDispatchConfig[] | undefined {
  return typeof source === 'function' ? source() : source;
}

// 以下装配小件同时被 subagent/subagentRunner.ts 复用（子 loop 精简重建，
// 见该文件头注释）；除加 export 外语义零改动。
export class RunStateTrackingEventStore implements EventStore {
  constructor(
    private readonly inner: EventStore,
    private readonly runStore: RunStore | undefined,
    private readonly tenantId?: string,
  ) {}

  async append(
    event: Parameters<EventStore['append']>[0],
    ctx?: Parameters<EventStore['append']>[1],
  ): ReturnType<EventStore['append']> {
    // PR 5 修 P0-4：透传 ctx (tenantId) 到 inner store
    const stored = await this.inner.append(event, this.withTenant(ctx));
    await this.afterAppend(stored);
    return stored;
  }

  async appendBatch(
    events: Parameters<NonNullable<EventStore['appendBatch']>>[0],
    ctx?: Parameters<NonNullable<EventStore['appendBatch']>>[1],
  ) {
    // PR 5 修 P0-4：透传 ctx (tenantId) 到 inner store
    const stored = this.inner.appendBatch
      ? await this.inner.appendBatch(events, this.withTenant(ctx))
      : await Promise.all(events.map((event) => this.inner.append(event, this.withTenant(ctx))));
    for (const event of stored) await this.afterAppend(event);
    return stored;
  }

  list(sessionId: string, options?: Parameters<EventStore['list']>[1]) {
    return this.inner.list(sessionId, options);
  }
  listPage(sessionId: string, options?: Parameters<NonNullable<EventStore['listPage']>>[1]) {
    return this.inner.listPage?.(sessionId, options) ?? Promise.resolve({ events: [], hasMore: false });
  }

  private withTenant(ctx: Parameters<EventStore['append']>[1]): Parameters<EventStore['append']>[1] {
    if (ctx?.tenantId || !this.tenantId) return ctx;
    return { ...(ctx ?? {}), tenantId: this.tenantId };
  }

  private async afterAppend(event: PlatformEvent): Promise<void> {
    if (!this.runStore || event.type === 'run_state_changed') return;
    let status: RunStatus | undefined;
    let reason: string | undefined;
    if (event.type === 'approval_requested') {
      status = 'waiting_approval';
      reason = `approval:${event.approvalId}`;
    } else if (event.type === 'approval_resolved') {
      status = 'running';
      reason = `approval_resolved:${event.approvalId}`;
    } else if (event.type === 'interaction_requested' && event.interactionType === 'ask_user') {
      status = 'waiting_user';
      reason = `interaction:${event.interactionId}`;
    } else if (event.type === 'interaction_resolved' && event.interactionType === 'ask_user') {
      status = 'running';
      reason = `interaction_resolved:${event.interactionId}`;
    } else if (event.type === 'run_finished') {
      status = event.subtype === 'success' ? 'completed' : event.subtype === 'interrupted' ? 'cancelled' : 'failed';
      reason = event.subtype === 'error' ? event.error ?? event.subtype : event.subtype;
    }
    if (status && 'runId' in event && typeof event.runId === 'string' && typeof event.sessionId === 'string') {
      const before = await this.runStore.get(event.runId);
      await this.runStore.markStatus(event.runId, status, reason);
      await appendRunStateChanged(
        this.inner,
        event.sessionId,
        event.runId,
        status,
        before?.status,
        reason,
        this.withTenant(undefined),
      );
    }
  }
}

/**
 * 子 agent 工具的装配依赖（2026-07-06）：executionTransportRegistry 与
 * tenantHandResolver 是各 dispatch 工厂的闭包级对象（非 config 字段），
 * AgentToolProvider 派生子 loop 时必须复用**同一实例**（serverRemote 注册、
 * vault 解析缓存都挂在上面），所以经参数显式传入 collectRuntimeTooling。
 */
interface SubagentToolingDeps {
  executionTransportRegistry: ExecutionTransportRegistry;
  tenantHandResolver: TenantRemoteHandAuthTokenResolver;
}

/**
 * 收集本次 dispatch 用到的所有 tool providers + buildInstructions 入参。
 * 两条 dispatch（首跑 / approval resume）共用同一构造，保证 instructions 一致。
 */
async function collectRuntimeTooling(
  config: RawRuntimeRunDispatchConfig,
  username: string | undefined,
  skillFilter: RuntimeSkillFilter = allowAllRuntimeSkills,
  requiredSkillIds: readonly string[] = [],
  subagentDeps?: SubagentToolingDeps,
): Promise<{
  providers: ToolProvider[];
}> {
  const providers: ToolProvider[] = [];

  // Skill 工具：注入 EffectiveSkillsResolver，SkillToolProvider.list(context) 会用它
  // 派生用户实际可用清单并拼进工具 description（模型注意力最集中的位置）。原
  // <available-skills> xml section 已废弃（2026-07-03）。
  if (config.skills && isToolEnabled(config.toolControls, 'Skill')) {
    providers.push(new SkillToolProvider(buildRuntimeSkillsResolver(config.skills, skillFilter, requiredSkillIds)));
  }

  // 2. BuiltinTools（TodoWrite/AskUserQuestion；workspace 文件工具由 WorkspaceToolProvider 提供）
  // createBuiltinTools 内部对 undefined 已经走默认全开；这里不再做 if/else 分支区分。
  const builtin = createBuiltinTools(config.builtinTools);
  providers.push(builtin);

  // 2.5 UserActivityList（safe 只读，身份只从 context 解析；记忆轮询 + 普通会话通用）
  if (config.userActivityService && isToolEnabled(config.toolControls, 'UserActivityList')) {
    providers.push(new UserActivityToolProvider(config.userActivityService));
  }

  // 3. Web 工具（平台托管网络出站，不走 workspace hand / shell）
  if (config.tenantStore) {
    providers.push(new TenantCompanyInfoToolProvider({
      sharedDir: config.sharedDir,
      tenantStore: config.tenantStore,
    }));
  }

  // 4. Web 工具（平台托管网络出站，不走 workspace hand / shell）
  if (config.webTools && config.webTools.enabled !== false) {
    const webProvider = new WebToolProvider(config.webTools);
    const webDescriptors = webProvider.list().filter((tool) => isToolEnabled(config.toolControls, tool));
    if (webDescriptors.length > 0) {
      providers.push(webProvider);
    }
  }

  // 4.5 GenerateImage 生图工具（brain 进程内执行，不进 WORKSPACE_HAND_TOOLS；
  // 凭据留在 server 侧，按张扣积分）。租户 gate（features.imageGenEnabled）由
  // provider 的 list/invoke 按 context 解析，默认 false fail-closed。
  if (config.imageGenTools && config.imageGenTools.enabled !== false
    && isToolEnabled(config.toolControls, 'GenerateImage')) {
    const tenantStore = config.tenantStore;
    providers.push(new ImageGenToolProvider({
      config: config.imageGenTools,
      billingService: config.billingService,
      appendPlatformEvent: config.appendPlatformEvent,
      isImageGenEnabledForTenant: (tenantId) => {
        if (!tenantId || !tenantStore) return false;
        try {
          return tenantStore.getSettings(tenantId)?.features?.imageGenEnabled === true;
        } catch {
          return false;
        }
      },
      logger: config.logger,
    }));
  }

  // 5. 定时任务工具（CronList/CronManage；服务未启用或无用户身份时 list() 自动隐藏）
  if (config.cronService) {
    providers.push(new CronToolProvider({ service: config.cronService }));
  }

  // 6. MCP 工具（带超时兜底，单 server hang 不会卡 dispatch 主路径）
  if (config.mcpProxy || config.mcpClientManager) {
    const mcpProvider = new McpClientToolProvider(config.mcpProxy ?? config.mcpClientManager!);
    try {
      await mcpProvider.warmup(username);
    } catch {
      // MCP 预热失败只影响本轮 MCP tool schema，不阻断主路径。
    }
    providers.push(mcpProvider);
  }

  // 7. Agent 工具（子 agent 委派，2026-07-06）。必须最后 push：parentProviders 快照
  // 在 push 之前截取，子工具集从快照派生 → 子 agent 天然拿不到 Agent 工具（禁嵌套，
  // 工具移除式，D4）。subagentDeps 缺失（调用方未接线）时不挂载。
  if (subagentDeps && isToolEnabled(config.toolControls, 'Agent')) {
    providers.push(new AgentToolProvider({
      config,
      executionTransportRegistry: subagentDeps.executionTransportRegistry,
      tenantHandResolver: subagentDeps.tenantHandResolver,
      parentProviders: [...providers],
    }));
  }

  return { providers };
}

type RuntimeSkillFilter = (skill: SkillEntry) => boolean;

function allowAllRuntimeSkills(): boolean {
  return true;
}

function filterRuntimeSkills(skills: SkillEntry[], filter: RuntimeSkillFilter): SkillEntry[] {
  return skills.filter(filter);
}

/**
 * 构造 Skill resolver。requiredSkillIds 只负责把专职 Agent 固有能力传给底层
 * SkillsDispatchConfig；最终仍会经过 runtime/browser filter 与 Agent 白名单。
 */
export function buildRuntimeSkillsResolver(
  skills: SkillsDispatchConfig,
  skillFilter: RuntimeSkillFilter = allowAllRuntimeSkills,
  requiredSkillIds: readonly string[] = [],
): EffectiveSkillsResolver {
  return {
    list: (ctx) => filterRuntimeSkills(
      skills.listForUser(resolveSkillContextUsername(ctx.channelContext), requiredSkillIds),
      skillFilter,
    ),
    resolveSkillDir: (skill, ctx) =>
      skills.resolveSkillDir(resolveSkillContextUsername(ctx.channelContext), skill, requiredSkillIds),
  };
}

/** AND 组合多个 skill filter：任一 filter 拒绝即拒绝（browser-hand filter 与 org agent 白名单叠加用，不是替换）。 */
export function composeSkillFilters(...filters: RuntimeSkillFilter[]): RuntimeSkillFilter {
  return (skill) => filters.every((filter) => filter(skill));
}

/** 专职 Agent skill 白名单 filter：固有能力清单 ∩ allowedSkills（仅按 id 命中，2026-07 审查 F10：name 可被同名 skill 冒用扩权）。 */
export function buildOrgAgentSkillFilter(agent: Pick<OrgAgentRecord, 'allowedSkills'>): RuntimeSkillFilter {
  const allowed = new Set(agent.allowedSkills);
  return (skill) => allowed.has(skill.id);
}

/**
 * 解析专职 Agent 覆盖三态：
 *   - null：orgAgentId 缺省 → 个人 Agent 路径照旧（兼容红线：零行为变化）
 *   - { error }：record 缺失 / disabled / 租户不符 / store 未配置 → 调用方 yield error
 *     **fail-closed**，绝不静默回退个人 persona + 全量 skill（漏一处 = 审批恢复后越权）
 *   - { agent }：正常应用覆盖（org 名 / 限定提示语 / skill 白名单 / 跳过 persona+memory）
 */
export function resolveOrgAgentOverrides(
  config: Pick<RawRuntimeRunDispatchConfig, 'orgAgentStore'>,
  orgAgentId: string | undefined,
  tenantId: string | undefined,
): null | { error: string } | { agent: OrgAgentRecord } {
  if (!orgAgentId) return null;
  const store = config.orgAgentStore;
  if (!store) {
    return { error: `企业专家服务不可用（orgAgentId=${orgAgentId}），已终止本次运行` };
  }
  const record = store.get(orgAgentId);
  if (!record || !record.enabled) {
    return { error: '该企业专家已被停用或删除，请联系组织管理员' };
  }
  if (record.tenantId !== tenantId) {
    // 跨租户/租户身份缺失一律 fail-closed（与 channel 侧 org_agent_unavailable 防枚举语义一致）
    return { error: '该企业专家已被停用或删除，请联系组织管理员' };
  }
  return { agent: record };
}

export function buildRuntimeSkillFilter(availableHands: HandRecord[]): RuntimeSkillFilter {
  const hasTenantAcsHand = availableHands.some((hand) => (
    typeof hand.metadata?.tenantRemoteHandId === 'string'
    && hand.metadata.tenantRemoteHandId === 'agent-saas-acs'
    && hand.status !== 'destroyed'
  ));
  if (!hasTenantAcsHand) return allowAllRuntimeSkills;

  // 门控判据看 capability 声明而非 status==='ready'：capabilities 是注册时静态写入的
  // 配置事实（tenantRemoteHandCapabilities），不是运行期探测结果。而每轮 dispatch 的
  // ensureRuntimeHandRegistered 都会把 ACS hand upsert 回 'provisioning'，随后毫秒级
  // 内 listBySession 取快照构建本 filter，异步 provision 翻回 'ready' 需要秒级——若
  // 要求 ready，browser skill 会在每一轮 run 的 <available-skills> 里被永久滤掉
  // （2026-07-03 生产实锤）。仅在 hand 明确不健康/已销毁时才视为无 browser 能力。
  const hasBrowserCapability = availableHands.some((hand) => (
    hand.status !== 'unhealthy'
    && hand.status !== 'destroyed'
    && hand.capabilities.some((capability) => (
      capability.name === 'browser'
      || capability.tools.some((tool) => tool.name === 'Browser' || tool.name === 'playwright-cli')
    ))
  ));
  if (hasBrowserCapability) return allowAllRuntimeSkills;

  return (skill) => skill.id !== 'browser' && skill.name !== 'browser';
}

/**
 * `image-gen` 是 GenerateImage 的方法论层，不是独立执行能力。平台工具、引擎或
 * 租户授权任一缺失时从 Skill 清单同步隐藏，避免模型把工具名当 Shell 命令，或
 * 用 WebSearch/browser 截图冒充生成结果。
 */
export function buildImageGenSkillFilter(
  config: Pick<RawRuntimeRunDispatchConfig, 'imageGenTools' | 'toolControls' | 'tenantStore'>,
  tenantId: string | undefined,
): RuntimeSkillFilter {
  let tenantEnabled = false;
  if (tenantId && config.tenantStore) {
    try {
      tenantEnabled = config.tenantStore.getSettings(tenantId)?.features?.imageGenEnabled === true;
    } catch {
      tenantEnabled = false;
    }
  }
  const toolAvailable = isToolEnabled(config.toolControls, 'GenerateImage')
    && listAvailableImageGenEngineIds(config.imageGenTools).length > 0;
  if (tenantEnabled && toolAvailable) return allowAllRuntimeSkills;
  return (skill) => skill.id !== 'image-gen';
}

export function resolveSkillContextUsername(context: ChannelContext | undefined): string | undefined {
  return context?.sessionOwner?.username ?? context?.user?.username;
}

function resolveContextIsPlatformAdmin(context: ChannelContext | undefined): boolean {
  const identity = context?.user ?? context?.sessionOwner;
  return identity?.role === 'admin' && identity.tenantId === DEFAULT_TENANT_ID;
}

function resolveDefaultExecutionTargetForContext(
  executionConfig: ExecutionConfig,
  context: ChannelContext,
): ExecutionTargetKind {
  const identity = context.user ?? context.sessionOwner;
  const decision = resolveExecutionTarget({
    config: executionConfig,
    user: identity ? { role: identity.role, tenantId: identity.tenantId } : null,
  });
  return decision.ok ? decision.target : executionConfig.defaultTarget;
}

function resolveContextTenantId(
  context: ChannelContext,
  existingSession?: RuntimeSessionRecord | null,
): string | undefined {
  return (context.sessionOwner ?? context.user)?.tenantId ?? existingSession?.tenantId;
}

function resolveSessionOwnerRole(
  config: RawRuntimeRunDispatchConfig,
  session: RuntimeSessionRecord,
): 'admin' | 'user' {
  return session.userRole
    ?? config.resolveUserRole?.({ userId: session.userId, username: session.username })
    ?? 'user';
}

/** Rebuild the original account identity for every scheduler wake/resume path. */
export function resolveWakeSessionOwner(
  config: RawRuntimeRunDispatchConfig,
  session: RuntimeSessionRecord,
  fallbackUserId?: string,
): NonNullable<ChannelContext['sessionOwner']> {
  const userId = session.userId || fallbackUserId || '';
  const realName = config.resolveUserRealName?.({
    userId: userId || undefined,
    username: session.username || undefined,
  });

  return {
    id: userId,
    username: session.username || 'unknown',
    role: resolveSessionOwnerRole(config, session),
    tenantId: resolveSessionOwnerTenantId(config, session),
    ...(realName ? { realName } : {}),
  };
}

/**
 * 解析 sessionOwner.tenantId（多组织隔离主防御的 fail-safe baseline）。
 *
 * 设计原则（疑点 3 加固，2026-06-22）：
 *   - resolveUserTenantId 未配置 → 返回 undefined。下游 `isPlatformAdmin` 检查
 *     会因 tenantId !== DEFAULT_TENANT_ID 而 false → Shell gate 把非平台
 *     用户路径拦在 server-local 之外。
 *   - resolveUserTenantId 返回 undefined → 不静默回填默认组织。fail-closed 比
 *     "用户已删 silently fallback to kaiyan = 跨组织读取所有人的工作区" 更安全。
 *   - resolveUserTenantId 抛错 → fail-safe 返回 undefined（同上），并记 warn
 *     日志保留诊断信息。不向上抛 throw，避免一次 UserStore 故障让所有 wake
 *     入口阻塞。
 *
 * 任何对 wake 路径的 tenant 身份补齐改动都应保留这个 fail-safe → undefined
 * 语义，避免与下游 `isPlatformAdmin` 假设解耦。
 */
export function resolveSessionOwnerTenantId(
  config: RawRuntimeRunDispatchConfig,
  session: RuntimeSessionRecord,
): string | undefined {
  if (!config.resolveUserTenantId) return undefined;
  try {
    return config.resolveUserTenantId({ userId: session.userId, username: session.username });
  } catch (err) {
    logger.warn('resolveUserTenantId 抛错（fail-safe 降级为 undefined）', {
      sessionId: session.sessionId,
      userId: session.userId,
      username: session.username,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

function normalizeApprovalPolicy(value: unknown): ToolApprovalPolicyOptions | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const autoApproveTools = (value as { autoApproveTools?: unknown }).autoApproveTools === true
    || (value as { autoApproveRunShell?: unknown }).autoApproveRunShell === true;
  return autoApproveTools ? { autoApproveTools: true } : undefined;
}

/**
 * 加载并组装 system prompt。模板源在 `workspace-shared/prompts/*.md`。
 *
 * Sections 顺序严格按 variability「从低到高」排列，最大化 OpenAI 自动前缀缓存命中：
 *   1. static.md             全局稳定（无变量、跨用户共享）
 *   2. dynamic-shared.md     per-tenant 稳定（COMPANY_INFO，月级不变）
 *   3. runtime-memory.md     全局稳定（固定提示，条件加载）
 *   4. dynamic-personal.md   per-user 变量（身份 + PERSONA + env + 安全块）
 *
 * ── ↑ 段 1 跨用户共享前缀；段 2 起同租户内共享，是 prompt cache 的理想命中区 ──
 *
 * 2026-07-03：原 section 4 `<available-skills>` xml 段已删——skill 清单现由
 * SkillToolProvider 动态注入到 Skill 工具 description 中，避免 xml 注意力弱的
 * 模型（glm-5.2 等）忽略中段 prompt 而幻觉调用不存在的 skill。工具 schema 是
 * 模型注意力最集中的位置，且天然会随 skill 增删刷新，不再需要 system prompt
 * 双写。
 *
 * 2026-07-03：原尾段 `<current-runtime>` 状态 XML（handPrompt.ts）已删——租户
 * hand 每轮 dispatch 被重置为 provisioning 后异步置 ready，dispatch 同步快照
 * 几乎恒为 provisioning（恒错误导）；workspaceId 无消费者（工具不接受执行环境
 * 标识参数）。运行态感知交给 WaitForWorkspaceReady 工具结果（实时真值）+
 * static.md「## 运行态」静态规则。删除后 instructions 无易变尾巴，per-user
 * 段之后逐字节稳定。
 */
export function buildInstructions(params: {
  sharedDir: string;
  tenantId?: string;
  agentName: string;
  userName: string;
  persona: string;
  cwd: string;
  executionTarget: ExecutionTargetKind;
  memorySearchEnabled: boolean;
  isPlatformAdmin: boolean;
  /** 专职 Agent 覆盖：注入 {{ORG_AGENT_INSTRUCTIONS}}，IF_PERSONA/IF_NO_PERSONA 强制 false，AGENT_NAME 用 org 名。 */
  orgAgent?: Pick<OrgAgentRecord, 'name' | 'instructions'>;
}): string {
  const personaBody = params.orgAgent ? '' : params.persona.trim();
  const hasPersona = personaBody.length > 0;

  const sharedVars: PromptVars = {
    COMPANY_INFO: loadCompanyInfo(params.sharedDir, params.tenantId),
  };
  const visibleCwd = visibleWorkspaceCwd(params.cwd, params.executionTarget);
  const personalVars: PromptVars = {
    CURRENT_USER: params.userName || '当前用户',
    AGENT_NAME: params.orgAgent ? params.orgAgent.name : params.agentName,
    PERSONA: personaBody,
    USER_CWD: visibleCwd,
    IF_PERSONA: !params.orgAgent && hasPersona,
    IF_NO_PERSONA: !params.orgAgent && !hasPersona,
    IF_NOT_ADMIN: !params.isPlatformAdmin,
    IF_ORG_AGENT: !!params.orgAgent,
    ORG_AGENT_INSTRUCTIONS: params.orgAgent?.instructions ?? '',
  };

  const sections: string[] = [
    loadPrompt(params.sharedDir, 'static'),
    loadAndRenderPrompt(params.sharedDir, 'dynamic-shared', sharedVars),
  ];

  if (params.memorySearchEnabled) {
    sections.push(loadPrompt(params.sharedDir, 'runtime-memory'));
  }
  sections.push(loadAndRenderPrompt(params.sharedDir, 'dynamic-personal', personalVars));

  return sections.join('\n\n');
}

export function visibleWorkspaceCwd(hostCwd: string, executionTarget: ExecutionTargetKind): string {
  if (executionTarget === 'server-remote') return '/workspace';
  if (executionTarget === 'server-container') return '/workspace';
  return hostCwd;
}

/**
 * 未配置 company.md 时的 fallback：不是给人看的占位符，而是给 agent 的行为指令——
 * 如实说明组织资料缺失并引导管理员补充，避免 agent 凭空编造公司信息。
 * 注意：此文本位于 dynamic-shared 共享缓存段，必须保持角色无关（admin/普通用户同文案）。
 */
const COMPANY_INFO_FALLBACK = '（本组织尚未配置组织资料。当用户问及公司业务、产品、团队、制度等信息时，如实说明你还没有组织资料，不要编造；并提示：组织管理员可在管理后台「组织管理 → 公司信息」页补充，补充后新会话自动生效。）';

function loadCompanyInfo(sharedDir: string, tenantId?: string): string {
  if (!tenantId) return COMPANY_INFO_FALLBACK;
  try {
    const content = readTenantCompanyInfoSync(sharedDir, tenantId)?.trim();
    return content || COMPANY_INFO_FALLBACK;
  } catch {
    return COMPANY_INFO_FALLBACK;
  }
}

/**
 * 07-05：给 tenant-remote hand（HttpTransport → acs-orchestrator/hand-server → pod）
 * 现场装配 wire.context.env。envResolver 走 workspace.tenantId + workspace.username
 * 二级查 tokens.json，得到 { AZEROTH_TOKEN, AZEROTH_API_URL } 塞进 wire。
 *
 * 与 dispatch.ts:603 本地 SDK spawn 路径的 AZEROTH_TOKEN 注入并行——两者共用同一份
 * tokens.json 与 resolveAzerothInjection，一份配置同时生效于本地与远端 pod。
 *
 * 未命中（该 (tenantId, username) 没配 PAT）→ 返回空对象 → wire 不带 env →
 * pod 内 CLI 报"未授权"，语义与本地 SDK 未配置时一致。
 */
export function buildTenantRemoteHandWireEnv(workspace: WorkspaceRef): Record<string, string> {
  const username = workspace.username;
  if (!username) return {};
  const tenantId = workspace.tenantId ?? DEFAULT_TENANT_ID;
  const injection = resolveAzerothInjection(tenantId, username);
  if (!injection) return {};
  return {
    AZEROTH_TOKEN: injection.token,
    ...(injection.apiUrl ? { AZEROTH_API_URL: injection.apiUrl } : {}),
  };
}

export function createRawRuntimeRunDispatch(config: RawRuntimeRunDispatchConfig): AgentRunDispatch {
  const logger = config.logger ?? noopLogger;
  const sessionCatalog = resolveSessionCatalog(config);
  const memoryEnabled = config.memory?.enabled ?? true;
  const memoryMaxLines = config.memory?.maxLines ?? 200;
  const executionTransportRegistry = config.executionTransportRegistry ?? createDefaultExecutionTransportRegistry();
  if (config.serverRemote && !executionTransportRegistry.has('server-remote')) {
    executionTransportRegistry.register(
      'server-remote',
      new HttpTransport({
        baseUrl: config.serverRemote.baseUrl,
        authToken: config.serverRemote.authToken,
        invokeTimeoutMs: config.serverRemote.invokeTimeoutMs,
      }),
    );
  }
  const executionConfig = config.executionConfig
    ?? createExecutionConfig(config.executionTarget ? { defaultTarget: config.executionTarget } : undefined);
  const tenantHandResolver = getTenantRemoteHandResolver(config);

  return async function* rawRuntimeRunDispatch(
    message: InboundMessage,
    context: ChannelContext,
    options: AgentRunOptions = {},
    hooks?: AgentRunHooks,
  ): AsyncGenerator<OutboundEvent> {
    // cron/dingtalk 通道：触发即跑，无 approval/interaction resume 路径，所需上下文
    // （context.user / cwd / modelConnection）由各 channel 注入，与 web 通道行为等价。
    if (context.channel !== 'web' && context.channel !== 'cron' && context.channel !== 'dingtalk') {
      yield { type: 'error', error: `Raw runtime 暂不支持通道 "${context.channel}"（仅支持 web/cron/dingtalk）` };
      return;
    }

    // PR 2026-06-14 (γ): raw runtime admin-only gate 解除。非 admin 用户可走 raw runtime；
    // 个别危险工具（Shell 等）仍由 WorkspaceToolProvider 内部按角色拦截。
    // δ 阶段加 anonymous 防御：必须有 user 身份（context.user 或 sessionOwner），否则
    // cwd 会落到 agentCwd 根目录，等同于把全用户 workspace 暴露给匿名访问。
    if (!context.user && !context.sessionOwner) {
      yield { type: 'error', error: 'Raw runtime 拒绝匿名访问：缺少 user / sessionOwner（请配置 auth.jwtSecret）' };
      return;
    }

    const resumeSessionId = options.resumeSessionId ?? context.resumeSessionId;
    const existingSession = resumeSessionId ? await sessionCatalog.get(resumeSessionId) : null;
    const cwd = options.cwd ? resolve(options.cwd) : existingSession?.cwd ?? config.agentCwd;
    const requestedModel = options.model;
    const { model, modelConnection, modelProviderOptions } = resolveRuntimeModelOptions(
      config,
      requestedModel,
      options.modelConnection ?? options.openaiAgentsConnection,
      options.modelProviderOptions,
    );
    const connection = modelConnection;
    const apiKey = connection?.apiKey || process.env.OPENAI_API_KEY;
    const baseUrl = connection?.baseUrl || process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL;
    const executionTarget = options.executionTarget ?? resolveDefaultExecutionTargetForContext(executionConfig, context);
    const sandboxPolicy = buildRawRuntimeSandboxPolicy(config, context, cwd, executionTarget);
    const approvalPolicy = normalizeApprovalPolicy(options.approvalPolicy);
    const toolProfile = normalizeToolProfile(options.toolProfile);

    if (!apiKey) {
      yield { type: 'error', error: 'Raw runtime 缺少 OPENAI_API_KEY 或模型组 apiKey' };
      return;
    }

    const isResume = !!resumeSessionId;
    const sessionId = resumeSessionId ?? randomUUID();
    const runId = options.runtimeRunId ?? `${Date.now()}-${randomUUID()}`;
    enterSessionContext(sessionId, runId);
    const identitySource = context.sessionOwner || context.user;
    const effectiveTenantId = resolveContextTenantId(context, existingSession);
    // BUG FIX 2026-06-23：tenantId 必须与 userId 同源用 identitySource，否则
    // admin 代操作 / cron / 内部触发等 context.user 为空但 sessionOwner 存在的
    // 路径上 hasTranscriptOwnerRef 会返回 false，transcript 会回退到 ownerless
    // dev/test layout，把同一 userId 按 cwd 切碎成多个文件夹。
    const transcriptPath = existingSession?.transcriptPath ?? getTranscriptPath(cwd, sessionId, { userId: identitySource?.id, tenantId: identitySource?.tenantId });
    await mkdir(dirname(transcriptPath), { recursive: true });

    // 专职 Agent 解析（在 session lock / run record 之前 fail-fast）：
    // 新会话由 options.orgAgentId 携带；resume 以 session meta 为准。
    const orgAgentId = options.orgAgentId ?? existingSession?.orgAgentId;
    const orgAgentResolution = resolveOrgAgentOverrides(config, orgAgentId, effectiveTenantId);
    if (orgAgentResolution && 'error' in orgAgentResolution) {
      logger.warn(`Org agent fail-closed: session=${sessionId} orgAgentId=${orgAgentId} reason=${orgAgentResolution.error}`);
      yield { type: 'error', error: orgAgentResolution.error };
      return;
    }
    const orgAgent = orgAgentResolution?.agent;

    let resolvedAttachments: ModelAttachmentRef[];
    try {
      resolvedAttachments = await resolveInboundAttachments(message.attachments, {
        cwd,
        channel: message.channel,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      yield { type: 'error', error: detail };
      return;
    }

    // Session-level lock：尽早占用，失败即退让；resume 路径多 brain 抢同一
    // session 时只让一个进入 dispatch。lock 必须在 try/finally 内 release。
    let lockHandle = config.sessionLock ? await config.sessionLock.tryAcquire(sessionId) : null;
    if (config.sessionLock && !lockHandle && !isCompactCommand(message.content) && config.autoCompaction) {
      // 自动压缩抢占（/compact v2）：用户消息永远第一优先级。若持锁的是本进程
      // 进行中的自动压缩 run，abort 它并短暂重试拿锁（压缩中途 abort 无残留——
      // compaction 事件只在成功收尾时落库）。
      if (config.autoCompaction.preempt(sessionId)) {
        lockHandle = await waitAcquireSessionLock(() => config.sessionLock!.tryAcquire(sessionId));
        if (lockHandle) {
          logger.info(`[auto-compact] user message preempted auto compaction, lock acquired session=${sessionId}`);
        }
      }
    }
    if (config.sessionLock && !lockHandle) {
      yield { type: 'error', error: `Session ${sessionId} 已被另一个 brain 持有，本次 dispatch 退让` };
      return;
    }

    const agentProfile = identitySource && config.agentStore
      ? config.agentStore.get(identitySource.username)
      : undefined;
    // 专职 Agent 覆盖：org 名 + 跳过个人 persona / memory 注入，memory search 关闭
    const agentName = orgAgent ? orgAgent.name : (agentProfile?.name || '开开');
    const userName = identitySource ? (identitySource.realName || identitySource.username || '') : '';
    const persona = (orgAgent || options.skipPersona) ? '' : ((await loadPersona(cwd)) || '');

    let memoryContext: string | undefined;
    if (memoryEnabled && !isResume && !options.skipMemory && !orgAgent) {
      const memory = await loadMemoryContext(cwd, memoryMaxLines);
      if (memory) memoryContext = memory;
    }
    const prompt = buildPrompt(message, context, resolvedAttachments);
    const memorySearchEnabled = !orgAgent
      && hasMemorySearchTool(config.memoryIndexService)
      && isToolEnabled(config.toolControls, 'MemorySearch');
    const isPlatformAdmin = resolveContextIsPlatformAdmin(context);
    const sessionModelRef = existingSession?.modelRef ?? options.modelRef ?? requestedModel ?? model;
    const workspaceId = deriveRuntimeWorkspaceId({
      existingSession,
      fallbackSessionId: sessionId,
      identity: {
        id: identitySource?.id,
        tenantId: effectiveTenantId,
      },
    });
    const sessionRecord: RuntimeSessionRecord = {
      ...(existingSession ?? createRuntimeSessionRecord({
        sessionId,
        userId: identitySource?.id,
        username: identitySource?.username,
        userRole: identitySource?.role,
        tenantId: effectiveTenantId,
        channel: context.channel,
        cwd,
        modelRef: sessionModelRef,
        executionTarget,
        status: 'running',
        ...(orgAgentId ? { orgAgentId } : {}),
      })),
      sessionId,
      userId: identitySource?.id ?? existingSession?.userId ?? '',
      username: identitySource?.username ?? existingSession?.username ?? '',
      userRole: identitySource?.role
        ?? existingSession?.userRole
        ?? config.resolveUserRole?.({ userId: existingSession?.userId, username: existingSession?.username }),
      tenantId: effectiveTenantId,
      channel: context.channel,
      cwd,
      transcriptPath,
      modelRef: sessionModelRef,
      executionTarget,
      workspaceId,
      status: 'running',
      ...(orgAgentId ? { orgAgentId } : {}),
      updatedAt: new Date().toISOString(),
    };
    await sessionCatalog.upsert(sessionRecord);
    const workspaceMountSubPath = deriveWorkspaceMountSubPath({ agentCwd: config.agentCwd, cwd });
    const sandboxScopeId = deriveSandboxScopeId({
      workspaceId: sessionRecord.workspaceId ?? sessionId,
      mountSubPath: workspaceMountSubPath,
    });
    await hooks?.onSessionStart?.(sessionId, transcriptPath);
    yield { type: 'session_init', sessionId };

    const baseEventStore = createEventStoreForSession(config, sessionRecord);
    let directRuntimeLease: DirectRuntimeLeaseHandle | null = null;
    await config.runStore?.upsertPending({
      runId,
      sessionId,
      userId: identitySource?.id ?? existingSession?.userId,
      // PR 5 修 P0-4：透传 tenantId 让 runtime_runs 落正确组织
      tenantId: sessionRecord.tenantId,
      model,
      channel: context.channel,
      executionTarget,
      workspaceId: sessionRecord.workspaceId ?? sessionId,
      sandboxScopeId,
      metadata: {
        cwd,
        transcriptPath,
        sandboxScopeId,
        ...(workspaceMountSubPath ? { mountSubPath: workspaceMountSubPath } : {}),
        ...(approvalPolicy ? { approvalPolicy } : {}),
        ...(toolProfile ? { toolProfile } : {}),
        wakeMessage: {
          channel: message.channel,
          chatId: message.chatId,
          content: message.content,
          senderId: message.senderId,
          senderName: message.senderName,
          attachments: message.attachments ?? [],
          metadata: message.metadata ?? {},
        },
      },
    });
    const eventStore = new RunStateTrackingEventStore(baseEventStore, config.runStore, sessionRecord.tenantId);
    directRuntimeLease = await acquireDirectRuntimeRunLease({
      runStore: config.runStore,
      runId,
      runtimeWorkerId: options.runtimeWorkerId,
      logger: config.logger,
    });
    await markRunState(config.runStore, eventStore, sessionId, runId, 'running');
    await ensureRuntimeHandRegistered({
      handStore: config.handStore,
      eventStore,
      executionTransportRegistry,
      executionTarget,
      sessionId,
      workspaceId: sessionRecord.workspaceId ?? sessionId,
      workspaceMountSubPath,
      endpoint: executionTarget === 'server-remote' ? config.serverRemote?.baseUrl : undefined,
      serverRemoteRecipe: config.serverRemote?.recipe,
      tenantRemoteHands: resolveTenantRemoteHandsSource(config.tenantRemoteHands),
      tenantRemoteHandResolver: tenantHandResolver,
      userId: identitySource?.id ?? existingSession?.userId,
      username: identitySource?.username ?? existingSession?.username,
      userTenantId: config.resolveUserTenantId?.({
        userId: identitySource?.id ?? existingSession?.userId,
        username: identitySource?.username ?? existingSession?.username,
      }),
      logger: config.logger,
    });
    const availableHands = config.handStore ? await config.handStore.listBySession(sessionId) : [];
    const baseSkillFilter = composeSkillFilters(
      buildRuntimeSkillFilter(availableHands),
      buildImageGenSkillFilter(config, sessionRecord.tenantId),
    );
    const tooling = await collectRuntimeTooling(
      config,
      identitySource?.username,
      // AND 组合：browser-hand filter 与 org agent 白名单叠加（不是替换）
      orgAgent ? composeSkillFilters(baseSkillFilter, buildOrgAgentSkillFilter(orgAgent)) : baseSkillFilter,
      orgAgent?.allowedSkills ?? [],
      { executionTransportRegistry, tenantHandResolver },
    );
    const instructions = options.skipSystemPrompt
      ? '你是运行在开沿科技公司开发的 Agent 平台上的 AI 助理。'
      : buildInstructions({
          sharedDir: config.sharedDir,
          tenantId: sessionRecord.tenantId,
          agentName,
          userName,
          persona,
          cwd,
          executionTarget,
          memorySearchEnabled,
          isPlatformAdmin,
          ...(orgAgent ? { orgAgent } : {}),
        });
    const approvalStore = createApprovalStoreForSession(config, sessionRecord, eventStore);
    const projection = new LegacyTranscriptProjection(transcriptPath);
    const modelAdapter = createModelAdapterForProtocol({ apiKey, baseUrl }, modelProviderOptions);
    const loop = new RawAgentLoop({
      modelAdapter,
      eventStore,
      approvalStore,
      transcriptProjection: projection,
      toolRuntime: applyToolProfile(new PlatformToolRuntime({
        memoryIndexService: config.memoryIndexService,
        executionTransportRegistry,
        handStore: config.handStore,
        resolveHandAuthToken: (hand) => tenantHandResolver.resolveForHand(hand),
        resolveWireEnv: buildTenantRemoteHandWireEnv,
        artifactService: config.artifactService,
        providers: [...tooling.providers, new SessionToolProvider(new SessionContextService(eventStore))],
        toolControls: config.toolControls,
      }), toolProfile),
      workspaceProvider: new LocalWorkspaceProvider(executionTarget),
      contextPolicy: config.contextPolicy,
      toolInvocationStore: config.toolInvocationStore,
      handStore: config.handStore,
      runStore: config.runStore,
    });

    try {
      const runContext = {
        runId,
        sessionId,
        model,
        cwd,
        workspaceId: sessionRecord.workspaceId ?? sessionId,
        sandboxScopeId,
        mountSubPath: workspaceMountSubPath,
        tenantId: sessionRecord.tenantId,
        executionTarget,
        sandboxPolicy,
        workerId: options.runtimeWorkerId,
        channelContext: context,
        approvalPolicy,
        hooks,
        signal: options.abortController?.signal,
      };
      let visionAnalysis;
      if (
        resolvedAttachments.some((attachment) => attachment.isImage)
        && !modelSupportsImage(modelProviderOptions?.inputModalities)
      ) {
        visionAnalysis = await analyzeImagesWithFallback(
          resolvedAttachments,
          config.getImageUnderstandingModelConfigs?.() ?? [],
          runContext,
          {
            timeoutMs: config.getImageUnderstandingTimeoutMs?.(),
            onAttempt: async (attempt) => {
              await eventStore.append({
                type: 'image_understanding',
                runId,
                sessionId,
                model: attempt.model,
                attachmentIds: resolvedAttachments
                  .filter((attachment) => attachment.isImage)
                  .map((attachment) => attachment.attachmentId),
                status: attempt.status,
                ...(attempt.usage ? { usage: attempt.usage } : {}),
                ...(attempt.error ? { error: attempt.error } : {}),
              });
              if (attempt.usage && identitySource?.username) {
                config.tokenUsageStore?.()?.recordResult({
                  username: identitySource.username,
                  tenantId: sessionRecord.tenantId ?? DEFAULT_TENANT_ID,
                  channel: 'vision',
                  modelUsage: { [attempt.model]: attempt.usage },
                  occurredAtMs: Date.now(),
                });
              }
            },
          },
        );
      }
      // /compact 平台命令（2026-07-03 真实现）：分流到上下文压缩，不进正常 agent run。
      // web / dingtalk / cron 任何通道发裸 "/compact" 行为一致。
      // instructions 传会话正常 system prompt——压缩请求与正常轮同构以命中 prompt cache。
      if (isCompactCommand(message.content)) {
        const runRecord = config.autoCompaction ? await config.runStore?.get(runId) : null;
        const isAutoCompactionRun = runRecord?.metadata?.autoCompaction === true;
        if (isAutoCompactionRun && config.autoCompaction) {
          // 让路：wake 到执行之间可能已有用户消息在排队 → 静默放弃本次压缩
          if (await config.autoCompaction.shouldYield(sessionId, runId)) {
            await config.runStore?.markStatus(runId, 'cancelled', 'auto_compaction_yield_to_user');
            logger.info(`[auto-compact] yield-at-wake session=${sessionId} run=${runId}`);
            yield { type: 'done' };
            return;
          }
          config.autoCompaction.registerActive(sessionId, runId);
          try {
            yield* loop.compact({ message, instructions }, runContext);
          } finally {
            config.autoCompaction.unregisterActive(sessionId, runId);
          }
        } else {
          yield* loop.compact({ message, instructions }, runContext);
        }
      } else {
        yield* loop.run(
          {
            message,
            prompt,
            attachments: resolvedAttachments,
            ...(visionAnalysis ? { visionAnalysis } : {}),
            recordUserMessage: options.recordUserMessage,
            ...(memoryContext ? { memoryContext } : {}),
            instructions,
            maxTurns: resolveEffectiveMaxTurns(config, options.maxTurns, {
              userId: context.user?.id ?? context.sessionOwner?.id,
              username: context.user?.username ?? context.sessionOwner?.username,
            }),
            connection: { apiKey, baseUrl },
          },
          runContext,
        );
        // post-run 自动压缩评估（fire-and-forget：绝不阻塞出站流收尾，错误内部吞掉）
        if (config.autoCompaction) {
          const autoCompaction = config.autoCompaction;
          void eventStore.list(sessionId)
            .then((allEvents) => autoCompaction.maybeScheduleAfterRun({
              sessionId,
              finishedRunId: runId,
              modelRef: sessionModelRef,
              model,
              tenantId: sessionRecord.tenantId,
              userId: identitySource?.id,
              channel: context.channel,
              executionTarget,
              workspaceId: sessionRecord.workspaceId,
              cwd,
              transcriptPath: sessionRecord.transcriptPath,
              events: allEvents,
            }))
            .catch(() => undefined);
        }
      }
      await sessionCatalog.markStatus(sessionId, 'idle');
    } catch (err) {
      if (options.abortController?.signal.aborted) {
        await sessionCatalog.markStatus(sessionId, 'idle').catch(() => undefined);
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      await markRunState(config.runStore, eventStore, sessionId, runId, 'failed', msg).catch(() => undefined);
      await sessionCatalog.markStatus(sessionId, 'error');
      logger.error(`Raw runtime run 失败: ${msg}`);
      yield { type: 'error', error: `Raw runtime 运行失败: ${msg}` };
    } finally {
      await directRuntimeLease?.release();
      if (lockHandle) await lockHandle.release().catch(() => undefined);
    }
  };
}

function buildRawRuntimeSandboxPolicy(
  config: RawRuntimeRunDispatchConfig,
  context: ChannelContext,
  cwd: string,
  executionTarget: ExecutionTargetKind,
): { denyRead: string[] } | undefined {
  if (executionTarget !== 'server-local') return undefined;
  const identity = context.sessionOwner ?? context.user;
  if (!identity || !config.agentCwd || !config.sharedDir) return undefined;
  // PR #31 transcript carve-out（与 engine/dispatch.ts 同策略）：
  // 完整身份（id + tenantId）齐备时给当前用户开 transcript 读洞，否则不开洞，
  // sandbox.ts 端默认 DENY ~/.agent-saas/legacy-transcripts 整目录兜底。
  const agentTranscriptDir = identity.id && identity.tenantId
    ? getAgentTranscriptDir({ tenantId: identity.tenantId, userId: identity.id })
    : undefined;
  const sandboxCtx: SandboxExpandContext = {
    username: identity.username,
    userCwd: cwd,
    tenantCwd: resolve(cwd, '..'),
    workspaceRoot: config.agentCwd,
    sharedDir: config.sharedDir,
    ...(agentTranscriptDir ? { agentTranscriptDir } : {}),
  };
  const denyRead = expandSandboxPaths(
    config.dispatch?.sandbox?.denyRead ?? DEFAULT_SANDBOX_DENY_READ,
    sandboxCtx,
  );
  return { denyRead };
}

export function createRawApprovalResumeDispatch(config: RawRuntimeRunDispatchConfig) {
  const logger = config.logger ?? noopLogger;
  const sessionCatalog = resolveSessionCatalog(config);
  const executionTransportRegistry = config.executionTransportRegistry ?? createDefaultExecutionTransportRegistry();
  if (config.serverRemote && !executionTransportRegistry.has('server-remote')) {
    executionTransportRegistry.register(
      'server-remote',
      new HttpTransport({
        baseUrl: config.serverRemote.baseUrl,
        authToken: config.serverRemote.authToken,
        invokeTimeoutMs: config.serverRemote.invokeTimeoutMs,
      }),
    );
  }
  const executionConfig = config.executionConfig
    ?? createExecutionConfig(config.executionTarget ? { defaultTarget: config.executionTarget } : undefined);
  const tenantHandResolver = getTenantRemoteHandResolver(config);

  return async function* rawApprovalResumeDispatch(
    request: RawApprovalResumeRequest,
  ): AsyncGenerator<OutboundEvent> {
    if (request.context.channel !== 'web') {
      yield { type: 'error', error: 'Raw approval resume 当前仅支持 Web 通道' };
      return;
    }

    // PR 2026-06-14 (γ): approval resume admin-only gate 解除（与 dispatch 同步）。
    // δ 阶段加 anonymous 防御：approval 路径上 user 也必须存在。
    if (!request.context.user && !request.context.sessionOwner) {
      yield { type: 'error', error: 'Raw approval resume 拒绝匿名访问：缺少 user / sessionOwner' };
      return;
    }
    const existingSession = await sessionCatalog.get(request.sessionId);
    const cwd = request.cwd ?? existingSession?.cwd;
    const transcriptPath = request.transcriptPath ?? existingSession?.transcriptPath;
    if (!cwd || !transcriptPath) {
      yield { type: 'error', error: `Raw approval resume 找不到 session 元数据: ${request.sessionId}` };
      return;
    }

    const requestedModel = request.model || existingSession?.modelRef;
    const { model, modelConnection, modelProviderOptions } = resolveRuntimeModelOptions(
      config,
      requestedModel,
      request.modelConnection,
      request.modelProviderOptions,
    );
    const apiKey = modelConnection?.apiKey || process.env.OPENAI_API_KEY;
    const baseUrl = modelConnection?.baseUrl || process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL;
    // approval resume 的 executionTarget 由调用方从 approval log / event log 推导（已实现），
    // 调用方应始终传入；缺省时退回 executionConfig.defaultTarget，避免重启场景下"目标漂移"。
    const executionTarget = request.executionTarget
      ?? existingSession?.executionTarget
      ?? resolveDefaultExecutionTargetForContext(executionConfig, request.context);
    const sandboxPolicy = buildRawRuntimeSandboxPolicy(config, request.context, cwd, executionTarget);
    const approvalPolicy = normalizeApprovalPolicy(request.approvalPolicy);
    if (!apiKey) {
      yield { type: 'error', error: 'Raw approval resume 缺少 OPENAI_API_KEY 或模型组 apiKey' };
      return;
    }
    const resumeToolProfile = normalizeToolProfile(request.toolProfile);

    // Session-level lock：resume 路径上 sessionId 已知，必须早于 catalog upsert
    // 和 loop.resumeApproval 占用，避免两个 brain 同时 wake 同一 session。
    const lockHandle = config.sessionLock ? await config.sessionLock.tryAcquire(request.sessionId) : null;
    if (config.sessionLock && !lockHandle) {
      yield { type: 'error', error: `Session ${request.sessionId} 已被另一个 brain 持有，本次 approval resume 退让` };
      return;
    }

    const identitySource = request.context.sessionOwner || request.context.user;
    const effectiveTenantId = resolveContextTenantId(request.context, existingSession);
    // 专职 Agent 覆盖（approval resume 同样应用，漏一处 = 审批恢复后越权）。
    // resume 路径 orgAgentId 只信 session meta（existingSession）。
    const orgAgentId = existingSession?.orgAgentId;
    const orgAgentResolution = resolveOrgAgentOverrides(config, orgAgentId, effectiveTenantId);
    if (orgAgentResolution && 'error' in orgAgentResolution) {
      if (lockHandle) await lockHandle.release().catch(() => undefined);
      logger.warn(`Org agent fail-closed (approval resume): session=${request.sessionId} orgAgentId=${orgAgentId}`);
      yield { type: 'error', error: orgAgentResolution.error };
      return;
    }
    const orgAgent = orgAgentResolution?.agent;
    const agentProfile = identitySource && config.agentStore
      ? config.agentStore.get(identitySource.username)
      : undefined;
    const agentName = orgAgent ? orgAgent.name : (agentProfile?.name || '开开');
    const userName = identitySource ? (identitySource.realName || identitySource.username || '') : '';
    const persona = orgAgent ? '' : ((await loadPersona(cwd)) || '');
    const memorySearchEnabled = !orgAgent
      && hasMemorySearchTool(config.memoryIndexService)
      && isToolEnabled(config.toolControls, 'MemorySearch');
    // resume 路径 identitySource 优先 sessionRecord.username（dispatch 首跑时已记录），
    // 防止重启 / anonymous 路径上 user.username 缺失导致 skill / MCP 全部消失。
    const resumeUsername = identitySource?.username || existingSession?.username || undefined;
    const resumeIsPlatformAdmin = resolveContextIsPlatformAdmin(request.context);
    const sessionModelRef = existingSession?.modelRef ?? request.model ?? model;

    const workspaceId = deriveRuntimeWorkspaceId({
      existingSession,
      fallbackSessionId: request.sessionId,
      identity: {
        id: identitySource?.id ?? existingSession?.userId,
        tenantId: effectiveTenantId,
      },
    });
    const sessionRecord: RuntimeSessionRecord = {
      ...(existingSession ?? createRuntimeSessionRecord({
        sessionId: request.sessionId,
        userId: identitySource?.id,
        username: identitySource?.username,
        userRole: identitySource?.role,
        tenantId: effectiveTenantId,
        channel: request.context.channel,
        cwd,
        modelRef: sessionModelRef,
        executionTarget,
        status: 'running',
      })),
      sessionId: request.sessionId,
      userId: identitySource?.id ?? existingSession?.userId ?? '',
      username: identitySource?.username ?? existingSession?.username ?? '',
      userRole: identitySource?.role
        ?? existingSession?.userRole
        ?? config.resolveUserRole?.({ userId: existingSession?.userId, username: existingSession?.username }),
      tenantId: effectiveTenantId,
      channel: request.context.channel,
      cwd,
      transcriptPath,
      modelRef: sessionModelRef,
      executionTarget,
      workspaceId,
      status: 'running',
      updatedAt: new Date().toISOString(),
    };
    await sessionCatalog.upsert(sessionRecord);
    const workspaceMountSubPath = deriveWorkspaceMountSubPath({ agentCwd: config.agentCwd, cwd });
    const sandboxScopeId = deriveSandboxScopeId({
      workspaceId: sessionRecord.workspaceId ?? request.sessionId,
      mountSubPath: workspaceMountSubPath,
    });

    const baseEventStore = createEventStoreForSession(config, sessionRecord);
    const eventStore = new RunStateTrackingEventStore(baseEventStore, config.runStore, sessionRecord.tenantId);
    const approvalStore = createApprovalStoreForSession(config, sessionRecord, eventStore);
    const pendingApproval = await approvalStore.get(request.approvalId);
    const resumeRunId = pendingApproval?.runId ?? `resume-${Date.now()}-${randomUUID()}`;
    enterSessionContext(request.sessionId, resumeRunId);
    let directRuntimeLease: DirectRuntimeLeaseHandle | null = null;
    await config.runStore?.upsertPending({
      runId: resumeRunId,
      sessionId: request.sessionId,
      userId: identitySource?.id ?? existingSession?.userId,
      // PR 5 修 P0-4：resume approval 路径透传 tenantId
      tenantId: sessionRecord.tenantId,
      model,
      channel: request.context.channel,
      executionTarget,
      workspaceId: sessionRecord.workspaceId,
      sandboxScopeId,
      metadata: { cwd, transcriptPath, approvalId: request.approvalId, sandboxScopeId, ...(workspaceMountSubPath ? { mountSubPath: workspaceMountSubPath } : {}), ...(approvalPolicy ? { approvalPolicy } : {}), ...(resumeToolProfile ? { toolProfile: resumeToolProfile } : {}) },
    });
    directRuntimeLease = await acquireDirectRuntimeRunLease({
      runStore: config.runStore,
      runId: resumeRunId,
      runtimeWorkerId: request.runtimeWorkerId,
      logger: config.logger,
    });
    await markRunState(config.runStore, eventStore, request.sessionId, resumeRunId, 'running');
    await ensureRuntimeHandRegistered({
      handStore: config.handStore,
      eventStore,
      executionTransportRegistry,
      executionTarget,
      sessionId: request.sessionId,
      workspaceId: sessionRecord.workspaceId ?? request.sessionId,
      workspaceMountSubPath,
      endpoint: executionTarget === 'server-remote' ? config.serverRemote?.baseUrl : undefined,
      serverRemoteRecipe: config.serverRemote?.recipe,
      tenantRemoteHands: resolveTenantRemoteHandsSource(config.tenantRemoteHands),
      tenantRemoteHandResolver: tenantHandResolver,
      userId: identitySource?.id ?? existingSession?.userId,
      username: identitySource?.username ?? existingSession?.username,
      userTenantId: config.resolveUserTenantId?.({
        userId: identitySource?.id ?? existingSession?.userId,
        username: identitySource?.username ?? existingSession?.username,
      }),
      logger: config.logger,
    });
    const availableHands = config.handStore ? await config.handStore.listBySession(request.sessionId) : [];
    const resumeBaseSkillFilter = composeSkillFilters(
      buildRuntimeSkillFilter(availableHands),
      buildImageGenSkillFilter(config, sessionRecord.tenantId),
    );
    const resumeTooling = await collectRuntimeTooling(
      config,
      resumeUsername,
      // AND 组合：browser-hand filter 与 org agent 白名单叠加（不是替换）
      orgAgent ? composeSkillFilters(resumeBaseSkillFilter, buildOrgAgentSkillFilter(orgAgent)) : resumeBaseSkillFilter,
      orgAgent?.allowedSkills ?? [],
      { executionTransportRegistry, tenantHandResolver },
    );
    const instructions = buildInstructions({
      sharedDir: config.sharedDir,
      tenantId: sessionRecord.tenantId,
      agentName,
      userName,
      persona,
      cwd,
      executionTarget,
      memorySearchEnabled,
      isPlatformAdmin: resumeIsPlatformAdmin,
      ...(orgAgent ? { orgAgent } : {}),
    });
    const projection = new LegacyTranscriptProjection(transcriptPath);
    const modelAdapter = createModelAdapterForProtocol({ apiKey, baseUrl }, modelProviderOptions);
    const loop = new RawAgentLoop({
      modelAdapter,
      eventStore,
      approvalStore,
      transcriptProjection: projection,
      toolRuntime: applyToolProfile(new PlatformToolRuntime({
        memoryIndexService: config.memoryIndexService,
        executionTransportRegistry,
        handStore: config.handStore,
        resolveHandAuthToken: (hand) => tenantHandResolver.resolveForHand(hand),
        resolveWireEnv: buildTenantRemoteHandWireEnv,
        artifactService: config.artifactService,
        providers: [...resumeTooling.providers, new SessionToolProvider(new SessionContextService(eventStore))],
        toolControls: config.toolControls,
      }), resumeToolProfile),
      workspaceProvider: new LocalWorkspaceProvider(executionTarget),
      contextPolicy: config.contextPolicy,
      toolInvocationStore: config.toolInvocationStore,
      handStore: config.handStore,
      runStore: config.runStore,
    });

    try {
      yield* loop.resumeApproval(
        {
          approvalId: request.approvalId,
          response: request.response,
          instructions,
          maxTurns: resolveEffectiveMaxTurns(config, request.maxTurns, {
            userId: request.context.user?.id ?? request.context.sessionOwner?.id,
            username: request.context.user?.username ?? request.context.sessionOwner?.username,
          }),
        },
        {
          runId: resumeRunId,
          sessionId: request.sessionId,
          model,
          cwd,
          workspaceId: sessionRecord.workspaceId ?? request.sessionId,
          sandboxScopeId,
          mountSubPath: workspaceMountSubPath,
          tenantId: sessionRecord.tenantId,
          executionTarget,
          sandboxPolicy,
          workerId: request.runtimeWorkerId,
          channelContext: request.context,
          approvalPolicy,
          hooks: request.hooks,
          signal: request.abortController?.signal,
        },
      );
      await sessionCatalog.markStatus(request.sessionId, 'idle');
    } catch (err) {
      if (request.abortController?.signal.aborted) {
        await sessionCatalog.markStatus(request.sessionId, 'idle').catch(() => undefined);
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      await markRunState(config.runStore, eventStore, request.sessionId, resumeRunId, 'failed', msg).catch(() => undefined);
      await sessionCatalog.markStatus(request.sessionId, 'error');
      logger.error(`Raw approval resume 失败: ${msg}`);
      yield { type: 'error', error: `Raw approval resume 失败: ${msg}` };
    } finally {
      await directRuntimeLease?.release();
      if (lockHandle) await lockHandle.release().catch(() => undefined);
    }
  };
}

export function createRawInteractionResumeDispatch(config: RawRuntimeRunDispatchConfig) {
  const logger = config.logger ?? noopLogger;
  const sessionCatalog = resolveSessionCatalog(config);
  const executionTransportRegistry = config.executionTransportRegistry ?? createDefaultExecutionTransportRegistry();
  if (config.serverRemote && !executionTransportRegistry.has('server-remote')) {
    executionTransportRegistry.register(
      'server-remote',
      new HttpTransport({
        baseUrl: config.serverRemote.baseUrl,
        authToken: config.serverRemote.authToken,
        invokeTimeoutMs: config.serverRemote.invokeTimeoutMs,
      }),
    );
  }
  const executionConfig = config.executionConfig
    ?? createExecutionConfig(config.executionTarget ? { defaultTarget: config.executionTarget } : undefined);
  const tenantHandResolver = getTenantRemoteHandResolver(config);

  return async function* rawInteractionResumeDispatch(
    request: RawInteractionResumeRequest,
  ): AsyncGenerator<OutboundEvent> {
    if (request.context.channel !== 'web') {
      yield { type: 'error', error: 'Raw interaction resume 当前仅支持 Web 通道' };
      return;
    }
    if (!request.context.user && !request.context.sessionOwner) {
      yield { type: 'error', error: 'Raw interaction resume 拒绝匿名访问：缺少 user / sessionOwner' };
      return;
    }
    const existingSession = await sessionCatalog.get(request.sessionId);
    const cwd = request.cwd ?? existingSession?.cwd;
    const transcriptPath = request.transcriptPath ?? existingSession?.transcriptPath;
    if (!cwd || !transcriptPath) {
      yield { type: 'error', error: `Raw interaction resume 找不到 session 元数据: ${request.sessionId}` };
      return;
    }

    const requestedModel = request.model || existingSession?.modelRef;
    const { model, modelConnection, modelProviderOptions } = resolveRuntimeModelOptions(
      config,
      requestedModel,
      request.modelConnection,
      request.modelProviderOptions,
    );
    const apiKey = modelConnection?.apiKey || process.env.OPENAI_API_KEY;
    const baseUrl = modelConnection?.baseUrl || process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL;
    const executionTarget = request.executionTarget
      ?? existingSession?.executionTarget
      ?? resolveDefaultExecutionTargetForContext(executionConfig, request.context);
    const sandboxPolicy = buildRawRuntimeSandboxPolicy(config, request.context, cwd, executionTarget);
    const approvalPolicy = normalizeApprovalPolicy(request.approvalPolicy);
    if (!apiKey) {
      yield { type: 'error', error: 'Raw interaction resume 缺少 OPENAI_API_KEY 或模型组 apiKey' };
      return;
    }
    const resumeToolProfile = normalizeToolProfile(request.toolProfile);

    const lockHandle = config.sessionLock ? await config.sessionLock.tryAcquire(request.sessionId) : null;
    if (config.sessionLock && !lockHandle) {
      yield { type: 'error', error: `Session ${request.sessionId} 已被另一个 brain 持有，本次 interaction resume 退让` };
      return;
    }

    const identitySource = request.context.sessionOwner || request.context.user;
    const effectiveTenantId = resolveContextTenantId(request.context, existingSession);
    // 专职 Agent 覆盖（interaction resume 同样应用，漏一处 = 交互恢复后越权）。
    // resume 路径 orgAgentId 只信 session meta（existingSession）。
    const orgAgentId = existingSession?.orgAgentId;
    const orgAgentResolution = resolveOrgAgentOverrides(config, orgAgentId, effectiveTenantId);
    if (orgAgentResolution && 'error' in orgAgentResolution) {
      if (lockHandle) await lockHandle.release().catch(() => undefined);
      logger.warn(`Org agent fail-closed (interaction resume): session=${request.sessionId} orgAgentId=${orgAgentId}`);
      yield { type: 'error', error: orgAgentResolution.error };
      return;
    }
    const orgAgent = orgAgentResolution?.agent;
    const agentProfile = identitySource && config.agentStore
      ? config.agentStore.get(identitySource.username)
      : undefined;
    const agentName = orgAgent ? orgAgent.name : (agentProfile?.name || '开开');
    const userName = identitySource ? (identitySource.realName || identitySource.username || '') : '';
    const persona = orgAgent ? '' : ((await loadPersona(cwd)) || '');
    const memorySearchEnabled = !orgAgent
      && hasMemorySearchTool(config.memoryIndexService)
      && isToolEnabled(config.toolControls, 'MemorySearch');
    const resumeUsername = identitySource?.username || existingSession?.username || undefined;
    const resumeIsPlatformAdmin = resolveContextIsPlatformAdmin(request.context);
    const sessionModelRef = existingSession?.modelRef ?? request.model ?? model;

    const workspaceId = deriveRuntimeWorkspaceId({
      existingSession,
      fallbackSessionId: request.sessionId,
      identity: {
        id: identitySource?.id ?? existingSession?.userId,
        tenantId: effectiveTenantId,
      },
    });
    const sessionRecord: RuntimeSessionRecord = {
      ...(existingSession ?? createRuntimeSessionRecord({
        sessionId: request.sessionId,
        userId: identitySource?.id,
        username: identitySource?.username,
        userRole: identitySource?.role,
        tenantId: effectiveTenantId,
        channel: request.context.channel,
        cwd,
        modelRef: sessionModelRef,
        executionTarget,
        status: 'running',
      })),
      sessionId: request.sessionId,
      userId: identitySource?.id ?? existingSession?.userId ?? '',
      username: identitySource?.username ?? existingSession?.username ?? '',
      userRole: identitySource?.role
        ?? existingSession?.userRole
        ?? config.resolveUserRole?.({ userId: existingSession?.userId, username: existingSession?.username }),
      tenantId: effectiveTenantId,
      channel: request.context.channel,
      cwd,
      transcriptPath,
      modelRef: sessionModelRef,
      executionTarget,
      workspaceId,
      status: 'running',
      updatedAt: new Date().toISOString(),
    };
    await sessionCatalog.upsert(sessionRecord);
    const workspaceMountSubPath = deriveWorkspaceMountSubPath({ agentCwd: config.agentCwd, cwd });
    const sandboxScopeId = deriveSandboxScopeId({
      workspaceId: sessionRecord.workspaceId ?? request.sessionId,
      mountSubPath: workspaceMountSubPath,
    });

    const baseEventStore = createEventStoreForSession(config, sessionRecord);
    const eventStore = new RunStateTrackingEventStore(baseEventStore, config.runStore, sessionRecord.tenantId);
    const priorEvents = await eventStore.list(request.sessionId);
    const requestEvent = [...priorEvents].reverse().find((event): event is Extract<PlatformEvent, { type: 'interaction_requested' }> => (
      event.type === 'interaction_requested'
      && event.sessionId === request.sessionId
      && event.interactionId === request.interactionId
      && event.interactionType === 'ask_user'
    ));
    const resolution = getInteractionResolution(priorEvents, request.sessionId, request.interactionId);
    if (!requestEvent) {
      if (lockHandle) await lockHandle.release().catch(() => undefined);
      yield { type: 'error', error: `Raw interaction resume 找不到 interaction_requested: ${request.interactionId}` };
      return;
    }
    if (!resolution) {
      if (lockHandle) await lockHandle.release().catch(() => undefined);
      yield { type: 'error', error: `Raw interaction resume 缺少 durable interaction_resolved: ${request.interactionId}` };
      return;
    }
    const resumeRunId = requestEvent.runId ?? `resume-${Date.now()}-${randomUUID()}`;
    enterSessionContext(request.sessionId, resumeRunId);
    let directRuntimeLease: DirectRuntimeLeaseHandle | null = null;
    await config.runStore?.upsertPending({
      runId: resumeRunId,
      sessionId: request.sessionId,
      userId: identitySource?.id ?? existingSession?.userId,
      // PR 5 修 P0-4：resume interaction 路径透传 tenantId
      tenantId: sessionRecord.tenantId,
      model,
      channel: request.context.channel,
      executionTarget,
      workspaceId: sessionRecord.workspaceId,
      sandboxScopeId,
      metadata: { cwd, transcriptPath, interactionId: request.interactionId, sandboxScopeId, ...(workspaceMountSubPath ? { mountSubPath: workspaceMountSubPath } : {}), ...(approvalPolicy ? { approvalPolicy } : {}), ...(resumeToolProfile ? { toolProfile: resumeToolProfile } : {}) },
    });
    directRuntimeLease = await acquireDirectRuntimeRunLease({
      runStore: config.runStore,
      runId: resumeRunId,
      runtimeWorkerId: request.runtimeWorkerId,
      logger: config.logger,
    });
    await markRunState(config.runStore, eventStore, request.sessionId, resumeRunId, 'running');
    await ensureRuntimeHandRegistered({
      handStore: config.handStore,
      eventStore,
      executionTransportRegistry,
      executionTarget,
      sessionId: request.sessionId,
      workspaceId: sessionRecord.workspaceId ?? request.sessionId,
      workspaceMountSubPath,
      endpoint: executionTarget === 'server-remote' ? config.serverRemote?.baseUrl : undefined,
      serverRemoteRecipe: config.serverRemote?.recipe,
      tenantRemoteHands: resolveTenantRemoteHandsSource(config.tenantRemoteHands),
      tenantRemoteHandResolver: tenantHandResolver,
      userId: identitySource?.id ?? existingSession?.userId,
      username: identitySource?.username ?? existingSession?.username,
      userTenantId: config.resolveUserTenantId?.({
        userId: identitySource?.id ?? existingSession?.userId,
        username: identitySource?.username ?? existingSession?.username,
      }),
      logger: config.logger,
    });
    const availableHands = config.handStore ? await config.handStore.listBySession(request.sessionId) : [];
    const resumeBaseSkillFilter = composeSkillFilters(
      buildRuntimeSkillFilter(availableHands),
      buildImageGenSkillFilter(config, sessionRecord.tenantId),
    );
    const resumeTooling = await collectRuntimeTooling(
      config,
      resumeUsername,
      // AND 组合：browser-hand filter 与 org agent 白名单叠加（不是替换）
      orgAgent ? composeSkillFilters(resumeBaseSkillFilter, buildOrgAgentSkillFilter(orgAgent)) : resumeBaseSkillFilter,
      orgAgent?.allowedSkills ?? [],
      { executionTransportRegistry, tenantHandResolver },
    );
    const instructions = buildInstructions({
      sharedDir: config.sharedDir,
      tenantId: sessionRecord.tenantId,
      agentName,
      userName,
      persona,
      cwd,
      executionTarget,
      memorySearchEnabled,
      isPlatformAdmin: resumeIsPlatformAdmin,
      ...(orgAgent ? { orgAgent } : {}),
    });
    const projection = new LegacyTranscriptProjection(transcriptPath);
    const modelAdapter = createModelAdapterForProtocol({ apiKey, baseUrl }, modelProviderOptions);
    const loop = new RawAgentLoop({
      modelAdapter,
      eventStore,
      approvalStore: createApprovalStoreForSession(config, sessionRecord, eventStore),
      transcriptProjection: projection,
      toolRuntime: applyToolProfile(new PlatformToolRuntime({
        memoryIndexService: config.memoryIndexService,
        executionTransportRegistry,
        handStore: config.handStore,
        resolveHandAuthToken: (hand) => tenantHandResolver.resolveForHand(hand),
        resolveWireEnv: buildTenantRemoteHandWireEnv,
        artifactService: config.artifactService,
        providers: [...resumeTooling.providers, new SessionToolProvider(new SessionContextService(eventStore))],
        toolControls: config.toolControls,
      }), resumeToolProfile),
      workspaceProvider: new LocalWorkspaceProvider(executionTarget),
      contextPolicy: config.contextPolicy,
      toolInvocationStore: config.toolInvocationStore,
      handStore: config.handStore,
      runStore: config.runStore,
    });

    try {
      yield* loop.resumeInteraction(
        {
          interactionId: request.interactionId,
          response: normalizeInteractionResponse(resolution.response ?? request.response),
          instructions,
          maxTurns: resolveEffectiveMaxTurns(config, request.maxTurns, {
            userId: request.context.user?.id ?? request.context.sessionOwner?.id,
            username: request.context.user?.username ?? request.context.sessionOwner?.username,
          }),
        },
        {
          runId: resumeRunId,
          sessionId: request.sessionId,
          model,
          cwd,
          workspaceId: sessionRecord.workspaceId ?? request.sessionId,
          sandboxScopeId,
          mountSubPath: workspaceMountSubPath,
          tenantId: sessionRecord.tenantId,
          executionTarget,
          sandboxPolicy,
          workerId: request.runtimeWorkerId,
          channelContext: request.context,
          approvalPolicy,
          hooks: request.hooks,
          signal: request.abortController?.signal,
        },
      );
      await sessionCatalog.markStatus(request.sessionId, 'idle');
    } catch (err) {
      if (request.abortController?.signal.aborted) {
        await sessionCatalog.markStatus(request.sessionId, 'idle').catch(() => undefined);
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      await markRunState(config.runStore, eventStore, request.sessionId, resumeRunId, 'failed', msg).catch(() => undefined);
      await sessionCatalog.markStatus(request.sessionId, 'error');
      logger.error(`Raw interaction resume 失败: ${msg}`);
      yield { type: 'error', error: `Raw interaction resume 失败: ${msg}` };
    } finally {
      await directRuntimeLease?.release();
      if (lockHandle) await lockHandle.release().catch(() => undefined);
    }
  };
}

export async function loadRawRuntimeWakeState(
  config: RawRuntimeRunDispatchConfig,
  sessionId: string,
): Promise<RawRuntimeWakeState | null> {
  const sessionCatalog = resolveSessionCatalog(config);
  const session = await sessionCatalog.get(sessionId);
  if (!session) return null;
  const eventStore = createEventStoreForSession(config, session);
  const approvalStore = createApprovalStoreForSession(config, session, eventStore);
  const events = await eventStore.list(sessionId);
  const approvals = await approvalStore.list(sessionId);
  const replayState = buildRuntimeReplayState(events, approvals, sessionId);
  return { session, events, approvals, replayState };
}

export async function wakeRuntimeSession(
  config: RawRuntimeRunDispatchConfig,
  run: RunRecord,
  options: WakeRuntimeSessionOptions = {},
): Promise<void> {
  const sessionCatalog = resolveSessionCatalog(config);
  const session = await sessionCatalog.get(run.sessionId);
  if (!session) {
    throw new Error(`wake context restore failed: session metadata not found for ${run.sessionId}`);
  }
  // 子 agent run 守卫（2026-07-06）：MVP 是父死子亡语义，子 run 绝不允许 scheduler
  // 恢复重放（重放 = 双份模型执行 + 双份计费）。正常路径下 subagentRunner 持有
  // lease 让 listRecoverable 捡不到执行中的子 run；这里兜底进程崩溃后 lease 过期
  // 的残留——直接判 orphaned，不做任何模型/工具调用。
  if (session.kind === 'subagent' || run.metadata?.subagent === true) {
    await options.lease?.release('orphaned', 'subagent_run_not_recoverable');
    await markRunState(
      config.runStore,
      new RunStateTrackingEventStore(createEventStoreForSession(config, session), config.runStore, session.tenantId ?? run.tenantId),
      run.sessionId,
      run.runId,
      'orphaned',
      'subagent_run_not_recoverable',
    ).catch(() => undefined);
    return;
  }
  const baseEventStore = createEventStoreForSession(config, session);
  const eventStore = new RunStateTrackingEventStore(
    baseEventStore,
    config.runStore,
    session.tenantId ?? run.tenantId,
  );
  const events = await eventStore.list(run.sessionId);
  const cancelRequested = events.some((event) => (
    event.type === 'run_cancel_requested'
    && (event.runId === run.runId || (!event.runId && event.sessionId === run.sessionId))
  ));
  if (cancelRequested) {
    await options.lease?.release('cancelled', 'cancel_requested_before_wake');
    await appendRunStateChanged(eventStore, run.sessionId, run.runId, 'cancelled', run.status, 'cancel_requested_before_wake');
    return;
  }

  const resumeApprovalCandidate = isResumeApprovalMetadata(run.metadata?.resumeApproval) ? run.metadata.resumeApproval : null;
  const resumeApprovalConsumed = resumeApprovalCandidate
    ? isConsumedResume(run.metadata, 'resumeApprovalConsumed', resumeApprovalCandidate.approvalId)
    : false;
  const resumeApproval = resumeApprovalCandidate && !resumeApprovalConsumed ? resumeApprovalCandidate : null;
  const resumeInteractionCandidate = isResumeInteractionMetadata(run.metadata?.resumeInteraction) ? run.metadata.resumeInteraction : null;
  const resumeInteractionConsumed = resumeInteractionCandidate
    ? isConsumedResume(run.metadata, 'resumeInteractionConsumed', resumeInteractionCandidate.interactionId)
    : false;
  const resumeInteraction = resumeInteractionCandidate && !resumeInteractionConsumed ? resumeInteractionCandidate : null;
  const approvalPolicy = normalizeApprovalPolicy(run.metadata?.approvalPolicy);
  const wakeToolProfile = normalizeToolProfile(run.metadata?.toolProfile);
  const pendingApproval = [...events].reverse().find((event): event is Extract<PlatformEvent, { type: 'approval_requested' }> => (
    event.type === 'approval_requested'
    && event.sessionId === run.sessionId
  ));
  const pendingAskUser = buildPendingInteractionsFromEvents(events, run.sessionId)
    .find((interaction) => interaction.type === 'ask_user');
  if (!resumeApproval && !resumeInteraction && pendingApproval && !events.some((event) => (
    event.type === 'approval_resolved'
    && event.approvalId === pendingApproval.approvalId
  ))) {
    await options.lease?.release('waiting_approval', 'wake_deferred_pending_approval');
    return;
  }
  if (!resumeInteraction && pendingAskUser) {
    await options.lease?.release('waiting_user', 'wake_deferred_pending_ask_user');
    return;
  }

  // Wake-time workspace provisioning. PR 8 enqueue-only 路径绕过了 engine/dispatch.ts
  // 的 ensureUserWorkspace 调用，新 tenant / 新用户首跑必踩 cwd 物理目录不存在
  // 导致 hand-server spawn ENOENT。这里在调 dispatch 之前先 provision，让 PR 4
  // 扁平→tenant 层迁移与首次目录初始化在 wake 时就完成。
  // 早返回分支（cancel / waiting_approval / waiting_user）已经在前面 return，
  // 不会经过这段——只有真要调模型/工具时才付 provisioning 成本。
  if (config.workspaceProvisioner) {
    try {
      await config.workspaceProvisioner({
        userId: session.userId,
        username: session.username,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await options.lease?.release('failed', `workspace_provision_failed:${reason}`);
      await appendRunStateChanged(eventStore, run.sessionId, run.runId, 'failed', run.status, `workspace_provision_failed:${reason}`);
      return;
    }
  }

  if (resumeApproval) {
    const hasInteractionResolved = events.some((event) => (
      event.type === 'interaction_resolved'
      && event.sessionId === run.sessionId
      && event.interactionId === resumeApproval.approvalId
    ));
    const hasApprovalResolved = events.some((event) => (
      event.type === 'approval_resolved'
      && event.sessionId === run.sessionId
      && event.approvalId === resumeApproval.approvalId
    ));
    if (!hasInteractionResolved || hasApprovalResolved) {
      await options.lease?.release(hasApprovalResolved ? 'completed' : 'failed', hasApprovalResolved ? 'approval_already_resolved' : 'missing_interaction_resolved_command');
      return;
    }
    await config.runStore?.markStatus(run.runId, 'running', 'approval_resume_wake_started', {
      resumeApprovalConsumedAt: new Date().toISOString(),
      resumeApprovalConsumedId: resumeApproval.approvalId,
    });
    const dispatch = createRawApprovalResumeDispatch(config);
    const abortController = new AbortController();
    runtimeRunController.register(run.runId, abortController);
    const renewTimer = startWakeLeaseRenewal({
      lease: options.lease,
      runStore: config.runStore,
      runId: run.runId,
      abortController,
      intervalMs: options.renewIntervalMs ?? 30_000,
    });
    try {
      for await (const event of dispatch({
        approvalId: resumeApproval.approvalId,
        response: resumeApproval.response,
        sessionId: run.sessionId,
        transcriptPath: session.transcriptPath,
        cwd: session.cwd,
        context: {
          channel: 'web',
          resumeSessionId: run.sessionId,
          sessionOwner: resolveWakeSessionOwner(config, session, run.userId),
          targetCwd: session.cwd,
        },
        model: run.model ?? session.modelRef,
        executionTarget: run.executionTarget ?? session.executionTarget,
        approvalPolicy,
        ...(wakeToolProfile ? { toolProfile: wakeToolProfile } : {}),
        abortController,
        runtimeWorkerId: options.lease?.workerId,
      })) {
        await options.onOutboundEvent?.(event, { runId: run.runId, sessionId: run.sessionId });
        if (event.type === 'error') throw new Error(event.error ?? 'approval resume wake failed');
      }
      const current = await config.runStore?.get(run.runId);
      await options.lease?.release(current?.status, current?.statusReason ?? 'approval_resume_wake_completed');
    } finally {
      if (renewTimer) clearInterval(renewTimer);
      runtimeRunController.unregister(run.runId);
    }
    return;
  }

  if (resumeInteraction) {
    const resolution = getInteractionResolution(events, run.sessionId, resumeInteraction.interactionId);
    if (!resolution) {
      await options.lease?.release('failed', 'missing_interaction_resolved_command');
      return;
    }
    await config.runStore?.markStatus(run.runId, 'running', 'interaction_resume_wake_started', {
      resumeInteractionConsumedAt: new Date().toISOString(),
      resumeInteractionConsumedId: resumeInteraction.interactionId,
    });
    const dispatch = createRawInteractionResumeDispatch(config);
    const abortController = new AbortController();
    runtimeRunController.register(run.runId, abortController);
    const renewTimer = startWakeLeaseRenewal({
      lease: options.lease,
      runStore: config.runStore,
      runId: run.runId,
      abortController,
      intervalMs: options.renewIntervalMs ?? 30_000,
    });
    try {
      for await (const event of dispatch({
        interactionId: resumeInteraction.interactionId,
        response: normalizeInteractionResponse(resolution.response ?? resumeInteraction.response),
        sessionId: run.sessionId,
        transcriptPath: session.transcriptPath,
        cwd: session.cwd,
        context: {
          channel: 'web',
          resumeSessionId: run.sessionId,
          sessionOwner: resolveWakeSessionOwner(config, session, run.userId),
          targetCwd: session.cwd,
        },
        model: run.model ?? session.modelRef,
        executionTarget: run.executionTarget ?? session.executionTarget,
        approvalPolicy,
        ...(wakeToolProfile ? { toolProfile: wakeToolProfile } : {}),
        abortController,
        runtimeWorkerId: options.lease?.workerId,
      })) {
        await options.onOutboundEvent?.(event, { runId: run.runId, sessionId: run.sessionId });
        if (event.type === 'error') throw new Error(event.error ?? 'interaction resume wake failed');
      }
      const current = await config.runStore?.get(run.runId);
      await options.lease?.release(current?.status, current?.statusReason ?? 'interaction_resume_wake_completed');
    } finally {
      if (renewTimer) clearInterval(renewTimer);
      runtimeRunController.unregister(run.runId);
    }
    return;
  }

  const wakePrompt = resolveWakePrompt(run, events, session);
  const context: ChannelContext = {
    channel: 'web',
    resumeSessionId: run.sessionId,
    sessionOwner: resolveWakeSessionOwner(config, session, run.userId),
    targetCwd: session.cwd,
  };
  const dispatch = createRawRuntimeRunDispatch(config);
  const abortController = new AbortController();
  runtimeRunController.register(run.runId, abortController);
  const renewTimer = startWakeLeaseRenewal({
    lease: options.lease,
    runStore: config.runStore,
    runId: run.runId,
    abortController,
    intervalMs: options.renewIntervalMs ?? 30_000,
  });
  try {
    for await (const event of dispatch(
      wakePrompt.message,
      context,
      {
        runtimeRunId: run.runId,
        resumeSessionId: run.sessionId,
        cwd: session.cwd,
        model: run.model ?? session.modelRef,
        executionTarget: run.executionTarget ?? session.executionTarget,
        approvalPolicy,
        ...(wakeToolProfile ? { toolProfile: wakeToolProfile } : {}),
        recordUserMessage: wakePrompt.recordUserMessage,
        abortController,
        runtimeWorkerId: options.lease?.workerId,
      },
    )) {
      await options.onOutboundEvent?.(event, { runId: run.runId, sessionId: run.sessionId });
      if (event.type === 'error') {
        throw new Error(event.error ?? 'wake dispatch failed');
      }
    }
    const current = await config.runStore?.get(run.runId);
    await options.lease?.release(current?.status, current?.statusReason ?? 'wake_completed');
  } finally {
    if (renewTimer) clearInterval(renewTimer);
    runtimeRunController.unregister(run.runId);
  }
}

function startWakeLeaseRenewal(input: {
  lease?: RuntimeWakeLease;
  runStore?: RunStore;
  runId: string;
  abortController: AbortController;
  intervalMs: number;
}): NodeJS.Timeout | null {
  if (!input.lease) return null;
  const timer = setInterval(() => {
    void (async () => {
      try {
        await input.lease?.renew();
      } catch (err) {
        const current = await input.runStore?.get(input.runId).catch(() => null);
        if (isTerminalRunStatus(current?.status)) {
          clearInterval(timer);
          return;
        }
        input.abortController.abort(err instanceof Error ? err : new Error(String(err)));
      }
    })();
  }, input.intervalMs);
  timer.unref?.();
  return timer;
}

function isTerminalRunStatus(status: RunStatus | undefined): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'orphaned';
}


export const HIDDEN_WAKE_CONTINUE_PROMPT =
  'Continue the interrupted managed-agent run from the durable session context. '
  + 'Do not treat this as a new user request. Do not restart completed work; continue from the latest completed event.';

export function resolveWakePrompt(
  run: RunRecord,
  events: PlatformEvent[],
  session: RuntimeSessionRecord,
): { message: InboundMessage; recordUserMessage: boolean } {
  const hasPersistedUserMessage = events.some((event) => (
    event.type === 'user_message'
    && event.sessionId === run.sessionId
    && event.runId === run.runId
  ));
  if (!hasPersistedUserMessage) {
    return { message: restoreWakeMessage(run, events, session), recordUserMessage: true };
  }
  return {
    message: {
      channel: 'web',
      chatId: run.sessionId,
      content: HIDDEN_WAKE_CONTINUE_PROMPT,
      senderId: session.userId ?? run.userId,
      senderName: session.username,
      metadata: {
        schedulerWake: true,
        originalRunId: run.runId,
        hiddenContinuation: true,
      },
    },
    recordUserMessage: false,
  };
}

function isResumeApprovalMetadata(value: unknown): value is { approvalId: string; response: InteractionResponse } {
  if (!value || typeof value !== 'object') return false;
  const obj = value as { approvalId?: unknown; response?: unknown; consumedAt?: unknown; resumeApprovalConsumedAt?: unknown };
  if (typeof obj.consumedAt === 'string' || typeof obj.resumeApprovalConsumedAt === 'string') return false;
  if (typeof obj.approvalId !== 'string' || !obj.response || typeof obj.response !== 'object') return false;
  const response = obj.response as { allow?: unknown };
  return typeof response.allow === 'boolean';
}

function isResumeInteractionMetadata(value: unknown): value is { interactionId: string; response: InteractionResponse } {
  if (!value || typeof value !== 'object') return false;
  const obj = value as { interactionId?: unknown; response?: unknown; consumedAt?: unknown; resumeInteractionConsumedAt?: unknown };
  if (typeof obj.consumedAt === 'string' || typeof obj.resumeInteractionConsumedAt === 'string') return false;
  if (typeof obj.interactionId !== 'string' || !obj.response || typeof obj.response !== 'object') return false;
  return true;
}

function isConsumedResume(
  metadata: Record<string, unknown>,
  prefix: 'resumeApprovalConsumed' | 'resumeInteractionConsumed',
  id: string,
): boolean {
  return typeof metadata[`${prefix}At`] === 'string'
    && metadata[`${prefix}Id`] === id;
}

function restoreWakeMessage(
  run: RunRecord,
  events: PlatformEvent[],
  session: RuntimeSessionRecord,
): InboundMessage {
  const metadataMessage = isWakeMessage(run.metadata?.wakeMessage) ? run.metadata.wakeMessage : null;
  const submitted = [...events].reverse().find((event): event is Extract<PlatformEvent, { type: 'user_message_submitted' }> => (
    event.type === 'user_message_submitted'
    && (!event.sessionId || event.sessionId === run.sessionId)
  ));
  const priorUserMessage = [...events].reverse().find((event): event is Extract<PlatformEvent, { type: 'user_message' }> => (
    event.type === 'user_message'
    && event.sessionId === run.sessionId
    && event.runId === run.runId
  ));
  return {
    channel: 'web',
    chatId: metadataMessage?.chatId ?? run.sessionId,
    content: metadataMessage?.content ?? submitted?.content ?? priorUserMessage?.content ?? 'Continue the interrupted managed-agent run from durable session context.',
    senderId: metadataMessage?.senderId ?? session.userId ?? run.userId,
    senderName: metadataMessage?.senderName ?? session.username,
    attachments: metadataMessage?.attachments,
    metadata: {
      ...(metadataMessage?.metadata ?? {}),
      schedulerWake: true,
      originalRunId: run.runId,
    },
  };
}

function isWakeMessage(value: unknown): value is {
  channel?: string;
  chatId?: string;
  content: string;
  senderId?: string;
  senderName?: string;
  attachments?: InboundMessage['attachments'];
  metadata?: Record<string, unknown>;
} {
  return !!value
    && typeof value === 'object'
    && typeof (value as { content?: unknown }).content === 'string';
}
