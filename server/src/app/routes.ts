import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import express from "express";
import type { Express, Request, Response } from "express";

import type { AppRuntime } from "./runtime.js";
import type { TenantStore } from "../data/tenants/store.js";
import type { UserInfo } from "../data/users/types.js";
import {
  getPublicModelList,
  getUserPublicModelList,
  resolveContextAccountingFromModels,
} from "./models.js";
import { applyModelsHotUpdate } from "./modelsHotUpdate.js";
import { DEFAULT_TENANT_ID } from "../data/tenants/types.js";
import { enforcePlatformWritePolicy } from "../auth/platformGovernance.js";

import {
  createHealthRouter,
  createUploadRouter,
  createCronRouter,
  createTaskboardRouter,
  createSessionsRouter,
  createTtsRouter,
  createGroupsRouter,
  createFileRouter,
  createVoiceRouter,
  createPreviewRoutes,
  createAppUpdateRouter,
  createUsageRouter,
  createArtifactsRouter,
  createSearchRouter,
  createScenariosRouter,
  createContentOpsRouter,
  createDwsRouter,
  createFeishuRouter,
} from "../routes/index.js";
import { createAuthRouter } from "../routes/auth.js";
import { createSignupRouters } from "../routes/signup.js";
import { requireAdmin } from "../auth/middleware.js";
import { createAgentsRouter } from "../routes/agents.js";
import { createOrgAgentsRouter } from "../routes/orgAgents.js";
import { createKbFilesRouter } from "../routes/kbFiles.js";
import { createOrgQaRouter } from "../routes/orgQa.js";
import { createFeedbackRouter } from "../routes/feedback.js";
import { createAppealsRouter, createTenantAppealsRouter } from "../routes/appeals.js";
import { createRuntimeAuditRouter } from "../routes/runtimeAudit.js";
import { createRuntimeTraceRouter } from "../routes/runtimeTrace.js";
import { createPlatformObservabilityRouter } from "../routes/platformObservability.js";
import { createSystemAdminRouter } from "../routes/systemAdmin.js";
import { createInternalAcsAlertsRouter } from "../routes/internalAcsAlerts.js";
import { RuntimeEfficiencyQuery } from "../runtime/efficiencyQuery.js";
import { createSkillsRouter } from "../routes/skills.js";
import { createGovernanceMigrationRouter } from '../routes/governanceMigration.js';
import { createGovernanceResourcesRouter } from '../routes/governanceResources.js';
import { createGovernanceAccessRouter } from '../routes/governanceAccess.js';
import { createGovernanceUiRouter } from '../routes/governanceUi.js';
import { createMcpRouter } from "../routes/mcp.js";
import { createConnectorsRouter } from "../routes/connectors.js";
import { createNotionRouter } from "../routes/notion.js";
import { createGoogleWorkspaceRouter } from "../routes/googleWorkspace.js";
import { revokeAllUserConnectorCredentials } from "../connectors/lifecycle.js";
import { runtimeRunController } from "../runtime/runController.js";
import { createTenantsRouter } from "../routes/tenants.js";
import { deleteTenantResources } from "../data/tenants/cleanup.js";
import { GovernanceTenantCleanup, type TenantCleanupDomain } from '../data/changeJobs/index.js';
import { createGovernanceOffboardingExecutor, type ExecuteUserOffboarding } from './governanceOffboarding.js';
import { createModelsAdminRouter } from "../routes/modelsAdmin.js";
import { createCodexSubscriptionAdminRouter } from "../routes/codexSubscriptionAdmin.js";
import { createTenantRemoteHandsAdminRouter } from "../routes/tenantRemoteHandsAdmin.js";
import { createRuntimeOperationsAdminRouter } from "../routes/runtimeOperationsAdmin.js";
import { createToolControlsAdminRouter } from "../routes/toolControlsAdmin.js";
import { createConnectorDictionaryAdminRouter } from "../routes/connectorDictionaryAdmin.js";
import { createConnectorDictionaryOrgRouter } from "../routes/connectorDictionaryOrg.js";
import { createImageGenPricingAdminRouter } from "../routes/imageGenPricingAdmin.js";
import { createEgressConfigAdminRouter } from "../routes/egressConfigAdmin.js";
import { createMemoryPollingAdminRouter } from "../routes/memoryPollingAdmin.js";
import { createSystemPromptsAdminRouter } from "../routes/systemPromptsAdmin.js";
import { createAgentRuntimeProfilesAdminRouter } from "../routes/agentRuntimeProfilesAdmin.js";
import { createAdminBillingRouter, createBillingRouter } from "../routes/billing.js";
import { createAzerothProxyRouter } from "../routes/azeroth-proxy.js";
import { createDingtalkSessionRouter } from "../channels/dingtalk/protocol/sessionRouter.js";
import type { WebChannel } from "../channels/web/channel.js";
import { initAuditLog, redactLegacyChatPreviewsInFile } from "../data/login-logs/index.js";
import { configureModelPricing } from "../data/usage/pricing.js";
import { configureImageGenPricing } from "../data/usage/imageGenPricing.js";

