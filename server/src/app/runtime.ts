import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'path';
import { serverLogger, configureLogger } from '../utils/logger.js';
import type { AppConfig } from '../types/index.js';
import { createRawApprovalResumeDispatch, createRawRuntimeRunDispatch, wakeRuntimeSession } from '../runtime/rawRuntimeRunDispatch.js';
import { createExecutionConfig } from '../runtime/executionConfig.js';
import {
  DuckDBRuntimeAuditQuery,
  EventStoreRuntimeAuditQuery,
  type RuntimeAuditQuery,
} from '../runtime/auditQuery.js';
import { createAuditProjection } from '../runtime/auditProjection.js';
import { closeAuditDuckDb, getAuditDuckDb } from '../runtime/auditDuckDb.js';
import { PgEventStore } from '../runtime/pgEventStore.js';
import { FileEventStore, getRuntimeEventLogPath } from '../runtime/fileEventStore.js';
import type { EventStore } from '../runtime/types.js';
import { RuntimeEventRetention } from '../runtime/runtimeEventRetention.js';
import { PgRuntimeAuditQuery } from '../runtime/pgAuditQuery.js';
import { PgSessionLock } from '../runtime/pgSessionLock.js';
import { PgRunStore } from '../runtime/runStore.js';
import { PgHandStore } from '../runtime/handStore.js';
import { PgSessionProjectionStore } from '../runtime/sessionProjectionStore.js';
import { PgToolInvocationStore } from '../runtime/toolInvocationStore.js';
import { PgClientDaemonRegistry } from '../runtime/clientDaemonRegistry.js';
import {
  InMemoryArtifactStore,
  LocalArtifactBlobStore,
  OssArtifactBlobStore,
  PgArtifactStore,
  type ArtifactBlobStore,
  type ArtifactStore,
} from '../runtime/artifactStore.js';
import { ArtifactService } from '../runtime/artifactService.js';
import {
  InMemorySessionShareStore,
  PgSessionShareStore,
  type SessionShareStore,
} from '../data/sessionShares/store.js';
import { recoverRunningToolInvocations } from '../runtime/toolInvocationRecovery.js';
import { deliverPendingToolInvocationCancels, deliverToolInvocationCancel } from '../runtime/toolInvocationCancelDelivery.js';
import { RuntimeScheduler } from '../runtime/scheduler.js';
import { DurableBackgroundTaskService } from '../runtime/background/backgroundTaskService.js';
import { isBackgroundCommandTaskRun } from '../runtime/background/backgroundTaskRuntime.js';
import { AutoCompactionService } from '../runtime/autoCompaction.js';
import { runtimeRunController } from '../runtime/runController.js';
import { FileSessionCatalog } from '../runtime/sessionCatalog.js';
import { createMiddlewareRunDispatch } from '../engine/dispatch.js';
import { DispatchMetricsStore } from '../engine/metricsStore.js';
import { createMemoryMaintenanceHook, withMemoryMaintenance } from '../engine/memoryHook.js';
import { getPublicModelList, getTenantPublicModelList, isModelAllowedForTenant } from './models.js';
import { ChannelManager } from '../channels/manager.js';
import { WebChannel } from '../channels/web/channel.js';
import { DingtalkChannel } from '../channels/dingtalk/channel.js';
import { createDingtalkDeps, type DingtalkDeps } from '../channels/dingtalk/factory.js';
import { createCronRuntime, type CronRuntime } from '../cron/bootstrap.js';
import { reconcileMemoryPollJobs, MEMORY_POLL_DEFAULTS } from '../cron/memoryPoll.js';
import { UserActivityService } from '../runtime/userActivityService.js';
import { createCronNotifier } from '../cron/notifier.js';
import type { NotifyChannel } from '../cron/notifyChannel.js';
import { createDingtalkNotifyChannel } from '../cron/notifyChannels/index.js';
import { buildFollowupContext } from '../cron/followup.js';
import { loadAppConfig } from './config.js';
import { resolveModelRef } from './models.js';
import type { AgentOptionsConfig } from '../agent/options.js';
import type { TitleGeneratorConfig } from '../agent/titleGenerator.js';
import type { GuardrailModelConfig } from '../agent/guardrail.js';
import type { ImageUnderstandingModelConfig } from '../runtime/imageUnderstanding.js';
import { OrgAgentStore } from '../data/orgAgents/store.js';
import { PgGuardrailEventStore } from '../data/guardrail/pgGuardrailEventStore.js';
import { PgMessageFeedbackStore } from '../data/feedback/store.js';
import { PgAppealStore } from '../data/appeals/index.js';
import type { AppealStore } from '../data/appeals/index.js';
import { MemoryIndexService } from '../memory/index/service.js';
import type { MemoryIndexConfig } from '../memory/index/types.js';
import { UserStore } from '../data/users/store.js';
import type { UserInfo } from '../data/users/types.js';
import { TenantStore } from '../data/tenants/store.js';
import { DEFAULT_TENANT_ID, LEGACY_TENANT_ID } from '../data/tenants/types.js';
import { tenantAccessErrorMessage, wrapDispatchWithTenantAccess } from '../data/tenants/access.js';
import { AgentStore } from '../data/agents/store.js';
import { GroupStore } from '../data/groups/store.js';
import { SkillConfigStore, migrateFromManifest } from '../data/skills/index.js';
import { McpConfigStore } from '../data/mcpConfig.js';
import { SignupConfigStore } from '../data/signupConfig.js';
import { scanPoolSkills as scanPoolSkillsForDispatch, scanTenantOwnSkillIds, scanUserCustomSkills } from '../data/skills/scanner.js';
import { resolveTenantSkillsDirFromRoot } from '../data/tenants/tenantSkillsPath.js';
import { syncSkills, resolveUserCwd, ensureUserWorkspace } from '../workspace/resolver.js';
import { agentDir, agentPath, resolveAgentPath } from '../workspace/namespace.js';
import { CronLeadership } from '../runtime/cronLeadership.js';
import { computeSkillsContentFingerprint } from '../data/skills/contentFingerprint.js';
import type { RawRuntimeRunDispatchConfig, SkillsDispatchConfig } from '../runtime/rawRuntimeRunDispatch.js';
import type { SkillEntry } from '../agent/skillToolProvider.js';
import { McpClientManager } from '../mcp/clientManager.js';
import { McpProxy } from '../mcp/proxy.js';
import { McpOAuthService } from '../mcp/oauthService.js';
import { CapabilityTokenService } from '../security/capabilityToken.js';
import { EncryptedFileSecretVault, HttpSecretVault, InMemorySecretVault, type SecretVault } from '../security/secretVault.js';
import {
  createTenantRemoteHandAuthTokenResolver,
  selectTenantRemoteHandsForRegistration,
} from '../runtime/tenantRemoteHandResolver.js';
import { createDefaultExecutionTransportRegistry } from '../agent/toolRuntime.js';
import { buildTenantScopedEnv } from '../agent/tenantEnv.js';
import { ClientDaemonTransport } from '../runtime/clientDaemonTransport.js';
import { ClientDaemonGateway } from '../runtime/clientDaemonGateway.js';
import { HandHealthScanner } from '../runtime/handHealthScanner.js';
import { PgSystemMetricsStore } from '../runtime/systemMetricsStore.js';
import { SystemMetricsCollector } from '../runtime/systemMetricsCollector.js';
import { PgAlertStateStore } from '../runtime/alertStateStore.js';
import { AlertNotifier } from '../runtime/alertNotifier.js';
import type { ResolvedWebToolsConfig } from '../agent/webToolProvider.js';
import type { ResolvedImageGenToolsConfig } from '../agent/imageGenToolProvider.js';
import { PgDwsConnectionStore, type DwsConnectionStore } from '../dws/store.js';
import { DwsAuthKeepaliveService, DwsAuthStatusRunner } from '../dws/keepalive.js';
import { PgDwsAuthSessionStore } from '../dws/authStore.js';
import { DwsAuthFlowService, DwsDeviceLoginRunner, type DwsAuthFlowServiceLike } from '../dws/authFlow.js';
import { PgFeishuConnectionStore, type FeishuConnectionStore } from '../feishu/store.js';
import { FeishuAuthKeepaliveService, FeishuAuthStatusRunner } from '../feishu/keepalive.js';
import { PgFeishuAuthSessionStore } from '../feishu/authStore.js';
import { FeishuAuthFlowService, FeishuDeviceLoginRunner, type FeishuAuthFlowServiceLike } from '../feishu/authFlow.js';
import { SystemPromptRegistry } from '../runtime/systemPrompts.js';

// δ: skillsDispatchConfig.listForUser 的进程级 cache（configVersion 驱动失效），
// 避免每次 dispatch / 每次 Skill.invoke 都重新 readdirSync pool 目录。
const SAFE_SKILL_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
import { migrateCronGroups } from '../data/groups/migrate.js';
import { findTranscriptPathBySessionId } from '../data/transcripts/store.js';
import { runStartupMigrations } from '../data/migrations/startup.js';
import { getBusinessDb } from '../data/db/business.js';
import { runBusinessMigrations } from '../data/db/migrations.js';
import { createTokenUsageStore, type TokenUsageStore } from '../data/usage/store.js';
import { rebuildTokenUsageFromJsonl } from '../data/usage/rebuildFromJsonl.js';
import { configureModelPricing } from '../data/usage/pricing.js';
import { configureImageGenPricing } from '../data/usage/imageGenPricing.js';
import { PgBillingStore } from '../data/billing/pgBillingStore.js';
import { BillingService } from '../data/billing/service.js';
import { clearSessionsListCache } from '../routes/sessions.js';
import { setSessionMetaProjectionSink } from '../data/transcripts/meta.js';
import { createAuthMiddleware } from '../auth/middleware.js';
import { sanitizeUserOverrides } from '../security/extraDirs.js';


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
  sharedDir: string;
  tenantSkillsRootDir: string;
  uploadsDir: string;
  channelManager: ChannelManager;
  dispatchMetricsStore: DispatchMetricsStore;
  dingtalkDeps: DingtalkDeps;
  cronRuntime: CronRuntime;
  getMemoryIndexService?: () => MemoryIndexService | null;
  memoryIndexShutdown?: () => Promise<void>;
  /** Runtime audit DuckDB 句柄关闭（仅 audit.projection='duckdb' 时定义） */
  auditProjectionShutdown?: () => Promise<void>;
  /** Runtime event store 外部连接关闭（仅 runtimeEventStore.backend='pg' 时定义） */
  runtimeEventStoreShutdown?: () => Promise<void>;
  /** MCP 客户端 manager 关闭（关闭 stdio 子进程 + HTTP 连接，δ 阶段新增） */
  mcpClientShutdown?: () => Promise<void>;
  mcpClientManager?: McpClientManager;
  secretVault?: SecretVault;
  userStore?: UserStore;
  /** DWS 连接状态只保存非敏感元数据；token 始终留在用户 workspace 的 .dws。 */
  dwsConnectionStore?: DwsConnectionStore;
  /** DWS 首次绑定：能力中心连接器页启动 device flow，短期授权码落 PG，token 仍只进用户 workspace。 */
  dwsAuthFlowService?: DwsAuthFlowServiceLike;
  /** 停止 DWS 授权守活 worker（ws-only 进程不启动）。 */
  dwsAuthKeepaliveShutdown?: () => void;
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
  agentStore?: AgentStore;
  skillConfigStore?: SkillConfigStore;
  mcpConfigStore?: McpConfigStore;
  mcpOAuthService?: McpOAuthService;
  /** 自助注册动态配置（platform-admin 配置页写入，signup router 按 version 懒重建） */
  signupConfigStore?: SignupConfigStore;
  groupStore: GroupStore;
  authMiddleware?: ReturnType<typeof createAuthMiddleware>;
  /**
   * Title generator 配置链。第一个是主模型，后续是 fallback——
   * 主返回空 content 或 catch 后会按顺序尝试 fallback。
   */
  titleGeneratorConfigs?: TitleGeneratorConfig[];
  /**
   * 公司级专职 Agent store（2026-07 唯恩批次）。仅 auth 启用时实例化
   * （与 agentStore 同生命周期）；routes 挂 /api/org-agents 用。
   */
  orgAgentStore?: OrgAgentStore;
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
  /**
   * 门禁模型配置链 getter（主 + fallback）。空数组 = 门禁模块未激活。
   * WebChannel 持有同一 getter——热更后取到的永远是最新链。
   */
  getGuardrailModelConfigs: () => GuardrailModelConfig[];
  /** 模型列表热更新时重建门禁配置链（routes.ts onModelsUpdated 写回）。 */
  updateGuardrailModelConfigs: (next: GuardrailModelConfig[]) => void;
  agentOptionsConfig: AgentOptionsConfig;
  tokenUsageStore?: TokenUsageStore;
  /** PG-backed credit billing service. Undefined for file/runtime dev backends. */
  billingService?: BillingService;
  /** 手动触发 token usage 全量回填（force=true）。未初始化 businessDb 时为 undefined */
  triggerTokenUsageRebuild?: () => Promise<unknown>;
  /** Runtime audit 读查询（按 sessionId/runId 投影 tool_audit）。 */
  runtimeAuditQuery?: RuntimeAuditQuery;
  /**
   * PG runtime run store 直接句柄（仅 runtimeEventStore.backend='pg'；file backend 为 undefined）。
   * 运行监测读 API（/api/admin/runtime/trace）用它查 RunRecord 并取 runsTable 表名。
   */
  runtimeRunStore?: PgRunStore;
  /** PG runtime session projection store（平台观测会话列表用；file backend 为 undefined）。 */
  runtimeSessionProjectionStore?: PgSessionProjectionStore;
  /** PG runtime tool invocation store（组织删除清理用；file backend 为 undefined）。 */
  runtimeToolInvocationStore?: PgToolInvocationStore;
  /** PG runtime hand store（组织删除清理用；file backend 为 undefined）。 */
  runtimeHandStore?: PgHandStore;
  /** PG-backed platform/system metrics store. Undefined for file backend. */
  systemMetricsStore?: PgSystemMetricsStore;
  /** Periodic collector for disk/NAS/PG/workspace metrics. Started only by processRole=all. */
  systemMetricsCollector?: SystemMetricsCollector;
  /** PG-backed alert dedupe state store. Undefined for file backend. */
  alertStateStore?: PgAlertStateStore;
  /** Periodic DingTalk alert notifier. Started only by processRole=all and configured webhook. */
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
  /** 更新 memory.index 配置并热写入后续 raw runtime dispatch。 */
  updateMemoryIndexConfig?: (memoryIndex: NonNullable<NonNullable<AppConfig['memory']>['index']> | undefined) => Promise<void>;
  /** 更新 memory.polling 配置：热更后续执行参数并立即重排系统任务。 */
  updateMemoryPollingConfig?: (polling: NonNullable<NonNullable<AppConfig['memory']>['polling']>) => Promise<void>;
  /** 平台系统提示语注册表；管理端保存后原地热更新。 */
  systemPromptRegistry: SystemPromptRegistry;
  /** Artifact metadata/blob service for runtime-produced artifacts. */
  artifactService?: ArtifactService;
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
  runtimeEventStoreFor: (transcriptPath: string) => EventStore;
  /**
   * 零停机部署（2026-07-15）：listen 后执行的后台启动任务（skills warmup 等）。
   * index.ts 在 app.listen 回调里调用；scheduler-only 进程在 createRuntime 后调用。
   */
  runDeferredStartupTasks: () => Promise<void>;
  /** skills 后台物化状态（/api/healthz/ready 载荷；部署门禁等待 done 再切流） */
  getSkillsWarmupStatus: () => SkillsWarmupStatus;
  /**
   * 启动 cron leader 协调器（PG advisory lock 单例守护，防蓝绿并存期双跑）。
   * 仅 processRole=all 且 cron 启用时有实际效果；替代旧的 cronService.start() 直调。
   */
  startCronCoordinator: () => void;
  /**
   * SIGUSR2 drain 序列（顺序敏感）：停 reconcile 定时器 → 停 cron 触发 →
   * 等 in-flight cron job 结清 → 释放 cron leadership（此后新实例可接管）→
   * 停 scheduler（不再 claim 新 run 并等 in-flight run 结清）。
   * WS 活跃流不在此处等待，由 index.ts 的 drain 轮询负责。
   */
  beginRuntimeDrain: () => Promise<void>;
}

