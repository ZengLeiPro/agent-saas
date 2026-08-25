import type { AgentRunHooks, InteractionResponse, RuntimeDrainHandoffState, ToolApprovalPolicyOptions } from '../agent/types.js';
import type { AgentRuntimeProfileResolver } from './agentProfiles.js';
import type { AgentStore } from '../data/agents/store.js';
import type { OrgAgentStore } from '../data/orgAgents/store.js';
import type { BillingService } from '../data/billing/service.js';
import type { RunPreflightService } from './runPreflight.js';
import type { PgRunResolutionSnapshotStore } from './runResolutionSnapshotStore.js';
import type { TenantStore } from '../data/tenants/store.js';
import type { PgEnvironmentStore } from '../data/environments/index.js';
import type { TokenUsageStore } from '../data/usage/store.js';
import type { MemoryIndexService } from '../memory/index/service.js';
import type { UserOverrides } from '../security/extraDirs.js';
import type { DispatchConfig } from '../app/config.js';
import type { ArtifactService } from './artifactService.js';
import type { ChannelContext, ModelProviderOptions, OutboundEvent } from '../types/index.js';
import type { ExecutionTargetKind } from '../agent/toolRuntime.js';
import type { SkillEntry } from '../agent/skillToolProvider.js';
import type { BuiltinToolsConfig } from '../agent/builtinTools.js';
import type { ResolvedWebToolsConfig } from '../agent/webToolProvider.js';
import type { ResolvedImageGenToolsConfig } from '../agent/imageGenToolProvider.js';
import type { ResolvedAudioTranscribeToolsConfig } from '../agent/audioTranscribeToolProvider.js';
import type { UserActivityService } from './userActivityService.js';
import type { McpClientManager } from '../mcp/clientManager.js';
import type { McpProxy } from '../mcp/proxy.js';
import type { ExecutionTransportRegistry } from './executionTransport.js';
import type { ModelAdapter, ApprovalRecord, ApprovalStore, EventStore, PlatformEvent } from './types.js';
import type { CodexResponsesWebSocketPool } from './responses/codexResponsesWebSocketPool.js';
import type { CodexCredentialManager } from './responses/codexCredentialManager.js';
import type { ExecutionConfig } from './executionConfig.js';
import type { ImageUnderstandingModelConfig } from './imageUnderstanding.js';
import type { SystemPromptId } from '../systemPrompts/types.js';
import type { ContextReconstructionPolicy } from './contextProjection.js';
import type { RuntimeReplayState } from './replay.js';
import type { OrgAgentCollectionAssignmentPin, RuntimeSessionRecord, SessionCatalog } from './sessionCatalog.js';
import type { RunStore } from './runStore.js';
import type { HandStore, WorkspaceRecipe } from './handStore.js';
import type { TenantRemoteHandAuthTokenResolver } from './tenantRemoteHandResolver.js';
import type { RuntimeWakeLease } from './runtimeWakeLeaseLifecycle.js';
import type { SecretVault } from '../security/secretVault.js';
import type { NetworkPolicyConfig } from './networkPolicy.js';
import type { ToolInvocationStore } from './toolInvocationStore.js';
import type { BackgroundTaskRuntime } from './background/backgroundTaskRuntime.js';

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

export interface SessionLockAcquireOptions {
  onLost?: (reason: Error) => void;
}

export interface SessionLockAcquirer {
  tryAcquire(
    sessionId: string,
    options?: SessionLockAcquireOptions,
  ): Promise<SessionLockHandle | null>;
}


export interface ModelAdapterFactoryDependencies {
  codexCredentialManager?: CodexCredentialManager;
  codexFetch?: typeof fetch;
  codexWebSocketPool?: CodexResponsesWebSocketPool;
}

export type ModelAdapterFactory = (
  connection: { apiKey?: string; baseUrl?: string },
  modelProviderOptions?: ModelProviderOptions,
) => ModelAdapter;


export interface SkillsDispatchConfig {
  /** requiredSkillIds 由专职 Agent 提供，是独立于成员个人勾选的固有能力。 */
  listForUser(
    username: string | undefined,
    requiredSkillIds?: readonly string[],
    tenantId?: string,
  ): SkillEntry[];
  resolveSkillDir(
    username: string | undefined,
    skill: string,
    requiredSkillIds?: readonly string[],
    tenantId?: string,
  ): string | null;
  /** 工具清单装配前完成真实成员的增量物化；service identity 不走成员物化。 */
  ensureReady?: (username: string | undefined, requiredSkillIds?: readonly string[]) => Promise<void>;
}

