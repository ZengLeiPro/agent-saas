import type { AppConfig } from '../types/index.js';
import type { AuthEpochAuthority } from '../auth/authEpochAuthority.js';
import type { CodexCredentialManager } from '../runtime/responses/codexCredentialManager.js';
import type { CodexDeviceAuthService } from '../runtime/responses/codexOAuth.js';
import type { RuntimeAuditQuery } from '../runtime/auditQuery.js';
import type { PgEventStore } from '../runtime/pgEventStore.js';
import type { EventStore } from '../runtime/types.js';
import type { PgRunStore } from '../runtime/runStore.js';
import type { PgHandStore } from '../runtime/handStore.js';
import type { PgSessionProjectionStore } from '../runtime/sessionProjectionStore.js';
import type {
  TaskboardExecutionService,
  TaskboardService,
} from '../taskboard/types.js';
import type { resolveTenantMemoryFeatureStatus } from '../memory/effectiveStatus.js';
import type { SessionReadStateStore } from '../data/sessionReadStateStore.js';
import type { PgToolInvocationStore } from '../runtime/toolInvocationStore.js';
import type { ArtifactService } from '../runtime/artifactService.js';
import type { ArtifactShareService } from '../runtime/artifactShareService.js';
import type { ArtifactShareStore } from '../runtime/artifactShareStore.js';
import type { SessionShareStore } from '../data/sessionShares/store.js';
import type { RuntimeAdmissionSnapshot } from '../runtime/memoryPressureGuard.js';
import type { RuntimePerformanceWorkloadSnapshot } from '../runtime/runtimePerformanceSampler.js';
import type { RuntimeSchedulerCapacityController } from '../runtime/runtimeSchedulerConfigStore.js';
import type { SandboxWarmupService } from '../runtime/sandboxWarmup.js';
import type { DispatchMetricsStore } from '../engine/metricsStore.js';
import type { ChannelManager } from '../channels/manager.js';
import type { DingtalkDeps } from '../channels/dingtalk/factory.js';
import type { CronRuntime } from '../cron/bootstrap.js';
import type { AgentOptionsConfig } from '../agent/options.js';
import type { TitleGeneratorConfig, TitleModelAdapterFactory } from '../agent/titleGenerator.js';
import type { GuardrailModelConfig } from '../agent/guardrail.js';
import type { OrgAgentStore } from '../data/orgAgents/store.js';
import type { OrgAgentRuntimePolicy } from '../data/orgAgents/runtimePolicy.js';
import type { AgentDwsAccountRecord, AgentDwsAccountStore } from '../data/agentDwsAccounts/index.js';
import type { AgentDwsMessageStore } from '../data/agentDwsMessages/index.js';
import type { AgentDwsMessageRouter } from '../dws/personalMessageRouter.js';
import type { AgentDwsAuthFlowServiceLike } from '../dws/agentAuthFlow.js';
import type { DwsPersonalEventGateway } from '../dws/personalEventGateway.js';
import type { PgGuardrailEventStore } from '../data/guardrail/pgGuardrailEventStore.js';
import type { PgMessageFeedbackStore } from '../data/feedback/store.js';
import type { AppealStore } from '../data/appeals/index.js';
import type { GovernanceAuditStore } from '../data/governance-audit/index.js';
import type { PgMembershipStore } from '../data/memberships/index.js';
import type { PgEntitlementStore } from '../data/entitlements/index.js';
import type { PgDirectoryGroupStore } from '../data/directoryGroups/index.js';
import type { PgOAuthGrantStore } from '../data/oauthGrants/index.js';
import type { PgAssignmentStore } from '../data/assignments/index.js';
import type { ContextStore } from '../context/store/index.js';
import type { ContextSourceAuthorizationRegistry } from '../context/retrieval/index.js';
import type { DerivedContextStore } from '../context/derived/index.js';
import type { PgCredentialStore } from '../data/credentials/index.js';
import type { PgConnectorCatalogStore } from '../data/connectorCatalog/index.js';
import type { PgEnvironmentStore } from '../data/environments/index.js';
import type { PgAgentResourceStore } from '../data/agentResources/index.js';
import type { PgSkillGovernanceStore } from '../data/skillGovernance/index.js';
import type {
  GovernanceChangePlanner,
  PgGovernanceChangeJobStore,
} from '../data/changeJobs/index.js';
import type { PgContentAccessGrantStore } from '../data/contentAccess/index.js';
import type {
  GovernanceProjectionReconciler,
  PgGovernanceProjectionOutboxStore,
} from '../data/governanceProjection/index.js';
import type {
  GovernanceShadowComparator,
  GovernanceWriteGate,
  PgGovernanceMigrationControlStore,
} from '../data/migrationControl/index.js';
import type { PgResourceReferenceStore } from '../data/resourceReferences/index.js';
import type { CredentialBroker } from '../runtime/credentialBroker.js';
import type { MemoryIndexService } from '../memory/index/service.js';
import type { MemoryConsolidationScannerStatus } from '../memory/consolidation/types.js';
import type { UserStore } from '../data/users/store.js';
import type { TenantStore } from '../data/tenants/store.js';
import type { AgentStore } from '../data/agents/store.js';
import type { GroupStore } from '../data/groups/store.js';
import type { SkillConfigStore } from '../data/skills/index.js';
import type { McpConfigStore } from '../data/mcpConfig.js';
import type { ConnectorConnectionStore } from '../connectors/connectionStore.js';
import type { AliyunConnectorService } from '../connectors/aliyun.js';
import type { GoogleWorkspaceOAuthService } from '../connectors/googleWorkspace.js';
import type { NotionConnectionView } from '../connectors/notion.js';
import type { SignupConfigStore } from '../data/signupConfig.js';
import type { EgressConfigStore } from '../data/egressConfig.js';
import type { SkillMaterializationCoordinator } from '../workspace/materialization/types.js';
import type { McpClientManager } from '../mcp/clientManager.js';
import type { McpOAuthService } from '../mcp/oauthService.js';
import type { SecretVault } from '../security/secretVault.js';
import type { ClientDaemonGateway } from '../runtime/clientDaemonGateway.js';
import type { PgSystemMetricsStore } from '../runtime/systemMetricsStore.js';
import type { SystemMetricsCollector } from '../runtime/systemMetricsCollector.js';
import type { PgAlertStateStore } from '../runtime/alertStateStore.js';
import type { AlertNotifier } from '../runtime/alertNotifier.js';
import type { DwsConnectionStore } from '../dws/store.js';
import type { DwsAuthFlowServiceLike } from '../dws/authFlow.js';
import type { NotionAuthFlowServiceLike } from '../notion/authFlow.js';
import type { FeishuConnectionStore } from '../feishu/store.js';
import type { FeishuAuthFlowServiceLike } from '../feishu/authFlow.js';
import type { SystemPromptRegistry } from '../runtime/systemPrompts.js';
import type { AgentRuntimeProfileStore } from '../data/agentProfiles/types.js';
import type { ConnectorDictionaryStore } from '../data/connectorDictionaryStore.js';
import type { UploadManager } from '../uploads/manager.js';
import type { VoiceTranscriptionService } from '../services/voiceTranscriptionService.js';
import type { SessionCatalog } from '../runtime/sessionCatalog.js';
import type { TokenUsageStore } from '../data/usage/store.js';
import type { BillingService } from '../data/billing/service.js';
import type { WebPushService } from '../webPush/service.js';
import type { createAuthMiddleware } from '../auth/middleware.js';