export interface CreateRuntimeOptions {
  processCwd?: string;
  processRole?: AppRuntimeProcessRole;
}

export type AppRuntimeProcessRole = 'all' | 'ws-only' | 'scheduler-only';

function ensureDirectory(path: string, label: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
    serverLogger.info(`Created ${label}: ${path}`);
  }
}

function createMemoryIndexService(
  processCwd: string,
  memoryIndexConfig: NonNullable<NonNullable<AppConfig['memory']>['index']> | undefined,
): MemoryIndexService | null {
  if (memoryIndexConfig?.enabled !== true) return null;

  const resolvedConfig: MemoryIndexConfig = {
    enabled: true,
    dbDir: resolve(processCwd, memoryIndexConfig.dbDir ?? 'data/memory-index'),
    embedding: memoryIndexConfig.embedding,
    chunking: {
      tokens: memoryIndexConfig.chunking?.tokens ?? 400,
      overlap: memoryIndexConfig.chunking?.overlap ?? 80,
    },
    search: {
      vectorWeight: memoryIndexConfig.search?.vectorWeight ?? 0.7,
      textWeight: memoryIndexConfig.search?.textWeight ?? 0.3,
      maxResults: memoryIndexConfig.search?.maxResults ?? 10,
      minScore: memoryIndexConfig.search?.minScore ?? 0.3,
    },
    temporalDecay: {
      enabled: memoryIndexConfig.temporalDecay?.enabled ?? false,
      halfLifeDays: memoryIndexConfig.temporalDecay?.halfLifeDays ?? 30,
    },
    sync: {
      debounceMs: memoryIndexConfig.sync?.debounceMs ?? 1500,
    },
  };

  return new MemoryIndexService(resolvedConfig, (msg) =>
    serverLogger.info(`[memory-index] ${msg}`),
  );
}

