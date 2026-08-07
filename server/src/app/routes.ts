import { resolve } from "node:path";
import express from "express";
import type { Express, Request, Response } from "express";

import type { AppRuntime } from "./runtime.js";
import type { TenantStore } from "../data/tenants/store.js";
import type { UserInfo } from "../data/users/types.js";
import type { TitleGeneratorConfig } from "../agent/titleGenerator.js";
import type { GuardrailModelConfig } from "../agent/guardrail.js";
import {
  getPublicModelList,
  getUserPublicModelList,
  resolveContextAccountingFromModels,
  resolveModelRef,
} from "./models.js";
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
import { createMcpRouter } from "../routes/mcp.js";
import { createConnectorsRouter } from "../routes/connectors.js";
import { createNotionRouter } from "../routes/notion.js";
import { createGoogleWorkspaceRouter } from "../routes/googleWorkspace.js";
import { revokeAllUserConnectorCredentials } from "../connectors/lifecycle.js";
import { runtimeRunController } from "../runtime/runController.js";
import { createTenantsRouter } from "../routes/tenants.js";
import { deleteTenantResources } from "../data/tenants/cleanup.js";
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
import { initAuditLog, clearLogsByUsername } from "../data/login-logs/index.js";
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

  // 平台管理员分层治理（2026-07-18）：auth middleware 之后、所有路由之前统一挂载。
  // 非 super 的平台 admin（万神殿员工账号）对管理路径只读；详见 platformGovernance.ts。
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
        onModelsUpdated: (models) => {
          configureModelPricing(models);
          const merged = { ...models, default: models.default };
          // 门禁链热更（放在 title 之前：title 的 early-return 不能吞掉门禁重建）。
          // 主模型解析失败保留原链——避免热更瞬时把门禁打挂。
          if (config.guardrail?.model) {
            const nextGuardrail: GuardrailModelConfig[] = [];
            const mainGuardrail = resolveModelRef(merged, config.guardrail.model);
            if (mainGuardrail) {
              nextGuardrail.push({
                model: mainGuardrail.model,
                connection: mainGuardrail.connection,
              });
              for (const ref of config.guardrail.fallbackModels ?? []) {
                const fb = resolveModelRef(merged, ref);
                if (fb) nextGuardrail.push({ model: fb.model, connection: fb.connection });
              }
              runtime.updateGuardrailModelConfigs(nextGuardrail);
            }
          }
          // 模型列表热更新：重建 titleGenerator 配置链。
          // resolveModelRef 找不到任一引用都保留原链——避免热更瞬时把功能打挂。
          if (!config.titleGenerator?.model) return;
          const next: TitleGeneratorConfig[] = [];
          const resolvedMain = resolveModelRef(
            merged,
            config.titleGenerator.model,
          );
          if (!resolvedMain) return;
          next.push({
            model: resolvedMain.model,
            connection: resolvedMain.connection,
          });
          for (const ref of config.titleGenerator.fallbackModels ?? []) {
            const fb = resolveModelRef(merged, ref);
            if (fb) next.push({ model: fb.model, connection: fb.connection });
          }
          runtime.titleGeneratorConfigs = next;
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

  if (runtime.userStore && config.auth?.enabled) {
    const usersFilePath = resolve(
      processCwd,
      config.auth.usersFile || "./data/users.json",
    );
    const avatarsDir = resolve(usersFilePath, "..", "avatars");
    // 初始化审计日志单例，供所有路由使用
    initAuditLog(loginLogFilePath);
    // 清除所有 admin 用户的历史审计日志（一次性，顺序执行避免竞态）
    const userStore = runtime.userStore;
    // 修 P1 BUG #3 延伸（2026-06-21）：原 if (u.role === 'admin') 会把组织 admin
    // 的 login logs 也清掉——组织 admin 的登录审计应保留给组织自己内部审计。
    // 只清平台 admin（kaiyan 组织内的 admin）的旧日志。
    (async () => {
      for (const u of userStore.listAll()) {
        if (u.role === "admin" && u.tenantId === DEFAULT_TENANT_ID) {
          await clearLogsByUsername(loginLogFilePath, u.username).catch(
            () => {},
          );
        }
      }
    })();
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
      });
      app.use("/api/signup", signupRouters.publicRouter);
      app.use("/api/admin/signup-config", signupRouters.adminRouter);
    }
    // Tenant management (admin-only CRUD；PR 1 仅元数据，不影响任何运行时行为)
    if (runtime.tenantStore) {
      app.use(
        "/api/tenants",
        createTenantsRouter({
          tenantStore: runtime.tenantStore,
          sharedDir,
          // ★ 2026-07-18 企业专家目录 MVP：新租户开通时 seed 3 个种子专家（disabled）
          orgAgentStore: runtime.orgAgentStore,
          onTenantDisabled: webChannel
            ? (tenantId: string) => webChannel.disconnectTenant(tenantId)
            : undefined,
          deleteTenantResources: runtime.userStore
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
                await runtime.googleWorkspaceOAuthService?.disconnect(
                  target.id,
                  target.username,
                  target.tenantId,
                );
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
              avatarsDir: resolve(
                processCwd,
                config.auth?.usersFile || "./data/users.json",
                "..",
                "avatars",
              ),
            })
            : undefined,
        }),
      );
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
        }),
      );
      app.use(
        "/api/connectors",
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
        }),
      );
      app.use(
        "/api/connectors",
        createGoogleWorkspaceRouter({
          oauthService: runtime.googleWorkspaceOAuthService,
          userStore: runtime.userStore,
          webBaseUrl: config.server?.webBaseUrl,
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
        }),
      );
    }
    // 公司级专职 Agent（组织管理员配置、员工使用；2026-07 唯恩批次）
    if (runtime.orgAgentStore) {
      app.use(
        "/api/org-agents",
        createOrgAgentsRouter({
          orgAgentStore: runtime.orgAgentStore,
          orgAgentAvatarsDir: resolve(processCwd, "./data/org-agent-avatars"),
          onSkillAssignmentsChanged: runtime.skillConfigStore
            ? () => runtime.skillConfigStore!.touchConfigVersion()
            : undefined,
        }),
      );
    }
  }
}