/**
 * AppRuntime 的公开契约类型。
 *
 * 从 `runtime.ts` 原样抽出：这里只有类型声明，没有任何运行时代码，
 * 便于 routes / channels / 测试等大量调用方只依赖契约而不拖进 createRuntime
 * 的整条装配链；`runtime.ts` 继续按既有 import 路径转发这些类型。
 */

/** skills 后台物化进度（/api/healthz/ready 载荷；蓝绿部署门禁等待 state=done 再切流） */
export interface SkillsWarmupStatus {
  state: 'pending' | 'running' | 'done' | 'failed';
  totalUsers?: number;
  processedUsers?: number;
  syncedUsers?: number;
  startedAtMs?: number;
  finishedAtMs?: number;
  error?: string;
}

export interface AppRuntime {
  config: AppConfig;
  processRole: AppRuntimeProcessRole;
  processCwd: string;
  sessionBasePath: string;
  agentCwd: string;
  /** Sandbox 预热服务（2026-07-31 冷启动治理）：会话打开即 fire-and-forget 预热 ACS Sandbox。 */
  sandboxWarmupService: SandboxWarmupService;
  sharedDir: string;
  tenantSkillsRootDir: string;
  uploadsDir: string;
  uploadManager: UploadManager;
  voiceTranscriptionService: VoiceTranscriptionService;
  channelManager: ChannelManager;
  dispatchMetricsStore: DispatchMetricsStore;
  dingtalkDeps: DingtalkDeps;
  cronRuntime: CronRuntime;
  getMemoryIndexService?: () => MemoryIndexService | null;
  getMemoryConsolidationScannerStatus?: () => Promise<MemoryConsolidationScannerStatus>;
  memoryIndexShutdown?: () => Promise<void>;
  /** Runtime audit DuckDB 句柄关闭（仅 audit.projection='duckdb' 时定义） */
  auditProjectionShutdown?: () => Promise<void>;
  /** Runtime event store 外部连接关闭（仅 runtimeEventStore.backend='pg' 时定义） */
  runtimeEventStoreShutdown?: () => Promise<void>;
  /** Stops durable tenant deletion scans before PostgreSQL shutdown. */
  tenantDeletionShutdown?: () => Promise<void>;
  /** MCP 客户端 manager 关闭（关闭 stdio 子进程 + HTTP 连接，δ 阶段新增） */
  mcpClientShutdown?: () => Promise<void>;
  mcpClientManager?: McpClientManager;
  secretVault?: SecretVault;
  codexCredentialManager: CodexCredentialManager;
  codexDeviceAuthService: CodexDeviceAuthService;
  codexWebSocketShutdown?: () => void;
  userStore?: UserStore;
  /** M30-01 durable auth epoch/generation authority. */
  authEpochAuthority?: AuthEpochAuthority;
  /** DWS 连接状态只保存非敏感元数据；token 始终留在用户 workspace 的 .dws。 */
  dwsConnectionStore?: DwsConnectionStore;
  /** DWS 首次绑定：能力中心连接器页启动 device flow，短期授权码落 PG，token 仍只进用户 workspace。 */
  dwsAuthFlowService?: DwsAuthFlowServiceLike;
  /** 组织 Agent 专属钉钉成员账号治理记录，不与真人用户 DWS connection 混用。 */
  agentDwsAccountStore?: AgentDwsAccountStore;
  /** 会话目录：上传附件绑定 sessionId 时校验当前用户归属。 */
  sessionCatalog?: Pick<SessionCatalog, 'get'>;
  /** Personal Stream durable inbox 与 conversation/session binding。 */
  agentDwsMessageStore?: AgentDwsMessageStore;
  /** durable inbox → 组织 Agent Session → current-user DWS 回复 worker。 */
  agentDwsMessageRouter?: AgentDwsMessageRouter;
  /** Agent-owned DWS device flow，token 只进入 Agent connector workspace。 */
  agentDwsAuthFlowService?: AgentDwsAuthFlowServiceLike;
  /** DWS Personal Stream consumer supervisor。 */
  dwsPersonalEventGateway?: DwsPersonalEventGateway;
  /** Context 范围保存后，立即把权威策略镜像到检索 Source/Collection。 */
  agentDwsContextPolicyUpdated?: (account: AgentDwsAccountRecord) => Promise<void>;
  agentDwsEnabledChanged?: (account: AgentDwsAccountRecord, enabled: boolean) => Promise<void>;
  /** Notion 官方 ntn 两阶段登录，成功后 token 转存用户级 Vault。 */
  notionAuthFlowService?: NotionAuthFlowServiceLike;
  getNotionConnection?: (identity: {
    userId: string;
    username: string;
    tenantId: string;
  }) => Promise<NotionConnectionView>;
  disconnectNotionConnection?: (identity: {
    userId: string;
    username: string;
    tenantId: string;
  }) => Promise<unknown>;
  /** Google Workspace 官方 API OAuth，运行时向 gws 注入短期 access token。 */
  googleWorkspaceOAuthService?: GoogleWorkspaceOAuthService;
  notionAuthFlowShutdown?: () => void;
  /** 停止 DWS 授权守活 worker（ws-only 进程不启动）。 */
  dwsAuthKeepaliveShutdown?: () => void | Promise<void>;
  contextPlaneShutdown?: () => Promise<void>;
  /** 飞书连接只保存非敏感元数据；用户 token 与加密 keychain 均留在其 workspace。 */
  feishuConnectionStore?: FeishuConnectionStore;
  /** 飞书首次绑定：Server 驱动官方 lark-cli split device flow。 */
  feishuAuthFlowService?: FeishuAuthFlowServiceLike;
  /** 停止飞书授权与守活任务。 */
  feishuAuthKeepaliveShutdown?: () => void;
  /**
   * Tenant 元数据 store。仅 `config.auth.enabled` 时实例化（与 userStore 共生命周期）。
   * 启动期自动 ensure 平台根组织和开沿日常组织。
   */
  tenantStore?: TenantStore;
  /** 租户记忆开关的配置态/实际生效态权威解析，供后台 API 展示。 */
  getTenantMemoryFeatureStatus: (tenantId: string) => ReturnType<typeof resolveTenantMemoryFeatureStatus>;
  agentStore?: AgentStore;
  skillConfigStore?: SkillConfigStore;
  mcpConfigStore?: McpConfigStore;
  /** 通用连接器账号、SecretVault ref 与能力开关；不依赖 MCP 生命周期。 */
  connectorConnectionStore?: ConnectorConnectionStore;
  /** 阿里云 RAM Role 连接器；源凭据只存 Vault，运行时仅注入短期 STS。 */
  aliyunConnectorService?: AliyunConnectorService;
  mcpOAuthService?: McpOAuthService;
  /** 自助注册动态配置（platform-admin 配置页写入，signup router 按 version 懒重建） */
  signupConfigStore?: SignupConfigStore;
  /** 网络出口（代理/镜像源）动态配置（platform-admin「网络出口」页写入） */
  egressConfigStore?: EgressConfigStore;
  /** 保存代理凭据后刷新 dispatcher 用的同步缓存 */
  refreshEgressProxyCredential?: () => Promise<void>;
  groupStore: GroupStore;
  authMiddleware?: ReturnType<typeof createAuthMiddleware>;
  /**
   * Title generator 配置链。第一个是主模型，后续是 fallback——
   * 主返回空 content 或 catch 后会按顺序尝试 fallback。
   */
  titleGeneratorConfigs?: TitleGeneratorConfig[];
  /** 标题 utility 专用 adapter factory；Codex 固定 HTTP/SSE，不复用主会话 WebSocket pool。 */
  titleModelAdapterFactory?: TitleModelAdapterFactory;
  refreshSharedConfig: () => void;
  /** 解析模型 SecretRef 并原子替换当前进程的运行时模型连接快照。 */
  updateModelsConfig?: (models: NonNullable<AppConfig['models']>) => Promise<void>;
  /**
   * 公司级专职 Agent store（2026-07 唯恩批次）。仅 auth 启用时实例化
   * （与 agentStore 同生命周期）；routes 挂 /api/org-agents 用。
   */
  orgAgentStore?: OrgAgentStore;
  /** 发布 dispatcher 模式前校验后台 Agent、Profile 与 Worker 模型连接。 */
  validateOrgAgentDispatcherRuntime?: (
    tenantId: string,
    policy: OrgAgentRuntimePolicy,
  ) => Promise<string[]>;
  /**
   * 门禁事件落库（仅 runtimeEventStore.backend='pg'；file backend 为 undefined，
   * WebChannel 降级 log）。阶段 2 质检台 /api/admin/qa/guardrail-events 消费。
   */
  guardrailEventStore?: PgGuardrailEventStore;
  /**
   * 消息反馈落库（仅 runtimeEventStore.backend='pg'；file backend 为 undefined，
   * /api/feedback 与质检台 /api/admin/qa/feedback 路由 503 → 前端隐藏入口）。
   */
  messageFeedbackStore?: PgMessageFeedbackStore;
  /**
   * 员工申诉落库（仅 runtimeEventStore.backend='pg'；file backend 为 undefined，
   * /api/appeals 与 /api/tenant/appeals 路由 503 → 前端隐藏入口）。
   */
  appealStore?: AppealStore;
  /** 个人任务看板；仅 PG runtime backend 装配，初始化失败时返回 503 并在后续请求重试。 */
  taskboardService?: TaskboardService;
  /** 任务看板单任务 Agent 执行闭环；依赖 PG durable scheduler。 */
  taskboardExecutionService?: TaskboardExecutionService;
  /**
   * 门禁模型配置链 getter（主 + fallback）。空数组 = 门禁模块未激活。
   * WebChannel 持有同一 getter——热更后取到的永远是最新链。
   */
  getGuardrailModelConfigs: () => GuardrailModelConfig[];
  /** 模型列表热更新时重建门禁配置链（routes.ts onModelsUpdated 写回）。 */
  updateGuardrailModelConfigs: (next: GuardrailModelConfig[]) => void;
  agentOptionsConfig: AgentOptionsConfig;
  tokenUsageStore?: TokenUsageStore;
  webPushService?: WebPushService;
  /** PG-backed credit billing service. Undefined for file/runtime dev backends. */
  billingService?: BillingService;
  /** 独立、append-only 的治理审计；未装配时高风险变更必须 fail closed。 */
  governanceAuditStore?: GovernanceAuditStore;
  /** Membership/Owner 与平台管理员独立事实模型；M1 仅影子写与回填。 */
  membershipStore?: PgMembershipStore;
  /** Entitlement 与 Tenant Policy 独立事实模型；M1 仅影子写与回填。 */
  entitlementStore?: PgEntitlementStore;
  /** 钉钉目录群组投影；无生产 projector 时 Assignment 必须 fail closed。 */
  directoryGroupStore?: PgDirectoryGroupStore;
  /** 用户 OAuth Grant、撤销状态机与 native handoff 权威。 */
  oauthGrantStore?: PgOAuthGrantStore;
  /** 组织资源 Assignment 与个人 Preference 独立事实模型；M1 仅影子写与回填。 */
  assignmentStore?: PgAssignmentStore;
  /** PostgreSQL Context Plane data store；仅 PG runtime 装配。 */
  contextStore?: ContextStore;
  /** Context 原生 source 的读时 ACL registry；Citation 与 Agent Recall 必须复用同一实例。 */
  contextSourceAuthorizationRegistry?: ContextSourceAuthorizationRegistry;
  /** Phase 3 deterministic entities/items/reviews/profile relational store. */
  derivedContextStore?: DerivedContextStore;
  /** P2 Credential 治理事实模型；影子回填 legacy connector 连接，仅读取不拦截。 */
  credentialStore?: PgCredentialStore;
  /** 版本化 Connector Catalog；与 Tool Presentation Dictionary 严格分离。 */
  connectorCatalogStore?: PgConnectorCatalogStore;
  /** Execution Provider 与 Environment Template/Version 事实模型。 */
  environmentStore?: PgEnvironmentStore;
  /** Org/Personal/Template Agent stable resource + immutable version。 */
  agentResourceStore?: PgAgentResourceStore;
  /** Platform/Tenant/Personal Skill stable resource、版本与候选审批链。 */
  skillGovernanceStore?: PgSkillGovernanceStore;
  /** 可重试 Tenant/Delete/Retire/Revoke 治理 Change Job。 */
  governanceChangeJobStore?: PgGovernanceChangeJobStore;
  governanceChangePlanner?: GovernanceChangePlanner;
  governanceMigrationControlStore?: PgGovernanceMigrationControlStore;
  governanceWriteGate?: GovernanceWriteGate;
  governanceShadowComparator?: GovernanceShadowComparator;
  contentAccessGrantStore?: PgContentAccessGrantStore;
  governanceProjectionOutboxStore?: PgGovernanceProjectionOutboxStore;
  governanceProjectionReconciler?: GovernanceProjectionReconciler;
  /** 跨领域 Resource Reference Index；退役/删除影响预览的权威来源。 */
  resourceReferenceStore?: PgResourceReferenceStore;
  /** Server-side Credential Broker；影子阶段用于 smoke 验证，尚未接入 connector 运行路径。 */
  credentialBroker?: CredentialBroker;
  /** 等待当前已排队的 M1 治理影子投影完成，主要供测试和优雅停机。 */
  flushGovernanceShadowProjections?: () => Promise<void>;
  /** 手动触发 token usage 全量回填（force=true）。未初始化 businessDb 时为 undefined */
  triggerTokenUsageRebuild?: () => Promise<unknown>;
  /** Runtime audit 读查询（按 sessionId/runId 投影 tool_audit）。 */
  runtimeAuditQuery?: RuntimeAuditQuery;
  /**
   * PG runtime run store 直接句柄（仅 runtimeEventStore.backend='pg'；file backend 为 undefined）。
   * 运行监测读 API（/api/admin/runtime/trace）用它查 RunRecord 并取 runsTable 表名。
   */
  runtimeRunStore?: PgRunStore;
  /** PG 统一持久化的顶层 run 并发控制；平台运行态页读取并热更新。 */
  runtimeSchedulerCapacity?: RuntimeSchedulerCapacityController;
  /** Runtime Worker 当前资源准入状态；readiness 与运维观测共用同一快照。 */
  getRuntimeAdmissionSnapshot?: () => RuntimeAdmissionSnapshot;
  /** Runtime Worker结构化性能采样：合并本地Scheduler、PG队列和资源准入快照。 */
  runtimePerformanceSnapshot?: () => Promise<RuntimePerformanceWorkloadSnapshot>;
  /** PG runtime session projection store（平台观测会话列表用；file backend 为 undefined）。 */
  runtimeSessionProjectionStore?: PgSessionProjectionStore;
  /** 用户维度会话未读状态真源。PG 后端持久化，file 后端落 runtime event。 */
  sessionReadStateStore: SessionReadStateStore;
  /** PG runtime tool invocation store（组织删除清理用；file backend 为 undefined）。 */
  runtimeToolInvocationStore?: PgToolInvocationStore;
  /** PG runtime hand store（组织删除清理用；file backend 为 undefined）。 */
  runtimeHandStore?: PgHandStore;
  /** PG-backed platform/system metrics store. Undefined for file backend. */
  systemMetricsStore?: PgSystemMetricsStore;
  /** Periodic collector for disk/NAS/PG/workspace metrics. Started by all/runtime-worker only. */
  systemMetricsCollector?: SystemMetricsCollector;
  /** PG-backed alert dedupe state store. Undefined for file backend. */
  alertStateStore?: PgAlertStateStore;
  /** Periodic DingTalk alert notifier. Started by all/runtime-worker only when configured. */
  alertNotifier?: AlertNotifier;
  /**
   * PG runtime event store 直接句柄（仅 backend='pg'；file backend 为 undefined）。
   * 运行监测读 API 复用其 pool / eventsTable 做聚合查询，避免另开第二份连接池。
   */
  runtimePgEventStore?: PgEventStore;
  /** 校验平台工具配置，包括 WebSearch SecretVault ref 解析。 */
  validateToolSettingsConfig?: (settings: Pick<AppConfig, 'toolControls' | 'webTools'>) => Promise<void>;
  /** 更新平台工具配置并热写入后续 raw runtime dispatch。 */
  updateToolSettingsConfig?: (settings: Pick<AppConfig, 'toolControls' | 'webTools'>) => Promise<void>;
  /** 校验 GenerateImage 引擎配置，包括 SecretVault ref 解析。 */
  validateImageGenToolsConfig?: (imageGenTools: AppConfig['imageGenTools']) => Promise<void>;
  /** 更新 GenerateImage 引擎配置并热写入后续 raw runtime dispatch。 */
  updateImageGenToolsConfig?: (imageGenTools: AppConfig['imageGenTools']) => Promise<void>;
  /** 校验 AudioTranscribe 服务配置及 SecretVault refs。 */
  validateAudioTranscribeConfig?: (stt: AppConfig['stt']) => Promise<void>;
  /** 更新 AudioTranscribe 配置并热写入后续 raw runtime dispatch。 */
  updateAudioTranscribeConfig?: (stt: AppConfig['stt']) => Promise<void>;
  /** 更新 memory.index 配置并热写入后续 raw runtime dispatch。 */
  updateMemoryIndexConfig?: (memoryIndex: NonNullable<NonNullable<AppConfig['memory']>['index']> | undefined) => Promise<void>;
  /** 更新 memory.polling 配置：热更后续执行参数并立即重排系统任务。 */
  updateMemoryPollingConfig?: (polling: NonNullable<NonNullable<AppConfig['memory']>['polling']>) => Promise<void>;
  /** 平台系统提示语注册表；管理端保存后原地热更新。 */
  systemPromptRegistry: SystemPromptRegistry;
  /** 平台 Agent 运行 Profile；PG 为可写真源，file backend 仅提供内置只读兼容版本。 */
  agentRuntimeProfileStore: AgentRuntimeProfileStore;
  /** 连接器映射词典：平台管理可改，保存即热更新工具行摘要的业务语言。 */
  connectorDictionaryStore: ConnectorDictionaryStore;
  /** Artifact metadata/blob service for runtime-produced artifacts. */
  artifactService?: ArtifactService;
  /** Owner-managed public Artifact sharing; absent when no persistent signing secret exists. */
  artifactShareService?: ArtifactShareService;
  /** Share persistence also drives GC pins and session-delete revocation. */
  artifactShareStore?: ArtifactShareStore;
  /** 会话只读分享存储。 */
  sessionShareStore: SessionShareStore;
  /** Artifact GC timer cleanup. */
  artifactShutdown?: () => Promise<void>;
  /** Reverse WebSocket gateway for customer-side client daemon hands. */
  clientDaemonGateway?: ClientDaemonGateway;
  /**
   * Runtime EventStore 解析函数。任何"按 sessionId 读事件流"的读路径
   * （pending API / WS approval resume reconnect）都应通过它拿 EventStore，
   * 避免硬编码 FileEventStore 导致 PG backend 读到空。
   * - PG backend：返回共享 pgEventStore（按 session_id 过滤）
   * - file backend：`new FileEventStore(getRuntimeEventLogPath(transcriptPath))`
   */
  runtimeEventStoreFor: (transcriptPath: string, tenantId: string) => EventStore;
  /**
   * 零停机部署（2026-07-15）：listen 后执行的后台启动任务（skills warmup 等）。
   * index.ts 在 app.listen 回调里调用；无 HTTP listener 的 worker 进程在 createRuntime 后调用。
   */
  runDeferredStartupTasks: () => Promise<void>;
  /** skills 后台物化状态（/api/healthz/ready 载荷；部署门禁等待 done 再切流） */
  getSkillsWarmupStatus: () => SkillsWarmupStatus;
  /** 技能物化协调器；路由、dispatch、cron 统一经此入口，不再直接递归复制。 */
  skillMaterialization?: SkillMaterializationCoordinator;
  /** 启动技能物化 worker；PG 按 release 选主，并以 workspace advisory lock 串行跨 release 写入。 */
  startSkillMaterializationCoordinator: () => void;
  /**
   * 启动 cron leader 协调器（PG advisory lock 单例守护，防蓝绿并存期双跑）。
   * 仅 processRole=all/runtime-worker 且 cron 启用时有实际效果；替代旧的 cronService.start() 直调。
   */
  startCronCoordinator: () => void;
  /** 蓝绿旧 worker 排空后，以 CAS 语义重新发布当前 retention status authority。 */
  reassertRuntimeEventRetentionAuthority: () => Promise<void>;
  /** 发布失败回退时让仍存活的旧 worker 显式重新 claim authority。 */
  claimRuntimeEventRetentionAuthority: () => Promise<void>;
  /**
   * SIGUSR2 drain 序列（顺序敏感）：停/取消系统指标扫描 → 停 reconcile 定时器 → 停 cron 触发 →
   * 等 in-flight cron job 结清 → 释放 cron leadership（此后新实例可接管）→
   * 停 scheduler（不再 claim 新 run 并等 in-flight run 结清）。
   * WS 活跃流与 HTTP 上传不在此处等待，由 index.ts 的 drain 轮询负责。
   */
  beginRuntimeDrain: () => Promise<void>;
}


/** Runtime construction options. */
export interface CreateRuntimeOptions {
  processCwd?: string;
  processRole?: AppRuntimeProcessRole;
}

export type AppRuntimeProcessRole = 'all' | 'ws-only' | 'scheduler-only' | 'runtime-worker';
