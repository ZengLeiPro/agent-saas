import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { readdir as readdirAsync } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'path';
import { serverLogger, configureLogger } from '../utils/logger.js';
import type { AppConfig } from '../types/index.js';
import {
  createModelAdapterForProtocol,
  createRawApprovalResumeDispatch,
  createRawRuntimeRunDispatch,
  wakeRuntimeSession,
} from '../runtime/rawRuntimeRunDispatch.js';
import {
  CodexCredentialManager,
  PgCodexCredentialLock,
} from '../runtime/responses/codexCredentialManager.js';
import { CodexDeviceAuthService } from '../runtime/responses/codexOAuth.js';
import { createExecutionConfig } from '../runtime/executionConfig.js';
import {
  DuckDBRuntimeAuditQuery,
  EventStoreRuntimeAuditQuery,
  type RuntimeAuditQuery,
} from '../runtime/auditQuery.js';
import { createAuditProjection } from '../runtime/auditProjection.js';
import { closeAuditDuckDb, getAuditDuckDb } from '../runtime/auditDuckDb.js';
import { PgEventStore } from '../runtime/pgEventStore.js';
import { appendTenantPlatformEvent, createRuntimeEventStoreFactory } from './runtimeEventStore.js';
import { RuntimeEventRetention } from '../runtime/runtimeEventRetention.js';
import { PgRuntimeAuditQuery } from '../runtime/pgAuditQuery.js';
import { PgSessionLock } from '../runtime/pgSessionLock.js';
import { PgTerminalEventOutboxRunStore, startTerminalEventOutboxDispatcher } from '../runtime/runTerminalOutboxDispatcher.js';
import { PgHandStore } from '../runtime/handStore.js';
import { PgSessionProjectionStore } from '../runtime/sessionProjectionStore.js';
import { MemoryConsolidationEngine } from '../memory/consolidation/engine.js';
import { TaskboardExecutionCoordinator, createTaskboardAttachmentAccess, createTaskboardRuntimeOptions, createTaskboardTrustedWorkspaceResolver } from '../taskboard/executionService.js';
import { RetryableTaskboardService } from '../taskboard/retryableService.js';
import { PgTaskboardStore } from '../taskboard/store.js';
import { configureTaskboardGithubRepositoryProvider } from '../taskboard/repositoryRuntime.js';
import type { RepositoryProvider } from '../taskboard/repositoryProvider.js';
import { resolveGithubToken } from '../connectors/github.js';
import { buildRuntimeTaskboardIntegrationV3Options, configureRuntimeIntegrationV3RepositoryAccess, startRuntimeTaskboardIntegrationV3, type RuntimeTaskboardIntegrationV3 } from './runtimeTaskboardIntegrationV3.js';
import { retentionWorkerOptions } from './runtimeEventRetentionConfig.js';
import { createRuntimeIntegrationV3HealthProvider } from '../taskboard/integrationV3Observability.js';
import { createIntegrationV3RequeueHandler } from '../taskboard/integrationV3Repair.js';
import type { TaskboardService } from '../taskboard/types.js';
import { createTaskboardTitleGenerator } from '../taskboard/taskTitle.js';
import { PgMemoryConsolidationStore } from '../memory/consolidation/store.js';
import { MEMORY_CONSOLIDATION_DEFAULTS, withMemoryConsolidationLeaseBuffer, type MemoryConsolidationResolvedConfig } from '../memory/consolidation/types.js';
import { resolveTenantMemoryFeatureStatus } from '../memory/effectiveStatus.js';
import {
  FileSessionReadStateStore,
  PgSessionReadStateStore,
  type SessionReadStateStore,
} from '../data/sessionReadStateStore.js';
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
import { artifactContentAudit, artifactServiceLifecycleOptions, initializeArtifactShareService, initializeArtifactShareStore, type ArtifactShareService, type ArtifactShareStore } from './artifactRuntime.js';
import { PgImageBlobStore, setImageBlobStore } from '../runtime/imageBlobStore.js';
import {
  InMemorySessionShareStore,
  PgSessionShareStore,
  type SessionShareStore,
} from '../data/sessionShares/store.js';
import { recoverRunningToolInvocations } from '../runtime/toolInvocationRecovery.js';
import { deliverPendingToolInvocationCancels, deliverToolInvocationCancel } from '../runtime/toolInvocationCancelDelivery.js';
import { RuntimeScheduler } from '../runtime/scheduler.js';
import { RuntimeOutboundStreamRelay } from '../runtime/runtimeOutboundStreamRelay.js';
import { MemoryPressureGuard, type RuntimeAdmissionGuard } from '../runtime/memoryPressureGuard.js';
import type { RuntimePerformanceWorkloadSnapshot } from '../runtime/runtimePerformanceSampler.js';
import {
  effectiveMaxConcurrentRuns,
  PgRuntimeSchedulerConfigStore,
  type RuntimeSchedulerCapacityController,
} from '../runtime/runtimeSchedulerConfigStore.js';
import { DurableBackgroundTaskService } from '../runtime/background/backgroundTaskService.js';
import { isBackgroundTaskRun } from '../runtime/background/backgroundTaskRuntime.js';
import { AutoCompactionService } from '../runtime/autoCompaction.js';
import { runtimeRunController } from '../runtime/runController.js';
import { FileSessionCatalog } from '../runtime/sessionCatalog.js';
import { SandboxWarmupService } from '../runtime/sandboxWarmup.js';
import { createMiddlewareRunDispatch } from '../engine/dispatch.js';
import { DispatchMetricsStore } from '../engine/metricsStore.js';
import { getPublicModelList, resolveModelRef } from './models.js';
import { ChannelManager } from '../channels/manager.js';
import { WebChannel } from '../channels/web/channel.js';
import { DingtalkChannel } from '../channels/dingtalk/channel.js';
import { createDingtalkDeps } from '../channels/dingtalk/factory.js';
import { createCronRuntime, withPgAdvisoryLock } from '../cron/bootstrap.js';
import { reconcileMemoryPollJobs, MEMORY_POLL_DEFAULTS } from '../cron/memoryPoll.js';
import { UserActivityService } from '../runtime/userActivityService.js';
import { createCronNotifier } from '../cron/notifier.js';
import type { NotifyChannel } from '../cron/notifyChannel.js';
import { createDingtalkNotifyChannel } from '../cron/notifyChannels/index.js';
import { buildFollowupContext } from '../cron/followup.js';
import { assertDevDatabaseSafety, loadAppConfig } from './config.js';
import { createRuntimeWebPushAssembly, startTaskboardStatusNotificationWorker } from './runtimeWebPush.js';
import { createModelResolvers } from './modelResolvers.js';
import { createTitleModelAdapterFactory, resolveTitleGeneratorConfigs } from './titleGeneratorConfigs.js';
import { resolveGuardrailModelConfigs } from './guardrailModelConfigs.js';
import { applyTenantLifecycleChange, TenantLifecycleWatcher } from './tenantLifecycleEffects.js';
import type { AgentOptionsConfig } from '../agent/options.js';
import type { GuardrailModelConfig } from '../agent/guardrail.js';
import type { ImageUnderstandingModelConfig } from '../runtime/imageUnderstanding.js';
import { isAssignedToOrgAgent, OrgAgentStore } from '../data/orgAgents/store.js';
import { createDwsBackgroundCompletionEnqueuer, createOrgAgentDispatcherRuntimeValidator } from './orgAgentDispatcherRuntime.js';
import { PgGuardrailEventStore } from '../data/guardrail/pgGuardrailEventStore.js';
import { PgMessageFeedbackStore } from '../data/feedback/store.js';
import { PgAppealStore } from '../data/appeals/index.js';
import type { GovernanceAuditStore } from '../data/governance-audit/index.js';
import { PgMembershipStore } from '../data/memberships/index.js';
import { PgEntitlementStore } from '../data/entitlements/index.js';
import { PgAssignmentStore } from '../data/assignments/index.js';
import { PgDirectoryGroupStore } from '../data/directoryGroups/index.js';
import { PgOAuthGrantStore } from '../data/oauthGrants/index.js';
import { PgCredentialStore } from '../data/credentials/index.js';
import { PgConnectorCatalogStore } from '../data/connectorCatalog/index.js';
import { PgEnvironmentStore } from '../data/environments/index.js';
import { PgAgentResourceStore } from '../data/agentResources/index.js';
import { PgSkillGovernanceStore } from '../data/skillGovernance/index.js';
import { GovernanceChangePlanner, PgGovernanceChangeJobStore } from '../data/changeJobs/index.js';
import { PgContentAccessGrantStore } from '../data/contentAccess/index.js';
import { GovernanceProjectionReconciler, PgGovernanceProjectionOutboxStore } from '../data/governanceProjection/index.js';
import { GovernanceShadowComparator, GovernanceWriteGate, PgGovernanceMigrationControlStore } from '../data/migrationControl/index.js';
import { PgResourceReferenceStore } from '../data/resourceReferences/index.js';
import { CredentialBroker } from '../runtime/credentialBroker.js';
import { RunPreflightService } from '../runtime/runPreflight.js';
import { PgRunResolutionSnapshotStore } from '../runtime/runResolutionSnapshotStore.js';
import { MemoryIndexService } from '../memory/index/service.js';
import { UserStore } from '../data/users/store.js';
import type { UserInfo } from '../data/users/types.js';
import { TenantStore } from '../data/tenants/store.js';
import { DEFAULT_TENANT_ID, LEGACY_TENANT_ID, TENANT_SLUG_PATTERN } from '../data/tenants/types.js';
import { tenantAccessErrorMessage, wrapDispatchWithTenantAccess } from '../data/tenants/access.js';
import { AgentStore } from '../data/agents/store.js';
import { GroupStore } from '../data/groups/store.js';
import { SkillConfigStore, migrateFromManifest } from '../data/skills/index.js';
import { GoogleWorkspaceOAuthService } from '../connectors/googleWorkspace.js';
import { connectNotionCredential } from '../connectors/notion.js';
import {
  scanPoolSkills as scanPoolSkillsForDispatch,
  scanTenantOwnSkillIds,
  scanUserCustomSkills,
} from '../data/skills/scanner.js';
import { resolveTenantSkillsDirFromRoot } from '../data/tenants/tenantSkillsPath.js';
import { resolveUserPersonalSkillIds as resolvePersonalSkillIds } from '../workspace/materialization/managedTenantSkills.js';
import { createSkillDispatchState } from './skillDispatchState.js';
import { resolveUserCwd, ensureUserWorkspace } from '../workspace/resolver.js';
import { agentDir, resolveAgentPath } from '../workspace/namespace.js';
import { CronLeadership } from '../runtime/cronLeadership.js';
import { computeSkillsContentFingerprintAsync } from '../data/skills/contentFingerprint.js';
import { SkillWorkspaceMaterializer } from '../workspace/materialization/materializer.js';
import { SkillMaterializationService } from '../workspace/materialization/service.js';
import {
  InMemorySkillMaterializationStore,
  PgSkillMaterializationStore,
} from '../workspace/materialization/store.js';
import type { SkillMaterializationRequest } from '../workspace/materialization/types.js';
import type { RawRuntimeRunDispatchConfig, SkillsDispatchConfig } from '../runtime/rawRuntimeRunDispatch.js';
import type { SkillEntry } from '../agent/skillToolProvider.js';
import {
  createTenantRemoteHandAuthTokenResolver,
  selectTenantRemoteHandsForRegistration,
} from '../runtime/tenantRemoteHandResolver.js';
import { createDefaultExecutionTransportRegistry } from '../agent/toolRuntime.js';
import { buildTenantScopedEnv } from '../agent/tenantEnv.js';
import { ClientDaemonTransport } from '../runtime/clientDaemonTransport.js';
import { ClientDaemonGateway } from '../runtime/clientDaemonGateway.js';
import { createHandHealthScanner } from '../runtime/createHandHealthScanner.js';
import type { HandHealthScanner } from '../runtime/handHealthScanner.js';
import { HandLeaseJanitor } from '../runtime/handLeaseJanitor.js';
import { PgSystemMetricsStore } from '../runtime/systemMetricsStore.js';
import { SystemMetricsCollector } from '../runtime/systemMetricsCollector.js';
import { PgAlertStateStore } from '../runtime/alertStateStore.js';
import { AlertNotifier } from '../runtime/alertNotifier.js';
import { notifyBillingAuditAlerts, registerSearchProviderAlerts } from './registerSearchProviderAlerts.js';
import { createToolSettingsUpdater, createWebToolsRuntimeUpdater } from './webToolsRuntimeUpdate.js';
import { createRuntimeSchedulerCapacityController } from './runtimeSchedulerCapacityAssembly.js';
import { PgDwsConnectionStore } from '../dws/store.js';
import { DwsAuthKeepaliveService, DwsAuthStatusRunner } from '../dws/keepalive.js';
import { PgDwsAuthSessionStore } from '../dws/authStore.js';
import { DwsAuthFlowService, DwsDeviceLoginRunner } from '../dws/authFlow.js';
import { createAgentDwsRuntime, type AgentDwsRuntimeBundle } from './agentDwsRuntime.js';
import { createConnectorServerRemoteResolver, hasAcsConnector } from './connectorServerRemote.js';
import type { PgAgentDwsAccountStore } from '../data/agentDwsAccounts/index.js';
import type { PgAgentDwsMessageStore } from '../data/agentDwsMessages/index.js';
import { NotionAuthFlowService, NotionDeviceLoginRunner } from '../notion/authFlow.js';
import { PgFeishuConnectionStore } from '../feishu/store.js';
import { FeishuAuthKeepaliveService } from '../feishu/keepalive.js';
import { PgFeishuAuthSessionStore } from '../feishu/authStore.js';
import { FeishuAuthFlowService, FeishuDeviceLoginRunner } from '../feishu/authFlow.js';
import {
  FeishuOAuthClient,
  FeishuTokenBroker,
  FeishuTokenBrokerLoginRunner,
  FeishuTokenBrokerStatusRunner,
} from '../feishu/tokenBroker.js';
import { SystemPromptRegistry } from '../runtime/systemPrompts.js';
import {
  InMemoryAgentRuntimeProfileStore,
  PgAgentRuntimeProfileStore,
} from '../data/agentProfiles/store.js';
import type { AgentRuntimeProfileStore } from '../data/agentProfiles/types.js';
import { AgentRuntimeProfileResolver } from '../runtime/agentProfiles.js';
import {
  InMemoryConnectorDictionaryStore,
  PgConnectorDictionaryStore,
  type ConnectorDictionaryStore,
} from '../data/connectorDictionaryStore.js';
import { setConnectorDictionary, setTenantConnectorDictionaries } from '../agent/toolPresentationBuilder.js';
import { UploadManager } from '../uploads/manager.js';
import { migrateCronGroups } from '../data/groups/migrate.js';
import {
  findTranscriptPathBySessionId,
  findTranscriptPathByTenantAndSessionId,
} from '../data/transcripts/store.js';
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
import { initializeRuntimeGovernanceStores } from './runtimeGovernanceStores.js';
import type { ContextStore } from '../context/store/index.js';
import { createRuntimeContextPlane, createRuntimeMemoryContextTools } from './runtimeMemoryContextTools.js';
import { initializeRuntimeGovernanceConnectors } from './runtimeGovernanceConnectors.js';
import {
  initializeRuntimeGovernanceCredentials,
  resolveImageGenToolsConfig,
  resolveWebToolsConfig,
} from './runtimeGovernanceCredentials.js';
import { initializeRuntimeGovernancePreflight } from './runtimeGovernancePreflight.js';
import { resolveSttRuntimeConfig } from '../runtime/sttRuntimeConfig.js';
import {
  SAFE_SKILL_NAME_RE,
  createMemoryIndexService,
  loadSettingsEnv,
} from './runtimeSetupHelpers.js';
// 公开契约类型已迁至 ./runtimeContracts.ts，这里按既有 import 路径继续对外转发。
export type {
  AppRuntime,
  AppRuntimeProcessRole,
  CreateRuntimeOptions,
  SkillsWarmupStatus,
} from './runtimeContracts.js';
// export ... from 是纯转发、不引入本地绑定，本文件内部使用需要再 import 一次。
import type {
  AppRuntime,
  CreateRuntimeOptions,
  SkillsWarmupStatus,
} from './runtimeContracts.js';

