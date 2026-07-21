import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => {
  const healthRouter = { id: 'health-router' };
  const appUpdateRouter = { id: 'app-update-router' };
  const uploadRouter = { id: 'upload-router' };
  const fileRouter = { id: 'file-router' };
  const voiceRouter = { id: 'voice-router' };
  const ttsRouter = { id: 'tts-router' };
  const sessionsRouter = { id: 'sessions-router' };
  const searchRouter = { id: 'search-router' };
  const scenariosRouter = { id: 'scenarios-router' };
  const workflowDemosRouter = { id: 'workflow-demos-router' };
  const contentOpsRouter = { id: 'content-ops-router' };
  const dwsRouter = { id: 'dws-router' };
  const userRoleRouter = { id: 'user-role-router' };
  const dingtalkRouter = { id: 'dingtalk-router' };
  const cronRouter = { id: 'cron-router' };
  const groupsRouter = { id: 'groups-router' };
  const tenantRemoteHandsAdminRouter = { id: 'tenant-remote-hands-admin-router' };
  const runtimeOperationsAdminRouter = { id: 'runtime-operations-admin-router' };
  const platformObservabilityRouter = { id: 'platform-observability-router' };
  const systemAdminRouter = { id: 'system-admin-router' };
  const internalAcsAlertsRouter = { id: 'internal-acs-alerts-router' };
  const toolControlsAdminRouter = { id: 'tool-controls-admin-router' };
  const previewTokenRouter = { id: 'preview-token-router' };
  const previewServeRouter = { id: 'preview-serve-router' };
  const kbFilesRouter = { id: 'kb-files-router' };
  const orgQaRouter = { id: 'org-qa-router' };
  const feedbackRouter = { id: 'feedback-router' };
  const requireAdmin = vi.fn((_req: unknown, _res: unknown, next: () => void) => next());

  return {
    healthRouter,
    appUpdateRouter,
    uploadRouter,
    fileRouter,
    voiceRouter,
    ttsRouter,
    sessionsRouter,
    searchRouter,
    scenariosRouter,
    workflowDemosRouter,
    contentOpsRouter,
    dwsRouter,
    userRoleRouter,
    dingtalkRouter,
    cronRouter,
    groupsRouter,
    tenantRemoteHandsAdminRouter,
    runtimeOperationsAdminRouter,
    platformObservabilityRouter,
    systemAdminRouter,
    internalAcsAlertsRouter,
    toolControlsAdminRouter,
    previewTokenRouter,
    previewServeRouter,
    kbFilesRouter,
    orgQaRouter,
    feedbackRouter,
    requireAdmin,
    createHealthRouter: vi.fn(() => healthRouter),
    createAppUpdateRouter: vi.fn(() => appUpdateRouter),
    createUploadRouter: vi.fn(() => uploadRouter),
    createFileRouter: vi.fn(() => fileRouter),
    createVoiceRouter: vi.fn(() => voiceRouter),
    createTtsRouter: vi.fn(() => ttsRouter),
    createSessionsRouter: vi.fn(() => sessionsRouter),
    createSearchRouter: vi.fn(() => searchRouter),
    createScenariosRouter: vi.fn(() => scenariosRouter),
    createWorkflowDemosRouter: vi.fn(() => workflowDemosRouter),
    createContentOpsRouter: vi.fn(() => contentOpsRouter),
    createDwsRouter: vi.fn(() => dwsRouter),
    createUserRoleRouter: vi.fn(() => userRoleRouter),
    createDingtalkSessionRouter: vi.fn(() => dingtalkRouter),
    createCronRouter: vi.fn(() => cronRouter),
    createGroupsRouter: vi.fn(() => groupsRouter),
    createTenantRemoteHandsAdminRouter: vi.fn(() => tenantRemoteHandsAdminRouter),
    createRuntimeOperationsAdminRouter: vi.fn(() => runtimeOperationsAdminRouter),
    createPlatformObservabilityRouter: vi.fn(() => platformObservabilityRouter),
    createSystemAdminRouter: vi.fn(() => systemAdminRouter),
    createInternalAcsAlertsRouter: vi.fn(() => internalAcsAlertsRouter),
    createToolControlsAdminRouter: vi.fn(() => toolControlsAdminRouter),
    createPreviewRoutes: vi.fn(() => ({ tokenRouter: previewTokenRouter, serveRouter: previewServeRouter })),
    createKbFilesRouter: vi.fn(() => kbFilesRouter),
    createOrgQaRouter: vi.fn(() => orgQaRouter),
    createFeedbackRouter: vi.fn(() => feedbackRouter),
  };
});