export interface RawRuntimeRunDispatchConfig {
  agentCwd: string;
  /**
   * `workspace-shared` 绝对路径。`buildInstructions()` 从 `${sharedDir}/prompts/*.md`
   * 加载 system prompt 片段；同时 `${sharedDir}/tenants/<tenantId>/company.md` 作为 `{{COMPANY_INFO}}` 注入。
   */
  sharedDir: string;
  /** Process-level model adapter factory; app runtime injects Codex OAuth transport here. */
  modelAdapterFactory?: ModelAdapterFactory;
  /** 平台系统提示语注册表 getter；每次运行现取，以支持管理端热更新。 */
  getSystemPrompt?: (id: SystemPromptId) => string;
  /** Run 执行边界刷新跨进程共享配置；普通 dispatch、resume 与 scheduler wake 均调用。 */
  refreshSharedConfig?: () => void;
  /** Stable entity + immutable version resolver. New sessions read current binding once; resumes use the pinned version. */
  agentRuntimeProfileResolver?: AgentRuntimeProfileResolver;
  memory?: { enabled?: boolean; maxLines?: number };
  memoryIndexService?: MemoryIndexService | null;
  /**
   * 记忆写入职责剥离（2026-07-29 批次）：租户是否对**新会话**启用 v2 策略
   * （主 Agent 只读 + 后台唯一写入）。已固定 pin 的会话不受开关变化影响。
   * 缺省 = 全部 v1（历史行为，工具面零变化）。
   */
  memoryWriteDelegationEnabled?: (tenantId: string | undefined) => boolean;
  /**
   * 记忆控制工具 provider（现仅 MemoryCommand）。注册进所有 run 的
   * PlatformToolRuntime，但可见性由 profile 与 memoryPolicyVersion 过滤。
   */
  memoryControlProviders?: import('../agent/toolRuntime.js').ToolProvider[];
  agentStore?: AgentStore;
  /** 公司级专职 Agent store。orgAgentId 会话解析限定提示语 + skill 白名单用；未配置时 orgAgentId 会话 fail-closed。 */
  orgAgentStore?: OrgAgentStore;
  /** Resolve effective collection assignments for a new org Agent snapshot. Errors fail closed. */
  resolveOrgAgentCollectionAssignments?: (input: {
    tenantId: string;
    userId: string;
    agentId: string;
  }) => Promise<OrgAgentCollectionAssignmentPin[]>;
  tenantStore?: TenantStore;
  environmentStore?: PgEnvironmentStore;
  authorizeEnvironmentTemplate?: (input: {
    tenantId: string;
    userId: string;
    agentId?: string;
    templateId: string;
  }) => Promise<boolean>;
  resolveUserRole?: (identity: { userId?: string; username?: string }) => 'admin' | 'user' | undefined;
  /**
   * 解析账户级「全部授权」偏好。所有入口（Web、钉钉、cron、scheduler wake、
   * 子 Agent）都以服务端持久化偏好兜底，避免依赖客户端逐条消息携带策略。
   */
  resolveUserAutoApproveTools?: (identity: { userId?: string; username?: string }) => boolean | undefined;
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
  /**
   * 预 provision 钩子（2026-08-10）：首跑创建 session record 后异步拉起 Sandbox，
   * 让 pod 冷启动与模型首个 token 重叠。fire-and-forget，实现方自带节流与失败静默。
   * 未配置时行为与改造前一致（首个工具调用时才拉起）。
   */
  sandboxWarmup?: (sessionId: string) => void;
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
   * 定时任务服务惰性 getter（CronList/CronManage 内置工具）；cronRuntime 晚装配，因此传 getter。
   */
  cronService?: () => import('../cron/service.js').CronService | undefined;
  taskboard?: import('../agent/taskboardToolActions.js').TaskboardToolOptions;
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
  /** PG durable 后台 Agent；file backend 缺省时 Agent(mode=background) fail-closed。 */
  backgroundTasks?: BackgroundTaskRuntime;
  /** DWS dispatcher Worker 终态进入 durable current-user outbox 的注入点。 */
  enqueueDwsBackgroundCompletion?: (input: {
    tenantId: string;
    taskId: string;
    accountId: string;
    conversationId: string;
    eventType: 'user_im_message_receive_at' | 'user_im_message_receive_o2o_all';
    messageId?: string;
    senderOpenDingtalkId?: string;
    content: string;
  }) => Promise<void>;
  /** 当前模型不支持 image 输入时使用的独立图片理解模型链。 */
  getImageUnderstandingModelConfigs?: () => readonly ImageUnderstandingModelConfig[];
  /** 图片理解模型单次尝试超时；默认 30 秒。 */
  getImageUnderstandingTimeoutMs?: () => number | undefined;
  /** 平台级模型可见工具开关。 */
  toolControls?: import('../app/config.js').ToolControlsConfig;
  /** Platform-managed web access tools (`WebSearch` / `WebFetch`). */
  webTools?: ResolvedWebToolsConfig;
  /**
   * WebSearch / WebFetch 的出站 fetch 实现（2026-07-25）。
   * 平台配置了网络出口代理时注入 egress-aware fetch：按域名决定走代理还是直连，
   * 代理不通时按配置降级。不注入则退回全局 fetch（直连），行为与改造前一致。
   * 只影响这两个工具——模型调用、OSS、钉钉等出站一律不受影响。
   */
  webFetchImpl?: typeof fetch;
  /**
   * 平台托管生图工具（GenerateImage，2026-07-15）。API key 已在装配层经
   * secretVault 解析，只存在于 server 进程内——绝不进 sandbox env、绝不上 wire。
   */
  imageGenTools?: ResolvedImageGenToolsConfig;
  audioTranscribeTools?: ResolvedAudioTranscribeToolsConfig; // 凭据仅在 server 进程内
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
  /** Artifact service used by the model-facing Artifact tool and hand-backed create protocol. */
  artifactService?: ArtifactService;
  /**
   * 自动上下文压缩（/compact v2）。配置后，正常回答结束但 run 尚未终态时
   * 以内联尾阶段压缩；期间用户消息继续进入同一 run 的 durable steering queue。
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
  /** Governance wake-time revalidation；Raw Runtime 在 Environment 解析后写最终 Snapshot。 */
  runPreflightService?: RunPreflightService;
  runResolutionSnapshotStore?: Pick<PgRunResolutionSnapshotStore, 'append' | 'get'>;
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
  /** 当前用户已启用连接器的运行态环境变量解析器。 */
  resolveConnectorRuntimeEnv?: (context: {
    userId: string;
    username: string;
    tenantId: string;
  }) => Promise<Record<string, string>>;
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
  toolProfile?: 'memory_poll' | 'memory_consolidate';
  dispatcherCompletion?: boolean;
  /** run.metadata.taskboardStagePrompt 恢复：任务看板 Execution 按阶段配置的特定提示语。 */
  taskboardStagePrompt?: string;
  /** Server-only persisted metadata for Integration Work/Review isolation re-attestation. */
  runtimeIsolationMetadata?: Record<string, unknown>;
  hooks?: AgentRunHooks;
  abortController?: AbortController;
  maxTurns?: number;
  runtimeWorkerId?: string;
  runtimeDrainHandoff?: RuntimeDrainHandoffState;
}

export interface RawInteractionResumeRequest {
  /** Scheduler wake 当前实际执行的 Run；replacement resume 必须显式覆盖原 interaction 的 Run。 */
  runId?: string;
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
  toolProfile?: 'memory_poll' | 'memory_consolidate';
  dispatcherCompletion?: boolean;
  /** run.metadata.taskboardStagePrompt 恢复：任务看板 Execution 按阶段配置的特定提示语。 */
  taskboardStagePrompt?: string;
  /** Server-only persisted metadata for Integration Work/Review isolation re-attestation. */
  runtimeIsolationMetadata?: Record<string, unknown>;
  hooks?: AgentRunHooks;
  abortController?: AbortController;
  maxTurns?: number;
  runtimeWorkerId?: string;
  runtimeDrainHandoff?: RuntimeDrainHandoffState;
}

export interface RawRuntimeWakeState {
  session: RuntimeSessionRecord;
  events: PlatformEvent[];
  approvals: ApprovalRecord[];
  replayState: RuntimeReplayState;
}

export interface WakeRuntimeSessionOptions {
  lease?: RuntimeWakeLease;
  renewIntervalMs?: number;
  onOutboundEvent?: (event: OutboundEvent, context: { runId: string; sessionId: string }) => void | Promise<void>;
}