function ensureDirectory(path: string, label: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
    serverLogger.info(`Created ${label}: ${path}`);
  }
}
export async function createRuntime(options: CreateRuntimeOptions = {}): Promise<AppRuntime> {
  const processCwd = options.processCwd ?? process.cwd();
  const processRole = options.processRole ?? 'all';
  const enableSchedulerWorker = processRole !== 'ws-only';
  const enableHttpListeners = processRole === 'all' || processRole === 'ws-only';
  const enableSingletonWorkers = processRole === 'all' || processRole === 'runtime-worker';
  const config = loadAppConfig(processCwd);
  const sessionLockMode = config.runtimeScheduler?.sessionLockMode ?? 'dual';
  // 非 production 进程禁止连远程 PG（2026-07-26 本地 dev 接管生产库事故）
  assertDevDatabaseSafety(config);
  // ClientDaemonGateway 仍是进程内连接表。拆成 ws-only + runtime-worker 后，daemon
  // 连在 Web 进程、执行却发生在 Worker，二者尚无跨进程转发层。显式配置时必须
  // fail-fast，让部署保留旧 worker，不能静默把 executionTarget=client 变成不可用。
  if (processRole === 'runtime-worker' && config.clientDaemon) {
    throw new Error(
      'runtime-worker 暂不支持进程内 clientDaemon gateway；请先外置 gateway 或禁用 clientDaemon 配置',
    );
  }
  const tenantLifecycleRequiresPg = config.auth?.enabled === true
    && (processRole !== 'all' || process.env.NODE_ENV === 'production');
  if (tenantLifecycleRequiresPg && config.runtimeEventStore?.backend !== 'pg') {
    throw new Error(
      `processRole=${processRole} requires runtimeEventStore.backend=pg for cross-instance tenant lifecycle coordination`,
    );
  }
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
  const skillSourceRevision = process.env.AGENT_SAAS_RELEASE_ID?.trim()
    || basename(realpathSync(projectRoot));
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
  const uploadManager = new UploadManager({ agentCwd });
  if (enableHttpListeners) uploadManager.start();
  const sessionBasePath = processCwd;

  // Memory Index: 只保留索引服务本身；OpenAI Agents 的 MCP/function tool 接入后续单独实现。
  const memoryIndexServiceRef: { current: MemoryIndexService | null } = { current: null };
  const memoryIndexServices = new Set<MemoryIndexService>();
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
  const titleGeneratorConfigs = resolveTitleGeneratorConfigs({
    models: config.models,
    titleGenerator: config.titleGenerator,
    defaultModel: process.env.OPENAI_DEFAULT_MODEL || process.env.OPENAI_MODEL || 'gpt-5.4-mini',
    logger: serverLogger,
  });
  // 门禁模型配置链（主 + fallback；2026-07 唯恩批次）。与 title 不同：
  // config.guardrail 缺省 = 门禁模块不激活（空数组，checkTopicScope fail-open
  // 短路），**没有** env 默认模型兜底。热更由 routes.ts onModelsUpdated 经
  // updateGuardrailModelConfigs 写回本变量，WebChannel 通过 getter 读取；标题链
  // 则由热更逻辑原地替换数组内容，保证已捕获该数组的会话也能看到新配置。
  let guardrailModelConfigs: GuardrailModelConfig[] = resolveGuardrailModelConfigs({
    models: config.models,
    guardrail: config.guardrail,
    logger: serverLogger,
  });

  // Auth 初始化（需要在 dispatch 之前，因为 agentStore 依赖 userStore）
  let userStore: UserStore | undefined;
  let tenantStore: TenantStore | undefined;
  // 跨进程刷新用（见 sharedConfigRefresher）：runtime-worker 要能感知 ws-only
  // 进程对 tenants.json 的改写，所以路径需要在这个 if 块之外可见。
  let tenantsFilePath: string | undefined;
  let authMiddleware: ReturnType<typeof createAuthMiddleware> | undefined;

  if (config.auth?.enabled && config.auth.jwtSecret) {
    const usersFilePath = resolve(processCwd, config.auth.usersFile || './data/users.json');
    userStore = new UserStore(usersFilePath);

    // Tenant store 与 user store 共生命周期；tenants.json 放在 users.json 同目录。
    // 启动期保证平台根组织和开沿日常组织都始终存在。
    tenantsFilePath = join(dirname(usersFilePath), 'tenants.json');
    const tenantPgConfig = config.runtimeEventStore?.backend === 'pg'
      ? config.runtimeEventStore
      : undefined;
    tenantStore = new TenantStore(tenantsFilePath, tenantPgConfig ? {
      withLock: <T>(operation: () => Promise<T>) => withPgAdvisoryLock(
        tenantPgConfig.connectionString,
        `${tenantPgConfig.tablePrefix ?? 'agent_saas'}:tenant-store`,
        operation,
      ),
    } : { useLocalLock: false });
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
  let skillMaterializationService: SkillMaterializationService | undefined;
  let skillMaterializationLeadership: CronLeadership | undefined;
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
    //   同步段（快，配置级）：syncWithPool 仅补全 pool 注册表；
    //   后台段（listen 后 deferredStartupTasks 执行）：异步内容指纹、逐用户版本
    //     检查物化、prune 幽灵条目与 manifest 收口。用户在后台段完成前发起会话
    //     时，由 dispatch 的 ensureReady 入队并等待，正确性不依赖 warmup 先跑完。
    const poolDir = resolveAgentPath(sharedDir, 'skills-pool');
    // scanPoolSkills 已经在文件顶部静态 import 为 scanPoolSkillsForDispatch。
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

    // 2. 来源指纹 + 逐用户物化 + prune → 后台任务（listen 后执行）。
    // 指纹扫描和物化都只用 fs/promises；此 deferred task 只 enqueue + 观察，
    // 不再在 HTTP 进程主线程里同步读 NAS、cpSync/rmSync 或递归 chown。
    const store = skillConfigStore;
    const warmupUserStore = userStore;
    deferredStartupTasks.push({
      name: 'skills-warmup',
      run: async () => {
        skillsWarmup.state = 'running';
        skillsWarmup.startedAtMs = Date.now();
        try {
          if (!skillMaterializationService) {
            throw new Error('技能物化服务未初始化');
          }
          try {
            const fingerprint = await computeSkillsContentFingerprintAsync(
              poolDir,
              tenantSkillsRootDir,
              resolveAgentPath(sharedDir, 'scripts'),
            );
            if (fingerprint !== store.getPoolContentHash()) {
              store.setPoolContentHashSync(fingerprint);
              serverLogger.info('Skills content fingerprint changed; configVersion bumped for versioned sync');
            }
          } catch (err) {
            serverLogger.warn(`Skills content fingerprint failed (versioned sync falls back to config-only changes): ${err instanceof Error ? err.message : String(err)}`);
          }
          const allUsers = warmupUserStore.listAll();
          skillsWarmup.processedUsers = 0;
          const requests: SkillMaterializationRequest[] = [];
          for (const u of allUsers) {
            const workspaceUser = { id: u.id, username: u.username, role: u.role as 'admin' | 'user', tenantId: u.tenantId };
            const userCwd = resolveUserCwd(agentCwd, workspaceUser);
            if (existsSync(agentDir(userCwd))) {
              requests.push({
                user: workspaceUser,
                userCwd,
                reason: 'startup',
                priority: 10,
              });
            }
          }
          skillsWarmup.totalUsers = requests.length;
          const batch = await skillMaterializationService.enqueue(requests);
          for (;;) {
            const status = await skillMaterializationService.getBatch(batch.id);
            if (!status) throw new Error(`技能 warmup 批次丢失：${batch.id}`);
            skillsWarmup.processedUsers = status.succeeded + status.failed;
            skillsWarmup.syncedUsers = status.succeeded;
            if (status.status === 'succeeded') break;
            if (status.status === 'partial' || status.status === 'failed') {
              throw new Error(status.error || `技能 warmup 失败：${status.failed}/${status.total}`);
            }
            await new Promise<void>((resolveWait) => setTimeout(resolveWait, 250));
          }

          // 3b. 全部 workspace 先按旧注册表完成撤销，再清理幽灵条目，避免首次
          // manifest 迁移时失去“该目录曾是系统技能”的识别依据。
          const tenantOwnIdsByTenant: Record<string, Set<string>> = {};
          const tenantsRoot = tenantSkillsRootDir;
          if (existsSync(tenantsRoot)) {
            for (const entry of await readdirAsync(tenantsRoot, { withFileTypes: true })) {
              try {
                if (!entry.isDirectory() || !TENANT_SLUG_PATTERN.test(entry.name)) continue;
                const tenantSkillDir = resolveTenantSkillsDirFromRoot(
                  tenantSkillsRootDir,
                  entry.name,
                );
                const ownIds = new Set(
                  (await readdirAsync(tenantSkillDir, { withFileTypes: true }))
                    .filter((skill) => (
                      skill.isDirectory()
                      && SAFE_SKILL_NAME_RE.test(skill.name)
                      && !currentPoolIds.has(skill.name)
                    ))
                    .map((skill) => skill.name),
                );
                tenantOwnIdsByTenant[entry.name] = ownIds;
              } catch {
                // 非法目录名或读取失败，跳过
              }
            }
          }
          const pruned = store.pruneStaleSkills(currentPoolIds, tenantOwnIdsByTenant);
          if (pruned > 0) {
            serverLogger.info(`Skills config: pruned ${pruned} stale entries`);
            // prune 会 bump configVersion；再跑一轮精确 diff 只更新 manifest 版本，
            // 内容摘要不变的技能不会重拷。
            const finalize = await skillMaterializationService.enqueue(requests);
            const finalized = await skillMaterializationService.waitForBatch(finalize.id);
            if (finalized.status !== 'succeeded') {
              throw new Error(finalized.error || '技能 prune 后 manifest 收口失败');
            }
          }

          skillsWarmup.state = 'done';
          skillsWarmup.finishedAtMs = Date.now();
          serverLogger.info(`Skills warmup done: ready=${skillsWarmup.syncedUsers ?? 0}/${allUsers.length} users in ${skillsWarmup.finishedAtMs - (skillsWarmup.startedAtMs ?? skillsWarmup.finishedAtMs)}ms`);
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
  let memoryConsolidationStore: PgMemoryConsolidationStore | undefined;
  let memoryConsolidationEngine: MemoryConsolidationEngine | undefined;
  let sessionLock: PgSessionLock | undefined;
  let pgRunStore: PgTerminalEventOutboxRunStore | undefined;
  let pgSessionProjectionStore: PgSessionProjectionStore | undefined;
  let sessionReadStateStore: SessionReadStateStore | undefined;
  let pgHandStore: PgHandStore | undefined;
  let pgToolInvocationStore: PgToolInvocationStore | undefined;
  let pgClientDaemonRegistry: PgClientDaemonRegistry | undefined;
  let guardrailEventStore: PgGuardrailEventStore | undefined;
  let messageFeedbackStore: PgMessageFeedbackStore | undefined;
  let appealStore: PgAppealStore | undefined;
  let taskboardService: TaskboardService | undefined;
  let taskboardStoreService: RetryableTaskboardService | undefined;
  let rawTaskboardStore: PgTaskboardStore | undefined, taskboardExecutionCoordinator: TaskboardExecutionCoordinator | undefined, integrationV3Runtime: RuntimeTaskboardIntegrationV3 | undefined, taskboardRepositoryProvider: ReturnType<typeof configureTaskboardGithubRepositoryProvider>, integrationV3RepositoryProvider: RepositoryProvider | undefined, taskboardStatusNotificationWorker: ReturnType<typeof startTaskboardStatusNotificationWorker>;
  let pgArtifactStore: PgArtifactStore | undefined;
  let systemMetricsStore: PgSystemMetricsStore | undefined;
  let systemMetricsCollector: SystemMetricsCollector | undefined;
  let alertStateStore: PgAlertStateStore | undefined;
  let alertNotifier: AlertNotifier | undefined;
  const runtimeWebPush = createRuntimeWebPushAssembly({
    config, userStore, getSessionStore: () => pgSessionProjectionStore, logger: serverLogger,
  });
  let dwsConnectionStore: PgDwsConnectionStore | undefined;
  let dwsAuthSessionStore: PgDwsAuthSessionStore | undefined;
  let dwsAuthKeepaliveService: DwsAuthKeepaliveService | undefined;
  let dwsAuthFlowService: DwsAuthFlowService | undefined;
  let agentDwsMessageStore: PgAgentDwsMessageStore | undefined; let agentDwsRuntime: AgentDwsRuntimeBundle | undefined;
  let notionAuthSessionStore: PgDwsAuthSessionStore | undefined;
  let notionAuthFlowService: NotionAuthFlowService | undefined;
  let googleWorkspaceOAuthService: GoogleWorkspaceOAuthService | undefined;
  let feishuConnectionStore: PgFeishuConnectionStore | undefined;
  let feishuAuthSessionStore: PgFeishuAuthSessionStore | undefined;
  let feishuTokenBroker: FeishuTokenBroker | undefined;
  let feishuAuthKeepaliveService: FeishuAuthKeepaliveService | undefined;
  let feishuAuthFlowService: FeishuAuthFlowService | undefined;
  let artifactStore: ArtifactStore | undefined;
  let artifactService: ArtifactService | undefined;
  let artifactShareStore: ArtifactShareStore | undefined;
  let artifactShareService: ArtifactShareService | undefined;
  let sessionShareStore: SessionShareStore | undefined;
  let agentRuntimeProfileStore: AgentRuntimeProfileStore | undefined;
  let connectorDictionaryStore: ConnectorDictionaryStore | undefined;
  let artifactShutdown: (() => Promise<void>) | undefined;
  let billingService: BillingService | undefined;
  let governanceAuditStore: GovernanceAuditStore | undefined;
  let membershipStore: PgMembershipStore | undefined;
  let entitlementStore: PgEntitlementStore | undefined;
  let directoryGroupStore: PgDirectoryGroupStore | undefined; let oauthGrantStore: PgOAuthGrantStore | undefined; let assignmentStore: PgAssignmentStore | undefined; let contextStore: ContextStore | undefined;
  let credentialStore: PgCredentialStore | undefined;
  let connectorCatalogStore: PgConnectorCatalogStore | undefined;
  let environmentStore: PgEnvironmentStore | undefined;
  let agentResourceStore: PgAgentResourceStore | undefined;
  let agentDwsAccountStore: PgAgentDwsAccountStore | undefined;
  let skillGovernanceStore: PgSkillGovernanceStore | undefined;
  let resolveLegacySkillResourceId = (_user: { id: string; tenantId: string }, skillId: string) => skillId;
  let governanceChangeJobStore: PgGovernanceChangeJobStore | undefined;
  let governanceChangePlanner: GovernanceChangePlanner | undefined;
  let governanceMigrationControlStore: PgGovernanceMigrationControlStore | undefined;
  let governanceWriteGate: GovernanceWriteGate | undefined;
  let governanceShadowComparator: GovernanceShadowComparator | undefined;
  let contentAccessGrantStore: PgContentAccessGrantStore | undefined;
  let governanceProjectionOutboxStore: PgGovernanceProjectionOutboxStore | undefined;
  let governanceProjectionReconciler: GovernanceProjectionReconciler | undefined;
  let resourceReferenceStore: PgResourceReferenceStore | undefined;
  let credentialBroker: CredentialBroker | undefined;
  let runResolutionSnapshotStore: PgRunResolutionSnapshotStore | undefined;
  let runPreflightService: RunPreflightService | undefined;
  let flushGovernanceShadowProjections: (() => Promise<void>) | undefined;
  const beginMemoryEmbeddingBillingRun = async (workspaceDir: string) => {
    if (!billingService) return undefined;
    const rel = relative(agentCwd, resolve(workspaceDir));
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) return undefined;
    const [tenantId, userId] = rel.split(sep);
    if (!tenantId || !userId || !TENANT_SLUG_PATTERN.test(tenantId)) return undefined;
    const user = userStore?.findById(userId);
    return await billingService.beginUtilityModelRun({
      tenantId,
      userId,
      username: user?.username ?? userId,
      channel: 'memory_embedding',
    });
  };
  let billingAuditTimer: NodeJS.Timeout | undefined;
  let runtimeEventRetention: RuntimeEventRetention | undefined;
  let runtimeScheduler: RuntimeScheduler | undefined;
  let runtimeSchedulerConfigStore: PgRuntimeSchedulerConfigStore | undefined;
  let runtimeSchedulerCapacity: RuntimeSchedulerCapacityController | undefined;
  const isRuntimeExecutionEnabled = async (): Promise<boolean> => (
    runtimeSchedulerConfigStore ? (await runtimeSchedulerConfigStore.get()).executionEnabled : true
  );
  let runtimeAdmissionGuard: RuntimeAdmissionGuard | undefined;
  let runtimeEventSubscriptionShutdown: (() => Promise<void>) | undefined;
  let tenantLifecycleWatcher: TenantLifecycleWatcher | undefined;
  let cancelDeliveryRetryTimer: NodeJS.Timeout | undefined;
  let runtimeSchedulerAutoWake = false;
  // B4: HandHealthScanner 仅 PG runtime 装配，shutdown 时 stop()。
  let handHealthScanner: HandHealthScanner | undefined;
  // 2026-08-03 P1: server-remote hand 租约巡检（同 scanner 门槛装配）。
  let handLeaseJanitor: HandLeaseJanitor | undefined;
  const {
    secretVault,
    resolvedSttRuntimeConfig,
    resolvedClientDaemonAuthToken,
    resolvedFeishuConnector,
    feishuConnectorScopes,
  } = await initializeRuntimeGovernanceCredentials(config, processCwd); const integrationV3Adapters = (await import('./runtimeIntegrationV3ProductionAdapters.js')).resolveProductionIntegrationV3Adapters({ config, secretVault, ...options });
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
  }) => void | Promise<void>) | undefined;
  let runtimeOutboundStreamRelay: RuntimeOutboundStreamRelay | undefined;
  if (config.runtimeEventStore?.backend === 'pg') {
    pgEventStore = new PgEventStore({
      connectionString: config.runtimeEventStore.connectionString,
      tablePrefix: config.runtimeEventStore.tablePrefix,
      poolMax: config.runtimeEventStore.poolMax,
      logger: serverLogger.child('PgEventStore'),
    });
    await pgEventStore.init();
    await runtimeWebPush.initialize(pgEventStore, config.runtimeEventStore.tablePrefix);
    ({
      authMiddleware,
      governanceAuditStore,
      membershipStore,
      entitlementStore,
      directoryGroupStore, oauthGrantStore, assignmentStore, contextStore,
      credentialStore,
      connectorCatalogStore,
      environmentStore,
      agentResourceStore,
      agentDwsAccountStore,
      agentDwsMessageStore,
      skillGovernanceStore,
      resolveLegacySkillResourceId,
      governanceChangeJobStore,
      governanceChangePlanner,
      governanceMigrationControlStore,
      governanceWriteGate,
      governanceShadowComparator,
      contentAccessGrantStore,
      governanceProjectionOutboxStore,
      governanceProjectionReconciler,
      resourceReferenceStore,
      runResolutionSnapshotStore,
      flushGovernanceShadowProjections,
    } = await initializeRuntimeGovernanceStores({
      pgEventStore,
      tablePrefix: config.runtimeEventStore.tablePrefix,
      config,
      userStore,
      tenantStore,
      orgAgentStore,
      skillConfigStore,
    }));
    if (enableSchedulerWorker) {
      runtimeOutboundStreamRelay = new RuntimeOutboundStreamRelay(pgEventStore, {
        logger: serverLogger.child('RuntimeOutboundStreamRelay'),
      });
    }
    try {
      const store = new PgTaskboardStore({
        pool: pgEventStore.pool,
        tablePrefix: config.runtimeEventStore.tablePrefix,
      });
      rawTaskboardStore = store;
      const retryableService = new RetryableTaskboardService(store, { onReady: () => { taskboardStatusNotificationWorker ??= startTaskboardStatusNotificationWorker(store, runtimeWebPush.service, enableSingletonWorkers, userStore); } });
      taskboardService = retryableService;
      taskboardStoreService = retryableService;
      await retryableService.init().catch((err) => {
        serverLogger.warn(`PgTaskboardStore init failed; requests return 503 until a later init retry succeeds: ${err instanceof Error ? err.message : String(err)}`);
      });
    } catch (err) {
      taskboardService = undefined;
      taskboardStoreService = undefined;
      serverLogger.warn(`PgTaskboardStore configuration invalid, taskboard routes degrade to 503: ${err instanceof Error ? err.message : String(err)}`);
    }
    const pgAgentRuntimeProfileStore = new PgAgentRuntimeProfileStore({
      pool: pgEventStore.pool,
      tablePrefix: config.runtimeEventStore.tablePrefix,
    });
    await pgAgentRuntimeProfileStore.init();
    agentRuntimeProfileStore = pgAgentRuntimeProfileStore;
    try {
      const pgConnectorDictionaryStore = new PgConnectorDictionaryStore(pgEventStore.pool, {
        tablePrefix: config.runtimeEventStore.tablePrefix,
      });
      await pgConnectorDictionaryStore.init();
      connectorDictionaryStore = pgConnectorDictionaryStore;
    } catch (err) {
      // 词典读不出来不该拖垮启动：运行时会回落内置默认种子，摘要照常产出，
      // 只是平台管理里改的那份暂时不生效
      connectorDictionaryStore = undefined;
      serverLogger.warn(`PgConnectorDictionaryStore init failed, falling back to builtin dictionary: ${err instanceof Error ? err.message : String(err)}`);
    }
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
      notionAuthSessionStore = new PgDwsAuthSessionStore({
        pool: pgEventStore.pool,
        tablePrefix: config.runtimeEventStore.tablePrefix,
        connectorId: 'notion',
      });
      await notionAuthSessionStore.init();
    } catch (err) {
      notionAuthSessionStore = undefined;
      serverLogger.warn(`Notion auth session store init failed: ${err instanceof Error ? err.message : String(err)}`);
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
    pgRunStore = new PgTerminalEventOutboxRunStore({
      pool: pgEventStore.pool,
      tablePrefix: config.runtimeEventStore.tablePrefix,
    });
    await pgRunStore.init();
    const defaultMaxConcurrentRuns = config.runtimeScheduler?.maxConcurrentRuns ?? 16;
    runtimeSchedulerConfigStore = new PgRuntimeSchedulerConfigStore(pgEventStore.pool, {
      tablePrefix: config.runtimeEventStore.tablePrefix,
      maxConfigurableConcurrentRuns: Math.max(
        defaultMaxConcurrentRuns,
        config.runtimeScheduler?.maxConfigurableConcurrentRuns ?? 64,
      ),
    });
    await runtimeSchedulerConfigStore.init(defaultMaxConcurrentRuns);
    pgSessionProjectionStore = new PgSessionProjectionStore({
      pool: pgEventStore.pool,
      tablePrefix: config.runtimeEventStore.tablePrefix,
    });
    await pgSessionProjectionStore.init();
    sessionReadStateStore = new PgSessionReadStateStore(pgEventStore.pool, {
      tableName: `${config.runtimeEventStore.tablePrefix || 'runtime'}_session_read_states`,
    });
    await sessionReadStateStore.init();
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
    // 模型图片 blob 副本：uploads/ 可被用户一键清空，历史会话重放要能从这里取回字节。
    // init 失败只降级（读图回落文件系统、历史图缺失时降级占位），不阻断服务启动。
    try {
      const imageBlobStore = new PgImageBlobStore({
        pool: pgEventStore.pool,
        tablePrefix: config.runtimeEventStore.tablePrefix,
      });
      await imageBlobStore.init();
      setImageBlobStore(imageBlobStore);
    } catch (err) {
      serverLogger.warn(
        `PgImageBlobStore init failed, model images fall back to filesystem only: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
    if (processRole === 'runtime-worker') {
      const activeClientDaemonDevices = (await pgClientDaemonRegistry.list())
        .filter((device) => device.status === 'active');
      if (activeClientDaemonDevices.length > 0) {
        throw new Error(
          `runtime-worker 暂不支持 ${activeClientDaemonDevices.length} 个活跃 clientDaemon device；请先外置跨进程 gateway`,
        );
      }
    }
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
      if (enableSingletonWorkers) {
        systemMetricsCollector.start();
      } else {
        serverLogger.info(`SystemMetricsCollector worker disabled for processRole=${processRole}`);
      }
    }
    if (enableSingletonWorkers) {
      alertNotifier.start();
    } else {
      serverLogger.info(`AlertNotifier worker disabled for processRole=${processRole}`);
    }
    registerSearchProviderAlerts(alertNotifier, serverLogger);
    const runBillingAudit = async () => {
      const audit = await billingService!.getAuditSummary({ days: 7 });
      if (audit.alerts.length > 0) {
        billingLogger.warn(`Billing audit alerts: ${audit.alerts.join('；')}`);
        await notifyBillingAuditAlerts(alertNotifier, audit.alerts);
      }
    };
    if (enableSingletonWorkers) {
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
    } else {
      serverLogger.info(`Billing audit worker disabled for processRole=${processRole}`);
    }
    const retentionConfig = config.runtimeEventRetention;
    runtimeEventRetention = new RuntimeEventRetention({
      pool: pgEventStore.pool,
      eventsTable: pgEventStore.eventsTable,
      toolInvocationsTable: pgToolInvocationStore.toolInvocationsTable,
      billingProjectionStateTable: pgBillingStore.projectionStateTable,
      ...retentionWorkerOptions(retentionConfig),
      projectBillingRuntimeEvents: (limit) => billingService!.projectRuntimeEvents(limit),
      logger: serverLogger.child('RuntimeEventRetention'),
    });
    if (enableSingletonWorkers) {
      runtimeEventRetention.start();
    } else {
      serverLogger.info(`RuntimeEventRetention disabled for processRole=${processRole}`);
    }
    if (enableSchedulerWorker) {
      const recoveryResult = await recoverRunningToolInvocations({
        toolInvocationStore: pgToolInvocationStore,
        eventStore: pgEventStore,
        runStore: pgRunStore,
        logger: serverLogger.child('ToolInvocationRecovery'),
      });
      if (recoveryResult.recovered > 0) {
        serverLogger.warn(`Recovered stale running tool invocations at startup: ${recoveryResult.recovered}/${recoveryResult.scanned}`);
      }
    }
    const terminalEventOutboxDispatcher = await startTerminalEventOutboxDispatcher({ runStore: pgRunStore, eventStore: pgEventStore, logger: serverLogger.child('TerminalEventOutbox') });
    runtimeEventStoreShutdown = async () => {
      setSessionMetaProjectionSink(undefined);
      clientDaemonGateway?.close();
      handHealthScanner?.stop();
      handLeaseJanitor?.stop();
      systemMetricsCollector?.stop();
      alertNotifier?.stop(); taskboardStatusNotificationWorker?.stop();
      await taskboardExecutionCoordinator?.stop();
      terminalEventOutboxDispatcher.stop();
      await runtimeScheduler?.stop();
      await runtimeOutboundStreamRelay?.flushAll();
      if (cancelDeliveryRetryTimer) clearInterval(cancelDeliveryRetryTimer);
      if (billingAuditTimer) clearInterval(billingAuditTimer);
      runtimeEventRetention?.stop();
      tenantLifecycleWatcher?.stop();
      await runtimeEventSubscriptionShutdown?.();
      await sessionLock?.close();
      userStore?.setPostPersistObserver(undefined);
      tenantStore?.setPostPersistObserver(undefined);
      orgAgentStore?.setPostPersistObserver(undefined);
      skillConfigStore?.setPostPersistObserver(undefined);
      await flushGovernanceShadowProjections?.();
      await artifactShareStore?.close?.();
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
  const runtimeEventStoreFor = createRuntimeEventStoreFactory(pgEventStore);
  const resolveTenantSkillHistoricalProvenance = (tenantId: string) => skillGovernanceStore?.listTenantSkillHistoricalProvenance(tenantId) ?? Promise.resolve(new Map());
  const resolveUserPersonalSkillIds = (user: { id: string; tenantId?: string }) => resolvePersonalSkillIds(user, skillGovernanceStore);
  if (skillConfigStore && userStore) {
    const materializationStore = pgEventStore
      ? new PgSkillMaterializationStore({
          pool: pgEventStore.pool,
          tablePrefix: config.runtimeEventStore?.backend === 'pg'
            ? config.runtimeEventStore.tablePrefix
            : undefined,
        })
      : new InMemorySkillMaterializationStore();
    await materializationStore.init();
    const materializer = new SkillWorkspaceMaterializer({
      sharedDir,
      sourceRevision: skillSourceRevision,
      tenantSkillsRootDir,
      skillConfigStore,
      resolveAssignedOrgAgentSkillIds: (workspaceUser) => {
        if (!workspaceUser.tenantId || !orgAgentStore) return [];
        return orgAgentStore.listByTenant(workspaceUser.tenantId)
          .filter((agent) => (
            agent.enabled
            && isAssignedToOrgAgent(agent, workspaceUser.username)
          ))
          .flatMap((agent) => agent.allowedSkills);
      },
      resolveTenantSkillHistoricalProvenance,
      resolveUserPersonalSkillIds, resolveUserPersonalSkillOwnership: skillGovernanceStore?.resolveUserPersonalSkillOwnership?.bind(skillGovernanceStore),
    });
    skillMaterializationService = new SkillMaterializationService({
      store: materializationStore,
      materializer,
      skillConfigStore,
      sourceRevision: skillSourceRevision,
      resolveTargetByUsername: (username) => {
        const user = userStore!.findByUsername(username);
        if (!user) return undefined;
        const workspaceUser = {
          id: user.id,
          username: user.username,
          role: user.role as 'admin' | 'user',
          tenantId: user.tenantId,
        };
        return {
          user: workspaceUser,
          userCwd: resolveUserCwd(agentCwd, workspaceUser),
        };
      },
    });
    skillMaterializationLeadership = new CronLeadership({
      connectionString: config.runtimeEventStore?.backend === 'pg'
        ? config.runtimeEventStore.connectionString
        : undefined,
      lockName: `${config.runtimeEventStore?.backend === 'pg'
        ? (config.runtimeEventStore.tablePrefix ?? 'agent_saas')
        : 'agent_saas'}:skill-materialization-leader:${skillSourceRevision}`,
      onAcquired: () => {
        skillMaterializationService!.start();
      },
      onLost: async (reason) => {
        serverLogger.warn(`Skill materialization leadership lost (${reason}); stopping local worker`);
        await skillMaterializationService!.stop();
      },
    });
  }
  if (!sessionReadStateStore) {
    sessionReadStateStore = new FileSessionReadStateStore(
      resolve(processCwd, './data/session-read-states.json'),
    );
    await sessionReadStateStore.init();
  }
  sessionShareStore ??= new InMemorySessionShareStore();
  const pgRuntimeEventStore = config.runtimeEventStore?.backend === 'pg' ? config.runtimeEventStore : undefined;
  artifactShareStore ??= await initializeArtifactShareStore(pgEventStore && pgRuntimeEventStore ? { pool: pgEventStore.pool, connectionString: pgRuntimeEventStore.connectionString, tablePrefix: pgRuntimeEventStore.tablePrefix } : undefined);
  if (!agentRuntimeProfileStore) {
    agentRuntimeProfileStore = new InMemoryAgentRuntimeProfileStore();
    await agentRuntimeProfileStore.init();
  }
  const agentRuntimeProfileResolver = new AgentRuntimeProfileResolver(agentRuntimeProfileStore);
  if (!connectorDictionaryStore) {
    connectorDictionaryStore = new InMemoryConnectorDictionaryStore();
    await connectorDictionaryStore.init();
  }
  // 启动时把词典推给摘要产出层。读失败不抛——`setConnectorDictionary(null)` 会
  // 回落内置种子，工具行摘要不会因为一张配置表而整体失灵。
  // 2026-08-04 任务 E：同时加载租户覆盖（整条覆盖合并视图在 builder 侧预计算）。
  try {
    setConnectorDictionary(await connectorDictionaryStore.listPlatform());
    setTenantConnectorDictionaries(await connectorDictionaryStore.listAllTenantOverrides());
  } catch (err) {
    setConnectorDictionary(null);
    serverLogger.warn(`connector dictionary load failed, using builtin: ${err instanceof Error ? err.message : String(err)}`);
  }
  // 跨进程热更新（2026-08-03）：admin 保存只能刷新处理该请求的 Web/API 进程，
  // 而 presentation 产出在独立的 Runtime Worker 进程（蓝绿解耦后 chat 走
  // enqueue-only → scheduler wake）。没有这条定时刷新，「保存即热更新」对
  // 会话执行进程永远无效，要等下次部署重启才生效。60s 从 PG 拉全量，
  // 语义=「保存后 ≤60s 全进程生效」；词典只有个位数条目，成本可忽略。
  // 单次读失败保留上一份内存词典（不回退 builtin），连续失败只影响新鲜度不影响可用性。
  const connectorDictionaryRefreshTimer = setInterval(() => {
    void connectorDictionaryStore!.listPlatform()
      .then(async (entries) => {
        setConnectorDictionary(entries);
        setTenantConnectorDictionaries(await connectorDictionaryStore!.listAllTenantOverrides());
      })
      .catch((err) => {
        serverLogger.warn(`connector dictionary refresh failed, keeping last loaded copy: ${err instanceof Error ? err.message : String(err)}`);
      });
  }, 60_000);
  connectorDictionaryRefreshTimer.unref();
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
    ...artifactServiceLifecycleOptions(artifactShareStore, sessionCatalog),
    resolveSessionTenantId: async sessionId => (await sessionCatalog.get(sessionId))?.tenantId,
    authorizeContentAccess: contentAccessGrantStore
      ? input => contentAccessGrantStore!.authorize(input)
      : undefined,
    auditContentAccess: artifactContentAudit(governanceAuditStore),
  });
  artifactShareService = initializeArtifactShareService(artifactShareStore, artifactService, artifactConfig?.signedUrlSecret ?? config.auth?.jwtSecret, message => serverLogger.warn(message));
  if (artifactConfig?.retentionDays && enableSingletonWorkers) {
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
  // PG backend：session single-writer 从常驻 advisory connection 迁到短查询表租约。
  // dual 是滚动升级兼容态；全量跑过 dual 后，生产配置切 lease 才真正去掉旧连接。
  if (pgEventStore) {
    sessionLock = new PgSessionLock({
      pool: pgEventStore.pool,
      tablePrefix: config.runtimeEventStore?.backend === 'pg'
        ? config.runtimeEventStore.tablePrefix
        : undefined,
      mode: sessionLockMode,
      logger: serverLogger.child('PgSessionLock'),
    });
    await sessionLock.init();
  }
  const skillsDispatchConfig: SkillsDispatchConfig | undefined = (() => {
    if (!skillConfigStore) return undefined;
    const store = skillConfigStore; // 闭包稳定捕获
    const poolDir = resolveAgentPath(sharedDir, 'skills-pool');
    const skillDispatchState = createSkillDispatchState({
      findUser: (username) => userStore?.findByUsername(username),
      agentCwd,
      tenantsRootDir: tenantSkillsRootDir,
      getConfigVersion: () => store.getConfigVersion(),
      scanPoolSkills: () => scanPoolSkillsForDispatch(poolDir),
      resolveTenantSkillHistoricalProvenance,
      resolveUserPersonalSkillIds, resolveUserPersonalSkillOwnership: skillGovernanceStore?.resolveUserPersonalSkillOwnership?.bind(skillGovernanceStore),
    });
    return {
      async ensureReady(username: string | undefined, requiredSkillIds: readonly string[] = []): Promise<void> {
        // ws-only 负责 Skill/User 管理接口，runtime-worker 负责会话执行；两者各自持有
        // 文件 store 的内存副本。每次 dispatch 在物化与清单计算前重载共享配置，
        // 否则用户刚导入并启用的自建 skill 要等 runtime-worker 重启后才会生效。
        store.reload();
        userStore?.reload();
        await (skillMaterializationService?.ensureReady(username, requiredSkillIds, 'dispatch')
          ?? Promise.resolve());
        await skillDispatchState.refresh(username);
      },
      listForUser(username: string | undefined, requiredSkillIds: readonly string[] = [], contextTenantId?: string): SkillEntry[] {
        const all = skillDispatchState.getAllPoolEntries();
        const user = username ? userStore?.findByUsername(username) : undefined;
        const tenantId = user?.tenantId ?? contextTenantId;
        if (!user && !tenantId) return [];
        const effective = new Set([
          ...(user ? store.getUserEffectivePoolSkills(user.username, tenantId) : []),
          ...store.getOrgAgentEffectivePoolSkills(tenantId, requiredSkillIds),
        ]);
        const poolResult = all.filter((s) => effective.has(s.id));

        try {
          const poolIds = new Set(all.map((s) => s.id));
          const tenantSkillsDir = tenantId ? resolveTenantSkillsDirFromRoot(tenantSkillsRootDir, tenantId) : null;
          const tenantOwnIds = tenantSkillsDir ? scanTenantOwnSkillIds(tenantSkillsDir, poolIds) : new Set<string>();
          const effectiveTenantOwn = new Set([
            ...(user ? store.getUserEffectiveTenantOwnSkills(user.username, tenantId, tenantOwnIds) : []),
            ...store.getOrgAgentEffectiveTenantOwnSkills(tenantId, tenantOwnIds, requiredSkillIds),
          ]);
          const tenantResult = tenantSkillsDir
            ? scanUserCustomSkills(tenantSkillsDir, poolIds)
              .filter((s) => effectiveTenantOwn.has(s.id))
              .map((s) => ({ id: s.id, name: (s as { name?: string }).name || s.id, description: s.description ?? '' }))
            : [];
          if (!user) return [...poolResult, ...tenantResult];

          // 按 selection 暴露用户自建 skill，路径由 resolveSkillDir 优先命中 workspace 副本。
          const userCwd = resolveUserCwd(agentCwd, {
            id: user.id,
            username: user.username,
            role: user.role,
            tenantId: user.tenantId,
          });
          const userSkillsDir = resolveAgentPath(userCwd, 'skills');
          const managedTenantIds = skillDispatchState.getManagedTenantIds(user.username);
          const selected = new Set(store.getUserSelectedSkills(user.username));
          const customExcluded = new Set([...poolIds, ...tenantOwnIds, ...managedTenantIds]);
          const customResult = scanUserCustomSkills(userSkillsDir, customExcluded)
            .filter((s) => selected.has(s.id))
            .map((s) => ({ id: s.id, name: (s as { name?: string }).name || s.id, description: s.description ?? '' }));
          return [...poolResult, ...tenantResult, ...customResult];
        } catch {
          // 非法路径 / 扫描失败：静默降级为仅 pool，dispatch 不因目录异常而崩
          return poolResult;
        }
      },
      resolveSkillDir(username: string | undefined, skill: string, _requiredSkillIds: readonly string[] = [], contextTenantId?: string): string | null {
        if (!SAFE_SKILL_NAME_RE.test(skill)) return null; // 防 path traversal
        const user = username ? userStore?.findByUsername(username) : undefined;
        if (user) {
          // 真实成员只使用已物化到个人 workspace 的副本，不能回退读取共享源。
          const userCwd = resolveUserCwd(agentCwd, {
            id: user.id,
            username: user.username,
            role: user.role,
            tenantId: user.tenantId,
          });
          const userDir = resolveAgentPath(userCwd, 'skills', skill);
          return existsSync(userDir) ? userDir : null;
        }

        // 企业 Agent 使用 service identity，不创建影子成员；直接读取租户或平台授权源。
        const tenantId = contextTenantId;
        if (tenantId) {
          const tenantDir = resolveAgentPath(
            resolveTenantSkillsDirFromRoot(tenantSkillsRootDir, tenantId),
            skill,
          );
          if (existsSync(tenantDir)) return tenantDir;
        }
        const sharedPoolDir = resolveAgentPath(poolDir, skill);
        return existsSync(sharedPoolDir) ? sharedPoolDir : null;
      },
    };
  })();
  const {
    mcpConfigStore,
    connectorConnectionStore,
    aliyunConnectorService,
    mcpOAuthService,
    signupConfigStore,
    egressConfigStore,
    refreshEgressProxyCredential,
    egressDispatchers,
    egressFetch,
    webToolEgressFetch,
    getNotionConnection,
    disconnectNotionConnection,
    codexWebSocketPool,
    mcpClientManager,
    mcpProxy,
    mcpClientShutdown,
    resolveRunScopedEnv,
    googleWorkspaceOAuthService: initializedGoogleWorkspaceOAuthService,
    credentialBroker: initializedCredentialBroker,
  } = await initializeRuntimeGovernanceConnectors({
    processCwd,
    agentCwd,
    config,
    secretVault,
    getFeishuTokenBroker: () => feishuTokenBroker,
    tenantRunEnvByTenant: resolvedSttRuntimeConfig.audioTranscribeEnvByTenant,
    userStore,
    tenantStore, orgAgentStore,
    skillConfigStore,
    pgEventStore,
    membershipStore, oauthGrantStore, governanceChangeJobStore,
    entitlementStore,
    assignmentStore,
    credentialStore,
    agentResourceStore,
    environmentStore,
    skillGovernanceStore,
    governanceAuditStore,
    governanceMigrationControlStore,
    governanceShadowComparator,
    runResolutionSnapshotStore,
    resolveLegacySkillResourceId,
  });
  googleWorkspaceOAuthService = initializedGoogleWorkspaceOAuthService;
  credentialBroker = initializedCredentialBroker;
  const { authorizationRegistry: contextSourceAuthorizationRegistry, derivedStore: derivedContextStore,
    syncRuntime: contextPlanePhase2Runtime } = createRuntimeContextPlane({
    contextStore, taskboardStore: rawTaskboardStore, membershipStore, assignmentStore, userStore, pool: pgEventStore?.pool, tablePrefix: config.runtimeEventStore?.backend === 'pg' ? config.runtimeEventStore.tablePrefix : undefined, fetchImpl: egressFetch, enableWorker: enableSchedulerWorker, logger: serverLogger,
  });
  taskboardRepositoryProvider = configureTaskboardGithubRepositoryProvider(taskboardStoreService, userStore, {
    connectionStore: connectorConnectionStore,
    vault: secretVault,
    onError: (error) => serverLogger.warn(`Taskboard GitHub credential resolve failed: ${error.message}`),
  });
  const configuredIntegrationV3Access = configureRuntimeIntegrationV3RepositoryAccess({ store: rawTaskboardStore, control: config.integrationV3ControlPlane, githubAppInstallationTokenProvider: integrationV3Adapters.githubAppInstallationTokenProvider, resolvePersonalAccessToken: async ({ tenantId, ownerUserId }) => {
    const user = userStore?.findById(ownerUserId); if (!user || user.disabled || (tenantId && user.tenantId !== tenantId)) return undefined;
    return resolveGithubToken({ connectionStore: connectorConnectionStore, vault: secretVault, governanceCredentialStore: credentialStore, onError: (error) => serverLogger.warn(`Integration PAT resolve failed: ${error.message}`) }, { userId: user.id, username: user.username, tenantId: user.tenantId });
  } });
  integrationV3RepositoryProvider = configuredIntegrationV3Access.repositoryProvider;
  const integrationV3PersonalAccessTokenResolver = configuredIntegrationV3Access.personalAccessTokenResolver;
  const initialMemoryIndexService = createMemoryIndexService(
    processCwd,
    config.memory?.index,
    { beginEmbeddingBillingRun: beginMemoryEmbeddingBillingRun },
  );
  if (initialMemoryIndexService) {
    memoryIndexServiceRef.current = initialMemoryIndexService;
    memoryIndexServices.add(initialMemoryIndexService);
    serverLogger.info('Memory index service created (hybrid search enabled)');
  }
  const tenantRemoteHandResolver = createTenantRemoteHandAuthTokenResolver({
    tenantRemoteHands: () => config.tenantRemoteHands?.hands,
    vault: secretVault,
    logger: serverLogger.child('TenantHand'),
  });
  // Sandbox 预热（2026-07-31 冷启动治理）：用户打开会话页即 fire-and-forget 预热
  // ACS Sandbox，让 30s+ 冷启动与打字/LLM 首轮并行。未配置 tenantRemoteHands
  // 的环境（本地开发/测试）service 内部找不到 ACS hand 自然跳过。
  const sandboxWarmupService = new SandboxWarmupService({
    agentCwd,
    sessionCatalog,
    tenantRemoteHands: () => config.tenantRemoteHands?.hands,
    tenantRemoteHandResolver,
    isExecutionEnabled: isRuntimeExecutionEnabled,
    logger: serverLogger.child('SandboxWarmup'),
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
  // 模型解析器：如果配置了 models，绑定到 RawRuntime / WebChannel / Cron。
  // 解析前会对齐磁盘配置，让 runtime-worker 能感知 ws-only 进程的写入（见 modelResolvers.ts）。
  const { modelResolver, defaultModelResolver, sharedConfigRefresher } = createModelResolvers({
    config,
    processCwd,
    tenantStore,
    tenantsFilePath,
    logger: serverLogger,
    titleGeneratorConfigs,
    onGuardrailModelConfigsUpdated: (next) => { guardrailModelConfigs = next; },
    onSystemPromptOverridesUpdated: (next) => { systemPromptRegistry.replaceOverrides(next); },
    // 凭据异步解析采用 fire-and-forget，并吞掉或记录 rejection，避免拖垮跨进程刷新。
    onWebToolsUpdated: (next) => { void applyWebToolsRuntimeUpdate(next).catch(() => undefined); },
    onSttUpdated: (next) => { void updateAudioTranscribeConfig(next).catch((error) => serverLogger.warn(`AudioTranscribe 运行时配置刷新失败：${error instanceof Error ? error.message : String(error)}`)); },
  });
  runPreflightService = initializeRuntimeGovernancePreflight({
    sessionCatalog,
    userStore,
    tenantStore,
    orgAgentStore,
    membershipStore, governanceChangeJobStore,
    entitlementStore,
    assignmentStore,
    credentialStore,
    connectorCatalogStore,
    environmentStore,
    agentResourceStore,
    skillGovernanceStore,
    governanceMigrationControlStore,
    governanceShadowComparator,
    runResolutionSnapshotStore,
    billingService,
    modelResolver,
  });
  // 用户活动聚合（2026-07-14 记忆轮询批次）：PG 后端可用；file backend 下
  // available=false，UserActivityList 工具不挂载、memory_poll 预检 fail-closed。
  const userActivityService = new UserActivityService({
    sessionProjection: pgSessionProjectionStore ?? null,
    eventStore: pgEventStore ?? null,
    logger: serverLogger.child('UserActivity'),
  });
  // ── L2 记忆整合 store（2026-07-29 记忆写入职责剥离批次）──────────
  // 先于 dispatch config 构造：MemoryCommand 与 L2/L3 用户级锁依赖它。
  // 仅 PG 后端可用；file 后端（单机开发形态）不启用整套 L2/v2 能力。
  if (config.runtimeEventStore?.backend === 'pg') {
    memoryConsolidationStore = new PgMemoryConsolidationStore({
      connectionString: config.runtimeEventStore.connectionString,
      tablePrefix: config.runtimeEventStore.tablePrefix ?? 'agent_runtime',
      logger: { warn: (msg) => serverLogger.warn(msg) },
    });
  }
  const resolveMemoryConsolidationConfig = (): MemoryConsolidationResolvedConfig => withMemoryConsolidationLeaseBuffer({
    ...MEMORY_CONSOLIDATION_DEFAULTS,
    enabled: config.memory?.consolidation?.enabled === true,
    ...Object.fromEntries(
      Object.entries(config.memory?.consolidation ?? {}).filter(([key, value]) => key !== 'enabled' && value !== undefined),
    ),
  } as MemoryConsolidationResolvedConfig);
  const getTenantMemoryFeatureStatus = (tenantId: string) => {
    let features;
    try {
      features = tenantStore?.getSettings(tenantId)?.features;
    } catch {
      features = undefined;
    }
    return resolveTenantMemoryFeatureStatus({
      features,
      platformPollingEnabled: config.memory?.polling?.enabled === true,
      pollingRuntimeAvailable: userActivityService.available,
      platformConsolidationEnabled: config.memory?.consolidation?.enabled === true,
      consolidationRuntimeAvailable: Boolean(
        memoryConsolidationStore && pgEventStore && pgSessionProjectionStore && userStore,
      ),
    });
  };

  const codexCredentialManager = new CodexCredentialManager({
    vault: secretVault, getConfig: () => config.codexSubscription,
    ...(pgEventStore ? { lock: new PgCodexCredentialLock(pgEventStore.pool) } : {}),
    fetchImpl: egressFetch,
  });
  const codexDeviceAuthService = new CodexDeviceAuthService(egressFetch);
  const titleModelAdapterFactory = createTitleModelAdapterFactory(codexCredentialManager, egressFetch);
  const memoryContextTools = createRuntimeMemoryContextTools({
    contextStore, assignments: assignmentStore, memberships: membershipStore, entitlements: entitlementStore, pool: pgEventStore?.pool, tablePrefix: config.runtimeEventStore?.backend === 'pg' ? config.runtimeEventStore.tablePrefix : undefined, recallIdSigningKey: config.auth?.jwtSecret, sessionCatalog, sourceAuthorizationRegistry: contextSourceAuthorizationRegistry,
    memoryStore: memoryConsolidationStore, memoryIndexService: memoryIndexServiceRef.current, logger: { info: msg => serverLogger.info(msg), warn: msg => serverLogger.warn(msg) },
  });
  const rawRuntimeConfig: RawRuntimeRunDispatchConfig = {
    agentCwd,
    sharedDir,
    modelAdapterFactory: (connection, providerOptions) => createModelAdapterForProtocol(
      connection,
      providerOptions,
      { codexCredentialManager, codexFetch: egressFetch, codexWebSocketPool },
    ),
    getSystemPrompt: (id) => systemPromptRegistry.get(id), refreshSharedConfig: () => { sharedConfigRefresher.refreshIfChanged(); rawRuntimeConfig.toolControls = config.toolControls; },
    agentRuntimeProfileResolver,
    ...(userActivityService.available ? { userActivityService } : {}),
    memory: {
      enabled: memoryEnabled && config.memory?.injectContext?.enabled !== false,
      maxLines: config.memory?.injectContext?.maxLines,
    },
    memoryIndexService: memoryIndexServiceRef.current,
    // 记忆写入职责剥离（2026-07-29）：租户开关决定新会话是否 pin v2。
    // 平台级 memory.consolidation.enabled 未开时全量 v1（后台没人接管写入，
    // 绝不能先剥离主 Agent 的写入能力）。
    memoryWriteDelegationEnabled: (tenantId) => tenantId
      ? getTenantMemoryFeatureStatus(tenantId).memoryWriteDelegationEnabled.effective
      : false,
    ...memoryContextTools, agentStore, orgAgentStore, tenantStore,
    environmentStore,
    taskboard: { service: () => taskboardService, generateTaskTitle: (description, identity) => createTaskboardTitleGenerator({ agentCwd, titleGeneratorConfigs, titleModelAdapterFactory, refreshSharedConfig: () => sharedConfigRefresher.refreshIfChanged(), getTitleSystemPrompt: () => systemPromptRegistry.get('utility.title'), tokenUsageStore, billingService })(description, identity), executionService: () => taskboardExecutionCoordinator, executionStore: () => taskboardStoreService, integrationPush: () => integrationV3Runtime?.integrationPush, resolveTrustedWorkspace: createTaskboardTrustedWorkspaceResolver(agentCwd), ...createTaskboardAttachmentAccess({ agentCwd, uploadManager, userStore }) },
    authorizeEnvironmentTemplate: async ({ tenantId, userId, agentId, templateId }) => {
      const effectiveAgentId = agentId
        ?? (await agentResourceStore?.findPersonalByOwner(tenantId, userId))?.agentId;
      const bindings = await assignmentStore!.listEffectiveResourceIds(
        tenantId, userId, 'environment_template', effectiveAgentId,
      );
      return bindings.some(binding => binding.resourceId === templateId);
    },
    resolveUserRole: ({ userId, username }: { userId?: string; username?: string }) => {
      const user = userId
        ? userStore?.findById(userId)
        : username
          ? userStore?.findByUsername(username)
          : undefined;
      return user?.role as 'admin' | 'user' | undefined;
    },
    // 「全部授权」是账户级服务端策略，不能依赖 Web 客户端逐条消息透传。
    // 老用户没有该字段时与前端默认值保持一致：默认开启；用户不存在则 fail-closed。
    resolveUserAutoApproveTools: ({ userId, username }: { userId?: string; username?: string }) => {
      const user = userId
        ? userStore?.findById(userId)
        : username
          ? userStore?.findByUsername(username)
          : undefined;
      if (!user) return undefined;
      return user.preferences?.authorizationModeEnabled ?? true;
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
    // 预 provision（2026-08-10，A 方案批次 2）：首跑建好 session record 后异步拉起
    // Sandbox。与「打开会话页」共用同一个 service，因此复用其 per-scope 节流，
    // 两条路径同时触发也只会真正发一次。
    sandboxWarmup: (sessionId: string) => sandboxWarmupService.fireForSession(sessionId),
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
    ...(agentDwsMessageStore ? { enqueueDwsBackgroundCompletion: createDwsBackgroundCompletionEnqueuer(agentDwsMessageStore) } : {}),
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
    ...(runPreflightService ? { runPreflightService } : {}),
    ...(runResolutionSnapshotStore ? { runResolutionSnapshotStore } : {}),
    ...(pgHandStore ? { handStore: pgHandStore } : {}),
    ...(pgToolInvocationStore ? { toolInvocationStore: pgToolInvocationStore } : {}),
    // /compact v2 自动压缩：在当前业务 run 的尾阶段内联执行；需要 PG runStore
    // 持久化 context pressure，并让压缩期间到达的用户消息继续作为 steering 排队。
    ...(pgRunStore && tenantStore ? {
      autoCompaction: new AutoCompactionService({
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
    // Web 工具统一交给代理规则分流；bypassDomains 强制直连，传输故障仍按 fail-open 降级。
    webFetchImpl: webToolEgressFetch,
    ...(resolvedImageGenTools ? { imageGenTools: resolvedImageGenTools } : {}),
    ...(resolvedSttRuntimeConfig.audioTranscribeConfig ? { audioTranscribeTools: resolvedSttRuntimeConfig.audioTranscribeConfig } : {}),
    // PG 直写按次计费事件；file backend 不配置时工具跳过扣费事件。
    ...(pgEventStore ? {
      appendPlatformEvent: (event, ctx) => appendTenantPlatformEvent(pgEventStore, event, ctx),
    } : {}),
    tenantRemoteHands: () => config.tenantRemoteHands?.hands,
    secretVault,
    tenantRemoteHandResolver,
    // Wake-time workspace provisioner — 修 P0 BUG #2（2026-06-21）。
    // PR 8 enqueue-only + scheduler wake 路径绕过了 engine/dispatch.ts 的
    // ensureUserWorkspace 调用，导致新 tenant / 新用户首跑 cwd 物理目录不存在
    // → hand-server spawn ENOENT。这里在 wake 时按 session.userId/username
    resolveConnectorRuntimeEnv: resolveRunScopedEnv,
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
  const validateToolSettingsConfig = async (settings: Pick<AppConfig, 'toolControls' | 'webTools'>): Promise<void> => { await resolveWebToolsConfig(settings.webTools, secretVault); };
  const applyWebToolsRuntimeUpdate = createWebToolsRuntimeUpdater({ target: rawRuntimeConfig, secretVault, logger: serverLogger });
  const updateToolSettingsConfig = createToolSettingsUpdater({ config, target: rawRuntimeConfig, applyWebTools: applyWebToolsRuntimeUpdate });
  const validateImageGenToolsConfig = async (imageGenTools: AppConfig['imageGenTools']): Promise<void> => { await resolveImageGenToolsConfig(imageGenTools, secretVault); };
  const updateImageGenToolsConfig = async (imageGenTools: AppConfig['imageGenTools']): Promise<void> => {
    config.imageGenTools = imageGenTools; const resolved = await resolveImageGenToolsConfig(imageGenTools, secretVault);
    if (resolved) rawRuntimeConfig.imageGenTools = resolved; else delete rawRuntimeConfig.imageGenTools;
  };
  const validateAudioTranscribeConfig = async (stt: AppConfig['stt']): Promise<void> => { await resolveSttRuntimeConfig(stt, secretVault); };
  const updateAudioTranscribeConfig = async (stt: AppConfig['stt']): Promise<void> => {
    config.stt = stt; const resolved = await resolveSttRuntimeConfig(stt, secretVault);
    if (resolved.audioTranscribeConfig) rawRuntimeConfig.audioTranscribeTools = resolved.audioTranscribeConfig;
    else delete rawRuntimeConfig.audioTranscribeTools;
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
    const next = createMemoryIndexService(
      processCwd,
      memoryIndex,
      { beginEmbeddingBillingRun: beginMemoryEmbeddingBillingRun },
    );
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
  if (pgRunStore) rawRuntimeConfig.backgroundTasks = new DurableBackgroundTaskService(rawRuntimeConfig);
  const baseRunDispatch = createRawRuntimeRunDispatch(rawRuntimeConfig), resumeApprovalDispatch = createRawApprovalResumeDispatch(rawRuntimeConfig);

  if (pgRunStore && pgEventStore) {
    runtimeSchedulerAutoWake = enableSchedulerWorker && (config.runtimeScheduler?.autoWake ?? true);
    const schedulerConfig = await runtimeSchedulerConfigStore!.get();
    const memoryPressureGuard = new MemoryPressureGuard({
      logger: serverLogger.child('MemoryPressureGuard'),
    });
    runtimeAdmissionGuard = memoryPressureGuard;
    runtimeScheduler = new RuntimeScheduler({
      runStore: pgRunStore,
      eventStore: pgEventStore,
      autoWake: runtimeSchedulerAutoWake,
      pollIntervalMs: config.runtimeScheduler?.pollIntervalMs,
      leaseMs: config.runtimeScheduler?.leaseMs,
      // dual 仍为每个 active session 占一条旧 advisory connection，迁移首版必须
      // 保持历史 4 槽；PG 中保存的是期望值，切到 lease 后自动解除迁移钳制。
      maxConcurrentRuns: effectiveMaxConcurrentRuns(
        schedulerConfig.maxConcurrentRuns,
        sessionLockMode,
      ),
      foregroundReservedRuns: config.runtimeScheduler?.foregroundReservedRuns ?? 10,
      executionEnabled: schedulerConfig.executionEnabled,
      resolveMaxConcurrentRuns: async () => effectiveMaxConcurrentRuns(
        (await runtimeSchedulerConfigStore!.get()).maxConcurrentRuns,
        sessionLockMode,
      ),
      resolveExecutionEnabled: isRuntimeExecutionEnabled,
      admissionGuard: memoryPressureGuard,
      approvalTimeoutMs: config.runtimeScheduler?.approvalTimeoutMs,
      canWake: sessionLock
        ? async (record) => {
          const lockHandle = await sessionLock.tryAcquire(record.sessionId);
          if (!lockHandle) return false;
          await lockHandle.release();
          return true;
        }
        : undefined,
      beforeTick: async () => {
        taskboardExecutionCoordinator?.wakeReconciliation();
        await rawRuntimeConfig.backgroundTasks!.reconcileWakeDeliveries();
        await governanceProjectionReconciler?.reconcileBatch();
      },
      failInterruptedBackgroundTask: (record) => rawRuntimeConfig.backgroundTasks!.failInterrupted(record),
      failBackgroundTask: (record, message) => rawRuntimeConfig.backgroundTasks!.fail(record, message),
      handoffBackgroundCommand: (record) => rawRuntimeConfig.backgroundTasks!.handoffCommandMonitor(record),
      wake: async (record, lease) => {
        const tenantId = record.tenantId ?? (record.userId ? userStore?.findById(record.userId)?.tenantId : undefined);
        const tenantAccessError = tenantAccessErrorMessage(tenantStore, tenantId);
        if (tenantAccessError) throw new Error(tenantAccessError);
        // claim/lease 后、模型调用前，用统一 evaluator 按最新
        // Membership/Entitlement/Policy/Assignment 复核。shadow 只记录 would-block，
        // enforce 下访问拒绝或治理依赖不可用均 fail closed。
        if (runPreflightService && runResolutionSnapshotStore && !isBackgroundTaskRun(record)) {
          try {
            const executionProviderId = typeof record.metadata?.executionProviderId === 'string'
              ? record.metadata.executionProviderId
              : record.executionTarget;
            const templateVersionId = typeof record.metadata?.environmentTemplateVersionId === 'string'
              ? record.metadata.environmentTemplateVersionId
              : undefined;
            const instanceId = typeof record.metadata?.handId === 'string'
              ? record.metadata.handId
              : undefined;
            const recipeDigest = typeof record.metadata?.recipeDigest === 'string'
              ? record.metadata.recipeDigest
              : undefined;
            const preflight = await runPreflightService.preflight({
              phase: 'wake',
              runId: record.runId,
              sessionId: record.sessionId,
              ...(record.userId ? { userId: record.userId } : {}),
              ...(tenantId ? { tenantId } : {}),
              ...(record.model ? { modelRef: record.model } : {}),
              ...(executionProviderId ? {
                environment: {
                  providerId: executionProviderId,
                  ...(templateVersionId ? { templateVersionId } : {}),
                  ...(instanceId ? { instanceId } : {}),
                  ...(recipeDigest ? { recipeDigest } : {}),
                },
              } : {}),
              // wake 回调下方仍由 legacy billing 权威计费门禁，避免 shadow 双结算。
              skipBilling: true,
            });
            // 最终 Snapshot 由 Raw Runtime 在 Environment Instance 解析后追加；
            // scheduler 此处只做 claim 后的最新权限复核。
            if (!preflight.proceed) {
              throw new Error(
                `[${preflight.accessDecision.reasonCode}] governance wake preflight blocked run ${record.runId}`,
              );
            }
            if (preflight.shadowWouldBlock) {
              serverLogger.warn(
                `[governance-shadow] wake preflight would block run=${record.runId} `
                + `access=${preflight.accessDecision.reasonCode} layer=${preflight.accessDecision.decisiveLayer} `
                + `blockers=${preflight.readiness.blockers.map(b => b.code).join(',') || 'none'}`,
              );
            }
          } catch (error) {
            const enforcing = await runPreflightService.enforcementMode()
              .then(mode => mode === 'enforce')
              .catch(() => true);
            if (enforcing) throw error;
            serverLogger.warn(
              `[governance-shadow] wake preflight unavailable (not blocking): run=${record.runId} `
              + `error=${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        // 普通 scheduler wake（Cron、审批恢复、后台结果交付）在这里按实际用量做启动门禁。
        // 后台任务包装 Run 本身不调模型：命令只监控 hand，Agent 由内部 child Run 独立检查。
        if (tenantId && billingService && !isBackgroundTaskRun(record)) {
          const allowed = await billingService.authorizeRun({
            tenantId,
            ...(record.userId ? { userId: record.userId } : {}),
            runId: record.runId,
          });
          if (!allowed.ok) throw new Error(`[${allowed.code}] ${allowed.reason}`);
        }
        const wakeRecord = taskboardExecutionCoordinator
          ? await taskboardExecutionCoordinator.prepareWake(record)
          : record;
        await wakeRuntimeSession(rawRuntimeConfig, wakeRecord, {
          lease,
          renewIntervalMs: config.runtimeScheduler?.renewIntervalMs,
          onOutboundEvent: async (event) => {
            const streamId = typeof record.metadata?.streamId === 'string' ? record.metadata.streamId : undefined;
            const clientMsgId = typeof record.metadata?.clientMsgId === 'string' ? record.metadata.clientMsgId : undefined;
            if (webRuntimeEventSink) {
              await webRuntimeEventSink({
                sessionId: record.sessionId,
                runId: record.runId,
                streamId,
                userId: record.userId,
                clientMsgId,
                event,
              });
              return;
            }
            await runtimeOutboundStreamRelay?.publish(event, {
              sessionId: record.sessionId,
              runId: record.runId,
              ...(tenantId ? { tenantId } : {}),
            });
          },
        });
      },
      logger: serverLogger.child('RuntimeScheduler'),
    });
    if (taskboardStoreService && defaultModelResolver) {
      taskboardExecutionCoordinator = new TaskboardExecutionCoordinator({ store: taskboardStoreService, scheduler: runtimeScheduler, runStore: pgRunStore, sessionCatalog,
        eventStore: pgEventStore, agentCwd, executionConfig, resolveDefaultModel: defaultModelResolver,
        ...createTaskboardRuntimeOptions({ modelResolver, userStore, timezone: config.server.timezone, logger: serverLogger, eventStore: pgEventStore, groupTaskboardSession: (input) => groupStore.addTaskboardSession(input), onSessionsChanged: clearSessionsListCache }),
        logger: serverLogger.child('TaskboardExecution') });
    }
    // Candidate v3 control-plane is retired. Existing Candidate rows are lazily
    // migrated into integration_agents; no Candidate worker is started here.
    runtimeSchedulerCapacity = createRuntimeSchedulerCapacityController({
      store: runtimeSchedulerConfigStore!, scheduler: runtimeScheduler, sessionLockMode,
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
      runtimeAuditQuery = new EventStoreRuntimeAuditQuery(findTranscriptPathByTenantAndSessionId);
    }
  } else {
    runtimeAuditQuery = new EventStoreRuntimeAuditQuery(findTranscriptPathByTenantAndSessionId);
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
    resolveConnectorRuntimeEnv: resolveRunScopedEnv,
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
      // resumeApprovalDispatch 内部会按原 Run 做实际用量门禁；这里仅负责恢复后的投影。
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

  // 旧 memory.maintenance hook 只包裹 Channel 直连 dispatch，PG Scheduler 主链从不经过，
  // 生产配置 enabled=true 反而制造“已启用”的假象。会话增量由 L2 durable consumer 负责，
  // 跨会话维护由 L3 memory_poll 负责；旧键仅保留一版配置兼容并明确告警。
  if (config.memory?.maintenance?.enabled === true) {
    serverLogger.warn('memory.maintenance is deprecated and ignored; use memory.consolidation + memory.polling');
  }
  const finalDispatch = billedRunDispatch;

  // Groups store：Web 与 Runtime Worker 共享文件，写操作必须锁内 reload→mutate→publish；
  // 读操作由 GroupStore 每次刷新，避免任一进程永久持有启动时旧快照。
  const groupsFilePath = resolve(processCwd, './data/groups.json');
  const groupsPgConfig = config.runtimeEventStore?.backend === 'pg'
    ? config.runtimeEventStore
    : undefined;
  const groupStore = new GroupStore(groupsFilePath, groupsPgConfig ? {
    withLock: <T>(operation: () => Promise<T>) => withPgAdvisoryLock(
      groupsPgConfig.connectionString,
      `${groupsPgConfig.tablePrefix ?? 'agent_saas'}:groups-store`,
      operation,
    ),
  } : {});
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

  runtimeWebPush.warnIfUnavailable();

  // Token usage 历史回填：首次启动时扫 ~/.agent-saas/legacy-transcripts 全量重建一次。
  // 异步触发，不阻塞启动；rebuild_state 表已有记录则自动跳过。
  if (businessDbHandle && enableSingletonWorkers) {
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
    enabled?: boolean;
    lookbackHours?: number;
    maxTurns?: number;
    timeoutSeconds?: number;
    model?: string;
    isExecutionEnabled?: (tenantId: string, userId: string) => boolean;
  } = {
    isExecutionEnabled: (tenantId, userId) => {
      try {
        const persistedPolling = loadAppConfig(processCwd).memory?.polling;
        if (persistedPolling?.enabled !== true || !userActivityService.available || !userStore || !tenantStore) {
          return false;
        }
        userStore.reload();
        tenantStore.reload();
        const currentUser = userStore.findById(userId);
        if (!currentUser || currentUser.disabled || currentUser.tenantId !== tenantId) return false;
        return tenantStore.getSettings(tenantId)?.features?.memoryPollingEnabled === true;
      } catch {
        return false;
      }
    },
  };
  const syncMemoryPollRuntimeConfig = (): void => {
    const polling = config.memory?.polling;
    memoryPollRuntimeConfig.enabled = polling?.enabled === true && userActivityService.available;
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
      runtimeEventStore: config.runtimeEventStore,
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
    ...(pgEventStore ? {
      onSessionGrouped: async (event: {
        sessionId: string;
        userId: string;
        groupId: string;
      }) => {
        const tenantId = userStore?.findById(event.userId)?.tenantId;
        if (!tenantId) throw new Error(`Cron session grouping tenant is missing for user ${event.userId}`);
        await pgEventStore.append({
          type: 'session_group_changed',
          sessionId: event.sessionId,
          userId: event.userId,
          groupId: event.groupId,
        }, { tenantId });
      },
    } : {}),
    userStore,
    tenantStore,
    tokenUsageStore,
    skillConfigStore,
    skillMaterialization: skillMaterializationService,
    tenantSkillsRootDir,
    userActivityService,
    memoryPoll: memoryPollRuntimeConfig,
    // L2 整合桥（2026-07-29 职责剥离批次）：L3 职责收敛 + 统一 PG commit lock
    // + tombstone 注入。store 不可用（file 后端）时不传，L3 保持 legacy 行为。
    ...(memoryConsolidationStore ? {
      memoryConsolidationBridge: {
        isTenantConsolidationEnabled: (tenantId: string | undefined) => tenantId
          ? getTenantMemoryFeatureStatus(tenantId).memoryConsolidationEnabled.effective
          : false,
        acquireCommitLock: (tenantId: string, userId: string, timeoutMs?: number) =>
          memoryConsolidationStore!.acquireCommitLock(tenantId, userId, timeoutMs),
        listForgottenSubjects: async (tenantId: string, userId: string) => {
          const tombstones = await memoryConsolidationStore!.listActiveTombstones(tenantId, userId);
          return tombstones
            .map((tombstone) => tombstone.subjectText)
            .filter((subject): subject is string => !!subject && subject.trim().length > 0);
        },
      },
    } : {}),
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
        runtimeWebPush.appendCronChannel(channels, notifyConfig);
        return channels;
      },
    }),
    // 单进程部署直接推送；拆分部署由 session_group_changed durable event
    // 经 PG NOTIFY 投到 ws-only 进程，且信号发生在分组成功落盘之后。
    onEvent: (event) => {
      if (event.type !== 'finished' || !event.sessionId || !event.owner) return;
      const webCh = channelManager.getChannel<WebChannel>('web');
      const eventBus = webCh?.getEventBus();
      const sessionUpdated = {
        type: 'session_updated',
        sessionId: event.sessionId,
        updatedAtMs: Date.now(),
        preview: event.output,
        isNew: true,
      };
      if (eventBus) {
        eventBus.emitDual(event.owner, event.sessionId, sessionUpdated);
        eventBus.emitUser(event.owner, { type: 'groups_changed' });
      } else {
        // fallback: 旧路径
        const wsServer = webCh?.getWsServer();
        wsServer?.broadcastToUser(event.owner, sessionUpdated);
        wsServer?.broadcastToUser(event.owner, { type: 'groups_changed' });
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
  // 仅 processRole=all/runtime-worker 执行（ws-only/scheduler-only 不动 cron store）；
  // 平台开关 config.memory.polling.enabled 关闭时也跑对账——负责把存量系统任务禁用。
  // ── L2 记忆整合引擎（2026-07-29）：随 cron leadership 启停（蓝绿单实例）──
  if (enableSingletonWorkers && pgEventStore && pgSessionProjectionStore && memoryConsolidationStore && userStore) {
    const consolidationLogger = serverLogger.child('MemoryConsolidation');
    const engineUserStore = userStore;
    memoryConsolidationEngine = new MemoryConsolidationEngine({
      store: memoryConsolidationStore,
      eventStore: pgEventStore,
      projectionStore: pgSessionProjectionStore,
      userStore: {
        findById: (id) => {
          const user = engineUserStore.findById(id);
          return user
            ? { id: user.id, username: user.username, role: user.role, tenantId: user.tenantId, disabled: user.disabled }
            : undefined;
        },
      },
      isTenantEnabled: (tenantId) =>
        getTenantMemoryFeatureStatus(tenantId).memoryConsolidationEnabled.effective,
      dispatch: billedRunDispatch,
      agentCwd,
      getConfig: resolveMemoryConsolidationConfig,
      logger: {
        info: (msg) => consolidationLogger.info(msg),
        warn: (msg) => consolidationLogger.warn(msg),
      },
    });
  }

  let cronLeadership: CronLeadership | undefined;
  let memoryPollReconcileTimer: ReturnType<typeof setInterval> | undefined;
  let memoryPollConfigRefreshTimer: ReturnType<typeof setInterval> | undefined;
  let runMemoryPollReconcile: (() => Promise<void>) | undefined;
  let refreshMemoryPollConfigFromDisk: (() => Promise<void>) | undefined;
  let memoryPollReconcileQueue: Promise<void> = Promise.resolve();
  let memoryPollLeadershipGeneration = 0;
  let memoryPollConfigFingerprint = JSON.stringify(config.memory?.polling ?? null);
  if (enableSingletonWorkers && cronRuntime.service) {
    const cronService = cronRuntime.service;
    if (userStore) {
      const reconcileMemoryPollOnce = async (expectedGeneration: number): Promise<void> => {
        try {
          if (!cronLeadership?.isLeader() || expectedGeneration !== memoryPollLeadershipGeneration) return;
          tenantStore?.reload();
          userStore.reload();
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
            if (!cronLeadership?.isLeader() || expectedGeneration !== memoryPollLeadershipGeneration) return;
            await cronService.applySystemJobs(plan, {
              fence: () => cronLeadership?.isLeader() === true
                && expectedGeneration === memoryPollLeadershipGeneration,
            });
            serverLogger.info(
              `Memory poll reconcile: eligible=${plan.stats.eligibleUsers} created=${plan.stats.created} enabled=${plan.stats.enabled} disabled=${plan.stats.disabled} dupDisabled=${plan.stats.duplicatesDisabled} rescheduled=${plan.stats.rescheduled}`,
            );
          }
        } catch (err) {
          serverLogger.warn(`Memory poll reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      };
      runMemoryPollReconcile = (): Promise<void> => {
        const expectedGeneration = memoryPollLeadershipGeneration;
        const execute = () => reconcileMemoryPollOnce(expectedGeneration);
        const queued = memoryPollReconcileQueue.then(execute, execute);
        memoryPollReconcileQueue = queued.catch(() => {});
        return queued;
      };
      refreshMemoryPollConfigFromDisk = async (): Promise<void> => {
        if (!cronLeadership?.isLeader()) return;
        try {
          const persistedPolling = loadAppConfig(processCwd).memory?.polling;
          const fingerprint = JSON.stringify(persistedPolling ?? null);
          if (fingerprint !== memoryPollConfigFingerprint) {
            memoryPollConfigFingerprint = fingerprint;
            config.memory = {
              ...(config.memory ?? {}),
              polling: persistedPolling,
            };
            syncMemoryPollRuntimeConfig();
          }
          // Reconcile even when the config fingerprint is unchanged: this is
          // the bounded repair path for a former leader whose commit raced a
          // leadership handoff after its last in-memory fence check.
          await runMemoryPollReconcile?.();
        } catch (err) {
          serverLogger.warn(`Memory poll config refresh failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      };
    }
    cronLeadership = new CronLeadership({
      connectionString: config.runtimeEventStore?.backend === 'pg' ? config.runtimeEventStore.connectionString : undefined,
      // tablePrefix 参与锁名：共库多环境（CI/dev 指同一 PG）不互相抢锁
      lockName: `${config.runtimeEventStore?.backend === 'pg' ? (config.runtimeEventStore.tablePrefix ?? 'agent_saas') : 'agent_saas'}:cron-leader`,
      onAcquired: async () => {
        memoryPollLeadershipGeneration += 1;
        await cronService.start();
        if (memoryConsolidationEngine) {
          await memoryConsolidationEngine.start().catch((err) => {
            serverLogger.warn(`MemoryConsolidationEngine start failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
        await refreshMemoryPollConfigFromDisk?.();
        if (runMemoryPollReconcile) {
          void runMemoryPollReconcile();
          if (!memoryPollReconcileTimer) {
            memoryPollReconcileTimer = setInterval(() => { void runMemoryPollReconcile!(); }, 6 * 3600_000);
            memoryPollReconcileTimer.unref?.();
          }
        }
        if (refreshMemoryPollConfigFromDisk && !memoryPollConfigRefreshTimer) {
          memoryPollConfigRefreshTimer = setInterval(() => {
            void refreshMemoryPollConfigFromDisk!();
          }, 5_000);
          memoryPollConfigRefreshTimer.unref?.();
        }
      },
      onLost: (reason) => {
        memoryPollLeadershipGeneration += 1;
        serverLogger.warn(`Cron leadership lost (${reason}); stopping local cron scheduling`);
        cronService.stop();
        memoryConsolidationEngine?.stop();
        if (memoryPollReconcileTimer) {
          clearInterval(memoryPollReconcileTimer);
          memoryPollReconcileTimer = undefined;
        }
        if (memoryPollConfigRefreshTimer) {
          clearInterval(memoryPollConfigRefreshTimer);
          memoryPollConfigRefreshTimer = undefined;
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
    memoryPollConfigFingerprint = JSON.stringify(polling);
    syncMemoryPollRuntimeConfig();
    if (cronLeadership?.isLeader()) {
      await runMemoryPollReconcile?.();
    }
  };

  // SIGUSR2 drain 序列（见 AppRuntime.beginRuntimeDrain 注释；index.ts 调用）
  let runtimeDrainStarted = false;
  const beginRuntimeDrain = async (): Promise<void> => {
    if (runtimeDrainStarted) return;
    runtimeDrainStarted = true; taskboardStatusNotificationWorker?.stop();
    await integrationV3Runtime?.stop();
    tenantLifecycleWatcher?.stop();
    memoryPollLeadershipGeneration += 1;
    // 1. 停止定时采样并取消在途 du。否则旧 Worker 在等待 run 安全交棒时仍会
    //    继续扫描 NAS；若随后 OOM 重启，还会从头派生新一轮 du。
    systemMetricsCollector?.stop();
    // 2. 停 reconcile 定时器
    if (memoryPollReconcileTimer) {
      clearInterval(memoryPollReconcileTimer);
      memoryPollReconcileTimer = undefined;
    }
    if (memoryPollConfigRefreshTimer) {
      clearInterval(memoryPollConfigRefreshTimer);
      memoryPollConfigRefreshTimer = undefined;
    }
    // 技能物化先停止 claim，并等待当前目录原子提交完成，再释放 leader。
    await skillMaterializationService?.stop();
    await skillMaterializationLeadership?.stop();
    // 3. 停 cron 触发（不打断执行中的 cron job）
    cronRuntime.service?.stop();
    // 4. 等 in-flight cron job 结清后再释放 leadership：新 leader 从 jobs.json
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
    // 5. 释放 leadership → 新实例在一个重试周期（≤15s）内接管 cron
    await cronLeadership?.stop();
    // 6. 先停任务看板恢复周期，避免 drain 期间继续 enqueue；再停 scheduler，
    //    不再 claim 新 run 并等 in-flight run 结清（两者 stop 均幂等）。
    await taskboardExecutionCoordinator?.stop();
    await runtimeScheduler?.stop();
  };

  if (enableSingletonWorkers) {
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
  }
  const webChannel = new WebChannel({
    timezone: config.server.timezone,
    displayConfig: config.messageDisplay?.web,
    agentCwd,
    sharedDir,
    loginLogFilePath: resolve(processCwd, './data/login-logs.jsonl'),
    modelResolver,
    userStore,
    titleGeneratorConfigs, titleModelAdapterFactory,
    refreshSharedConfig: sharedConfigRefresher.refreshIfChanged,
    getTitleSystemPrompt: () => systemPromptRegistry.get('utility.title'),
    sttConfig: resolvedSttRuntimeConfig.sttConfig,
    ...(config.auth?.enabled ? { authEnabled: true, jwtSecret: config.auth.jwtSecret } : { authEnabled: false }),
    userOverrides: config.agent.userOverrides,
    getIsDraining: () => channelManager.draining,
    uploadManager,
    tokenUsageStore,
    billingService: () => billingService,
    tenantStore,
    allowedOrigins: config.server.corsOrigins,
    // 专职 Agent + LLM 话题门禁（2026-07 唯恩批次）。getGuardrailModelConfigs
    // 必须是 getter：热更后 channel 每次调用都取到最新链。guardrailEventStore
    // 仅 PG backend 存在，file backend 降级 log。
    orgAgentStore,
    getGuardrailModelConfigs: () => guardrailModelConfigs,
    guardrailEventStore,
    sessionReadStateStore: sessionReadStateStore!,
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
    runtimeEventStoreSupportsPathless: Boolean(pgEventStore),
    memoryWriteDelegationEnabled: (tenantId) => tenantId
      ? getTenantMemoryFeatureStatus(tenantId).memoryWriteDelegationEnabled.effective
      : false,
    ...(runtimeScheduler && pgRunStore ? {
      enqueueRuntime: {
        scheduler: runtimeScheduler,
        runStore: pgRunStore,
        sessionCatalog,
        ...(pgToolInvocationStore ? { toolInvocationStore: pgToolInvocationStore } : {}),
        enabled: true,
      },
    } : {}),
    ...(runPreflightService ? { runPreflight: runPreflightService } : {}),
  }, finalDispatch);
  if (tenantStore) {
    tenantLifecycleWatcher = new TenantLifecycleWatcher({
      tenantStore,
      onChange: change => applyTenantLifecycleChange(change, {
        tenantStore,
        webChannel: enableHttpListeners ? webChannel : undefined,
        runStore: pgRunStore,
      }).then(() => undefined),
      logger: { warn: message => serverLogger.warn(message) },
    });
    tenantLifecycleWatcher.start();
  }
  // 同进程 stream bridge 只在持有 WS listener 的进程上有意义：'all' 模式由 scheduler 直接
  // 推到本地 WebChannel，scheduler-only 模式下根本没有 WS 客户端，bridge 是结构性 noop。
  // 让 scheduler.wake 的 onOutboundEvent 回调自动跳过（line 826 已 `?.()` 守卫），避免
  // scheduler-only 进程刷出大量 "Runtime outbound event dropped before WebChannel start"
  // 误报。生产投递走 PG NOTIFY → ws-only 进程订阅 publishRuntimePlatformEvent 路径。
  if (enableHttpListeners) {
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
    runtimeEventSubscriptionShutdown = await pgEventStore.subscribeAppended(async (event) => {
      await taskboardExecutionCoordinator?.handleRuntimeEvent(event).catch((err) => {
        serverLogger.warn(
          `Taskboard runtime event projection failed: event=${event.type} error=${err instanceof Error ? err.message : String(err)}`,
        );
      });
      if (event.type !== 'tenant_lifecycle_changed') await runtimeWebPush.deliverRuntimeEvent(event);
      if (event.type === 'tenant_lifecycle_changed') {
        await applyTenantLifecycleChange(event, {
          tenantStore,
          webChannel: enableHttpListeners ? webChannel : undefined,
          runStore: pgRunStore,
        }).then((result) => {
          if (event.disabled) {
            serverLogger.info(
              `Tenant suspension applied from event bridge: tenant=${event.tenantId} local=${result.abortedLocalRuns} durable=${result.cancelledDurableRuns}`,
            );
          }
        }).catch((error) => {
          serverLogger.error(
            `Tenant lifecycle event bridge failed: tenant=${event.tenantId} error=${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
      if (event.type === 'tool_invocation_cancel_requested' && enableSchedulerWorker) {
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
      // 2026-08-04 P0：web 进程 handleAbortAsync 里的 runtimeRunController.abort 是进程内注册表，
      // Web/Worker 解耦后摸不到 worker 进程里正在跑的 run（实证 fc3bf95a：cancel 后 run 继续跑
      // 4 分钟到自然 success）。run_cancel_requested 是 durable 广播事件，所有进程在此消费并
      // abort 本进程注册表中的同 runId（不存在则 no-op），使停止按钮跨进程生效。模型请求飞行中
      // 没有 running tool invocation，上面的分支不会触发，本分支是该窗口的唯一取消通道。
      if (event.type === 'run_cancel_requested' && event.runId) {
        const aborted = runtimeRunController.abort(event.runId, event.reason ?? 'run_cancel_requested');
        if (aborted) {
          serverLogger.info(`Run cancel delivered via event bridge: run=${event.runId} reason=${event.reason ?? 'run_cancel_requested'}`);
        }
      }
      if (event.type === 'run_finished' || event.type === 'run_started') {
        // L2 记忆整合低延迟唤醒；正确性不依赖此调用（durable cursor 扫描兜底）
        memoryConsolidationEngine?.wake();
      }
      if (enableHttpListeners && event.type !== 'tenant_lifecycle_changed') {
        webChannel.publishRuntimePlatformEvent(event);
      }
    });
    if (enableSchedulerWorker) {
      await runCancelDeliveryScan().catch((err) => {
        serverLogger.warn(`Tool cancel delivery startup scan failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      cancelDeliveryRetryTimer = setInterval(() => {
        void runCancelDeliveryScan().catch((err) => {
          serverLogger.warn(`Tool cancel delivery retry scan failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }, 5_000);
      cancelDeliveryRetryTimer.unref?.();
    }
    serverLogger.info('Runtime EventStore live bridge initialized: backend=pg listen/notify; terminal outbox recovery started');
  }
  if (runtimeScheduler && enableSchedulerWorker) {
    await runtimeScheduler.start();
    serverLogger.info(`RuntimeScheduler started: autoWake=${runtimeSchedulerAutoWake ? 'true' : 'false'}`);
  } else if (runtimeScheduler) {
    serverLogger.info(`RuntimeScheduler worker disabled for processRole=${processRole}; durable enqueue remains enabled`);
  }

  const connectorAcsConfigured = hasAcsConnector(config.tenantRemoteHands?.hands);
  const resolveConnectorServerRemote = createConnectorServerRemoteResolver({
    defaultRemote: resolvedServerRemote,
    eligibleHands: user => selectTenantRemoteHandsForRegistration(config.tenantRemoteHands?.hands, {
      userId: user.id, username: user.username, userTenantId: user.tenantId,
    }),
    resolveHand: hand => tenantRemoteHandResolver.resolveForRegister(hand),
  });

  if (notionAuthSessionStore && userStore && (resolvedServerRemote || connectorAcsConfigured)) {
    notionAuthFlowService = new NotionAuthFlowService({
      authSessionStore: notionAuthSessionStore,
      runner: new NotionDeviceLoginRunner({
        agentCwd,
        resolveServerRemote: resolveConnectorServerRemote,
      }),
      onCredential: async (connectedUser, token) => {
        const currentUser = userStore.findById(connectedUser.id);
        if (
          !currentUser
          || currentUser.disabled
          || currentUser.username !== connectedUser.username
          || currentUser.tenantId !== connectedUser.tenantId
        ) {
          throw new Error('Notion 授权用户已失效');
        }
        await connectNotionCredential({
          connectionStore: connectorConnectionStore,
          vault: secretVault,
          username: connectedUser.username,
          userId: connectedUser.id,
          tenantId: connectedUser.tenantId,
          token,
          fetchImpl: egressFetch,
        });
      },
      logger: serverLogger.child('NotionAuthFlow'),
    });
  } else if (userStore) {
    serverLogger.warn('Notion auth flow unavailable: PG auth store or connector execution remote is not configured');
  }

  if (dwsConnectionStore && userStore && (resolvedServerRemote || connectorAcsConfigured)) {
    dwsAuthKeepaliveService = new DwsAuthKeepaliveService({
      agentCwd,
      userStore,
      connectionStore: dwsConnectionStore,
      runner: new DwsAuthStatusRunner({ agentCwd, resolveServerRemote: resolveConnectorServerRemote }),
      logger: serverLogger.child('DwsKeepalive'),
      isExecutionEnabled: isRuntimeExecutionEnabled,
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
            await skillConfigStore.setUserSkillSelected(connectedUser.username, 'dws', true);
          }
          await dwsAuthKeepaliveService?.runOnce();
        },
        logger: serverLogger.child('DwsAuthFlow'),
      });
    }
  } else if (userStore) {
    serverLogger.warn('DWS auth keepalive unavailable: PG connection store or DWS execution remote is not configured');
  }

  if (agentDwsAccountStore) agentDwsRuntime = await createAgentDwsRuntime({
    agentCwd, accountStore: agentDwsAccountStore, assignmentStore, contextStore, messageStore: agentDwsMessageStore, pgEventStore, pgRunStore,
    tablePrefix: config.runtimeEventStore?.backend === 'pg' ? config.runtimeEventStore.tablePrefix ?? 'agent_runtime' : 'agent_runtime', dispatch: finalDispatch, resolveDefaultModel: tenantId => defaultModelResolver?.(tenantId) ?? null,
    resolveServerRemote: resolveConnectorServerRemote, remoteAvailable: Boolean(resolvedServerRemote || connectorAcsConfigured),
    enableWorker: enableSchedulerWorker, isExecutionEnabled: isRuntimeExecutionEnabled, logger: serverLogger,
  });

  if (feishuConnectionStore && userStore && resolvedFeishuConnector && feishuConnectorScopes) {
    feishuTokenBroker = new FeishuTokenBroker({
      oauth: new FeishuOAuthClient({
        appId: resolvedFeishuConnector.appId,
        appSecret: resolvedFeishuConnector.appSecret,
        fetchImpl: egressFetch,
      }),
      vault: secretVault,
      connectionStore: feishuConnectionStore,
      scope: feishuConnectorScopes,
      profileId: 'kaiyan-agent',
      onError: error => serverLogger.warn(`Feishu Token Broker maintenance failed: ${error.message}`),
    });
    feishuAuthKeepaliveService = new FeishuAuthKeepaliveService({
      userStore,
      connectionStore: feishuConnectionStore,
      runner: new FeishuTokenBrokerStatusRunner(feishuTokenBroker),
      logger: serverLogger.child('FeishuKeepalive'),
      isExecutionEnabled: isRuntimeExecutionEnabled,
    });
    if (enableSchedulerWorker) {
      feishuAuthKeepaliveService.start();
    } else {
      serverLogger.info(`Feishu auth keepalive worker disabled for processRole=${processRole}; status API remains available`);
    }
    if (feishuAuthSessionStore) {
      const legacyFeishuLogoutRunner = new FeishuDeviceLoginRunner({
        agentCwd,
        appId: resolvedFeishuConnector.appId,
        appSecret: resolvedFeishuConnector.appSecret,
        resolveServerRemote: resolveConnectorServerRemote,
      });
      feishuAuthFlowService = new FeishuAuthFlowService({
        authSessionStore: feishuAuthSessionStore,
        connectionStore: feishuConnectionStore,
        runner: new FeishuTokenBrokerLoginRunner(feishuTokenBroker, {
          legacyLogout: (user, profileIds) => legacyFeishuLogoutRunner.logout(user, profileIds),
        }),
        onConnected: async (connectedUser) => {
          if (
            skillConfigStore
            && skillConfigStore.isTenantSkillAvailableToUser('feishu', connectedUser.tenantId, connectedUser.username)
          ) {
            await skillConfigStore.setUserSkillSelected(connectedUser.username, 'feishu', true);
          }
          await feishuAuthKeepaliveService?.runOnce();
        },
        logger: serverLogger.child('FeishuAuthFlow'),
      });
    }
  } else if (userStore) {
    serverLogger.warn('Feishu Token Broker unavailable: PG store, app credentials, or business scopes are not configured');
  }

  // Hand lease 老化不能与主动恢复共用开关：事故止血关闭 scanner 时，janitor 仍须运行。
  if (enableSingletonWorkers && pgHandStore) {
    handLeaseJanitor = new HandLeaseJanitor({
      handStore: pgHandStore,
      logger: serverLogger.child('HandLeaseJanitor'),
    });
    handLeaseJanitor.start();
  }
  // B4: 仅恢复关联 active run 的 Server-remote Hand；历史会话由下一条真实消息按需复活。
  if (enableSingletonWorkers && pgHandStore && pgEventStore && config.runtimeHandHealthScanner?.enabled !== false) {
    handHealthScanner = createHandHealthScanner({
      config: config.runtimeHandHealthScanner,
      handStore: pgHandStore,
      eventStore: pgEventStore,
      resolveHandAuthToken: (hand) => tenantRemoteHandResolver.resolveForHand(hand),
      defaultServerRemoteAuthToken: resolvedServerRemote?.authToken,
      logger: serverLogger.child('HandHealth'),
      isExecutionEnabled: isRuntimeExecutionEnabled,
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

  const performanceScheduler = runtimeScheduler;
  const performanceRunStore = pgRunStore;
  const runtimePerformanceSnapshot = performanceScheduler && performanceRunStore
    ? async (): Promise<RuntimePerformanceWorkloadSnapshot> => ({
        scheduler: performanceScheduler.getPerformanceSnapshot(),
        activeRuns: await performanceRunStore.getActiveCounts(),
        ...(runtimeAdmissionGuard ? { admission: runtimeAdmissionGuard.getSnapshot() } : {}),
      })
    : undefined;

  return {
    config,
    processRole,
    processCwd,
    sessionBasePath,
    agentCwd,
    sandboxWarmupService,
    sharedDir,
    tenantSkillsRootDir,
    uploadsDir,
    uploadManager, sessionCatalog,
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
    codexCredentialManager,
    codexDeviceAuthService,
    codexWebSocketShutdown: () => codexWebSocketPool.close(),
    userStore,
    dwsConnectionStore,
    dwsAuthFlowService,
    agentDwsAccountStore,
    agentDwsMessageStore,
    agentDwsAuthFlowService: agentDwsRuntime?.authFlowService, agentDwsMessageRouter: agentDwsRuntime?.messageRouter,
    dwsPersonalEventGateway: agentDwsRuntime?.eventGateway, agentDwsContextPolicyUpdated: agentDwsRuntime?.onContextPolicyUpdated,
    agentDwsEnabledChanged: agentDwsRuntime?.onEnabledChanged, notionAuthFlowService,
    getNotionConnection,
    disconnectNotionConnection,
    googleWorkspaceOAuthService,
    notionAuthFlowShutdown: notionAuthFlowService ? () => notionAuthFlowService?.stop() : undefined,
    contextPlaneShutdown: contextPlanePhase2Runtime ? () => contextPlanePhase2Runtime!.stop() : undefined,
    dwsAuthKeepaliveShutdown: dwsAuthKeepaliveService || dwsAuthFlowService || agentDwsRuntime
      ? async () => {
          dwsAuthFlowService?.stop();
          dwsAuthKeepaliveService?.stop();
          await agentDwsRuntime?.stop();
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
    getTenantMemoryFeatureStatus,
    agentStore,
    skillConfigStore,
    mcpConfigStore,
    connectorConnectionStore,
    aliyunConnectorService,
    mcpOAuthService,
    signupConfigStore,
    egressConfigStore,
    refreshEgressProxyCredential,
    groupStore,
    authMiddleware,
    titleGeneratorConfigs, titleModelAdapterFactory,
    refreshSharedConfig: sharedConfigRefresher.refreshIfChanged,
    orgAgentStore,
    validateOrgAgentDispatcherRuntime: createOrgAgentDispatcherRuntimeValidator({ backgroundTasks: rawRuntimeConfig.backgroundTasks, profileResolver: rawRuntimeConfig.agentRuntimeProfileResolver, defaultModelResolver, modelResolver }),
    guardrailEventStore,
    messageFeedbackStore,
    appealStore,
    taskboardService,
    taskboardExecutionService: taskboardExecutionCoordinator,
    integrationV3WorkerShutdown: integrationV3Runtime ? () => integrationV3Runtime.stop() : undefined,
    getIntegrationV3Health: createRuntimeIntegrationV3HealthProvider(config.integrationV3ControlPlane?.enabled === true, rawTaskboardStore, () => integrationV3Runtime?.health(), processRole),
    requeueIntegrationV3Candidate: rawTaskboardStore ? createIntegrationV3RequeueHandler(rawTaskboardStore) : undefined,
    getGuardrailModelConfigs: () => guardrailModelConfigs,
    updateGuardrailModelConfigs: (next: GuardrailModelConfig[]) => { guardrailModelConfigs = next; },
    agentOptionsConfig,
    tokenUsageStore,
    webPushService: runtimeWebPush.service,
    billingService,
    governanceAuditStore,
    membershipStore,
    entitlementStore,
    directoryGroupStore,
    oauthGrantStore,
    assignmentStore, contextStore, contextSourceAuthorizationRegistry, derivedContextStore, credentialStore, connectorCatalogStore,
    environmentStore,
    agentResourceStore,
    skillGovernanceStore,
    governanceChangeJobStore, governanceChangePlanner, governanceMigrationControlStore,
    governanceWriteGate, governanceShadowComparator, contentAccessGrantStore,
    governanceProjectionOutboxStore, governanceProjectionReconciler,
    resourceReferenceStore,
    credentialBroker,
    flushGovernanceShadowProjections,
    runtimeAuditQuery,
    runtimeRunStore: pgRunStore,
    runtimeSchedulerCapacity,
    runtimePerformanceSnapshot,
    runtimeSessionProjectionStore: pgSessionProjectionStore,
    sessionReadStateStore: sessionReadStateStore!,
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
    validateAudioTranscribeConfig, updateAudioTranscribeConfig,
    updateMemoryIndexConfig,
    updateMemoryPollingConfig,
    systemPromptRegistry,
    agentRuntimeProfileStore,
    connectorDictionaryStore,
    artifactService,
    artifactShareService,
    artifactShareStore,
    sessionShareStore,
    artifactShutdown,
    clientDaemonGateway,
    runtimeEventStoreFor,
    skillMaterialization: skillMaterializationService,
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
    startSkillMaterializationCoordinator: () => {
      skillMaterializationLeadership?.start();
    },
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