vi.mock('../routes/index.js', () => ({
  createHealthRouter: mocked.createHealthRouter,
  createAppUpdateRouter: mocked.createAppUpdateRouter,
  createUploadRouter: mocked.createUploadRouter,
  createFileRouter: mocked.createFileRouter,
  createVoiceRouter: mocked.createVoiceRouter,
  createTtsRouter: mocked.createTtsRouter,
  createSessionsRouter: mocked.createSessionsRouter,
  createSearchRouter: mocked.createSearchRouter,
  createScenariosRouter: mocked.createScenariosRouter,
  createWorkflowDemosRouter: mocked.createWorkflowDemosRouter,
  createContentOpsRouter: mocked.createContentOpsRouter,
  createDwsRouter: mocked.createDwsRouter,
  createUserRoleRouter: mocked.createUserRoleRouter,
  createCronRouter: mocked.createCronRouter,
  createGroupsRouter: mocked.createGroupsRouter,
  createPreviewRoutes: mocked.createPreviewRoutes,
}));
vi.mock('../channels/dingtalk/protocol/sessionRouter.js', () => ({
  createDingtalkSessionRouter: mocked.createDingtalkSessionRouter,
}));
vi.mock('../routes/kbFiles.js', () => ({
  createKbFilesRouter: mocked.createKbFilesRouter,
}));
vi.mock('../routes/orgQa.js', () => ({
  createOrgQaRouter: mocked.createOrgQaRouter,
}));
vi.mock('../routes/feedback.js', () => ({
  createFeedbackRouter: mocked.createFeedbackRouter,
}));
vi.mock('../routes/tenantRemoteHandsAdmin.js', () => ({
  createTenantRemoteHandsAdminRouter: mocked.createTenantRemoteHandsAdminRouter,
}));
vi.mock('../routes/runtimeOperationsAdmin.js', () => ({
  createRuntimeOperationsAdminRouter: mocked.createRuntimeOperationsAdminRouter,
}));
vi.mock('../routes/platformObservability.js', () => ({
  createPlatformObservabilityRouter: mocked.createPlatformObservabilityRouter,
}));
vi.mock('../routes/systemAdmin.js', () => ({
  createSystemAdminRouter: mocked.createSystemAdminRouter,
}));
vi.mock('../routes/internalAcsAlerts.js', () => ({
  createInternalAcsAlertsRouter: mocked.createInternalAcsAlertsRouter,
}));
vi.mock('../routes/toolControlsAdmin.js', () => ({
  createToolControlsAdminRouter: mocked.createToolControlsAdminRouter,
}));

