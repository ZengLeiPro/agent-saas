import { resolve } from "node:path";
import express from "express";
import type { Express, Request, Response } from "express";

import type { AppRuntime } from "./runtime.js";
import type { TenantStore } from "../data/tenants/store.js";
import type { TitleGeneratorConfig } from "../agent/titleGenerator.js";
import {
  getPublicModelList,
  getTenantPublicModelList,
  resolveContextAccountingFromModels,
  resolveModelRef,
} from "./models.js";
import { DEFAULT_TENANT_ID } from "../data/tenants/types.js";

import {
  createHealthRouter,
  createUploadRouter,
  createCronRouter,
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
} from "../routes/index.js";
import { createAuthRouter } from "../routes/auth.js";
import { createSignupRouters } from "../routes/signup.js";
import { requireAdmin } from "../auth/middleware.js";
import { createAgentsRouter } from "../routes/agents.js";
import { createRuntimeAuditRouter } from "../routes/runtimeAudit.js";
import { createRuntimeTraceRouter } from "../routes/runtimeTrace.js";
import { RuntimeEfficiencyQuery } from "../runtime/efficiencyQuery.js";
import { createSkillsRouter } from "../routes/skills.js";
import { createMcpRouter } from "../routes/mcp.js";
import { createTenantsRouter } from "../routes/tenants.js";
import { createModelsAdminRouter } from "../routes/modelsAdmin.js";
import { createTenantRemoteHandsAdminRouter } from "../routes/tenantRemoteHandsAdmin.js";
import { createRuntimeOperationsAdminRouter } from "../routes/runtimeOperationsAdmin.js";
import { createToolControlsAdminRouter } from "../routes/toolControlsAdmin.js";
import { createAdminBillingRouter, createBillingRouter } from "../routes/billing.js";
import { createAzerothProxyRouter } from "../routes/azeroth-proxy.js";
import { createDingtalkSessionRouter } from "../channels/dingtalk/protocol/sessionRouter.js";
import type { WebChannel } from "../channels/web/channel.js";
import { initAuditLog, clearLogsByUsername } from "../data/login-logs/index.js";
import { configureModelPricing } from "../data/usage/pricing.js";

function tenantFeatureGuard(
  tenantStore: TenantStore | undefined,
  feature:
    | "filesEnabled"
    | "cronEnabled"
    | "mcpEnabled"
    | "customSkillsEnabled",
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
  const {
    config,
    agentCwd,
    sharedDir,
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
      getActiveRunCounts: runtime.runtimeRunStore?.getActiveCounts
        ? () => runtime.runtimeRunStore!.getActiveCounts!()
        : undefined,
      getIsDraining: () => channelManager.draining,
    }),
  );
  // App update: version check + APK download
  const mobileDir = resolve(import.meta.dirname, "../../../mobile");
  app.use("/api", createAppUpdateRouter({ mobileDir }));

  app.use(
    "/api/upload",
    tenantFeatureGuard(runtime.tenantStore, "filesEnabled", "文件能力"),
  );
  app.use(
    "/api/file",
    tenantFeatureGuard(runtime.tenantStore, "filesEnabled", "文件能力"),
  );
  app.use("/api", createUploadRouter({ agentCwd }));
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
      getStreamStatus: webChannel
        ? (sid) => webChannel.getStreamStatus(sid)
        : undefined,
      broadcastToUser: webChannel
        ? (userId, data) =>
            webChannel.getWsServer()?.broadcastToUser(userId, data)
        : undefined,
      titleGeneratorConfigs: runtime.titleGeneratorConfigs,
      tokenUsageStore: runtime.tokenUsageStore,
      getEventBus: webChannel ? () => webChannel.getEventBus() : undefined,
      runtimeEventStoreFor: runtime.runtimeEventStoreFor,
      resolveContextAccounting: (modelRef) => resolveContextAccountingFromModels(config.models, modelRef),
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
      res.json(getTenantPublicModelList(config.models!, tenantSettings));
    });
    app.use(
      "/api/admin/models",
      createModelsAdminRouter({
        processCwd,
        config,
        onModelsUpdated: (models) => {
          configureModelPricing(models);
          // 模型列表热更新：重建 titleGenerator 配置链。
          // resolveModelRef 找不到任一引用都保留原链——避免热更瞬时把功能打挂。
          if (!config.titleGenerator?.model) return;
          const merged = { ...models, default: models.default };
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
    }),
  );
  app.use(
    "/api/admin/tool-controls",
    createToolControlsAdminRouter({
      processCwd,
      config,
      validateToolSettingsConfig: runtime.validateToolSettingsConfig,
      onToolSettingsUpdated: runtime.updateToolSettingsConfig,
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

  // Token 用量统计（admin-only），数据由 b4187f00 引入的 business.sqlite 提供
  if (runtime.tokenUsageStore) {
    app.use(
      "/api/admin/usage",
      requireAdmin,
      createUsageRouter({
        tokenUsageStore: runtime.tokenUsageStore,
        userStore: runtime.userStore,
        triggerRebuild: runtime.triggerTokenUsageRebuild,
      }),
    );
  }

  if (runtime.billingService) {
    app.use("/api/billing", createBillingRouter({ billingService: runtime.billingService }));
    app.use(
      "/api/admin/billing",
      requireAdmin,
      createAdminBillingRouter({ billingService: runtime.billingService }),
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

  // Agent 运行监测读 API（平台 admin-only，router 内 isPlatformAdmin 再硬拦一层）：
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
        efficiencyQuery: new RuntimeEfficiencyQuery({
          pool: runtime.runtimePgEventStore.pool,
          eventsTable: runtime.runtimePgEventStore.eventsTable,
          runsTable: runtime.runtimeRunStore.runsTable,
          billingUsageEventsTable: runtimeTraceBillingStore.usageEventsTable,
        }),
      }),
    );
  }

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
        onUserDisabled: webChannel
          ? (userId: string) => webChannel.disconnectUser(userId)
          : undefined,
        skillConfigStore: runtime.skillConfigStore,
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
        loginLogFilePath,
        skillConfigStore: runtime.skillConfigStore,
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
          onTenantDisabled: webChannel
            ? (tenantId: string) => webChannel.disconnectTenant(tenantId)
            : undefined,
        }),
      );
    }
    // Skill management
    if (runtime.skillConfigStore) {
      app.use(
        "/api/skills",
        tenantFeatureGuard(runtime.tenantStore, "customSkillsEnabled", "Skill"),
      );
      app.use(
        "/api/skills",
        createSkillsRouter({
          skillConfigStore: runtime.skillConfigStore,
          userStore: runtime.userStore!,
          agentCwd,
          sharedDir,
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
          userStore: runtime.userStore!,
          skillConfigStore: runtime.skillConfigStore,
          getMemoryIndexService: runtime.getMemoryIndexService,
        }),
      );
    }
  }
}