function tenantFeatureGuard(
  tenantStore: TenantStore | undefined,
  feature:
    | "filesEnabled"
    | "cronEnabled"
    | "mcpEnabled"
    | "customSkillsEnabled"
    | "kbEnabled",
  label: string,
) {
  return (req: Request, res: Response, next: express.NextFunction): void => {
    if (!tenantStore || !req.user?.tenantId) {
      next();
      return;
    }
    const settings = tenantStore.getSettings(req.user.tenantId);
    if (settings && settings.features[feature] === false) {
      res.status(403).json({
        error: `${label} 已被当前组织禁用`,
        code: "TENANT_FEATURE_DISABLED",
      });
      return;
    }
    next();
  };
}

export function registerRoutes(app: Express, runtime: AppRuntime): void {
  // 路由约定:
  // - 通道消息入口路由（如 /api/chat、/api/dingtalk/webhook）由各 Channel.start() 注册
  // - 控制面/查询类路由由 app 统一注册

  // 兼容原权限治理挂载点；平台管理员现已统一为完整权限。
  app.use("/api", enforcePlatformWritePolicy);
  const {
    config,
    agentCwd,
    sharedDir,
    tenantSkillsRootDir,
    sessionBasePath,
    dingtalkDeps,
    cronRuntime,
    dispatchMetricsStore,
  } = runtime;
  const processCwd = runtime.processCwd || runtime.agentCwd || process.cwd();
  const loginLogFilePath = resolve(processCwd, "./data/login-logs.jsonl");

  const { channelManager } = runtime;
  app.use(
    "/api",
    createHealthRouter(config, {
      getDispatchMetrics: () => dispatchMetricsStore.getSnapshot(),
      getActiveStreamCount: () => channelManager.getActiveStreamCount(),
      getUploadMetrics: () => runtime.uploadManager.getMetricsSnapshot(),
      getActiveRunCounts: runtime.runtimeRunStore?.getActiveCounts
        ? () => runtime.runtimeRunStore!.getActiveCounts!()
        : undefined,
      getIsDraining: () => channelManager.draining,
      getSkillsWarmupStatus: () => runtime.getSkillsWarmupStatus(),
    }),
  );
  // App update: version check + APK download
  const mobileDir = resolve(processCwd, "../mobile");
  app.use("/api", createAppUpdateRouter({ mobileDir }));

  app.use(
    "/api/upload",
    tenantFeatureGuard(runtime.tenantStore, "filesEnabled", "文件能力"),
  );
  app.use(
    "/api/file",
    tenantFeatureGuard(runtime.tenantStore, "filesEnabled", "文件能力"),
  );
  app.use(
    "/api/uploads",
    tenantFeatureGuard(runtime.tenantStore, "filesEnabled", "文件能力"),
  );
  app.use("/api", createUploadRouter({ agentCwd, uploadManager: runtime.uploadManager }));
  app.use(
    "/api",
    createFileRouter({ agentCwd, userOverrides: config.agent.userOverrides }),
  );
  if (runtime.artifactService) {
    app.use(
      "/api/sessions/:sessionId/artifacts",
      tenantFeatureGuard(runtime.tenantStore, "filesEnabled", "文件能力"),
    );
    app.use(
      "/api/artifacts",
      tenantFeatureGuard(runtime.tenantStore, "filesEnabled", "文件能力"),
    );
    app.use(
      "/api",
      createArtifactsRouter({
        artifactService: runtime.artifactService,
        defaultReadUrlTtlSeconds: config.artifact?.readUrlTtlSeconds,
      }),
    );
  }

  // 租户共享知识库文件只读服务（引用溯源卡；2026-07 唯恩批次）。
  // 独立开关 kbEnabled（默认 false，不复用 filesEnabled——关掉个人文件能力仍可溯源）。
  app.use(
    "/api/kb",
    tenantFeatureGuard(runtime.tenantStore, "kbEnabled", "知识库"),
    createKbFilesRouter({ kbRootDir: resolve(processCwd, "./data/kb") }),
  );

  // 消息反馈（专职 Agent 会话 owner-only 点踩；PG 未装配时路由内 503）
  app.use(
    "/api/feedback",
    createFeedbackRouter({ messageFeedbackStore: runtime.messageFeedbackStore }),
  );

  // 员工申诉（门禁拒答后 owner-only 申诉 + 管理员处理队列；PG 未装配时路由内 503）
  app.use(
    "/api/appeals",
    createAppealsRouter({ appealStore: runtime.appealStore }),
  );
  app.use(
    "/api/tenant/appeals",
    createTenantAppealsRouter({ appealStore: runtime.appealStore }),
  );

  // DWS 单轨连接状态：仅暴露当前登录用户自己的非敏感元数据。
  // access/refresh token 始终由 DWS 保存在该用户的 NAS workspace 内。
  app.use("/api", createDwsRouter({
    connectionStore: runtime.dwsConnectionStore,
    authFlowService: runtime.dwsAuthFlowService,
    userStore: runtime.userStore,
  }));

  // 飞书单轨连接状态：浏览器/PG 只接触非敏感元数据；用户 token 与官方 CLI
  // 加密 keychain 始终保存在其独立 NAS workspace 的 .lark-cli/ 内。
  app.use("/api", createFeishuRouter({
    connectionStore: runtime.feishuConnectionStore,
    authFlowService: runtime.feishuAuthFlowService,
    userStore: runtime.userStore,
  }));

  // Azeroth 透明反向代理：mobile/web 通过 /api/azeroth/* 调用 azeroth API，
  // 由 server 注入对应员工的 PAT，新增 azeroth 接口零代码。
  // 依赖：index.ts 中 express.json() 已配置为跳过 /api/azeroth/* 路径
  app.use("/api", createAzerothProxyRouter());

  // HTML Preview: token API 走 /api（需认证），文件服务走 /preview（自认证）
  const preview = createPreviewRoutes({
    agentCwd,
    userOverrides: config.agent.userOverrides,
  });
  app.use("/api", preview.tokenRouter);
  app.use("/preview", preview.serveRouter);

  app.use("/api", createVoiceRouter({ agentCwd }));
  app.use("/api", createTtsRouter({ tts: config.tts }));
  app.use(
    "/api/search",
    createSearchRouter({ agentCwd, userStore: runtime.userStore }),
  );
  // 场景库：预置场景卡片（所有登录用户可读；服务端过滤未上架条目并剥离内部 source 字段）
  app.use(
    "/api/scenarios",
    createScenariosRouter({
      cronService: cronRuntime.service ?? undefined,
      roleKit: config.roleKit,
      tenantStore: runtime.tenantStore,
    }),
  );
  app.use("/api/contentops", createContentOpsRouter());
  const webChannel = channelManager.getChannel<WebChannel>("web");
  app.use(
    "/api",
    createSessionsRouter({
      agentCwd,
      dingtalkSessionsBasePath: sessionBasePath,
      cronRunsDir: cronRuntime.cronRunsDir,
      groupStore: runtime.groupStore,
      userStore: runtime.userStore,
      agentStore: runtime.agentStore,
      orgAgentStore: runtime.orgAgentStore,
      getStreamStatus: webChannel
        ? (sid) => webChannel.getStreamStatus(sid)
        : undefined,
      broadcastToUser: webChannel
        ? (userId, data) =>
            webChannel.getWsServer()?.broadcastToUser(userId, data)
        : undefined,
      titleGeneratorConfigs: runtime.titleGeneratorConfigs,
      getTitleSystemPrompt: () => runtime.systemPromptRegistry.get('utility.title'),
      tokenUsageStore: runtime.tokenUsageStore,
      billingService: runtime.billingService,
      getEventBus: webChannel ? () => webChannel.getEventBus() : undefined,
      runtimeEventStoreFor: runtime.runtimeEventStoreFor,
      resolveContextAccounting: (modelRef) => resolveContextAccountingFromModels(config.models, modelRef),
      sessionShareStore: runtime.sessionShareStore,
      sessionProjectionStore: runtime.runtimeSessionProjectionStore,
      sessionReadStateStore: runtime.sessionReadStateStore,
      sandboxWarmup: (sessionId) => runtime.sandboxWarmupService.fireForSession(sessionId),
      listPendingSteeringBySession: runtime.runtimeRunStore?.listPendingSteeringBySession
        ? (sessionId) => runtime.runtimeRunStore!.listPendingSteeringBySession!(sessionId)
        : undefined,
    }),
  );
  app.use(
    "/api/dingtalk",
    requireAdmin,
    createDingtalkSessionRouter({
      sessionService: dingtalkDeps.sessionService,
      deliveryService: dingtalkDeps.deliveryService,
    }),
  );

  // 模型列表 API
  if (config.models) {
    configureModelPricing(config.models);
    app.get("/api/models", (req: Request, res: Response) => {
      const tenantSettings = req.user?.tenantId
        ? runtime.tenantStore?.getSettings(req.user.tenantId)
        : undefined;
      const preferredDefault = req.user && runtime.userStore
        ? runtime.userStore.findById(req.user.sub)?.preferences?.defaultModel
        : undefined;
      res.json(getUserPublicModelList(config.models!, tenantSettings, preferredDefault));
    });
    app.use(
      "/api/admin/models",
      createModelsAdminRouter({
        processCwd,
        config,
        // 热更新逻辑与 runtime-worker 侧共用同一实现（modelsHotUpdate.ts），
        // 避免两个进程对同一份 config 产生不一致的内存状态。
        onModelsUpdated: (models) => {
          applyModelsHotUpdate({ config, target: runtime, models });
        },
        onMemoryIndexUpdated: runtime.updateMemoryIndexConfig,
      }),
    );
  }
  app.use(
    "/api/admin/codex-subscription",
    createCodexSubscriptionAdminRouter({
      processCwd,
      config,
      credentialManager: runtime.codexCredentialManager,
      deviceAuthService: runtime.codexDeviceAuthService,
      closeWebSockets: runtime.codexWebSocketShutdown,
    }),
  );
  app.use(
    "/api/admin/tenant-remote-hands",
    createTenantRemoteHandsAdminRouter({
      processCwd,
      config,
      secretVault: runtime.secretVault,
    }),
  );
  app.use(
    "/api/admin/runtime-operations",
    createRuntimeOperationsAdminRouter({
      config,
      secretVault: runtime.secretVault,
      processRole: runtime.processRole,
      userStore: runtime.userStore,
      runtimeSchedulerCapacity: runtime.runtimeSchedulerCapacity,
    }),
  );
  app.use(
    "/api/admin/tool-controls",
    createToolControlsAdminRouter({
      processCwd,
      config,
      secretVault: runtime.secretVault,
      validateToolSettingsConfig: runtime.validateToolSettingsConfig,
      onToolSettingsUpdated: runtime.updateToolSettingsConfig,
    }),
  );
  // 连接器映射词典（2026-08-03）：决定工具行怎么把命令行还原成业务语言、
  // 哪些调用配得上回执章。保存即热更新，无需重启。
  app.use(
    "/api/admin/connector-dictionary",
    createConnectorDictionaryAdminRouter({
      store: runtime.connectorDictionaryStore,
    }),
  );
  // 租户级词典覆盖（2026-08-04 任务 E）：组织管理员按 binary 整条覆盖平台条目。
  app.use(
    "/api/org/connector-dictionary",
    createConnectorDictionaryOrgRouter({
      store: runtime.connectorDictionaryStore,
    }),
  );
  app.use(
    "/api/admin/system-prompts",
    createSystemPromptsAdminRouter({
      processCwd,
      config,
      registry: runtime.systemPromptRegistry,
    }),
  );
  app.use(
    "/api/admin/agent-profiles",
    createAgentRuntimeProfilesAdminRouter({
      store: runtime.agentRuntimeProfileStore,
      getToolControls: () => config.toolControls,
    }),
  );
  // GenerateImage 引擎配置与 per-engine 定价（2026-07-15）：平台管理员运行时可改，
  // PUT 后 jsonc 回写 config.json + SecretVault 凭据托管 + runtime 热更，无需重启。
  app.use(
    "/api/admin/image-gen-pricing",
    createImageGenPricingAdminRouter({
      processCwd,
      config,
      secretVault: runtime.secretVault,
      onPricingUpdated: (pricing) => configureImageGenPricing(pricing),
      validateImageGenToolsConfig: runtime.validateImageGenToolsConfig,
      onImageGenToolsUpdated: runtime.updateImageGenToolsConfig,
    }),
  );
  // 网络出口（代理 / 国内镜像源，2026-07-25）：server 段落盘即生效（dispatcher 按
  // configVersion 懒重建）；sandbox 段另行 PATCH 给 acs-orchestrator，只对新建容器生效。
  if (runtime.egressConfigStore) {
    app.use(
      "/api/admin/egress-config",
      createEgressConfigAdminRouter({
        config,
        store: runtime.egressConfigStore,
        secretVault: runtime.secretVault,
        refreshProxyCredential: runtime.refreshEgressProxyCredential,
      }),
    );
  }
  app.use(
    "/api/admin/memory-polling",
    createMemoryPollingAdminRouter({
      processCwd,
      config,
      onPollingUpdated: runtime.updateMemoryPollingConfig,
    }),
  );

  if (cronRuntime.service) {
    app.use(
      "/api/cron",
      tenantFeatureGuard(runtime.tenantStore, "cronEnabled", "定时任务"),
    );
    app.use(
      "/api/cron",
      createCronRouter(
        cronRuntime.service,
        cronRuntime.cronRunsDir,
        runtime.groupStore,
      ),
    );
  }

  app.use(
    "/api/taskboard",
    tenantFeatureGuard(runtime.tenantStore, "cronEnabled", "定时任务"),
    createTaskboardRouter({
      service: runtime.taskboardService,
      executionService: runtime.taskboardExecutionService,
      userStore: runtime.userStore,
    }),
  );

  // Token 用量统计（admin-only），数据由 b4187f00 引入的 business.sqlite 提供
  if (runtime.tokenUsageStore) {
    const usageBillingStore = runtime.billingService?.store;
    app.use(
      "/api/admin/usage",
      requireAdmin,
      createUsageRouter({
        tokenUsageStore: runtime.tokenUsageStore,
        userStore: runtime.userStore,
        triggerRebuild: runtime.triggerTokenUsageRebuild,
        // USD 成本对组织 admin 按 billing policy.showCost fail-closed 脱敏（2026-07-14）
        getTenantPolicy: usageBillingStore
          ? (tenantId) => usageBillingStore.getTenantPolicy(tenantId)
          : undefined,
      }),
    );
  }

  if (runtime.billingService) {
    app.use("/api/billing", createBillingRouter({ billingService: runtime.billingService }));
    app.use(
      "/api/admin/billing",
      requireAdmin,
      createAdminBillingRouter({
        billingService: runtime.billingService,
        alertNotifier: runtime.alertNotifier,
        governanceAuditStore: runtime.governanceAuditStore,
      }),
    );
  }

  // Runtime audit 读 API（admin-only）：按 sessionId/runId 查 tool_audit 投影，
  // 不引 DB，直接读 *.runtime-events.jsonl。
  if (runtime.runtimeAuditQuery) {
    app.use(
      "/api/admin/runtime/audit",
      requireAdmin,
      createRuntimeAuditRouter({ auditQuery: runtime.runtimeAuditQuery }),
    );
  }

  // Agent 运行监测读 API（admin-only，router 内 resolveTenant 隔离：平台 admin 全量、
  // 组织 admin 锁本租户 + ¥ 成本按 policy.showCost 脱敏）：
  // run trace drill-down + 最近 run 列表 + 效率聚合。仅 PG runtime backend 可用
  // （依赖 runtime_runs / runtime_events / billing usage 三张表）；依赖不齐时不挂载。
  const runtimeTraceBillingStore = runtime.billingService?.store;
  if (
    runtime.runtimeRunStore &&
    runtime.runtimePgEventStore &&
    runtimeTraceBillingStore
  ) {
    app.use(
      "/api/admin/runtime/trace",
      requireAdmin,
      createRuntimeTraceRouter({
        runStore: runtime.runtimeRunStore,
        eventStore: runtime.runtimePgEventStore,
        billingStore: runtimeTraceBillingStore,
        userStore: runtime.userStore,
        getTenantPolicy: (tenantId) => runtimeTraceBillingStore.getTenantPolicy(tenantId),
        efficiencyQuery: new RuntimeEfficiencyQuery({
          pool: runtime.runtimePgEventStore.pool,
          eventsTable: runtime.runtimePgEventStore.eventsTable,
          runsTable: runtime.runtimeRunStore.runsTable,
          billingUsageEventsTable: runtimeTraceBillingStore.usageEventsTable,
        }),
      }),
    );
  }

  // 组织对话质检台（会话记录/门禁日志/反馈标注；2026-07 唯恩批次）。
  // 须挂在 /api/admin 观测路由之前，避免前缀匹配先落进 observability router。
  app.use(
    "/api/admin/qa",
    requireAdmin,
    createOrgQaRouter({
      sessionProjectionStore: runtime.runtimeSessionProjectionStore,
      orgAgentStore: runtime.orgAgentStore,
      guardrailEventStore: runtime.guardrailEventStore,
      messageFeedbackStore: runtime.messageFeedbackStore,
      userStore: runtime.userStore,
      authorizeAdminAccess: async input => {
        if (!runtime.membershipStore) return false;
        if (input.platformAdmin) {
          return (await runtime.membershipStore.getPlatformAdmin(input.userId))?.status === 'active';
        }
        const membership = await runtime.membershipStore.getMembership(input.tenantId, input.userId);
        return membership?.status === 'active' && membership.persona === 'org_admin';
      },
      authorizeContentAccess: runtime.contentAccessGrantStore
        ? input => runtime.contentAccessGrantStore!.authorize(input)
        : undefined,
      auditContentAccess: runtime.governanceAuditStore
        ? async input => (await runtime.governanceAuditStore!.append({
            correlationId: `qa-read:${input.sessionId}:${randomUUID()}`,
            actorType: 'user',
            actorUserId: input.actorUserId,
            actorPersona: input.actorPersona,
            actorTenantId: input.actorTenantId,
            action: 'session.content.qa_read',
            targetType: 'session',
            targetId: input.sessionId,
            targetTenantId: input.tenantId,
            purpose: 'organization agent quality review',
            result: 'succeeded',
            metadata: { scope: input.scope },
          })).auditId
        : undefined,
    }),
  );

  app.use(
    "/api/admin",
    requireAdmin,
    createPlatformObservabilityRouter({
      config,
      secretVault: runtime.secretVault,
      tenantStore: runtime.tenantStore,
      userStore: runtime.userStore,
      billingService: runtime.billingService,
      runStore: runtime.runtimeRunStore,
      sessionProjectionStore: runtime.runtimeSessionProjectionStore,
      eventStore: runtime.runtimePgEventStore,
      toolInvocationStore: runtime.runtimeToolInvocationStore,
      systemMetricsStore: runtime.systemMetricsStore,
      getDispatchMetrics: () => dispatchMetricsStore.getSnapshot(),
    }),
  );

  app.use(
    "/api/admin/system",
    requireAdmin,
    createSystemAdminRouter({
      agentCwd,
      systemMetricsStore: runtime.systemMetricsStore,
      systemMetricsCollector: runtime.systemMetricsCollector,
      alertNotifier: runtime.alertNotifier,
      userStore: runtime.userStore,
      governanceAuditStore: runtime.governanceAuditStore,
    }),
  );

  app.use(
    "/api/internal",
    createInternalAcsAlertsRouter({
      alertNotifier: runtime.alertNotifier,
      inboundToken: process.env.ACS_ALERT_INBOUND_TOKEN,
    }),
  );

  app.use(
    "/api",
    createGroupsRouter({
      groupStore: runtime.groupStore,
      agentCwd: runtime.agentCwd,
      userStore: runtime.userStore,
      agentStore: runtime.agentStore,
      loginLogFilePath,
      broadcastToUser: webChannel
        ? (userId, data) =>
            webChannel.getWsServer()?.broadcastToUser(userId, data)
        : undefined,
      getEventBus: webChannel ? () => webChannel.getEventBus() : undefined,
    }),
  );

  let executeUserOffboarding: ExecuteUserOffboarding | undefined;

  if (runtime.userStore && config.auth?.enabled) {
    const usersFilePath = resolve(
      processCwd,
      config.auth.usersFile || "./data/users.json",
    );
    const avatarsDir = resolve(usersFilePath, "..", "avatars");
    // 活动日志与治理审计分离。启动时绝不删除管理员历史；仅物理擦除旧聊天 preview。
    initAuditLog(loginLogFilePath);
    void redactLegacyChatPreviewsInFile(loginLogFilePath).catch((error) => {
      console.warn(`[audit] 历史聊天 preview 物理脱敏失败: ${error instanceof Error ? error.message : String(error)}`);
    });
    const userStore = runtime.userStore;
    const terminateAndRevokeUserConnectors = async (target: UserInfo) => {
      // 先中止活跃运行，避免外部连接器清理失败时用户继续持有已注入的短期凭据。
      runtimeRunController.abortByUser(target.id, 'user access revoked');
      webChannel?.disconnectUser(target.id);
      await runtime.aliyunConnectorService?.disconnect({
        userId: target.id,
        username: target.username,
        tenantId: target.tenantId,
      }).catch(() => undefined);
      await Promise.allSettled([
        runtime.connectorConnectionStore && runtime.secretVault
          ? revokeAllUserConnectorCredentials({
              connectionStore: runtime.connectorConnectionStore,
              vault: runtime.secretVault,
              userId: target.id,
              username: target.username,
              tenantId: target.tenantId,
            })
          : undefined,
        runtime.dwsAuthFlowService?.revokeUser?.(target),
        runtime.feishuAuthFlowService?.revokeUser?.(target),
        runtime.notionAuthFlowService?.cancelUser?.(target.tenantId, target.id),
        runtime.googleWorkspaceOAuthService?.cancelUser(target.id),
        runtime.googleWorkspaceOAuthService?.disconnect(target.id, target.username, target.tenantId),
        runtime.mcpOAuthService?.disconnectUser(target.username, target.tenantId),
      ]);
    };
    executeUserOffboarding = createGovernanceOffboardingExecutor({
      runtime,
      userStore,
      terminateAndRevokeUserConnectors,
      disconnectWebUser: userId => webChannel?.disconnectUser(userId),
      removeCronByOwners: ownerIds => cronRuntime.service?.removeByOwners(ownerIds) ?? Promise.resolve(),
    });
    app.use(
      "/api/auth",
      createAuthRouter({
        userStore: runtime.userStore,
        tenantStore: runtime.tenantStore,
        jwtSecret: config.auth.jwtSecret,
        tokenExpiresIn: config.auth.tokenExpiresIn || "30d",
        avatarsDir,
        loginLogFilePath,
        agentCwd,
        sharedDir,
        tenantSkillsRootDir,
        onUserDisabled: async (userId: string) => {
          const disabledUser = userStore.findById(userId);
          if (disabledUser) await terminateAndRevokeUserConnectors(disabledUser);
        },
        onUserTenantChanging: terminateAndRevokeUserConnectors,
        skillConfigStore: runtime.skillConfigStore,
        onUserDeleting: async (target) => {
          await Promise.all([
            terminateAndRevokeUserConnectors(target),
            cronRuntime.service?.removeByOwners([target.id]),
          ]);
        },
        mcpOAuthService: runtime.mcpOAuthService,
        signupConfigStore: runtime.signupConfigStore,
        secretVault: runtime.secretVault,
        getModelsConfig: () => config.models,
        legacyWriteGate: runtime.governanceWriteGate,
      }),
    );
    // 手机号自助注册试用（官网联动 MVP）。公开路径在 auth middleware PUBLIC_ROUTES
    // 放行；enabled 开关与频控在 router 内收口。配置走 SignupConfigStore 动态读
    // （platform-admin「注册管理」页可改，改完下一请求即生效，无需重启）。
    if (runtime.tenantStore && runtime.signupConfigStore) {
      const signupRouters = createSignupRouters({
        userStore: runtime.userStore,
        tenantStore: runtime.tenantStore,
        billingService: runtime.billingService,
        modelsConfig: config.models,
        signupConfigStore: runtime.signupConfigStore,
        secretVault: runtime.secretVault,
        jwtSecret: config.auth.jwtSecret,
        tokenExpiresIn: config.auth.tokenExpiresIn || "30d",
        agentCwd,
        sharedDir,
        tenantSkillsRootDir,
        loginLogFilePath,
        skillConfigStore: runtime.skillConfigStore,
        // ★ 2026-07-18 企业专家目录 MVP：注册开通试用租户时 seed 3 个种子专家
        orgAgentStore: runtime.orgAgentStore,
        legacyWriteGate: runtime.governanceWriteGate,
      });
      app.use("/api/signup", signupRouters.publicRouter);
      app.use("/api/admin/signup-config", signupRouters.adminRouter);
    }
    const executeLegacyTenantDeletion = runtime.tenantStore && runtime.userStore
      ? (tenantId: string) => deleteTenantResources({
        tenantId,
        tenantStore: runtime.tenantStore!,
        userStore: runtime.userStore!,
        agentStore: runtime.agentStore,
        skillConfigStore: runtime.skillConfigStore,
        mcpConfigStore: runtime.mcpConfigStore,
        connectorConnectionStore: runtime.connectorConnectionStore,
        onUserDeleting: async (target) => {
          await Promise.all([
            runtime.dwsAuthFlowService?.revokeUser?.(target),
            runtime.feishuAuthFlowService?.revokeUser?.(target),
            runtime.notionAuthFlowService?.cancelUser?.(target.tenantId, target.id),
          ]);
          await runtime.googleWorkspaceOAuthService?.cancelUser(target.id);
          await runtime.googleWorkspaceOAuthService?.disconnect(target.id, target.username, target.tenantId);
          if (runtime.connectorConnectionStore && runtime.secretVault) {
            await revokeAllUserConnectorCredentials({
              connectionStore: runtime.connectorConnectionStore,
              vault: runtime.secretVault,
              userId: target.id,
              username: target.username,
              tenantId: target.tenantId,
            });
          }
        },
        mcpOAuthService: runtime.mcpOAuthService,
        groupStore: runtime.groupStore,
        cronService: runtime.cronRuntime.service,
        tokenUsageStore: runtime.tokenUsageStore,
        billingService: runtime.billingService,
        runtimePgEventStore: runtime.runtimePgEventStore,
        runtimeRunStore: runtime.runtimeRunStore,
        runtimeSessionProjectionStore: runtime.runtimeSessionProjectionStore,
        runtimeToolInvocationStore: runtime.runtimeToolInvocationStore,
        runtimeHandStore: runtime.runtimeHandStore,
        artifactService: runtime.artifactService,
        agentCwd,
        sharedDir,
        tenantSkillsRootDir: runtime.tenantSkillsRootDir,
        avatarsDir: resolve(processCwd, config.auth?.usersFile || './data/users.json', '..', 'avatars'),
      })
      : undefined;
    const governanceTenantCleanup = runtime.runtimePgEventStore && runtime.secretVault
      ? new GovernanceTenantCleanup({
          pool: runtime.runtimePgEventStore.pool,
          tablePrefix: config.runtimeEventStore?.backend === 'pg'
            ? config.runtimeEventStore.tablePrefix
            : undefined,
          vault: runtime.secretVault,
        })
      : undefined;
    const legacyTenantDeletionRuns = new Map<string, Promise<void>>();
    const executeTenantDeletionDomain = executeLegacyTenantDeletion && governanceTenantCleanup
      ? async (tenantId: string, domain: string): Promise<void> => {
          if (domain === 'memory' || domain === 'sessions_runs') {
            let run = legacyTenantDeletionRuns.get(tenantId);
            if (!run) {
              run = executeLegacyTenantDeletion(tenantId)
                .then(() => undefined)
                .catch(error => {
                  if (error instanceof Error && error.message === 'Tenant not found') return;
                  throw error;
                });
              legacyTenantDeletionRuns.set(tenantId, run);
            }
            await run;
            return;
          }
          await governanceTenantCleanup.execute(tenantId, domain as TenantCleanupDomain);
        }
      : undefined;
    // Tenant management (admin-only CRUD；PR 1 仅元数据，不影响任何运行时行为)
    if (runtime.tenantStore) {
      app.use(
        "/api/tenants",
        createTenantsRouter({
          tenantStore: runtime.tenantStore,
          sharedDir,
          resolveMemoryFeatureStatus: runtime.getTenantMemoryFeatureStatus,
          // ★ 2026-07-18 企业专家目录 MVP：新租户开通时 seed 3 个种子专家（disabled）
          orgAgentStore: runtime.orgAgentStore,
          governanceAuditStore: runtime.governanceAuditStore,
          legacyWriteGate: runtime.governanceWriteGate,
          onTenantDisabled: webChannel
            ? (tenantId: string) => webChannel.disconnectTenant(tenantId)
            : undefined,
          deleteTenantResources: executeLegacyTenantDeletion,
        }),
      );
    }
    app.use(createGovernanceUiRouter({
      users: runtime.userStore,
      tenants: runtime.tenantStore,
      memberships: runtime.membershipStore,
      entitlements: runtime.entitlementStore,
      assignments: runtime.assignmentStore,
      agents: runtime.agentResourceStore,
      skills: runtime.skillGovernanceStore,
      connectors: runtime.connectorCatalogStore,
      credentials: runtime.credentialStore,
      environments: runtime.environmentStore,
      audit: runtime.governanceAuditStore,
    }));
    if (
      runtime.membershipStore
      && runtime.entitlementStore
      && runtime.assignmentStore
      && runtime.governanceAuditStore
    ) {
      app.use('/api/governance/access', createGovernanceAccessRouter({
        memberships: runtime.membershipStore,
        entitlements: runtime.entitlementStore,
        assignments: runtime.assignmentStore,
        audit: runtime.governanceAuditStore,
        contentAccess: runtime.contentAccessGrantStore,
        projectionOutbox: runtime.governanceProjectionOutboxStore,
        projectionReconciler: runtime.governanceProjectionReconciler,
        membershipPreviewSecret: config.auth.jwtSecret,
      }));
    }
    if (
      runtime.membershipStore
      && runtime.agentResourceStore
      && runtime.skillGovernanceStore
      && runtime.connectorCatalogStore
      && runtime.credentialStore
      && runtime.environmentStore
      && runtime.governanceChangeJobStore
      && runtime.governanceChangePlanner
      && runtime.secretVault
      && runtime.governanceAuditStore
    ) {
      app.use('/api/governance/resources', createGovernanceResourcesRouter({
        memberships: runtime.membershipStore,
        agents: runtime.agentResourceStore,
        skills: runtime.skillGovernanceStore,
        connectors: runtime.connectorCatalogStore,
        credentials: runtime.credentialStore,
        environments: runtime.environmentStore,
        changeJobs: runtime.governanceChangeJobStore,
        changePlanner: runtime.governanceChangePlanner,
        ...(executeTenantDeletionDomain ? { executeTenantDeletionDomain } : {}),
        tenantExists: (tenantId: string) => Boolean(runtime.tenantStore?.findById(tenantId)),
        resolveUserTenantId: (userId: string) => runtime.userStore?.findById(userId)?.tenantId,
        executeUserOffboarding,
        projectionOutbox: runtime.governanceProjectionOutboxStore,
        projectionReconciler: runtime.governanceProjectionReconciler,
        vault: runtime.secretVault,
        audit: runtime.governanceAuditStore,
      }));
    }
    if (runtime.governanceMigrationControlStore && runtime.membershipStore && runtime.governanceAuditStore) {
      app.use('/api/governance/migration', createGovernanceMigrationRouter({
        store: runtime.governanceMigrationControlStore,
        memberships: runtime.membershipStore,
        audit: runtime.governanceAuditStore,
      }));
    }
    // Skill management
    if (runtime.skillConfigStore) {
      app.use(
        "/api/skills",
        tenantFeatureGuard(runtime.tenantStore, "customSkillsEnabled", "自定义技能"),
      );
      app.use(
        "/api/skills",
        createSkillsRouter({
          skillConfigStore: runtime.skillConfigStore,
          userStore: runtime.userStore!,
          agentCwd,
          sharedDir,
          tenantSkillsRootDir: runtime.tenantSkillsRootDir,
          skillMaterialization: runtime.skillMaterialization,
          legacyWriteGate: runtime.governanceWriteGate,
        }),
      );
    }
    // 原生连接器账号与凭据；独立于 MCP feature gate。
    if (runtime.connectorConnectionStore && runtime.secretVault) {
      app.use(
        "/api/connectors",
        createConnectorsRouter({
          connectionStore: runtime.connectorConnectionStore,
          secretVault: runtime.secretVault,
          aliyunService: runtime.aliyunConnectorService,
          legacyWriteGate: runtime.governanceWriteGate,
        }),
      );
      app.use(
        "/api",
        createNotionRouter({
          connectionStore: runtime.connectorConnectionStore,
          authFlowService: runtime.notionAuthFlowService,
          userStore: runtime.userStore,
          available: Boolean(runtime.getNotionConnection && runtime.disconnectNotionConnection),
          getConnection: async (identity) => {
            if (!runtime.getNotionConnection) throw new Error('Notion 连接服务尚未配置');
            return await runtime.getNotionConnection(identity);
          },
          disconnect: async (userId, username, tenantId) => {
            if (!runtime.disconnectNotionConnection) throw new Error('Notion 连接服务尚未配置');
            return await runtime.disconnectNotionConnection({ userId, username, tenantId });
          },
          legacyWriteGate: runtime.governanceWriteGate,
        }),
      );
      app.use(
        "/api/connectors",
        createGoogleWorkspaceRouter({
          oauthService: runtime.googleWorkspaceOAuthService,
          userStore: runtime.userStore,
          webBaseUrl: config.server?.webBaseUrl,
          legacyWriteGate: runtime.governanceWriteGate,
        }),
      );
    }
    // MCP management and per-user enablement
    if (runtime.mcpConfigStore && runtime.mcpClientManager) {
      app.use(
        "/api/mcp",
        tenantFeatureGuard(runtime.tenantStore, "mcpEnabled", "MCP 工具"),
      );
      app.use(
        "/api/mcp",
        createMcpRouter({
          store: runtime.mcpConfigStore,
          userStore: runtime.userStore!,
          manager: runtime.mcpClientManager,
          agentCwd,
          secretVault: runtime.secretVault,
          oauthService: runtime.mcpOAuthService,
          webBaseUrl: config.server?.webBaseUrl,
          legacyWriteGate: runtime.governanceWriteGate,
        }),
      );
    }
    // Agent profiles
    if (runtime.agentStore) {
      const agentAvatarsDir = resolve(processCwd, "./data/agent-avatars");
      app.use(
        "/api/agents",
        createAgentsRouter({
          agentStore: runtime.agentStore,
          agentAvatarsDir,
          agentCwd: agentCwd,
          sharedDir,
          tenantSkillsRootDir,
          userStore: runtime.userStore!,
          skillConfigStore: runtime.skillConfigStore,
          getMemoryIndexService: runtime.getMemoryIndexService,
          legacyWriteGate: runtime.governanceWriteGate,
        }),
      );
    }
    // 公司级专职 Agent（组织管理员配置、员工使用；2026-07 唯恩批次）
    if (runtime.orgAgentStore) {
      app.use(
        "/api/org-agents",
        createOrgAgentsRouter({
          orgAgentStore: runtime.orgAgentStore,
          tenantStore: runtime.tenantStore!,
          orgAgentAvatarsDir: resolve(processCwd, "./data/org-agent-avatars"),
          getGuardrailModelConfigs: runtime.getGuardrailModelConfigs,
          billingService: runtime.billingService,
          legacyWriteGate: runtime.governanceWriteGate,
          onSkillAssignmentsChanged: runtime.skillConfigStore
            ? () => runtime.skillConfigStore!.touchConfigVersion()
            : undefined,
        }),
      );
    }
  }
}