vi.mock('../auth/middleware.js', () => ({
  requireAdmin: mocked.requireAdmin,
  requireAuth: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  // imageGenPricingAdmin 路由（2026-07-15 生图批次）在 registerRoutes 时挂载平台管理员守卫
  requirePlatformAdmin: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));

import { registerRoutes } from '../app/routes.js';

describe('registerRoutes', () => {
  beforeEach(() => {
    mocked.createHealthRouter.mockClear();
    mocked.createAppUpdateRouter.mockClear();
    mocked.createUploadRouter.mockClear();
    mocked.createFileRouter.mockClear();
    mocked.createVoiceRouter.mockClear();
    mocked.createTtsRouter.mockClear();
    mocked.createSessionsRouter.mockClear();
    mocked.createSearchRouter.mockClear();
    mocked.createScenariosRouter.mockClear();
    mocked.createWorkflowDemosRouter.mockClear();
    mocked.createContentOpsRouter.mockClear();
    mocked.createDwsRouter.mockClear();
    mocked.createUserRoleRouter.mockClear();
    mocked.createDingtalkSessionRouter.mockClear();
    mocked.createCronRouter.mockClear();
    mocked.createGroupsRouter.mockClear();
    mocked.createTenantRemoteHandsAdminRouter.mockClear();
    mocked.createRuntimeOperationsAdminRouter.mockClear();
    mocked.createPlatformObservabilityRouter.mockClear();
    mocked.createSystemAdminRouter.mockClear();
    mocked.createInternalAcsAlertsRouter.mockClear();
    mocked.createToolControlsAdminRouter.mockClear();
    mocked.createPreviewRoutes.mockClear();
  });

  it('registers base routes and skips cron route when cron service is absent', () => {
    const app = {
      use: vi.fn(),
      get: vi.fn(),
    };

    const runtime: any = {
      config: { server: {}, agent: { userOverrides: { zengky: { extraDirs: ['/Users/admin/code/kai'] } } } },
      agentCwd: '/agent',
      sessionBasePath: '/sessions',
      dingtalkDeps: {
        sessionService: { loadSessions: vi.fn() },
        deliveryService: { sendMessage: vi.fn() },
      },
      dispatchMetricsStore: {
        getSnapshot: vi.fn(() => ({ totalRuns: 0 })),
      },
      channelManager: {
        getActiveStreamCount: vi.fn(() => 0),
        getChannel: vi.fn(() => undefined),
        draining: false,
      },
      cronRuntime: {
        service: null,
        cronRunsDir: '/runs',
      },
      groupStore: {},
      userStore: undefined,
      workflowDemoStore: {},
    };

    registerRoutes(app as any, runtime);

    expect(mocked.createHealthRouter).toHaveBeenCalledWith(
      runtime.config,
      expect.objectContaining({
        getDispatchMetrics: expect.any(Function),
      }),
    );
    expect(mocked.createUploadRouter).toHaveBeenCalledWith({ agentCwd: '/agent' });
    expect(mocked.createFileRouter).toHaveBeenCalledWith({
      agentCwd: '/agent',
      userOverrides: { zengky: { extraDirs: ['/Users/admin/code/kai'] } },
    });
    expect(mocked.createPreviewRoutes).toHaveBeenCalledWith({
      agentCwd: '/agent',
      userOverrides: { zengky: { extraDirs: ['/Users/admin/code/kai'] } },
    });
    expect(mocked.createSearchRouter).toHaveBeenCalledWith({
      agentCwd: '/agent',
      userStore: runtime.userStore,
    });
    expect(mocked.createWorkflowDemosRouter).toHaveBeenCalledWith({
      store: runtime.workflowDemoStore,
    });
    expect(mocked.createSessionsRouter).toHaveBeenCalledWith(
      expect.objectContaining({
        agentCwd: '/agent',
        dingtalkSessionsBasePath: '/sessions',
        cronRunsDir: '/runs',
      }),
    );
    expect(mocked.createDingtalkSessionRouter).toHaveBeenCalledWith({
      sessionService: runtime.dingtalkDeps.sessionService,
      deliveryService: runtime.dingtalkDeps.deliveryService,
    });
    expect(mocked.createCronRouter).not.toHaveBeenCalled();
    expect(mocked.createDwsRouter).toHaveBeenCalledWith({
      connectionStore: runtime.dwsConnectionStore,
      authFlowService: runtime.dwsAuthFlowService,
      userStore: runtime.userStore,
    });

    // Base routes: health + app-update + upload-guard + file-guard + upload + file + azeroth-proxy
    //   + preview(token+serve) + voice + tts + search + scenarios + contentops + sessions + dingtalk
    //   + tenant-remote-hands admin + runtime-operations admin + observability admin
    //   + system admin + internal ACS alerts + tool-controls admin + groups = 23
    //   + kb files（kbEnabled guard 与 router 同一次 use 注册）+ feedback + DWS + qa admin = 27
    //   + image-gen pricing admin + memory-polling admin = 29
    //   + 平台管理员分层治理 enforcePlatformWritePolicy（2026-07-18）= 30
    //   + 员工申诉 /api/appeals + /api/tenant/appeals（2026-07-19 装配）= 32
    //   + Workflow Demo 状态化运行/公开回放 = 33
    // 注：upload-guard / file-guard 是 tenantFeatureGuard("filesEnabled") 中间件，
    //     无条件注册（cron/mcp 的 guard 仅在对应 service 存在时注册，本用例未命中）。
    expect(app.use).toHaveBeenCalledTimes(33);
    expect(app.use).toHaveBeenCalledWith('/api/kb', expect.any(Function), mocked.kbFilesRouter);
    expect(app.use).toHaveBeenCalledWith('/api/feedback', mocked.feedbackRouter);
    expect(app.use).toHaveBeenCalledWith('/api/appeals', expect.any(Function));
    expect(app.use).toHaveBeenCalledWith('/api/tenant/appeals', expect.any(Function));
    expect(app.use).toHaveBeenCalledWith('/api', mocked.dwsRouter);
    expect(app.use).toHaveBeenCalledWith('/api/admin/qa', mocked.requireAdmin, mocked.orgQaRouter);
    expect(app.use).toHaveBeenCalledWith('/api', mocked.healthRouter);
    expect(app.use).toHaveBeenCalledWith('/api', mocked.appUpdateRouter);
    expect(app.use).toHaveBeenCalledWith('/api', mocked.uploadRouter);
    expect(app.use).toHaveBeenCalledWith('/api', mocked.fileRouter);
    expect(app.use).toHaveBeenCalledWith('/api', mocked.previewTokenRouter);
    expect(app.use).toHaveBeenCalledWith('/preview', mocked.previewServeRouter);
    expect(app.use).toHaveBeenCalledWith('/api/search', mocked.searchRouter);
    expect(app.use).toHaveBeenCalledWith('/api/scenarios', mocked.scenariosRouter);
    expect(app.use).toHaveBeenCalledWith('/api', mocked.workflowDemosRouter);
    expect(app.use).toHaveBeenCalledWith('/api/contentops', mocked.contentOpsRouter);
    expect(app.use).toHaveBeenCalledWith('/api', mocked.sessionsRouter);
    expect(app.use).toHaveBeenCalledWith('/api', mocked.groupsRouter);
    expect(app.use).toHaveBeenCalledWith('/api/dingtalk', mocked.requireAdmin, mocked.dingtalkRouter);
    expect(app.use).toHaveBeenCalledWith('/api/admin/tenant-remote-hands', mocked.tenantRemoteHandsAdminRouter);
    expect(app.use).toHaveBeenCalledWith('/api/admin/runtime-operations', mocked.runtimeOperationsAdminRouter);
    expect(app.use).toHaveBeenCalledWith('/api/admin', mocked.requireAdmin, mocked.platformObservabilityRouter);
    expect(app.use).toHaveBeenCalledWith('/api/admin/system', mocked.requireAdmin, mocked.systemAdminRouter);
    expect(app.use).toHaveBeenCalledWith('/api/internal', mocked.internalAcsAlertsRouter);
    expect(app.use).toHaveBeenCalledWith('/api/admin/tool-controls', mocked.toolControlsAdminRouter);
    expect(app.use).toHaveBeenCalledWith('/api/admin/image-gen-pricing', expect.any(Function));
    expect(app.use).toHaveBeenCalledWith('/api/admin/memory-polling', expect.any(Function));
  });

  it('registers cron route when cron service is present', () => {
    const app = {
      use: vi.fn(),
      get: vi.fn(),
    };
    const cronService = { getStatus: vi.fn() };

    const runtime: any = {
      config: { server: {}, agent: { userOverrides: undefined } },
      agentCwd: '/agent',
      sessionBasePath: '/sessions',
      dingtalkDeps: {
        sessionService: { loadSessions: vi.fn() },
        deliveryService: { sendMessage: vi.fn() },
      },
      dispatchMetricsStore: {
        getSnapshot: vi.fn(() => ({ totalRuns: 0 })),
      },
      channelManager: {
        getActiveStreamCount: vi.fn(() => 0),
        getChannel: vi.fn(() => undefined),
        draining: false,
      },
      cronRuntime: {
        service: cronService,
        cronRunsDir: '/runs',
      },
      groupStore: {},
      userStore: undefined,
      workflowDemoStore: {},
    };

    registerRoutes(app as any, runtime);

    expect(mocked.createCronRouter).toHaveBeenCalledWith(cronService, '/runs', runtime.groupStore);
    // 12 base + 1 cron = 13
    expect(app.use).toHaveBeenCalledWith('/api/cron', mocked.cronRouter);
  });
});