async function resolveWebToolsConfig(
  webTools: AppConfig['webTools'],
  secretVault: SecretVault,
): Promise<ResolvedWebToolsConfig | undefined> {
  if (!webTools) return undefined;
  const resolved: ResolvedWebToolsConfig = {};
  if (webTools.enabled !== undefined) resolved.enabled = webTools.enabled;
  if (webTools.fetch) resolved.fetch = webTools.fetch;
  if (webTools.egress) resolved.egress = webTools.egress;

  if (webTools.search) {
    const { apiKeyRef, apiKey, ...searchRest } = webTools.search;
    let resolvedApiKey = apiKey;
    if (apiKeyRef) {
      try {
        resolvedApiKey = await secretVault.getSecret(apiKeyRef, {
          actor: 'system',
          userId: '__system__',
          scopes: ['secret:web_tools:read'],
        });
      } catch (err) {
        throw new Error(
          `webTools.search.apiKeyRef "${apiKeyRef}" 解析失败: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    resolved.search = {
      ...searchRest,
      ...(resolvedApiKey ? { apiKey: resolvedApiKey } : {}),
    };
  }

  return resolved;
}

/**
 * GenerateImage 生图工具凭据解析（2026-07-15）：apiKeyRef 经 secretVault 解析成
 * 明文 key 后只进 rawRuntimeConfig（server 进程内），绝不进 sandbox env、绝不加进
 * handEnvAllowlist / tenantSharedEnv——复用 webTools 的 apiKeyRef 先例。
 */
async function resolveImageGenToolsConfig(
  imageGenTools: AppConfig['imageGenTools'],
  secretVault: SecretVault,
): Promise<ResolvedImageGenToolsConfig | undefined> {
  if (!imageGenTools) return undefined;
  const resolved: ResolvedImageGenToolsConfig = {};
  if (imageGenTools.enabled !== undefined) resolved.enabled = imageGenTools.enabled;

  for (const key of ['gptImage2', 'seedream'] as const) {
    const engine = imageGenTools[key];
    if (!engine) continue;
    const { apiKeyRef, apiKey, ...engineRest } = engine;
    let resolvedApiKey = apiKey;
    if (apiKeyRef) {
      try {
        resolvedApiKey = await secretVault.getSecret(apiKeyRef, {
          actor: 'system',
          userId: '__system__',
          scopes: ['secret:image_gen_tools:read'],
        });
      } catch (err) {
        throw new Error(
          `imageGenTools.${key}.apiKeyRef "${apiKeyRef}" 解析失败: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    resolved[key] = {
      ...engineRest,
      ...(resolvedApiKey ? { apiKey: resolvedApiKey } : {}),
    };
  }

  return resolved;
}

export async function createRuntime(options: CreateRuntimeOptions = {}): Promise<AppRuntime> {
  const processCwd = options.processCwd ?? process.cwd();
  const processRole = options.processRole ?? 'all';
  const enableSchedulerWorker = processRole !== 'ws-only';
  const config = loadAppConfig(processCwd);

  // 从配置初始化全局 Logger（必须在其他模块使用 logger 之前）
  const loggingConfig = config.observability?.logging;
  if (loggingConfig !== false) {
    const opts = typeof loggingConfig === 'object' ? loggingConfig : {};
    configureLogger({
      minLevel: opts.level ?? 'info',
      showTimestamp: opts.timestamp ?? true,
      timestampFormat: opts.timestampFormat ?? 'time',
      ...(opts.colorEnabled !== undefined ? { colorEnabled: opts.colorEnabled } : {}),
    });
  }

  const agentCwd = config.agent.cwd ? resolve(processCwd, config.agent.cwd) : processCwd;
  ensureDirectory(agentCwd, 'agent cwd directory');
  const projectRoot = resolve(processCwd, '..');
  const sharedDir = config.agent.sharedDir
    ? resolve(projectRoot, config.agent.sharedDir)
    : join(agentCwd, '.shared');  // 向后兼容
  const systemPromptRegistry = new SystemPromptRegistry(sharedDir, config.systemPrompts);
  // 线上上传/提升的组织自有 skill 必须落持久数据目录，不能落 release 下的 workspace-shared。
  // release 目录会在每次部署时切换 symlink，写进去的租户内容会天然丢失。
  const tenantSkillsRootDir = resolve(processCwd, './data/tenant-skills');
  config.agent.userOverrides = sanitizeUserOverrides(config.agent.userOverrides, {
    processCwd,
    globalAgentCwd: agentCwd,
  });

  // PR 6 P0-5：多组织 settings 加载
  //   - v1：`workspace-shared/.ky-agent/settings.json` → sharedEnv (default tenant fallback)
  //   - v2 per-tenant：`workspace-shared/<tenantSlug>/.ky-agent/settings.json` → tenantSharedEnv[slug]
  // env: 通过 agentOptionsConfig.{sharedEnv, tenantSharedEnv} 传递给 buildEnv(tenantId)
  //      显式合并（不再污染 process.env）
  function loadSettingsEnv(path: string): Record<string, string> | undefined {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8'));
      if (!raw.env || typeof raw.env !== 'object') return undefined;
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(raw.env)) {
        if (typeof value === 'string') env[key] = value;
      }
      return env;
    } catch {
      return undefined;
    }
  }

  // v1：sharedDir 顶层（向后兼容，所有组织的 fallback baseline）
  const sharedSettingsPath = resolveAgentPath(sharedDir, 'settings.json');
  const sharedEnv = loadSettingsEnv(sharedSettingsPath);
  if (!sharedEnv) {
    serverLogger.warn(`Shared settings not found: ${sharedSettingsPath}`);
  }

  // v2：sharedDir/<tenantSlug>/.ky-agent/settings.json — 扫子目录拼 map
  const tenantSharedEnv: Record<string, Record<string, string>> = {};
  try {
    const entries = readdirSync(sharedDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name === 'skills-pool' || entry.name === 'scripts') continue;
      const slug = entry.name;
      // slug 安全校验（防止扫到 ".." 之类异常目录名）
      if (!/^[a-z][a-z0-9-]{1,30}$/.test(slug)) continue;
      const path = resolveAgentPath(join(sharedDir, slug), 'settings.json');
      const env = loadSettingsEnv(path);
      if (env) {
        tenantSharedEnv[slug] = env;
        serverLogger.info(`Loaded tenant settings: ${slug} (${Object.keys(env).length} env entries)`);
      }
    }
  } catch (err) {
    serverLogger.warn(`Failed to scan tenant settings dirs: ${err}`);
  }

  const uploadsDir = join(agentCwd, 'uploads');
  const sessionBasePath = processCwd;

  // Memory Index: 只保留索引服务本身；OpenAI Agents 的 MCP/function tool 接入后续单独实现。
  const memoryIndexServiceRef: { current: MemoryIndexService | null } = { current: null };
  const memoryIndexServices = new Set<MemoryIndexService>();
  const initialMemoryIndexService = createMemoryIndexService(processCwd, config.memory?.index);
  if (initialMemoryIndexService) {
    memoryIndexServiceRef.current = initialMemoryIndexService;
    memoryIndexServices.add(initialMemoryIndexService);
    serverLogger.info('Memory index service created (hybrid search enabled)');
  }
  const memoryIndexShutdown = async () => {
    const services = Array.from(memoryIndexServices);
    memoryIndexServices.clear();
    memoryIndexServiceRef.current = null;
    await Promise.allSettled(services.map((service) => service.closeAll()));
  };

  const agentOptionsConfig: AgentOptionsConfig = {
    proxy: config.proxy,
    agent: config.agent,
    sharedEnv,
    tenantSharedEnv,
    sharedDir,
  };

  // Title generator config 链（主 + fallback）
  // 主模型返回空 / 报错时，自动 fallback。命名场景对模型质量不敏感、对可用性敏感，
  // 主推稳定模型即可。
  const titleGeneratorConfigs: TitleGeneratorConfig[] = [];

  // 检测：resolveModelRef 在 ref 失败时会**静默回退到 default**——
  // 之前 titleGenerator.model 配 "openai-agents/glm-5.2" 实际跑的是 default
  // "ark-agents/glm-5.2"，几个月没人察觉。比对 ref modelId 与解析结果，不一致就 warn。
  const detectSilentFallback = (ref: string, resolvedModel: string, label = 'Title generator') => {
    const refModelId = ref.split('/').pop() ?? '';
    if (refModelId && resolvedModel !== refModelId) {
      serverLogger.warn(
        `${label}: ref "${ref}" silently fell back to default ` +
          `(resolved="${resolvedModel}"); check models.groups for the correct groupId.`,
      );
    }
  };

  if (config.titleGenerator?.model && config.models) {
    const resolved = resolveModelRef(config.models, config.titleGenerator.model);
    if (resolved) {
      titleGeneratorConfigs.push({ model: resolved.model, connection: resolved.connection });
      serverLogger.info(`Title generator: using model "${resolved.model}" from "${config.titleGenerator.model}"`);
      detectSilentFallback(config.titleGenerator.model, resolved.model);
    } else {
      serverLogger.warn(`Title generator: model ref "${config.titleGenerator.model}" not found, falling back to default`);
      const fallbackModel = process.env.OPENAI_DEFAULT_MODEL || process.env.OPENAI_MODEL || 'gpt-5.4-mini';
      titleGeneratorConfigs.push({ model: fallbackModel });
    }
    // 解析 fallbackModels：每个都得在 models 配置里有定义；找不到的直接跳过 + warn。
    for (const ref of config.titleGenerator.fallbackModels ?? []) {
      const fb = resolveModelRef(config.models, ref);
      if (fb) {
        titleGeneratorConfigs.push({ model: fb.model, connection: fb.connection });
        serverLogger.info(`Title generator: fallback "${fb.model}" from "${ref}"`);
        detectSilentFallback(ref, fb.model);
      } else {
        serverLogger.warn(`Title generator: fallback model ref "${ref}" not found, skipped`);
      }
    }
  } else {
    const fallbackModel = process.env.OPENAI_DEFAULT_MODEL || process.env.OPENAI_MODEL || 'gpt-5.4-mini';
    titleGeneratorConfigs.push({ model: fallbackModel });
  }

  // 门禁模型配置链（主 + fallback；2026-07 唯恩批次）。与 title 不同：
  // config.guardrail 缺省 = 门禁模块不激活（空数组，checkTopicScope fail-open
  // 短路），**没有** env 默认模型兜底。热更由 routes.ts onModelsUpdated 经
  // updateGuardrailModelConfigs 写回本变量；WebChannel 拿的是 getter——避开
  // titleGeneratorConfigs 构造时被捕获旧数组引用的 stale 坑。
  let guardrailModelConfigs: GuardrailModelConfig[] = [];
  if (config.guardrail?.model && config.models) {
    for (const ref of [config.guardrail.model, ...(config.guardrail.fallbackModels ?? [])]) {
      const resolved = resolveModelRef(config.models, ref);
      if (resolved) {
        guardrailModelConfigs.push({ model: resolved.model, connection: resolved.connection });
        serverLogger.info(`Guardrail: model "${resolved.model}" from "${ref}"`);
        detectSilentFallback(ref, resolved.model, 'Guardrail');
      } else {
        serverLogger.warn(`Guardrail: model ref "${ref}" not found, skipped`);
      }
    }
    if (guardrailModelConfigs.length === 0) {
      serverLogger.warn('Guardrail: no model resolved from config.guardrail, module inactive');
    }
  }

  // Auth 初始化（需要在 dispatch 之前，因为 agentStore 依赖 userStore）
  let userStore: UserStore | undefined;
  let tenantStore: TenantStore | undefined;
  let authMiddleware: ReturnType<typeof createAuthMiddleware> | undefined;

  if (config.auth?.enabled && config.auth.jwtSecret) {
    const usersFilePath = resolve(processCwd, config.auth.usersFile || './data/users.json');
    userStore = new UserStore(usersFilePath);

    // Tenant store 与 user store 共生命周期；tenants.json 放在 users.json 同目录。
    // 启动期保证平台根组织和开沿日常组织都始终存在。
    const tenantsFilePath = join(dirname(usersFilePath), 'tenants.json');
    tenantStore = new TenantStore(tenantsFilePath);
    await tenantStore.ensureDefaultTenant();
    await tenantStore.ensureKaiyanTenant();
    authMiddleware = createAuthMiddleware(config.auth.jwtSecret, userStore, tenantStore, config.auth.tokenExpiresIn || '30d');
    serverLogger.info('Auth enabled');
    serverLogger.info(`Tenant store loaded: ${tenantStore.count()} tenant(s), platform='${DEFAULT_TENANT_ID}', legacy='${LEGACY_TENANT_ID}'`);
  }

  // Agent profiles store
  let agentStore: AgentStore | undefined;
  if (userStore) {
    const agentStoreFile = resolve(processCwd, './data/agents.json');
    agentStore = new AgentStore(agentStoreFile);
    const allUsernames = userStore.listAll().map(u => u.username);
    agentStore.initDefaults(allUsernames);
  }

  // 公司级专职 Agent store（2026-07 唯恩批次）：组织管理员定义、员工使用。
  // 仅 auth 启用时装配（org agent 依赖租户/用户身份）；文件与 agents.json 同目录。
  let orgAgentStore: OrgAgentStore | undefined;
  if (userStore) {
    orgAgentStore = new OrgAgentStore(resolve(processCwd, './data/org-agents.json'));
    serverLogger.info(`Org agent store loaded: ${orgAgentStore.listAll().length} agent(s)`);
  }

  // ── 零停机部署（2026-07-15）：listen 后执行的后台启动任务 ──────────
  // 重 IO 的启动工作（skills 全量物化）从 createRuntime 关键路径移出，
  // index.ts 在 app.listen 之后调用 runDeferredStartupTasks() 执行。
  // 启动关键路径只保留轻量配置级操作 → healthz-ready 秒级。
  const deferredStartupTasks: Array<{ name: string; run: () => Promise<void> }> = [];
  const skillsWarmup: SkillsWarmupStatus = { state: 'pending' };

  // Skills config store
  let skillConfigStore: SkillConfigStore | undefined;
  if (userStore) {
    const skillsConfigPath = resolve(processCwd, './data/skills-config.json');
    if (!existsSync(skillsConfigPath)) {
      // 首次启动：从旧 _manifest.json 迁移
      const poolDir = resolveAgentPath(sharedDir, 'skills-pool');
      const tmpStore = new SkillConfigStore(skillsConfigPath);
      const allUsernames = userStore.listAll().map(u => u.username);
      migrateFromManifest(tmpStore, poolDir, allUsernames);
      skillConfigStore = tmpStore;
      serverLogger.info('Skills config store initialized (migrated from manifest)');
    } else {
      skillConfigStore = new SkillConfigStore(skillsConfigPath);
      serverLogger.info('Skills config store loaded');
    }
    // 启动时：发现新 skill → 内容指纹比对 → 后台版本化物化 → 清理幽灵条目
    // 2026-07-15 零停机部署批次：旧「启动无条件全量 syncSkills」（16 用户实测
    // 约 165s，阻塞 listen）拆为两段——
    //   同步段（快，配置级）：syncWithPool 补全配置 + 内容指纹比对（指纹变化
    //     → bump configVersion，驱动版本化同步）；
    //   后台段（listen 后 deferredStartupTasks 执行）：逐用户版本检查物化 +
    //     prune 幽灵条目 + 写版本标记。用户在后台段完成前发起会话时，由
    //     dispatch 路径的 refreshUserWorkspace 版本检查兜底，正确性不依赖后台段。
    const poolDir = resolveAgentPath(sharedDir, 'skills-pool');
    // δ: scanPoolSkills 已经在文件顶部静态 import 为 scanPoolSkillsForDispatch；
    //     不需要再 dynamic import。syncSkills 同理用静态 import。
    const currentPoolIds = new Set(scanPoolSkillsForDispatch(poolDir).map(s => s.id));

    // 安全检查：pool 为空（目录不存在或内容被清空）或配置损坏时跳过全量同步
    if (currentPoolIds.size === 0) {
      serverLogger.warn('Skills pool is empty or missing, skipping startup sync');
      skillsWarmup.state = 'done';
    } else if (skillConfigStore.loadFailed) {
      serverLogger.warn('Skills config was corrupted, skipping startup sync to prevent data loss');
      skillsWarmup.state = 'failed';
      skillsWarmup.error = 'skills config corrupted';
    } else {

    // 1. 将 pool 文件系统新增的 skill 写入 poolVisibility（补全缺失条目）
    const discovered = skillConfigStore.syncWithPool(currentPoolIds);
    if (discovered > 0) {
      serverLogger.info(`Skills config: discovered ${discovered} new pool skills`);
    }

    // 2. 内容指纹：skill 文件内容变化（通常随新 release 携带）→ bump
    //    configVersion，让版本驱动同步（后台 warmup + dispatch refresh）物化。
    //    指纹基于文件内容而非 mtime → no-op 部署/重启不触发全用户复制。
    try {
      const fingerprint = computeSkillsContentFingerprint(poolDir, tenantSkillsRootDir);
      if (fingerprint !== skillConfigStore.getPoolContentHash()) {
        skillConfigStore.setPoolContentHashSync(fingerprint);
        serverLogger.info('Skills content fingerprint changed; configVersion bumped for versioned sync');
      }
    } catch (err) {
      serverLogger.warn(`Skills content fingerprint failed (versioned sync falls back to config-only changes): ${err instanceof Error ? err.message : String(err)}`);
    }

    // 3. 逐用户物化 + prune + 版本标记 → 后台任务（listen 后执行）
    const store = skillConfigStore;
    const warmupUserStore = userStore;
    deferredStartupTasks.push({
      name: 'skills-warmup',
      run: async () => {
        skillsWarmup.state = 'running';
        skillsWarmup.startedAtMs = Date.now();
        try {
          // 3a. 逐用户版本检查物化。
          // PR 5 修 P0-7：PR 4 后 workspace 路径变为 <cwd>/<tenant>/<user>/，必须用
          // resolveUserCwd 才能命中正确路径；之前 join(agentCwd, u.username) 全部 ENOENT。
          const allUsers = warmupUserStore.listAll();
          skillsWarmup.totalUsers = allUsers.length;
          skillsWarmup.processedUsers = 0;
          let synced = 0;
          for (const u of allUsers) {
            const workspaceUser = { id: u.id, username: u.username, role: u.role as 'admin' | 'user', tenantId: u.tenantId };
            const userCwd = resolveUserCwd(agentCwd, workspaceUser);
            if (existsSync(agentDir(userCwd))) {
              let localVersion = 0;
              try {
                localVersion = parseInt(readFileSync(agentPath(userCwd, '.skills-version'), 'utf-8').trim(), 10) || 0;
              } catch { /* 标记缺失 → 视为 0，触发同步 */ }
              if (localVersion < store.getConfigVersion()) {
                // syncSkills 是同步 fs 重操作（共享盘上逐用户秒级）；本任务在
                // listen 后运行，逐用户 yield 一次事件循环，避免长时间饿死在线请求。
                syncSkills(userCwd, sharedDir, workspaceUser, store, tenantSkillsRootDir);
                synced++;
              }
            }
            skillsWarmup.processedUsers++;
            await new Promise<void>((r) => setImmediate(r));
          }
          skillsWarmup.syncedUsers = synced;

          // 3b. 清理配置中的幽灵条目（全部用户 sync 完成后再清理，避免 syncSkills
          //     清理用户残留副本时读不到 poolVisibility 历史记录）
          const tenantOwnIdsByTenant: Record<string, Set<string>> = {};
          const tenantsRoot = tenantSkillsRootDir;
          if (existsSync(tenantsRoot)) {
            for (const entry of readdirSync(tenantsRoot)) {
              try {
                if (!statSync(join(tenantsRoot, entry)).isDirectory()) continue;
                tenantOwnIdsByTenant[entry] = scanTenantOwnSkillIds(resolveTenantSkillsDirFromRoot(tenantSkillsRootDir, entry), currentPoolIds);
              } catch {
                // 非法目录名或读取失败，跳过
              }
            }
          }
          const pruned = store.pruneStaleSkills(currentPoolIds, tenantOwnIdsByTenant);
          if (pruned > 0) {
            serverLogger.info(`Skills config: pruned ${pruned} stale entries`);
          }

          // 3c. 更新版本标记（写入 prune 后的最新 configVersion，避免 dispatch 时冗余同步）
          for (const u of allUsers) {
            const workspaceUser = { id: u.id, username: u.username, role: u.role as 'admin' | 'user', tenantId: u.tenantId };
            const userCwd = resolveUserCwd(agentCwd, workspaceUser);
            const versionFile = agentPath(userCwd, '.skills-version');
            if (existsSync(agentDir(userCwd))) {
              writeFileSync(versionFile, String(store.getConfigVersion()), 'utf-8');
            }
          }

          skillsWarmup.state = 'done';
          skillsWarmup.finishedAtMs = Date.now();
          serverLogger.info(`Skills warmup done: synced=${synced}/${allUsers.length} users in ${skillsWarmup.finishedAtMs - (skillsWarmup.startedAtMs ?? skillsWarmup.finishedAtMs)}ms`);
        } catch (err) {
          skillsWarmup.state = 'failed';
          skillsWarmup.finishedAtMs = Date.now();
          skillsWarmup.error = err instanceof Error ? err.message : String(err);
          serverLogger.error('Skills warmup failed (dispatch-time versioned sync still covers correctness):', err);
        }
      },
    });

    } // end of safety-checked startup sync block
  } else {
    // 无 userStore（auth 关闭的开发形态）：没有多用户物化需求
    skillsWarmup.state = 'done';
  }

  const memoryEnabled = config.memory?.enabled !== false;
  const sessionCatalog = new FileSessionCatalog({ agentCwd });
  let runtimeEventStoreShutdown: (() => Promise<void>) | undefined;
  let pgEventStore: PgEventStore | undefined;
  let pgRunStore: PgRunStore | undefined;
  let pgSessionProjectionStore: PgSessionProjectionStore | undefined;
  let pgHandStore: PgHandStore | undefined;
  let pgToolInvocationStore: PgToolInvocationStore | undefined;
  let pgClientDaemonRegistry: PgClientDaemonRegistry | undefined;
  let guardrailEventStore: PgGuardrailEventStore | undefined;
  let messageFeedbackStore: PgMessageFeedbackStore | undefined;
  let appealStore: PgAppealStore | undefined;
  let pgArtifactStore: PgArtifactStore | undefined;
  let systemMetricsStore: PgSystemMetricsStore | undefined;
  let systemMetricsCollector: SystemMetricsCollector | undefined;
  let alertStateStore: PgAlertStateStore | undefined;
  let alertNotifier: AlertNotifier | undefined;
  let dwsConnectionStore: PgDwsConnectionStore | undefined;
  let dwsAuthSessionStore: PgDwsAuthSessionStore | undefined;
  let dwsAuthKeepaliveService: DwsAuthKeepaliveService | undefined;
  let dwsAuthFlowService: DwsAuthFlowService | undefined;
  let feishuConnectionStore: PgFeishuConnectionStore | undefined;
  let feishuAuthSessionStore: PgFeishuAuthSessionStore | undefined;
  let feishuAuthKeepaliveService: FeishuAuthKeepaliveService | undefined;
  let feishuAuthFlowService: FeishuAuthFlowService | undefined;
  let artifactStore: ArtifactStore | undefined;
  let artifactService: ArtifactService | undefined;
  let sessionShareStore: SessionShareStore | undefined;
  let artifactShutdown: (() => Promise<void>) | undefined;
  let billingService: BillingService | undefined;
  let billingAuditTimer: NodeJS.Timeout | undefined;
  let runtimeEventRetention: RuntimeEventRetention | undefined;
  let runtimeScheduler: RuntimeScheduler | undefined;
  let runtimeEventSubscriptionShutdown: (() => Promise<void>) | undefined;
  let cancelDeliveryRetryTimer: NodeJS.Timeout | undefined;
  let runtimeSchedulerAutoWake = false;
  // B4: HandHealthScanner 仅 PG runtime 装配，shutdown 时 stop()。
  let handHealthScanner: HandHealthScanner | undefined;
  // A2: SecretVault 提前到 ClientDaemonGateway 之前，便于装配时按 vault ref 解析
  // clientDaemon.authTokenRef → plaintext，再用 setAuthToken 注入。提前到这里也让
  // MCP / tenant resolver / serverRemote 装配时共享同一个 vault 实例。
  const secretVault: SecretVault = (() => {
    const vc = config.secretVault;
    if (!vc || vc.backend === 'memory') {
      return new InMemorySecretVault();
    }
    if (vc.backend === 'encrypted-file') {
      const key = vc.encryptionKey
        ?? (vc.encryptionKeyEnv ? process.env[vc.encryptionKeyEnv] : undefined);
      if (!key || key.length < 16) {
        throw new Error(
          `secretVault.backend="encrypted-file" 加密密钥未提供或长度 <16：${vc.encryptionKeyEnv ? `env "${vc.encryptionKeyEnv}" 为空或过短` : 'encryptionKey 缺失'}`,
        );
      }
      const filePath = resolve(processCwd, vc.filePath);
      return new EncryptedFileSecretVault(filePath, key);
    }
    // http
    const token = vc.authToken
      ?? (vc.authTokenEnv ? process.env[vc.authTokenEnv] : undefined);
    if (!token || token.length < 8) {
      throw new Error(
        `secretVault.backend="http" bearer token 未提供或长度 <8：${vc.authTokenEnv ? `env "${vc.authTokenEnv}" 为空或过短` : 'authToken 缺失'}`,
      );
    }
    return new HttpSecretVault({ baseUrl: vc.baseUrl, authToken: token });
  })();

  // A5: clientDaemon 的 bearer 在装配阶段解析为 plaintext。`authTokenRef` 走 vault
  // (actor:'system', scope:'secret:client_daemon:read')，`authToken` inline 透传。
  // 两者都未提供时返回 undefined → gateway 接受任意连接（dev/受信网络）。
  const resolvedClientDaemonAuthToken = await (async (): Promise<string | undefined> => {
    const cd = config.clientDaemon;
    if (!cd) return undefined;
    if (cd.authTokenRef) {
      try {
        return await secretVault.getSecret(cd.authTokenRef, {
          actor: 'system',
          userId: '__system__',
          scopes: ['secret:client_daemon:read'],
        });
      } catch (err) {
        throw new Error(
          `clientDaemon.authTokenRef "${cd.authTokenRef}" 解析失败: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return cd.authToken;
  })();

  // 飞书官方 CLI 的 device flow 必须先绑定一个企业自建应用。App ID 可由普通 env
  // 提供；App Secret 优先从 SecretVault ref 解析，兼容直接 env 仅用于部署迁移。
  // 明文只保留在 server 进程内，后续经 ACS 内部 __FeishuCli 的 stdin 写入用户
  // workspace 加密 keychain，不进入浏览器、PG、sandbox env 或 Agent transcript。
  const resolvedFeishuConnector = await (async (): Promise<{ appId: string; appSecret: string } | undefined> => {
    const appId = process.env.FEISHU_CONNECTOR_APP_ID?.trim();
    const appSecretRef = process.env.FEISHU_CONNECTOR_APP_SECRET_REF?.trim();
    const inlineSecret = process.env.FEISHU_CONNECTOR_APP_SECRET?.trim();
    if (!appId && !appSecretRef && !inlineSecret) return undefined;
    if (!appId) {
      serverLogger.warn('Feishu connector disabled: FEISHU_CONNECTOR_APP_ID is missing');
      return undefined;
    }
    try {
      const appSecret = appSecretRef
        ? await secretVault.getSecret(appSecretRef, {
            actor: 'system',
            userId: '__system__',
            scopes: ['secret:feishu_connector:read'],
          })
        : inlineSecret;
      if (!appSecret) {
        serverLogger.warn('Feishu connector disabled: app secret is missing');
        return undefined;
      }
      return { appId, appSecret };
    } catch (err) {
      serverLogger.warn(`Feishu connector disabled: app secret resolution failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  })();

  // P4 防御纵深（2026-06-22 落地，06-26 收敛 admin 容器 env）：把按 tenant 装配子进程 env 的规则统一塞进
  // ServerLocal / Container 两条路径。buildTenantScopedEnv 会按 workspace.tenantId
  // 决定是"匿名内部调用保留完整 process.env"还是"明确 tenant 先剔除敏感宿主
  // env，再复原显式配置 + 注入 per-user PAT"。
  const executionTransportRegistry = createDefaultExecutionTransportRegistry({
    envBuilder: (workspace) => buildTenantScopedEnv({ agentOptions: agentOptionsConfig }, workspace),
  });
  const clientDaemonTransport = new ClientDaemonTransport();
  executionTransportRegistry.register('client', clientDaemonTransport);
  let clientDaemonGateway: ClientDaemonGateway | undefined;
  let webRuntimeEventSink: ((args: {
    sessionId: string;
    runId: string;
    streamId?: string;
    userId?: string;
    clientMsgId?: string;
    event: import('../types/index.js').OutboundEvent;
  }) => void) | undefined;
  if (config.runtimeEventStore?.backend === 'pg') {
    pgEventStore = new PgEventStore({
      connectionString: config.runtimeEventStore.connectionString,
      tablePrefix: config.runtimeEventStore.tablePrefix,
      poolMax: config.runtimeEventStore.poolMax,
      logger: serverLogger.child('PgEventStore'),
    });
    await pgEventStore.init();
    try {
      dwsConnectionStore = new PgDwsConnectionStore({
        pool: pgEventStore.pool,
        tablePrefix: config.runtimeEventStore.tablePrefix,
      });
      await dwsConnectionStore.init();
    } catch (err) {
      dwsConnectionStore = undefined;
      serverLogger.warn(`PgDwsConnectionStore init failed, DWS keepalive disabled: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (dwsConnectionStore) {
      try {
        dwsAuthSessionStore = new PgDwsAuthSessionStore({
          pool: pgEventStore.pool,
          tablePrefix: config.runtimeEventStore.tablePrefix,
        });
        await dwsAuthSessionStore.init();
      } catch (err) {
        dwsAuthSessionStore = undefined;
        serverLogger.warn(`PgDwsAuthSessionStore init failed, DWS one-click connection disabled: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    try {
      feishuConnectionStore = new PgFeishuConnectionStore({
        pool: pgEventStore.pool,
        tablePrefix: config.runtimeEventStore.tablePrefix,
      });
      await feishuConnectionStore.init();
    } catch (err) {
      feishuConnectionStore = undefined;
      serverLogger.warn(`PgFeishuConnectionStore init failed, Feishu keepalive disabled: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (feishuConnectionStore) {
      try {
        feishuAuthSessionStore = new PgFeishuAuthSessionStore({
          pool: pgEventStore.pool,
          tablePrefix: config.runtimeEventStore.tablePrefix,
        });
        await feishuAuthSessionStore.init();
      } catch (err) {
        feishuAuthSessionStore = undefined;
        serverLogger.warn(`PgFeishuAuthSessionStore init failed, Feishu one-click connection disabled: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    pgRunStore = new PgRunStore({
      pool: pgEventStore.pool,
      tablePrefix: config.runtimeEventStore.tablePrefix,
    });
    await pgRunStore.init();
    pgSessionProjectionStore = new PgSessionProjectionStore({
      pool: pgEventStore.pool,
      tablePrefix: config.runtimeEventStore.tablePrefix,
    });
    await pgSessionProjectionStore.init();
    setSessionMetaProjectionSink({
      upsert: async (transcriptPath, meta) => {
        await pgSessionProjectionStore!.upsertFromMeta(transcriptPath, meta);
      },
      delete: async (sessionId) => {
        await pgSessionProjectionStore!.deleteBySessionId(sessionId);
      },
    });
    pgHandStore = new PgHandStore({
      pool: pgEventStore.pool,
      tablePrefix: config.runtimeEventStore.tablePrefix,
    });
    await pgHandStore.init();
    pgToolInvocationStore = new PgToolInvocationStore({
      pool: pgEventStore.pool,
      tablePrefix: config.runtimeEventStore.tablePrefix,
    });
    await pgToolInvocationStore.init();
    // 门禁事件落库（专职 Agent 话题门禁；2026-07 唯恩批次）。init 失败降级
    // undefined（WebChannel 侧落库降级 log）——门禁是体验增强，不因表初始化
    // 失败阻塞启动（兼容红线：PG 不可用时门禁照常判定）。
    try {
      const store = new PgGuardrailEventStore({
        pool: pgEventStore.pool,
        tablePrefix: config.runtimeEventStore.tablePrefix,
      });
      await store.init();
      guardrailEventStore = store;
    } catch (err) {
      serverLogger.warn(`PgGuardrailEventStore init failed, guardrail events degrade to log: ${err instanceof Error ? err.message : String(err)}`);
    }
    // 消息反馈落库（质检台需求雷达的另一半）。init 失败降级 undefined →
    // 反馈路由 503，前端隐藏入口——反馈是体验增强，不阻塞启动。
    try {
      const store = new PgMessageFeedbackStore({
        pool: pgEventStore.pool,
        tablePrefix: config.runtimeEventStore.tablePrefix,
      });
      await store.init();
      messageFeedbackStore = store;
    } catch (err) {
      serverLogger.warn(`PgMessageFeedbackStore init failed, feedback routes degrade to 503: ${err instanceof Error ? err.message : String(err)}`);
    }
    // 员工申诉落库（企业专家目录批次；按 guardrail event 反查 owner 做越权守卫）。
    // init 失败降级 undefined → /api/appeals 路由 503，前端隐藏申诉入口——
    // 申诉是体验增强，不阻塞启动。
    try {
      const store = new PgAppealStore({
        pool: pgEventStore.pool,
        tablePrefix: config.runtimeEventStore.tablePrefix,
      });
      await store.init();
      appealStore = store;
    } catch (err) {
      serverLogger.warn(`PgAppealStore init failed, appeal routes degrade to 503: ${err instanceof Error ? err.message : String(err)}`);
    }
    pgArtifactStore = new PgArtifactStore({
      pool: pgEventStore.pool,
      tablePrefix: config.runtimeEventStore.tablePrefix,
    });
    await pgArtifactStore.init();
    artifactStore = pgArtifactStore;
    const pgSessionShareStore = new PgSessionShareStore({
      pool: pgEventStore.pool,
      tablePrefix: config.runtimeEventStore.tablePrefix,
    });
    await pgSessionShareStore.init();
    sessionShareStore = pgSessionShareStore;
    systemMetricsStore = new PgSystemMetricsStore({
      pool: pgEventStore.pool,
      tablePrefix: config.runtimeEventStore.tablePrefix,
    });
    await systemMetricsStore.init();
    alertStateStore = new PgAlertStateStore({
      pool: pgEventStore.pool,
      tablePrefix: config.runtimeEventStore.tablePrefix,
    });
    await alertStateStore.init();
    // C1: per-device daemon registry (PG backend). dev/file backend uses the
    // shared bearer fallback path inside ClientDaemonGateway.
    pgClientDaemonRegistry = new PgClientDaemonRegistry({
      pool: pgEventStore.pool,
      tablePrefix: config.runtimeEventStore.tablePrefix,
    });
    await pgClientDaemonRegistry.init();
    const billingLogger = serverLogger.child('Billing');
    const pgBillingStore = new PgBillingStore({
      pool: pgEventStore.pool,
      tablePrefix: config.runtimeEventStore.tablePrefix,
      eventsTable: pgEventStore.eventsTable,
      runsTable: pgRunStore.runsTable,
      logger: billingLogger,
    });
    await pgBillingStore.init();
    billingService = new BillingService({
      store: pgBillingStore,
      userStore,
      logger: billingLogger,
      // memory_poll 计费豁免（2026-07-14 曾磊拍板默认不扣）：仅当租户显式开启
      // features.memoryPollChargesCredits 时 memory_poll run 才产生 debit
      isMemoryPollBillable: (tenantId) => {
        try {
          return tenantStore?.getSettings(tenantId)?.features?.memoryPollChargesCredits === true;
        } catch {
          return false;
        }
      },
    });
    alertNotifier = new AlertNotifier({
      config,
      alertStateStore,
      runStore: pgRunStore,
      eventStore: pgEventStore,
      systemMetricsStore,
      billingService,
      secretVault,
      logger: serverLogger.child('AlertNotifier'),
    });
    if (config.systemMonitor?.enabled !== false) {
      systemMetricsCollector = new SystemMetricsCollector({
        store: systemMetricsStore,
        agentCwd,
        processCwd,
        tablePrefix: config.runtimeEventStore.tablePrefix,
        tenantStore,
        userStore,
        enabled: config.systemMonitor?.enabled,
        fastIntervalMs: config.systemMonitor?.fastIntervalMs,
        workspaceScanIntervalMs: config.systemMonitor?.workspaceScanIntervalMs,
        duConcurrency: config.systemMonitor?.duConcurrency,
        tlsCheckHosts: config.systemMonitor?.tlsCheckHosts,
        logger: serverLogger.child('SystemMetrics'),
      });
      if (processRole === 'all') {
        systemMetricsCollector.start();
      } else {
        serverLogger.info(`SystemMetricsCollector worker disabled for processRole=${processRole}`);
      }
    }
    if (processRole === 'all') {
      alertNotifier.start();
    } else {
      serverLogger.info(`AlertNotifier worker disabled for processRole=${processRole}`);
    }
    const runBillingAudit = async () => {
      const audit = await billingService!.getAuditSummary({ days: 7 });
      if (audit.alerts.length > 0) {
        billingLogger.warn(`Billing audit alerts: ${audit.alerts.join('；')}`);
        await alertNotifier?.notifyExternal('billing_audit', audit.alerts.map((message) => ({
          kind: 'billing_audit',
          severity: 'high' as const,
          title: message,
          occurredAt: new Date().toISOString(),
          actions: ['open_billing'],
          // FIX-2: billing audit 每条 alert 语义不同，去重键保留 message hash（文档 §6.5）。
          dedupeKey: createHash('sha1').update(message).digest('hex').slice(0, 16),
        })));
      }
    };
    void billingService.projectRuntimeEvents(2000)
      .then(() => runBillingAudit())
      .catch((err) => {
        billingLogger.warn(`Billing startup projection/audit failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    billingAuditTimer = setInterval(() => {
      void runBillingAudit().catch((err) => {
        billingLogger.warn(`Billing audit failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, 24 * 60 * 60 * 1000);
    billingAuditTimer.unref?.();
    const retentionConfig = config.runtimeEventRetention;
    runtimeEventRetention = new RuntimeEventRetention({
      pool: pgEventStore.pool,
      eventsTable: pgEventStore.eventsTable,
      billingProjectionStateTable: pgBillingStore.projectionStateTable,
      archiveDir: resolve(processCwd, retentionConfig?.archiveDir ?? './data/runtime-event-archives'),
      enabled: retentionConfig?.enabled,
      dailyAtHour: retentionConfig?.dailyAtHour,
      dailyAtMinute: retentionConfig?.dailyAtMinute,
      batchLimit: retentionConfig?.batchLimit,
      toolDeltaRetentionDays: retentionConfig?.toolDeltaRetentionDays,
      failedInvocationRetentionDays: retentionConfig?.failedInvocationRetentionDays,
      handEventRetentionDays: retentionConfig?.handEventRetentionDays,
      billingCatchupBatchLimit: retentionConfig?.billingCatchupBatchLimit,
      billingCatchupMaxBatches: retentionConfig?.billingCatchupMaxBatches,
      projectBillingRuntimeEvents: (limit) => billingService!.projectRuntimeEvents(limit),
      logger: serverLogger.child('RuntimeEventRetention'),
    });
    if (processRole === 'all') {
      runtimeEventRetention.start();
    } else {
      serverLogger.info(`RuntimeEventRetention disabled for processRole=${processRole}`);
    }
    const recoveryResult = await recoverRunningToolInvocations({
      toolInvocationStore: pgToolInvocationStore,
      eventStore: pgEventStore,
      runStore: pgRunStore,
      logger: serverLogger.child('ToolInvocationRecovery'),
    });
    if (recoveryResult.recovered > 0) {
      serverLogger.warn(`Recovered stale running tool invocations at startup: ${recoveryResult.recovered}/${recoveryResult.scanned}`);
    }
    runtimeEventStoreShutdown = async () => {
      setSessionMetaProjectionSink(undefined);
      clientDaemonGateway?.close();
      handHealthScanner?.stop();
      systemMetricsCollector?.stop();
      alertNotifier?.stop();
      await runtimeScheduler?.stop();
      if (cancelDeliveryRetryTimer) clearInterval(cancelDeliveryRetryTimer);
      if (billingAuditTimer) clearInterval(billingAuditTimer);
      runtimeEventRetention?.stop();
      await runtimeEventSubscriptionShutdown?.();
      await pgEventStore!.close();
    };
    serverLogger.info('Runtime EventStore initialized: backend=pg; durable RunStore + HandStore + RuntimeScheduler initialized');
  }

  clientDaemonGateway = new ClientDaemonGateway({
    transport: clientDaemonTransport,
    handStore: pgHandStore,
    path: config.clientDaemon?.path,
    authToken: resolvedClientDaemonAuthToken,
    // C1: per-device registry — PG backend only. file/dev backend keeps the
    // shared bearer flow with no behavior change.
    ...(pgClientDaemonRegistry ? { deviceRegistry: pgClientDaemonRegistry, deviceSecretVault: secretVault } : {}),
    helloTimeoutMs: config.clientDaemon?.helloTimeoutMs,
    heartbeatTimeoutMs: config.clientDaemon?.heartbeatTimeoutMs,
    heartbeatScanIntervalMs: config.clientDaemon?.heartbeatScanIntervalMs,
    logger: serverLogger.child('ClientDaemonGateway'),
  });

  // 任何"按 sessionId 读事件流"的读路径都应通过这个 factory 拿 store，
  // 避免硬编码 FileEventStore 导致 PG backend 读到空 jsonl。
  // 注入到 WebChannel.runtimeEventStoreFor + createSessionsRouter.runtimeEventStoreFor。
  const runtimeEventStoreFor: (transcriptPath: string) => EventStore = pgEventStore
    ? (_transcriptPath) => pgEventStore!  // PG backend：共享 pool，按 session_id 过滤
    : (transcriptPath) => new FileEventStore(getRuntimeEventLogPath(transcriptPath));

  sessionShareStore ??= new InMemorySessionShareStore();
  artifactStore ??= new InMemoryArtifactStore();
  const artifactConfig = config.artifact;
  let artifactBlobStore: ArtifactBlobStore;
  if (artifactConfig?.backend === 'oss') {
    artifactBlobStore = new OssArtifactBlobStore({
      accessKeyId: artifactConfig.accessKeyId,
      accessKeySecret: artifactConfig.accessKeySecret,
      bucket: artifactConfig.bucket,
      region: artifactConfig.region,
      endpoint: artifactConfig.endpoint,
      prefix: artifactConfig.prefix,
    });
    serverLogger.info(`Artifact blob store initialized: backend=oss bucket=${artifactConfig.bucket}`);
  } else {
    const localRoot = resolve(processCwd, artifactConfig?.backend === 'local' && artifactConfig.rootDir ? artifactConfig.rootDir : './data/artifacts');
    ensureDirectory(localRoot, 'artifact blob directory');
    artifactBlobStore = new LocalArtifactBlobStore({
      rootDir: localRoot,
      publicBaseUrl: artifactConfig?.backend === 'local' ? artifactConfig.publicBaseUrl : undefined,
    });
    serverLogger.info(`Artifact blob store initialized: backend=local root=${localRoot}`);
  }
  artifactService = new ArtifactService({
    artifactStore,
    blobStore: artifactBlobStore,
    agentCwd,
    signingSecret: artifactConfig?.signedUrlSecret ?? config.auth?.jwtSecret,
    defaultReadUrlTtlSeconds: artifactConfig?.readUrlTtlSeconds,
    maxBlobBytes: artifactConfig?.maxBlobBytes,
  });
  if (artifactConfig?.retentionDays) {
    const runArtifactGc = async () => {
      const result = await artifactService!.pruneExpiredArtifacts(artifactConfig.retentionDays!, 200);
      if (result.deleted > 0) {
        serverLogger.info(`Artifact GC deleted ${result.deleted}/${result.scanned} expired artifacts`);
      }
    };
    runArtifactGc().catch((err) => {
      serverLogger.warn(`Artifact GC startup pass failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    const artifactGcTimer = setInterval(() => {
      runArtifactGc().catch((err) => {
        serverLogger.warn(`Artifact GC pass failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, artifactConfig.gcIntervalMs ?? 24 * 60 * 60 * 1000);
    artifactGcTimer.unref?.();
    artifactShutdown = async () => {
      clearInterval(artifactGcTimer);
    };
  }

  // Runtime-level execution config（A+C）：
  // - 已认证用户（含 platform admin）默认 server-container，作为本机 Docker 隔离 fallback；
  // - 匿名/内部调用默认 server-local，避免 cron/maintenance 路径被这次切换顺手改道；
  // - 若 session attach 了唯一 ready tenant-remote hand，工具层仍会优先自动路由到该 hand；
  // - 普通用户不允许显式指定 executionTarget（系统策略自动选择隔离目标）。
  const executionConfig = createExecutionConfig({
    defaultTarget: 'server-local',
    tenantDefaultTarget: 'server-container',
    allowAdminOverride: true,
    allowUserOverride: false,
  });
  // PG backend 时：用同一 pool 启动 PgSessionLock 给两条 dispatch 防多 brain
  // 并发 wake；file backend 时不启用 lock（单 brain 场景）。
  const sessionLock = pgEventStore ? new PgSessionLock({ pool: pgEventStore.pool }) : undefined;

  // Skills wiring：把 SkillConfigStore + sharedDir 缝成 raw runtime 的 SkillsDispatchConfig，
  // 让 dispatch 不直接依赖 store 实现。
  // δ: listForUser 加 configVersion-aware cache（pool 不变就复用扫描结果，避免
  //    每次 dispatch readdirSync）；resolveSkillDir 加 safeName 防 path traversal。
  const skillsDispatchConfig: SkillsDispatchConfig | undefined = (() => {
    if (!skillConfigStore) return undefined;
    const store = skillConfigStore; // 闭包稳定捕获
    const poolDir = resolveAgentPath(sharedDir, 'skills-pool');
    let cache: { version: number; entries: { id: string; name: string; description: string }[] } | null = null;
    function getAllPoolEntries() {
      const currentVersion = store.getConfigVersion();
      if (cache && cache.version === currentVersion) return cache.entries;
      const scanned = scanPoolSkillsForDispatch(poolDir).map((s) => ({
        id: s.id,
        // 保留 frontmatter name 字段（若无 fallback 到 id）
        name: (s as { name?: string }).name || s.id,
        description: s.description ?? '',
      }));
      cache = { version: currentVersion, entries: scanned };
      return scanned;
    }
    return {
      listForUser(username: string | undefined, requiredSkillIds: readonly string[] = []): SkillEntry[] {
        if (!username) return [];
        const all = getAllPoolEntries();
        const user = userStore?.findByUsername(username);
        const tenantId = user?.tenantId;
        const effective = new Set([
          ...store.getUserEffectivePoolSkills(username, tenantId),
          ...store.getOrgAgentEffectivePoolSkills(tenantId, requiredSkillIds),
        ]);
        const poolResult = all.filter((s) => effective.has(s.id));

        // 追加用户自建 skill：与前端 SkillSelector「自建」tab 同源。
        // 早期 dispatch 只列 pool skill，自建 skill 上传后模型看不到、也调不到（invoke
        // 前 allowed 校验会拒）；2026-07-03 起改为按 selection 暴露给模型，前端 Switch
        // 可开关且真实生效。物理路径由 resolveSkillDir 优先命中 user workspace 副本。
        if (!user) return poolResult;
        try {
          const userCwd = resolveUserCwd(agentCwd, {
            id: user.id,
            username: user.username,
            role: user.role,
            tenantId: user.tenantId,
          });
          const userSkillsDir = resolveAgentPath(userCwd, 'skills');
          const poolIds = new Set(all.map((s) => s.id));
          const tenantSkillsDir = user.tenantId ? resolveTenantSkillsDirFromRoot(tenantSkillsRootDir, user.tenantId) : null;
          const tenantOwnIds = tenantSkillsDir ? scanTenantOwnSkillIds(tenantSkillsDir, poolIds) : new Set<string>();
          const effectiveTenantOwn = new Set(
            [
              ...store.getUserEffectiveTenantOwnSkills(username, user.tenantId, tenantOwnIds),
              ...store.getOrgAgentEffectiveTenantOwnSkills(user.tenantId, tenantOwnIds, requiredSkillIds),
            ],
          );
          const tenantResult = tenantSkillsDir
            ? scanUserCustomSkills(tenantSkillsDir, poolIds)
              .filter((s) => effectiveTenantOwn.has(s.id))
              .map((s) => ({
                id: s.id,
                name: (s as { name?: string }).name || s.id,
                description: s.description ?? '',
              }))
            : [];
          const selected = new Set(store.getUserSelectedSkills(username));
          const customExcluded = new Set([...poolIds, ...tenantOwnIds]);
          const customResult = scanUserCustomSkills(userSkillsDir, customExcluded)
            .filter((s) => selected.has(s.id))
            .map((s) => ({
              id: s.id,
              name: (s as { name?: string }).name || s.id,
              description: s.description ?? '',
            }));
          return [...poolResult, ...tenantResult, ...customResult];
        } catch {
          // 非法路径 / 扫描失败：静默降级为仅 pool，dispatch 不因单用户目录异常而崩
          return poolResult;
        }
      },
      resolveSkillDir(username: string | undefined, skill: string, requiredSkillIds: readonly string[] = []): string | null {
        if (!username) return null;
        if (!SAFE_SKILL_NAME_RE.test(skill)) return null; // 防 path traversal
        // 优先 user workspace 副本（已被 syncSkills 复制）
        // PR 4 路径修复：扁平 `<cwd>/<username>` 已废弃，必须 resolveUserCwd
        // 才能命中正确路径（非 kaiyan 组织用户在 dispatch 时永远 fallback 到
        // pool 副本，agent 调 skill 时实际读到的可能不是用户最新修改的）。
        const u = userStore?.findByUsername(username);
        const userCwd = u
          ? resolveUserCwd(agentCwd, { id: u.id, username: u.username, role: u.role, tenantId: u.tenantId })
          : join(agentCwd, username); // 用户不存在时的兼容兜底
        const userDir = resolveAgentPath(userCwd, 'skills', skill);
        if (existsSync(userDir)) return userDir;
        if (u) {
          try {
            syncSkills(
              userCwd,
              sharedDir,
              { id: u.id, username: u.username, role: u.role, tenantId: u.tenantId },
              store,
              tenantSkillsRootDir,
              requiredSkillIds,
            );
          } catch (err) {
            serverLogger.warn(`Skill sync before invoke failed for ${username}/${skill}: ${err instanceof Error ? err.message : String(err)}`);
          }
          if (existsSync(userDir)) return userDir;
        }
        return null;
      },
    };
  })();

  // MCP client manager（lazy connect per user）。failOnError=false 让连不上的
  // server 不阻塞 dispatch；连接仍快速失败，单次 MCP 工具调用最长允许 10 分钟。
  const mcpConfigStore = new McpConfigStore(join(processCwd, 'data', 'mcp-config.json'));
  const installedMcpPresets = await mcpConfigStore.installBuiltinOAuthServers();
  if (installedMcpPresets > 0) {
    serverLogger.info(`Installed ${installedMcpPresets} built-in OAuth MCP connector preset(s)`);
  }
  const mcpOAuthService = new McpOAuthService({
    store: mcpConfigStore,
    vault: secretVault,
    userResolver: username => {
      const user = userStore?.findByUsername(username);
      return user ? { tenantId: user.tenantId, disabled: user.disabled } : undefined;
    },
  });
  // 自助注册动态配置：文件不存在时用 config.json 的 auth.selfSignup 作 seed（兼容旧配置方式）
  const signupConfigStore = new SignupConfigStore(
    join(processCwd, 'data', 'signup-config.json'),
    config.auth?.selfSignup,
  );
  const mcpCapabilityTokens = new CapabilityTokenService();
  const mcpClientManager = new McpClientManager({
    agentCwd,
    failOnError: false,
    connectTimeoutMs: 5_000,
    invokeTimeoutMs: 10 * 60_000,
    logger: serverLogger.child('McpClient'),
    secretVault,
    configProvider: (username, workspaceRoot) => mcpConfigStore.buildUserMcpServers(
      username,
      workspaceRoot,
      userStore?.findByUsername(username)?.tenantId,
    ),
    workspaceResolver: (username) => {
      const u = userStore?.findByUsername(username);
      return u
        ? resolveUserCwd(agentCwd, { id: u.id, username: u.username, role: u.role, tenantId: u.tenantId })
        : join(agentCwd, username);
    },
    // PR 11：让 mcp_proxy 调 vault.getSecret 时附 tenantId，使
    // tenant/global scope secret 通过 ACL（user-scope secret 行为不变）
    tenantResolver: (username) => userStore?.findByUsername(username)?.tenantId,
    oauthProviderFactory: ({ username, tenantId, serverName }) => mcpOAuthService.runtimeProvider({
      username,
      tenantId,
      serverName,
    }),
  });
  const mcpProxy = new McpProxy({
    manager: mcpClientManager,
    capabilityTokens: mcpCapabilityTokens,
    vault: secretVault,
    logger: serverLogger.child('McpProxy'),
  });
  const mcpClientShutdown = () => mcpClientManager.shutdown();

  const tenantRemoteHandResolver = createTenantRemoteHandAuthTokenResolver({
    tenantRemoteHands: () => config.tenantRemoteHands?.hands,
    vault: secretVault,
    logger: serverLogger.child('TenantHand'),
  });

  // A4: serverRemote 凭证在装配层解析为 plaintext，下游 dispatch / cancel delivery
  // 仍按 plaintext 接收。authTokenRef 走 vault.getSecret(actor:'system')；inline
  // authToken 直接透传。两者互斥由 schema 保证。
  const resolvedServerRemote = await (async () => {
    const sr = config.serverRemote;
    if (!sr) return undefined;
    let authToken: string | undefined;
    if (sr.authTokenRef) {
      try {
        authToken = await secretVault.getSecret(sr.authTokenRef, {
          actor: 'system',
          userId: '__system__',
          scopes: ['secret:server_remote:read'],
        });
      } catch (err) {
        throw new Error(
          `serverRemote.authTokenRef "${sr.authTokenRef}" 解析失败: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else if (sr.authToken) {
      authToken = sr.authToken;
    }
    if (!authToken) {
      throw new Error('serverRemote 凭证解析失败：authToken/authTokenRef 都为空（schema 应已拦截）');
    }
    return {
      baseUrl: sr.baseUrl,
      authToken,
      ...(sr.invokeTimeoutMs !== undefined ? { invokeTimeoutMs: sr.invokeTimeoutMs } : {}),
    };
  })();

  const resolvedWebTools = await resolveWebToolsConfig(config.webTools, secretVault);
  const resolvedImageGenTools = await resolveImageGenToolsConfig(config.imageGenTools, secretVault);
  // 生图 per-engine 定价注册表初始化；admin PUT /api/admin/image-gen-pricing 时热更。
  configureImageGenPricing(config.imageGenTools?.pricing);

  // 模型解析器：如果配置了 models，绑定到 RawRuntime / WebChannel / Cron
  const modelResolver = config.models
    ? (ref: string, tenantId?: string) => {
        const tenantSettings = tenantId ? tenantStore?.getSettings(tenantId) : undefined;
        if (!isModelAllowedForTenant(config.models!, tenantSettings, ref)) return null;
        return resolveModelRef(config.models!, ref);
      }
    : undefined;
  const defaultModelResolver = config.models
    ? (tenantId?: string) => {
        const tenantSettings = tenantId ? tenantStore?.getSettings(tenantId) : undefined;
        const ref = getTenantPublicModelList(config.models!, tenantSettings).default || config.models!.default;
        const resolved = modelResolver?.(ref, tenantId);
        return resolved ? { ref, ...resolved } : null;
      }
    : undefined;

  // 用户活动聚合（2026-07-14 记忆轮询批次）：PG 后端可用；file backend 下
  // available=false，UserActivityList 工具不挂载、memory_poll 预检 fail-closed。
  const userActivityService = new UserActivityService({
    sessionProjection: pgSessionProjectionStore ?? null,
    eventStore: pgEventStore ?? null,
    logger: serverLogger.child('UserActivity'),
  });

  const rawRuntimeConfig: RawRuntimeRunDispatchConfig = {
    agentCwd,
    sharedDir,
    getSystemPrompt: (id) => systemPromptRegistry.get(id),
    ...(userActivityService.available ? { userActivityService } : {}),
    memory: {
      enabled: memoryEnabled && config.memory?.injectContext?.enabled !== false,
      maxLines: config.memory?.injectContext?.maxLines,
    },
    memoryIndexService: memoryIndexServiceRef.current,
    agentStore,
    orgAgentStore,
    tenantStore,
    resolveUserRole: ({ userId, username }: { userId?: string; username?: string }) => {
      const user = userId
        ? userStore?.findById(userId)
        : username
          ? userStore?.findByUsername(username)
          : undefined;
      return user?.role as 'admin' | 'user' | undefined;
    },
    // scheduler wake 不经过 Web channel，需要从账户资料恢复系统提示语使用的全名。
    resolveUserRealName: ({ userId, username }: { userId?: string; username?: string }) => {
      const user = userId
        ? userStore?.findById(userId)
        : username
          ? userStore?.findByUsername(username)
          : undefined;
      return user?.realName;
    },
    // B1: 把 UserStore.tenantId 暴露给 dispatch，让 tenant remote hand
    // tenantIds allow-list 可在 attach 时按用户身份自动决策。
    resolveUserTenantId: ({ userId, username }: { userId?: string; username?: string }) => {
      const user = userId
        ? userStore?.findById(userId)
        : username
          ? userStore?.findByUsername(username)
          : undefined;
      return user?.tenantId;
    },
    defaultMaxTurns: config.agent.maxTurns,
    resolveUserMaxTurns: ({ userId, username }: { userId?: string; username?: string }) => {
      const user = userId
        ? userStore?.findById(userId)
        : username
          ? userStore?.findByUsername(username)
          : undefined;
      return user?.permissions?.maxTurns;
    },
    userOverrides: config.agent.userOverrides,
    dispatch: config.dispatch,
    executionConfig,
    modelResolver,
    getImageUnderstandingModelConfigs: (): ImageUnderstandingModelConfig[] => {
      const imageUnderstanding = config.models?.imageUnderstanding;
      if (!config.models || !imageUnderstanding) return [];
      return [imageUnderstanding.model, ...(imageUnderstanding.fallbackModels ?? [])]
        .filter((ref) => {
          const separator = ref.indexOf('/');
          if (separator < 1) return false;
          const groupId = ref.slice(0, separator);
          const modelId = ref.slice(separator + 1);
          return config.models!.groups.some((group) => (
            group.id === groupId && group.models.some((model) => model.id === modelId)
          ));
        })
        .map((ref) => resolveModelRef(config.models!, ref))
        .filter((resolved): resolved is NonNullable<typeof resolved> => !!resolved)
        .map((resolved) => ({
          model: resolved.model,
          connection: resolved.connection,
          providerOptions: resolved.providerOptions,
        }));
    },
    getImageUnderstandingTimeoutMs: () => config.models?.imageUnderstanding?.timeoutMs,
    toolControls: config.toolControls,
    // 子 agent 工具（2026-07-06）：两者都在本 config 构造之后才就绪
    // （billingService 赋值在上文 ~L658，tokenUsageStore 声明在下文 ~L1280），
    // 与 cronService 同款惰性 getter 形态；闭包在 dispatch invoke 时才求值，
    // 到那时变量必已初始化，无 TDZ 问题。
    billingService: () => billingService,
    tokenUsageStore: () => tokenUsageStore,
    sessionCatalog,
    skills: skillsDispatchConfig,
    mcpClientManager,
    mcpProxy,
    ...(pgEventStore ? { eventStoreFactory: () => pgEventStore } : {}),
    ...(pgRunStore ? { runStore: pgRunStore } : {}),
    ...(pgHandStore ? { handStore: pgHandStore } : {}),
    ...(pgToolInvocationStore ? { toolInvocationStore: pgToolInvocationStore } : {}),
    // /compact v2 自动压缩：需要 PG runStore（enqueue 走 scheduler wake 链路）。
    // file backend 无 scheduler，不装配（手动 /compact 不受影响）。
    ...(pgRunStore && tenantStore ? {
      autoCompaction: new AutoCompactionService({
        runStore: pgRunStore,
        getTenantSettings: (tenantId) => {
          if (!tenantId) return undefined;
          try {
            return tenantStore!.getSettings(tenantId)?.features;
          } catch {
            return undefined;
          }
        },
      }),
    } : {}),
    executionTransportRegistry,
    ...(sessionLock ? { sessionLock } : {}),
    ...(artifactService ? { artifactService } : {}),
    ...(resolvedServerRemote ? { serverRemote: resolvedServerRemote } : {}),
    ...(resolvedWebTools ? { webTools: resolvedWebTools } : {}),
    ...(resolvedImageGenTools ? { imageGenTools: resolvedImageGenTools } : {}),
    // metered_tool_usage（GenerateImage 按次扣费）事件直写 runtime_events；
    // file backend 不配置 → 工具跳过扣费事件（billingService 也不存在，语义一致）。
    ...(pgEventStore ? {
      appendPlatformEvent: (
        event: import('../runtime/types.js').PlatformEventInput,
        ctx?: import('../runtime/types.js').EventAppendContext,
      ) => pgEventStore.append(event, ctx),
    } : {}),
    tenantRemoteHands: () => config.tenantRemoteHands?.hands,
    secretVault,
    tenantRemoteHandResolver,
    // Wake-time workspace provisioner — 修 P0 BUG #2（2026-06-21）。
    // PR 8 enqueue-only + scheduler wake 路径绕过了 engine/dispatch.ts 的
    // ensureUserWorkspace 调用，导致新 tenant / 新用户首跑 cwd 物理目录不存在
    // → hand-server spawn ENOENT。这里在 wake 时按 session.userId/username
    // 反查 UserStore 得到完整 WorkspaceUser（含 tenantId / realName），调用
    // ensureUserWorkspace（含 PR 4 扁平→tenant 层 mkdir + 迁移、首次 skills 同步）。
    // 幂等：目录已存在直接 return；底层 mkdir 与 rename 都是无副作用重入安全的。
    workspaceProvisioner: async ({ userId, username }: { userId?: string; username?: string }) => {
      const userRecord = userId
        ? userStore?.findById(userId)
        : username
          ? userStore?.findByUsername(username)
          : undefined;
      if (!userRecord) {
        // 无法解析用户身份时跳过——上层 dispatch 自然会用 session.cwd 跑，
        // 旧 file backend / 测试 fixture / 历史无 user session 仍兼容。
        return;
      }
      const workspaceUser = {
        id: userRecord.id,
        username: userRecord.username,
        role: userRecord.role as 'admin' | 'user',
        tenantId: userRecord.tenantId,
      };
      const userCwd = resolveUserCwd(agentCwd, workspaceUser);
      await ensureUserWorkspace(
        userCwd,
        agentCwd,
        sharedDir,
        workspaceUser,
        { realName: userRecord.realName, position: userRecord.position },
        skillConfigStore,
        tenantSkillsRootDir,
      );
    },
    logger: serverLogger.child('RawRuntime'),
  };
  const validateToolSettingsConfig = async (settings: Pick<AppConfig, 'toolControls' | 'webTools'>): Promise<void> => {
    await resolveWebToolsConfig(settings.webTools, secretVault);
  };
  const updateToolSettingsConfig = async (settings: Pick<AppConfig, 'toolControls' | 'webTools'>): Promise<void> => {
    config.toolControls = settings.toolControls;
    config.webTools = settings.webTools;
    rawRuntimeConfig.toolControls = settings.toolControls;
    const resolved = await resolveWebToolsConfig(settings.webTools, secretVault);
    if (resolved) rawRuntimeConfig.webTools = resolved;
    else delete rawRuntimeConfig.webTools;
  };
  const validateImageGenToolsConfig = async (imageGenTools: AppConfig['imageGenTools']): Promise<void> => {
    await resolveImageGenToolsConfig(imageGenTools, secretVault);
  };
  const updateImageGenToolsConfig = async (imageGenTools: AppConfig['imageGenTools']): Promise<void> => {
    config.imageGenTools = imageGenTools;
    const resolved = await resolveImageGenToolsConfig(imageGenTools, secretVault);
    if (resolved) rawRuntimeConfig.imageGenTools = resolved;
    else delete rawRuntimeConfig.imageGenTools;
  };
  const updateMemoryIndexConfig = async (
    memoryIndex: NonNullable<NonNullable<AppConfig['memory']>['index']> | undefined,
  ): Promise<void> => {
    if (memoryIndex) {
      config.memory = {
        ...(config.memory ?? {}),
        index: memoryIndex,
      };
    } else if (config.memory) {
      delete config.memory.index;
    }

    const previous = memoryIndexServiceRef.current;
    const next = createMemoryIndexService(processCwd, memoryIndex);
    if (next) memoryIndexServices.add(next);
    memoryIndexServiceRef.current = next;
    rawRuntimeConfig.memoryIndexService = next;
    if (previous && previous !== next) {
      previous.retireAll();
    }
    serverLogger.info(next
      ? 'Memory index service hot-swapped for subsequent runs'
      : 'Memory index service disabled for subsequent runs');
  };
  if (pgRunStore) {
    rawRuntimeConfig.backgroundTasks = new DurableBackgroundTaskService(rawRuntimeConfig);
  }
  const baseRunDispatch = createRawRuntimeRunDispatch(rawRuntimeConfig);
  const resumeApprovalDispatch = createRawApprovalResumeDispatch(rawRuntimeConfig);

  if (pgRunStore && pgEventStore) {
    runtimeSchedulerAutoWake = enableSchedulerWorker && (config.runtimeScheduler?.autoWake ?? true);
    runtimeScheduler = new RuntimeScheduler({
      runStore: pgRunStore,
      eventStore: pgEventStore,
      autoWake: runtimeSchedulerAutoWake,
      pollIntervalMs: config.runtimeScheduler?.pollIntervalMs,
      leaseMs: config.runtimeScheduler?.leaseMs,
      maxConcurrentRuns: config.runtimeScheduler?.maxConcurrentRuns,
      maxConcurrentBackgroundRuns: config.runtimeScheduler?.maxConcurrentBackgroundRuns,
      approvalTimeoutMs: config.runtimeScheduler?.approvalTimeoutMs,
      beforeTick: () => rawRuntimeConfig.backgroundTasks!.reconcileWakeDeliveries(),
      failInterruptedBackgroundTask: (record) => rawRuntimeConfig.backgroundTasks!.failInterrupted(record),
      failBackgroundTask: (record, message) => rawRuntimeConfig.backgroundTasks!.fail(record, message),
      handoffBackgroundCommand: (record) => rawRuntimeConfig.backgroundTasks!.handoffCommandMonitor(record),
      wake: async (record, lease) => {
        const tenantId = record.tenantId ?? (record.userId ? userStore?.findById(record.userId)?.tenantId : undefined);
        const tenantAccessError = tenantAccessErrorMessage(tenantStore, tenantId);
        if (tenantAccessError) throw new Error(tenantAccessError);
        // 后台任务完成 wake 是已获准任务的终态交付，不是新任务派生；若任务执行期间
        // 恰好触达 hard cap，仍允许这一轮把结果送回父会话（用量照常记账）。
        // 后台命令 monitor 不调模型、不产生 token，同样不应被余额闸门中断。
        if (
          tenantId
          && billingService
          && record.metadata?.backgroundTaskWake !== true
          && !isBackgroundCommandTaskRun(record)
        ) {
          const allowed = await billingService.assertTenantCanStartRun(tenantId);
          if (!allowed.ok) throw new Error(allowed.reason);
        }
        await wakeRuntimeSession(rawRuntimeConfig, record, {
          lease,
          renewIntervalMs: config.runtimeScheduler?.renewIntervalMs,
          onOutboundEvent: (event) => {
            const streamId = typeof record.metadata?.streamId === 'string' ? record.metadata.streamId : undefined;
            const clientMsgId = typeof record.metadata?.clientMsgId === 'string' ? record.metadata.clientMsgId : undefined;
            webRuntimeEventSink?.({
              sessionId: record.sessionId,
              runId: record.runId,
              streamId,
              userId: record.userId,
              clientMsgId,
              event,
            });
          },
        });
      },
      logger: serverLogger.child('RuntimeScheduler'),
    });
  }

  // Runtime audit 读 API：
  //  - runtimeEventStore.backend='pg'：强制 PgRuntimeAuditQuery（复用 PgEventStore
  //    的 pool + eventsTable）。file/duckdb 两个实现都依赖磁盘 jsonl，事件已经
  //    不在那里了，所以 PG backend 下 audit.projection 字段被忽略。
  //  - file backend + audit.projection='duckdb'：DuckDB 投影表 + 每次 query 前
  //    tick 增量。
  //  - file backend + audit.projection='file' (默认)：EventStore 直读 jsonl。
  const auditMode = config.audit?.projection ?? 'file';
  let runtimeAuditQuery: RuntimeAuditQuery;
  let auditProjectionShutdown: (() => Promise<void>) | undefined;

  if (pgEventStore) {
    runtimeAuditQuery = new PgRuntimeAuditQuery({
      pool: pgEventStore.pool,
      eventsTable: pgEventStore.eventsTable,
    });
    serverLogger.info('Runtime audit query: backend=pg (shared pool with PgEventStore)');
  } else if (auditMode === 'duckdb') {
    try {
      const auditDataDir = resolve(processCwd, './data');
      const { db: auditDb } = await getAuditDuckDb(auditDataDir);
      const projection = createAuditProjection({
        db: auditDb,
        logger: {
          info: (m, meta) => serverLogger.info(m, meta),
          warn: (m, meta) => serverLogger.warn(m, meta),
          error: (m, meta) => serverLogger.error(m, meta),
        },
      });
      await projection.initialize();
      // 启动时全量投影一次（增量 tick 由每次 query 触发）
      const initialStats = await projection.tick();
      serverLogger.info(
        `Audit projection (duckdb) initialized: filesScanned=${initialStats.filesScanned} `
        + `eventsInserted=${initialStats.eventsInserted} resets=${initialStats.resets}`,
      );
      runtimeAuditQuery = new DuckDBRuntimeAuditQuery(auditDb, projection);
      auditProjectionShutdown = closeAuditDuckDb;
    } catch (err) {
      serverLogger.warn(
        `Audit projection (duckdb) init failed, falling back to file backend: `
        + `${err instanceof Error ? err.message : String(err)}`,
      );
      runtimeAuditQuery = new EventStoreRuntimeAuditQuery(findTranscriptPathBySessionId);
    }
  } else {
    runtimeAuditQuery = new EventStoreRuntimeAuditQuery(findTranscriptPathBySessionId);
  }

  const dispatchMetricsStore = new DispatchMetricsStore();
  const dispatchPipelineEnabled = config.dispatch?.enabled ?? true;
  const middlewareOpts = {
    processCwd,
    globalAgentCwd: agentCwd,
    sharedDir,
    tenantSkillsRootDir,
    dispatch: config.dispatch,
    observability: config.observability,
    metricsReporter: dispatchMetricsStore.report,
    logger: serverLogger.child('Dispatch'),
    skillConfigStore,
    mcpConfigStore,
    userOverrides: config.agent.userOverrides,
  };
  const runDispatch = dispatchPipelineEnabled === false
    ? baseRunDispatch
    : createMiddlewareRunDispatch(baseRunDispatch, middlewareOpts);
  const cronRunDispatch = dispatchPipelineEnabled === false
    ? baseRunDispatch
    : createMiddlewareRunDispatch(baseRunDispatch, middlewareOpts);
  const tenantGuardedRunDispatch = wrapDispatchWithTenantAccess(runDispatch, tenantStore);
  const tenantGuardedCronRunDispatch = wrapDispatchWithTenantAccess(cronRunDispatch, tenantStore);
  const billedRunDispatch = billingService ? billingService.wrapDispatch(tenantGuardedRunDispatch) : tenantGuardedRunDispatch;
  const billedCronRunDispatch = billingService ? billingService.wrapDispatch(tenantGuardedCronRunDispatch) : tenantGuardedCronRunDispatch;
  const tenantGuardedResumeApprovalDispatch: typeof resumeApprovalDispatch = async function* tenantGuardedApprovalResumeDispatch(request) {
    const tenantId = request.context.sessionOwner?.tenantId ?? request.context.user?.tenantId;
    const error = tenantAccessErrorMessage(tenantStore, tenantId);
    if (error) {
      yield { type: 'error', error };
      return;
    }
    yield* resumeApprovalDispatch(request);
  };
  const billedResumeApprovalDispatch: typeof resumeApprovalDispatch = billingService
    ? async function* billingWrappedApprovalResumeDispatch(request) {
      const tenantId = request.context.user?.tenantId ?? request.context.sessionOwner?.tenantId;
      if (tenantId) {
        const allowed = await billingService!.assertTenantCanStartRun(tenantId);
        if (!allowed.ok) {
          yield { type: 'error', error: allowed.reason };
          return;
        }
      }
      try {
        yield* tenantGuardedResumeApprovalDispatch(request);
      } finally {
        void billingService!.projectRuntimeEvents().catch((err) => {
          serverLogger.warn(`billing projection after approval resume failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    }
    : tenantGuardedResumeApprovalDispatch;

  if (dispatchPipelineEnabled === false) {
    serverLogger.warn('Dispatch middleware pipeline is disabled, using direct run dispatch');
  }

  // Memory maintenance hook：事件流结束后按策略触发记忆维护
  const memoryMaintenanceEnabled = memoryEnabled && config.memory?.maintenance?.enabled === true;
  const finalDispatch = memoryMaintenanceEnabled
    ? withMemoryMaintenance(
      billedRunDispatch,
      createMemoryMaintenanceHook({
        agentCwd,
        config: {
          enabled: true,
          minTextLength: config.memory?.maintenance?.minTextLength ?? 500,
          cooldownMinutes: config.memory?.maintenance?.cooldownMinutes ?? 60,
        },
        maintenanceDispatch: billedRunDispatch,
        logger: serverLogger.child('Memory'),
      }),
    )
    : billedRunDispatch;

  // Groups store
  const groupsFilePath = resolve(processCwd, './data/groups.json');
  const groupStore = new GroupStore(groupsFilePath);
  configureModelPricing(config.models);

  // Business SQLite：共享业务 db，当前承载 token 用量统计；
  // 与 per-user memory-index/{username}.sqlite 物理隔离。
  const businessDataDir = resolve(processCwd, './data');
  let tokenUsageStore: TokenUsageStore | undefined;
  let businessDbHandle: ReturnType<typeof getBusinessDb> | undefined;
  try {
    businessDbHandle = getBusinessDb(businessDataDir);
    const migrationResult = runBusinessMigrations(businessDbHandle);
    if (migrationResult.applied.length > 0) {
      serverLogger.info(
        `Business DB migrations applied: ${migrationResult.applied.map(m => `${m.module}@v${m.version}`).join(', ')}`,
      );
    }
    tokenUsageStore = createTokenUsageStore(businessDbHandle);
  } catch (err) {
    serverLogger.warn(`Business DB init failed (token usage disabled): ${err instanceof Error ? err.message : String(err)}`);
  }

  // Token usage 历史回填：首次启动时扫 ~/.agent-saas/legacy-transcripts 全量重建一次。
  // 异步触发，不阻塞启动；rebuild_state 表已有记录则自动跳过。
  if (businessDbHandle) {
    void rebuildTokenUsageFromJsonl(businessDbHandle, {
      agentCwd,
      log: (msg) => serverLogger.info(msg),
    }).catch((err) => {
      serverLogger.warn(`Token usage rebuild error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  const channelManager = new ChannelManager();
  const dingtalkDeps = createDingtalkDeps(sessionBasePath);

  // 保持同一对象引用：平台管理热更新时原地同步，CronService 后续执行即可读到
  // 最新的回看窗口、轮数、超时和模型，不需要重启进程。
  const memoryPollRuntimeConfig: {
    lookbackHours?: number;
    maxTurns?: number;
    timeoutSeconds?: number;
    model?: string;
  } = {};
  const syncMemoryPollRuntimeConfig = (): void => {
    const polling = config.memory?.polling;
    memoryPollRuntimeConfig.lookbackHours = polling?.lookbackHours;
    memoryPollRuntimeConfig.maxTurns = polling?.maxTurns;
    memoryPollRuntimeConfig.timeoutSeconds = polling?.timeoutSeconds;
    if (polling?.model) memoryPollRuntimeConfig.model = polling.model;
    else delete memoryPollRuntimeConfig.model;
  };
  syncMemoryPollRuntimeConfig();

  const cronRuntime = createCronRuntime({
    config: {
      cron: config.cron,
      server: config.server,
    },
    agentCwd,
    sharedDir,
    processCwd,
    runAgent: billedCronRunDispatch,
    defaultMaxTurns: config.agent.maxTurns || 10,
    defaultTimeoutSeconds: 1800,
    defaultModel: config.models?.default,
    resolveModel: modelResolver,
    resolveDefaultModel: defaultModelResolver,
    groupStore,
    userStore,
    tenantStore,
    tokenUsageStore,
    skillConfigStore,
    tenantSkillsRootDir,
    userActivityService,
    memoryPoll: memoryPollRuntimeConfig,
    notify: createCronNotifier({
      resolveChannels: (notifyConfig) => {
        const channels: NotifyChannel[] = [];
        const shouldDingtalk = notifyConfig.channel === 'dingtalk' || notifyConfig.channel === 'both';

        if (shouldDingtalk) {
          channels.push(createDingtalkNotifyChannel(
            {
              dingtalkConfig: config.dingtalk,
              dingtalkSendMessageConfig: config.dingtalkSendMessage,
              loadSessions: () => dingtalkDeps.sessionService.loadSessions(),
              sendMessage: (opts) => dingtalkDeps.deliveryService.sendMessage(opts),
              sendToUser: dingtalkDeps.sendToUser,
              sendToGroup: dingtalkDeps.sendToGroup,
            },
            notifyConfig.dingtalk,
          ));
        }
        return channels;
      },
    }),
    // Cron 完成后通过 WS 推送 session_updated，使客户端列表实时更新
    onEvent: (event) => {
      if (event.type !== 'finished' || !event.sessionId || !event.owner) return;
      const webCh = channelManager.getChannel<WebChannel>('web');
      const eventBus = webCh?.getEventBus();
      if (eventBus) {
        eventBus.emitUser(event.owner, {
          type: 'session_updated',
          sessionId: event.sessionId,
          updatedAtMs: Date.now(),
          preview: event.output,
        });
      } else {
        // fallback: 旧路径
        const wsServer = webCh?.getWsServer();
        wsServer?.broadcastToUser(event.owner, {
          type: 'session_updated',
          sessionId: event.sessionId,
          updatedAtMs: Date.now(),
          preview: event.output,
        });
      }
      clearSessionsListCache();
    },
  });

  // CronList/CronManage 内置工具接线：dispatch 构造早于 cronRuntime，
  // config 传的是惰性 getter（与 updateToolSettingsConfig 热改同模式）。
  rawRuntimeConfig.cronService = () => cronRuntime.service ?? undefined;

  // ── Cron leader 协调器（2026-07-15 零停机部署批次）─────────────────
  // 蓝绿部署下新旧实例短暂并存：cron 调度（含 memory_poll reconcile）必须
  // 单实例运行，否则同一任务双触发（双 run / 双扣费 / 双通知）。
  // PG advisory lock 选主；旧实例 drain 退出 / 崩溃 → session 断开自动释放
  // 锁 → 新实例 ≤15s 接管。file backend（单实例开发形态）无连接串 → 立即成为
  // leader，行为与历史一致。
  //
  // 记忆轮询每用户任务对账（2026-07-14 批次）：leader 上任时补齐 + 每 6h 复核。
  // 仅 processRole=all 执行（ws-only/scheduler-only 不动 cron store）；
  // 平台开关 config.memory.polling.enabled 关闭时也跑对账——负责把存量系统任务禁用。
  let cronLeadership: CronLeadership | undefined;
  let memoryPollReconcileTimer: ReturnType<typeof setInterval> | undefined;
  let runMemoryPollReconcile: (() => Promise<void>) | undefined;
  if (processRole === 'all' && cronRuntime.service) {
    const cronService = cronRuntime.service;
    if (userStore) {
      runMemoryPollReconcile = async (): Promise<void> => {
        try {
          const memoryPollingConfig = config.memory?.polling;
          const existingJobs = await cronService.list({ includeDisabled: true });
          const plan = reconcileMemoryPollJobs({
            users: userStore.listAll().map((user) => ({
              id: user.id,
              username: user.username,
              role: user.role,
              tenantId: user.tenantId,
              disabled: user.disabled,
            })),
            existingJobs,
            tenantStore,
            enabled: memoryPollingConfig?.enabled === true && userActivityService.available,
            hour: memoryPollingConfig?.hour ?? MEMORY_POLL_DEFAULTS.hour,
            hoursSpan: memoryPollingConfig?.hoursSpan ?? MEMORY_POLL_DEFAULTS.hoursSpan,
            timezone: memoryPollingConfig?.timezone ?? config.server.timezone ?? MEMORY_POLL_DEFAULTS.timezone,
            nowMs: Date.now(),
          });
          if (plan.toCreate.length > 0 || plan.toUpdate.length > 0) {
            await cronService.applySystemJobs(plan);
            serverLogger.info(
              `Memory poll reconcile: eligible=${plan.stats.eligibleUsers} created=${plan.stats.created} enabled=${plan.stats.enabled} disabled=${plan.stats.disabled} dupDisabled=${plan.stats.duplicatesDisabled} rescheduled=${plan.stats.rescheduled}`,
            );
          }
        } catch (err) {
          serverLogger.warn(`Memory poll reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      };
    }
    cronLeadership = new CronLeadership({
      connectionString: config.runtimeEventStore?.backend === 'pg' ? config.runtimeEventStore.connectionString : undefined,
      // tablePrefix 参与锁名：共库多环境（CI/dev 指同一 PG）不互相抢锁
      lockName: `${config.runtimeEventStore?.backend === 'pg' ? (config.runtimeEventStore.tablePrefix ?? 'agent_saas') : 'agent_saas'}:cron-leader`,
      onAcquired: async () => {
        await cronService.start();
        if (runMemoryPollReconcile) {
          void runMemoryPollReconcile();
          if (!memoryPollReconcileTimer) {
            memoryPollReconcileTimer = setInterval(() => { void runMemoryPollReconcile!(); }, 6 * 3600_000);
            memoryPollReconcileTimer.unref?.();
          }
        }
      },
      onLost: (reason) => {
        serverLogger.warn(`Cron leadership lost (${reason}); stopping local cron scheduling`);
        cronService.stop();
        if (memoryPollReconcileTimer) {
          clearInterval(memoryPollReconcileTimer);
          memoryPollReconcileTimer = undefined;
        }
      },
    });
  }

  const updateMemoryPollingConfig = async (
    polling: NonNullable<NonNullable<AppConfig['memory']>['polling']>,
  ): Promise<void> => {
    config.memory = {
      ...(config.memory ?? {}),
      polling,
    };
    syncMemoryPollRuntimeConfig();
    if (cronLeadership?.isLeader()) {
      await runMemoryPollReconcile?.();
    }
  };

  // SIGUSR2 drain 序列（见 AppRuntime.beginRuntimeDrain 注释；index.ts 调用）
  let runtimeDrainStarted = false;
  const beginRuntimeDrain = async (): Promise<void> => {
    if (runtimeDrainStarted) return;
    runtimeDrainStarted = true;
    // 1. 停 reconcile 定时器
    if (memoryPollReconcileTimer) {
      clearInterval(memoryPollReconcileTimer);
      memoryPollReconcileTimer = undefined;
    }
    // 2. 停 cron 触发（不打断执行中的 cron job）
    cronRuntime.service?.stop();
    // 3. 等 in-flight cron job 结清后再释放 leadership：新 leader 从 jobs.json
    //    加载状态，旧实例执行完的 saveJobs（lastRun 等）必须先落盘，否则任务
    //    状态回退可能导致新 leader 重复触发。
    if (cronRuntime.service) {
      const quiesceDeadline = Date.now() + 10 * 60_000;
      for (;;) {
        const status = cronRuntime.service.getStatus();
        const runningCount = status.runningJobIds?.length ?? 0;
        if (runningCount === 0) break;
        if (Date.now() > quiesceDeadline) {
          serverLogger.warn(`Drain: ${runningCount} cron job(s) still running at quiesce deadline; releasing leadership anyway`);
          break;
        }
        serverLogger.info(`Drain: waiting for ${runningCount} in-flight cron job(s)`);
        await new Promise<void>((r) => setTimeout(r, 2000));
      }
    }
    // 4. 释放 leadership → 新实例在一个重试周期（≤15s）内接管 cron
    await cronLeadership?.stop();
    // 5. 停 scheduler：不再 claim 新 run，并等 in-flight run 结清
    //    （scheduler.stop 幂等；后续 runtimeEventStoreShutdown 再调用是 no-op）
    await runtimeScheduler?.stop();
  };

  // Backfill cron groups from historical run logs (one-time migration)
  await migrateCronGroups(groupStore, cronRuntime.service, cronRuntime.cronRunsDir);

  // Prune orphaned sessionIds from groups (transcripts deleted outside API)
  const pruned = await groupStore.pruneOrphanedSessionIds(
    async (sid) => (await findTranscriptPathBySessionId(sid)) !== null,
  );
  if (pruned > 0) {
    serverLogger.info(`Groups: pruned ${pruned} orphaned sessionIds`);
  }

  // Startup data migrations: BUG 2/3/4
  if (userStore) {
    await runStartupMigrations({
      globalAgentCwd: agentCwd,
      userStore,
      groupStore,
      cronService: cronRuntime.service,
    });
  }

  // 构造 STT 配置（阿里云百炼 DashScope）
  const sttConfig = config.stt?.apiKey && config.stt?.ossAccessKeyId
    ? config.stt
    : undefined;

  const webChannel = new WebChannel({
    timezone: config.server.timezone,
    displayConfig: config.messageDisplay?.web,
    agentCwd,
    sharedDir,
    loginLogFilePath: resolve(processCwd, './data/login-logs.jsonl'),
    modelResolver,
    userStore,
    titleGeneratorConfigs,
    getTitleSystemPrompt: () => systemPromptRegistry.get('utility.title'),
    sttConfig,
    jwtSecret: config.auth?.jwtSecret,
    userOverrides: config.agent.userOverrides,
    getIsDraining: () => channelManager.draining,
    tokenUsageStore,
    tenantStore,
    allowedOrigins: config.server.corsOrigins,
    // 专职 Agent + LLM 话题门禁（2026-07 唯恩批次）。getGuardrailModelConfigs
    // 必须是 getter：热更后 channel 每次调用都取到最新链（title 的 stale 数组
    // 引用坑勿复刻）。guardrailEventStore 仅 PG backend 存在，file backend 降级 log。
    orgAgentStore,
    getGuardrailModelConfigs: () => guardrailModelConfigs,
    guardrailEventStore,
    getGuardrailSystemPrompt: () => systemPromptRegistry.get('utility.guardrail'),
    ...(config.guardrail ? {
      guardrailOptions: {
        ...(config.guardrail.timeoutMs !== undefined ? { timeoutMs: config.guardrail.timeoutMs } : {}),
        ...(config.guardrail.maxRecentRounds !== undefined ? { maxRecentRounds: config.guardrail.maxRecentRounds } : {}),
      },
    } : {}),
    resumeApprovalDispatch: billedResumeApprovalDispatch,
    executionConfig,
    runtimeEventStoreFor,
    ...(runtimeScheduler && pgRunStore ? {
      enqueueRuntime: {
        scheduler: runtimeScheduler,
        runStore: pgRunStore,
        sessionCatalog,
        ...(pgToolInvocationStore ? { toolInvocationStore: pgToolInvocationStore } : {}),
        enabled: true,
      },
    } : {}),
  }, finalDispatch);
  // 同进程 stream bridge 只在持有 WS listener 的进程上有意义：'all' 模式由 scheduler 直接
  // 推到本地 WebChannel，scheduler-only 模式下根本没有 WS 客户端，bridge 是结构性 noop。
  // 让 scheduler.wake 的 onOutboundEvent 回调自动跳过（line 826 已 `?.()` 守卫），避免
  // scheduler-only 进程刷出大量 "Runtime outbound event dropped before WebChannel start"
  // 误报。生产投递走 PG NOTIFY → ws-only 进程订阅 publishRuntimePlatformEvent 路径。
  if (processRole !== 'scheduler-only') {
    webRuntimeEventSink = (args) => webChannel.publishRuntimeOutboundEvent(args);
  }
  channelManager.register(webChannel);
  if (pgEventStore) {
    const runCancelDeliveryScan = async () => {
      if (!pgToolInvocationStore) return;
      const result = await deliverPendingToolInvocationCancels({
        toolInvocationStore: pgToolInvocationStore,
        handStore: pgHandStore,
        runStore: pgRunStore,
        serverRemoteBaseUrl: resolvedServerRemote?.baseUrl,
        serverRemoteAuthToken: resolvedServerRemote?.authToken,
        resolveHandAuthToken: (hand) => tenantRemoteHandResolver.resolveForHand(hand),
        logger: serverLogger.child('ToolCancelDispatcher'),
      });
      if (result.attempted > 0) {
        serverLogger.info(`Tool cancel delivery retry scan: scanned=${result.scanned} attempted=${result.attempted} results=${JSON.stringify(result.results)}`);
      }
    };
    runtimeEventSubscriptionShutdown = await pgEventStore.subscribeAppended((event) => {
      if (event.type === 'tool_invocation_cancel_requested') {
        void deliverToolInvocationCancel({
          event,
          toolInvocationStore: pgToolInvocationStore,
          handStore: pgHandStore,
          runStore: pgRunStore,
          serverRemoteBaseUrl: resolvedServerRemote?.baseUrl,
          serverRemoteAuthToken: resolvedServerRemote?.authToken,
          resolveHandAuthToken: (hand) => tenantRemoteHandResolver.resolveForHand(hand),
          logger: serverLogger.child('ToolCancelDispatcher'),
        });
        runtimeRunController.abort(event.runId, event.reason ?? 'tool_invocation_cancel_requested');
      }
      webChannel.publishRuntimePlatformEvent(event);
    });
    await runCancelDeliveryScan().catch((err) => {
      serverLogger.warn(`Tool cancel delivery startup scan failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    cancelDeliveryRetryTimer = setInterval(() => {
      void runCancelDeliveryScan().catch((err) => {
        serverLogger.warn(`Tool cancel delivery retry scan failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, 5_000);
    cancelDeliveryRetryTimer.unref?.();
    serverLogger.info('Runtime EventStore live bridge initialized: backend=pg listen/notify');
  }
  if (runtimeScheduler && enableSchedulerWorker) {
    await runtimeScheduler.start();
    serverLogger.info(`RuntimeScheduler started: autoWake=${runtimeSchedulerAutoWake ? 'true' : 'false'}`);
  } else if (runtimeScheduler) {
    serverLogger.info(`RuntimeScheduler worker disabled for processRole=${processRole}; durable enqueue remains enabled`);
  }

  const connectorAcsConfigured = config.tenantRemoteHands?.hands.some((hand) => (
    (hand.id === 'agent-saas-acs' || /acs/i.test(hand.id))
    && hand.rollout?.mode !== 'disabled'
    && hand.rollout?.mode !== 'drain'
  )) ?? false;
  const resolveConnectorServerRemote = async (user: UserInfo) => {
    if (resolvedServerRemote) return resolvedServerRemote;
    const eligible = selectTenantRemoteHandsForRegistration(config.tenantRemoteHands?.hands, {
      userId: user.id,
      username: user.username,
      userTenantId: user.tenantId,
    });
    const entry = eligible.find((hand) => hand.id === 'agent-saas-acs')
      ?? eligible.find((hand) => /acs/i.test(hand.id));
    if (!entry) throw new Error(`用户 ${user.id} 没有可用的 ACS 连接器执行环境`);
    const resolved = await tenantRemoteHandResolver.resolveForRegister(entry);
    return {
      baseUrl: resolved.baseUrl,
      authToken: resolved.authToken,
      ...(resolved.invokeTimeoutMs ? { invokeTimeoutMs: resolved.invokeTimeoutMs } : {}),
    };
  };

  if (dwsConnectionStore && userStore && (resolvedServerRemote || connectorAcsConfigured)) {
    dwsAuthKeepaliveService = new DwsAuthKeepaliveService({
      agentCwd,
      userStore,
      connectionStore: dwsConnectionStore,
      runner: new DwsAuthStatusRunner({ agentCwd, resolveServerRemote: resolveConnectorServerRemote }),
      logger: serverLogger.child('DwsKeepalive'),
    });
    if (enableSchedulerWorker) {
      dwsAuthKeepaliveService.start();
    } else {
      serverLogger.info(`DWS auth keepalive worker disabled for processRole=${processRole}; status API remains available`);
    }
    if (dwsAuthSessionStore) {
      dwsAuthFlowService = new DwsAuthFlowService({
        agentCwd,
        authSessionStore: dwsAuthSessionStore,
        connectionStore: dwsConnectionStore,
        runner: new DwsDeviceLoginRunner({ agentCwd, resolveServerRemote: resolveConnectorServerRemote }),
        onConnected: async (connectedUser) => {
          if (
            skillConfigStore
            && skillConfigStore.isTenantSkillAvailableToUser('dws', connectedUser.tenantId, connectedUser.username)
          ) {
            const selected = skillConfigStore.getUserSelectedSkills(connectedUser.username);
            if (!selected.includes('dws')) {
              await skillConfigStore.setUserSelectedSkills(
                connectedUser.username,
                [...selected, 'dws'].sort(),
              );
            }
          }
          await dwsAuthKeepaliveService?.runOnce();
        },
        logger: serverLogger.child('DwsAuthFlow'),
      });
    }
  } else if (userStore) {
    serverLogger.warn('DWS auth keepalive unavailable: PG connection store or DWS execution remote is not configured');
  }

  if (feishuConnectionStore && userStore && (resolvedServerRemote || connectorAcsConfigured)) {
    feishuAuthKeepaliveService = new FeishuAuthKeepaliveService({
      userStore,
      connectionStore: feishuConnectionStore,
      runner: new FeishuAuthStatusRunner({ agentCwd, resolveServerRemote: resolveConnectorServerRemote }),
      logger: serverLogger.child('FeishuKeepalive'),
    });
    if (enableSchedulerWorker) {
      feishuAuthKeepaliveService.start();
    } else {
      serverLogger.info(`Feishu auth keepalive worker disabled for processRole=${processRole}; status API remains available`);
    }
    if (feishuAuthSessionStore && resolvedFeishuConnector) {
      feishuAuthFlowService = new FeishuAuthFlowService({
        authSessionStore: feishuAuthSessionStore,
        connectionStore: feishuConnectionStore,
        runner: new FeishuDeviceLoginRunner({
          agentCwd,
          appId: resolvedFeishuConnector.appId,
          appSecret: resolvedFeishuConnector.appSecret,
          resolveServerRemote: resolveConnectorServerRemote,
        }),
        onConnected: async (connectedUser) => {
          if (
            skillConfigStore
            && skillConfigStore.isTenantSkillAvailableToUser('feishu', connectedUser.tenantId, connectedUser.username)
          ) {
            const selected = skillConfigStore.getUserSelectedSkills(connectedUser.username);
            if (!selected.includes('feishu')) {
              await skillConfigStore.setUserSelectedSkills(
                connectedUser.username,
                [...selected, 'feishu'].sort(),
              );
            }
          }
          await feishuAuthKeepaliveService?.runOnce();
        },
        logger: serverLogger.child('FeishuAuthFlow'),
      });
    } else if (!resolvedFeishuConnector) {
      serverLogger.warn('Feishu one-click connection unavailable: connector app credentials are not configured');
    }
  } else if (userStore) {
    serverLogger.warn('Feishu auth keepalive unavailable: PG connection store or ACS execution remote is not configured');
  }

  // B4: Server-remote hands 健康 scanner（仅 PG runtime）。默认开启；显式 false 关闭。
  if (pgHandStore && pgEventStore && config.runtimeHandHealthScanner?.enabled !== false) {
    handHealthScanner = new HandHealthScanner({
      handStore: pgHandStore,
      eventStore: pgEventStore,
      intervalMs: config.runtimeHandHealthScanner?.intervalMs,
      healthTimeoutMs: config.runtimeHandHealthScanner?.healthTimeoutMs,
      resolveHandAuthToken: (hand) => tenantRemoteHandResolver.resolveForHand(hand),
      defaultServerRemoteAuthToken: resolvedServerRemote?.authToken,
      logger: serverLogger.child('HandHealth'),
    });
    handHealthScanner.start();
  }

  if (config.dingtalk?.enabled) {
    channelManager.register(new DingtalkChannel({
      mode: config.dingtalk.mode,
      robots: config.dingtalk.robots,
      timezone: config.server.timezone,
      displayConfig: config.messageDisplay?.dingtalk,
      tts: config.tts,
      uploadsDir,
      messageBufferMs: config.dingtalk.messageBufferMs,
      agentCwd,
      modelResolver,
      modelList: config.models ? getPublicModelList(config.models) : null,
      tokenUsageStore,
    }, finalDispatch, {
      sessionService: dingtalkDeps.sessionService,
      deliveryService: dingtalkDeps.deliveryService,
      resolveFollowupContext: (runId, question) => buildFollowupContext(
        runId,
        question,
        cronRuntime.cronRunsDir,
      ),
      userStore,
      tenantStore,
    }));
  }

  return {
    config,
    processRole,
    processCwd,
    sessionBasePath,
    agentCwd,
    sharedDir,
    tenantSkillsRootDir,
    uploadsDir,
    channelManager,
    dispatchMetricsStore,
    dingtalkDeps,
    cronRuntime,
    getMemoryIndexService: () => memoryIndexServiceRef.current,
    memoryIndexShutdown,
    auditProjectionShutdown,
    runtimeEventStoreShutdown,
    mcpClientShutdown,
    mcpClientManager,
    secretVault,
    userStore,
    dwsConnectionStore,
    dwsAuthFlowService,
    dwsAuthKeepaliveShutdown: dwsAuthKeepaliveService || dwsAuthFlowService
      ? () => {
          dwsAuthFlowService?.stop();
          dwsAuthKeepaliveService?.stop();
        }
      : undefined,
    feishuConnectionStore,
    feishuAuthFlowService,
    feishuAuthKeepaliveShutdown: feishuAuthKeepaliveService || feishuAuthFlowService
      ? () => {
          feishuAuthFlowService?.stop();
          feishuAuthKeepaliveService?.stop();
        }
      : undefined,
    tenantStore,
    agentStore,
    skillConfigStore,
    mcpConfigStore,
    mcpOAuthService,
    signupConfigStore,
    groupStore,
    authMiddleware,
    titleGeneratorConfigs,
    orgAgentStore,
    guardrailEventStore,
    messageFeedbackStore,
    appealStore,
    getGuardrailModelConfigs: () => guardrailModelConfigs,
    updateGuardrailModelConfigs: (next: GuardrailModelConfig[]) => { guardrailModelConfigs = next; },
    agentOptionsConfig,
    tokenUsageStore,
    billingService,
    runtimeAuditQuery,
    runtimeRunStore: pgRunStore,
    runtimeSessionProjectionStore: pgSessionProjectionStore,
    runtimeToolInvocationStore: pgToolInvocationStore,
    runtimeHandStore: pgHandStore,
    systemMetricsStore,
    systemMetricsCollector,
    alertStateStore,
    alertNotifier,
    runtimePgEventStore: pgEventStore,
    validateToolSettingsConfig,
    updateToolSettingsConfig,
    validateImageGenToolsConfig,
    updateImageGenToolsConfig,
    updateMemoryIndexConfig,
    updateMemoryPollingConfig,
    systemPromptRegistry,
    artifactService,
    sessionShareStore,
    artifactShutdown,
    clientDaemonGateway,
    runtimeEventStoreFor,
    runDeferredStartupTasks: async () => {
      for (const task of deferredStartupTasks) {
        try {
          await task.run();
        } catch (err) {
          serverLogger.error(`Deferred startup task "${task.name}" failed:`, err);
        }
      }
    },
    getSkillsWarmupStatus: () => ({ ...skillsWarmup }),
    startCronCoordinator: () => {
      cronLeadership?.start();
    },
    beginRuntimeDrain,
    triggerTokenUsageRebuild: businessDbHandle
      ? () =>
          rebuildTokenUsageFromJsonl(businessDbHandle!, {
            agentCwd,
            log: (msg) => serverLogger.info(msg),
            force: true,
          }).catch((err) => {
            serverLogger.warn(
              `Token usage manual rebuild error: ${err instanceof Error ? err.message : String(err)}`,
            );
            throw err;
          })
      : undefined,
  };
}
