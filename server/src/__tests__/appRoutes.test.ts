import express from 'express';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => {
  const healthRouter = { id: 'health-router' };
  const appUpdateRouter = { id: 'app-update-router' };
  const mobileTelemetryRouter = { id: 'mobile-telemetry-router' };
  const uploadRouter = { id: 'upload-router' };
  const fileRouter = { id: 'file-router' };
  const voiceRouter = { id: 'voice-router' };
  const ttsRouter = { id: 'tts-router' };
  const sessionsRouter = { id: 'sessions-router' };
  const searchRouter = { id: 'search-router' };
  const scenariosRouter = { id: 'scenarios-router' };
  const contentOpsRouter = { id: 'content-ops-router' };
  const dwsRouter = { id: 'dws-router' };
  const feishuRouter = { id: 'feishu-router' };
  const contextCitationsRouter = { id: 'context-citations-router' };
  const contextAdminRouter = { id: 'context-admin-router' };
  const userRoleRouter = { id: 'user-role-router' };
  const dingtalkRouter = { id: 'dingtalk-router' };
  const cronRouter = { id: 'cron-router' };
  const webPushRouter = { id: 'web-push-router' };
  const taskboardRouter = { id: 'taskboard-router' };
  const groupsRouter = { id: 'groups-router' };
  const tenantRemoteHandsAdminRouter = { id: 'tenant-remote-hands-admin-router' };
  const runtimeOperationsAdminRouter = { id: 'runtime-operations-admin-router' };
  const platformObservabilityRouter = { id: 'platform-observability-router' };
  const systemAdminRouter = { id: 'system-admin-router' };
  const internalAcsAlertsRouter = { id: 'internal-acs-alerts-router' };
  const toolControlsAdminRouter = { id: 'tool-controls-admin-router' };
  const audioTranscribeAdminRouter = { id: 'audio-transcribe-admin-router' };
  const connectorDictionaryAdminRouter = { id: 'connector-dictionary-admin-router' };
  const systemPromptsRouter = { id: 'system-prompts-router' };
  const previewTokenRouter = { id: 'preview-token-router' };
  const previewServeRouter = { id: 'preview-serve-router' };
  const kbFilesRouter = { id: 'kb-files-router' };
  const orgQaRouter = { id: 'org-qa-router' };
  const feedbackRouter = { id: 'feedback-router' };
  const azerothProxyRouter = { id: 'azeroth-proxy-router' };
  const requireAdmin = vi.fn((_req: unknown, _res: unknown, next: () => void) => next());

  return {
    healthRouter,
    appUpdateRouter,
    mobileTelemetryRouter,
    uploadRouter,
    fileRouter,
    voiceRouter,
    ttsRouter,
    sessionsRouter,
    searchRouter,
    scenariosRouter,
    contentOpsRouter,
    dwsRouter,
    feishuRouter,
    contextCitationsRouter,
    contextAdminRouter,
    userRoleRouter,
    dingtalkRouter,
    cronRouter,
    webPushRouter,
    taskboardRouter,
    groupsRouter,
    tenantRemoteHandsAdminRouter,
    runtimeOperationsAdminRouter,
    platformObservabilityRouter,
    systemAdminRouter,
    internalAcsAlertsRouter,
    toolControlsAdminRouter,
    audioTranscribeAdminRouter,
    connectorDictionaryAdminRouter,
    systemPromptsRouter,
    previewTokenRouter,
    previewServeRouter,
    kbFilesRouter,
    orgQaRouter,
    feedbackRouter,
    azerothProxyRouter,
    requireAdmin,
    createHealthRouter: vi.fn(() => healthRouter),
    createAppUpdateRouter: vi.fn(() => appUpdateRouter),
    configuredMobileTelemetryRouter: vi.fn(() => mobileTelemetryRouter),
    createUploadRouter: vi.fn(() => uploadRouter),
    createFileRouter: vi.fn(() => fileRouter),
    createVoiceRouter: vi.fn(() => voiceRouter),
    createTtsRouter: vi.fn(() => ttsRouter),
    createSessionsRouter: vi.fn(() => sessionsRouter),
    createSearchRouter: vi.fn(() => searchRouter),
    createScenariosRouter: vi.fn(() => scenariosRouter),
    createContentOpsRouter: vi.fn(() => contentOpsRouter),
    createDwsRouter: vi.fn(() => dwsRouter),
    createFeishuRouter: vi.fn(() => feishuRouter),
    createContextCitationsRouter: vi.fn(() => contextCitationsRouter),
    createContextAdminRouter: vi.fn(() => contextAdminRouter),
    createUserRoleRouter: vi.fn(() => userRoleRouter),
    createDingtalkSessionRouter: vi.fn(() => dingtalkRouter),
    createCronRouter: vi.fn(() => cronRouter),
    createWebPushRouter: vi.fn(() => webPushRouter),
    createTaskboardRouter: vi.fn(() => taskboardRouter),
    createGroupsRouter: vi.fn(() => groupsRouter),
    createTenantRemoteHandsAdminRouter: vi.fn(() => tenantRemoteHandsAdminRouter),
    createRuntimeOperationsAdminRouter: vi.fn(() => runtimeOperationsAdminRouter),
    createPlatformObservabilityRouter: vi.fn(() => platformObservabilityRouter),
    createSystemAdminRouter: vi.fn(() => systemAdminRouter),
    createInternalAcsAlertsRouter: vi.fn(() => internalAcsAlertsRouter),
    createToolControlsAdminRouter: vi.fn(() => toolControlsAdminRouter),
    createAudioTranscribeAdminRouter: vi.fn(() => audioTranscribeAdminRouter),
    createConnectorDictionaryAdminRouter: vi.fn(() => connectorDictionaryAdminRouter),
    createSystemPromptsAdminRouter: vi.fn(() => systemPromptsRouter),
    createPreviewRoutes: vi.fn(() => ({ tokenRouter: previewTokenRouter, serveRouter: previewServeRouter })),
    createKbFilesRouter: vi.fn(() => kbFilesRouter),
    createOrgQaRouter: vi.fn(() => orgQaRouter),
    createFeedbackRouter: vi.fn(() => feedbackRouter),
    createAzerothProxyRouter: vi.fn(() => azerothProxyRouter),
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
  createContentOpsRouter: mocked.createContentOpsRouter,
  createDwsRouter: mocked.createDwsRouter,
  createFeishuRouter: mocked.createFeishuRouter,
  createContextCitationsRouter: mocked.createContextCitationsRouter,
  createContextAdminRouter: mocked.createContextAdminRouter,
  createUserRoleRouter: mocked.createUserRoleRouter,
  createCronRouter: mocked.createCronRouter,
  createWebPushRouter: mocked.createWebPushRouter,
  createTaskboardRouter: mocked.createTaskboardRouter,
  createGroupsRouter: mocked.createGroupsRouter,
  createPreviewRoutes: mocked.createPreviewRoutes,
}));
vi.mock('../telemetry/mobileTelemetry.js', () => ({
  configuredMobileTelemetryRouter: mocked.configuredMobileTelemetryRouter,
}));

vi.mock('../routes/azeroth-proxy.js', () => ({
  createAzerothProxyRouter: mocked.createAzerothProxyRouter,
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
vi.mock('../routes/runtimeOperationsAdmin.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../routes/runtimeOperationsAdmin.js')>(),
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
vi.mock('../routes/audioTranscribeAdmin.js', () => ({
  createAudioTranscribeAdminRouter: mocked.createAudioTranscribeAdminRouter,
}));
vi.mock('../routes/connectorDictionaryAdmin.js', () => ({
  createConnectorDictionaryAdminRouter: mocked.createConnectorDictionaryAdminRouter,
}));
vi.mock('../routes/systemPromptsAdmin.js', () => ({
  createSystemPromptsAdminRouter: mocked.createSystemPromptsAdminRouter,
}));

vi.mock('../auth/middleware.js', () => ({
  requireAdmin: mocked.requireAdmin,
  requireAuth: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  // imageGenPricingAdmin 路由（2026-07-15 生图批次）在 registerRoutes 时挂载平台管理员守卫
  requirePlatformAdmin: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));

import { activeOffboardingWriteFence, registerRoutes } from '../app/routes.js';

describe('registerRoutes', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('AGENT_SAAS_ALLOW_UNIDENTIFIED_ENVIRONMENT', '1');
    mocked.createHealthRouter.mockClear();
    mocked.createAppUpdateRouter.mockClear();
    mocked.configuredMobileTelemetryRouter.mockClear();
    mocked.createUploadRouter.mockClear();
    mocked.createFileRouter.mockClear();
    mocked.createVoiceRouter.mockClear();
    mocked.createTtsRouter.mockClear();
    mocked.createSessionsRouter.mockClear();
    mocked.createSearchRouter.mockClear();
    mocked.createScenariosRouter.mockClear();
    mocked.createContentOpsRouter.mockClear();
    mocked.createDwsRouter.mockClear();
    mocked.createFeishuRouter.mockClear();
    mocked.createContextCitationsRouter.mockClear();
    mocked.createContextAdminRouter.mockClear();
    mocked.createUserRoleRouter.mockClear();
    mocked.createDingtalkSessionRouter.mockClear();
    mocked.createCronRouter.mockClear();
    mocked.createWebPushRouter.mockClear();
    mocked.createTaskboardRouter.mockClear();
    mocked.createGroupsRouter.mockClear();
    mocked.createTenantRemoteHandsAdminRouter.mockClear();
    mocked.createRuntimeOperationsAdminRouter.mockClear();
    mocked.createPlatformObservabilityRouter.mockClear();
    mocked.createSystemAdminRouter.mockClear();
    mocked.createInternalAcsAlertsRouter.mockClear();
    mocked.createToolControlsAdminRouter.mockClear();
    mocked.createAudioTranscribeAdminRouter.mockClear();
    mocked.createSystemPromptsAdminRouter.mockClear();
    mocked.createPreviewRoutes.mockClear();
  });

  afterEach(() => vi.unstubAllEnvs());

  it('registers base routes, config baseline/identity callbacks, and skips cron without a service', async () => {
    const app = {
      use: vi.fn(),
      get: vi.fn(),
    };

    const runtime: any = {
      processRole: 'ws-only',
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
      uploadManager: {
        getMetricsSnapshot: vi.fn(() => ({ activeUploads: 0 })),
      },
      getRuntimeAdmissionSnapshot: vi.fn(() => ({ state: 'healthy', admitting: true })),
      cronRuntime: {
        service: null,
        cronRunsDir: '/runs',
      },
      groupStore: {},
      userStore: undefined,
      refreshSharedConfig: vi.fn(async () => true),
      validateSharedConfigCandidate: vi.fn(async () => undefined),
      refreshVoiceTranscriptionConfig: vi.fn(async () => true),
    };

    registerRoutes(app as any, runtime);

    // Tool 与 STT 都必须通过同一 force=true 共享配置刷新器建立完整基线。
    expect(mocked.createHealthRouter).toHaveBeenCalledWith(
      runtime.config,
      expect.objectContaining({
        getDispatchMetrics: expect.any(Function),
        getRuntimeAdmissionSnapshot: expect.any(Function),
      }),
    );
    const healthOptions = (mocked.createHealthRouter as any).mock.calls[0]?.[1];
    expect(healthOptions.getRuntimeAdmissionSnapshot).not.toBe(runtime.getRuntimeAdmissionSnapshot);
    const systemAdminOptions = (mocked.createSystemAdminRouter as any).mock.calls[0]?.[0];
    expect(systemAdminOptions.getRuntimeWorkerAdmissionSnapshot).toBe(
      healthOptions.getRuntimeAdmissionSnapshot,
    );
    expect(mocked.createUploadRouter).toHaveBeenCalledWith({
      agentCwd: '/agent',
      uploadManager: runtime.uploadManager,
      sessionCatalog: runtime.sessionCatalog,
    });
    expect(mocked.createFileRouter).toHaveBeenCalledWith({
      agentCwd: '/agent',
      userOverrides: { zengky: { extraDirs: ['/Users/admin/code/kai'] } },
    });
    expect(mocked.createVoiceRouter).toHaveBeenCalledWith({
      agentCwd: '/agent',
      transcriptionService: runtime.voiceTranscriptionService,
      refreshSharedConfig: runtime.refreshVoiceTranscriptionConfig,
    });
    // Legacy grants are checked against live principal and auth-epoch state.
    expect(mocked.createPreviewRoutes).toHaveBeenCalledWith({
      agentCwd: '/agent',
      userOverrides: { zengky: { extraDirs: ['/Users/admin/code/kai'] } },
      userStore: runtime.userStore,
      authEpochAuthority: runtime.authEpochAuthority,
    });
    expect(mocked.createSearchRouter).toHaveBeenCalledWith({
      agentCwd: '/agent',
      userStore: runtime.userStore,
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
    expect(mocked.createFeishuRouter).toHaveBeenCalledWith({
      connectionStore: runtime.feishuConnectionStore,
      authFlowService: runtime.feishuAuthFlowService,
      userStore: runtime.userStore,
    });

    // Base routes（health 与 system admin 共享 active worker readiness）: health + app-update + upload-guard + file-guard + upload + file + azeroth-proxy
    //   + preview(token+serve) + voice + tts + search + scenarios + contentops + sessions + dingtalk
    //   + tenant-remote-hands admin + runtime-operations admin + observability admin
    //   + system admin + internal ACS alerts + tool-controls admin + groups = 23
    //   + kb files（kbEnabled guard 与 router 同一次 use 注册）+ feedback + DWS + qa admin = 27
    //   + image-gen pricing admin + memory-polling admin = 29
    //   + 平台管理员分层治理 enforcePlatformWritePolicy（2026-07-18）= 30
    //   + 员工申诉 /api/appeals + /api/tenant/appeals（2026-07-19 装配）= 32
    //   + 飞书官方 CLI 连接器 = 33
    //   + 系统提示语管理 = 34
    //   + 附件用量/清理 guard = 35
    //   + Agent 运行 Profile 平台管理 = 36
    //   + Codex 订阅连接管理 = 37
    //   + 连接器映射词典平台管理（2026-08-03）= 38
    //   + 租户级词典覆盖组织管理（2026-08-04 任务 E）= 39
    //   + 个人任务看板（复用 cronEnabled guard）= 40
    //   + 活跃离职流程 API 写入围栏 = 41
    //   + 音频转录平台管理 = 42
    //   + 当前用户 Web Push 订阅管理 = 43
    //   + Agent DWS 账号路由 = 44
    //   + Agent DWS 精确前缀管理员门禁 = 45
    //   + 租户专家模板 = 46
    //   + 普通用户 Context citation = 47
    //   + Context Plane 管理路由 = 48
    //   + 有效配置状态管理路由 = 49
    // 注：upload / uploads / file 三个 guard 都是 tenantFeatureGuard("filesEnabled") 中间件，
    //     无条件注册（cron/mcp 的 guard 仅在对应 service 存在时注册，本用例未命中）。
    expect(app.use).toHaveBeenCalledTimes(50);
    expect(app.use).toHaveBeenCalledWith('/api/admin/config-status', expect.any(Function));
    expect(app.use).toHaveBeenCalledWith('/api', mocked.contextCitationsRouter);
    expect(app.use).toHaveBeenCalledWith(
      '/api/admin/context-plane', mocked.requireAdmin, mocked.contextAdminRouter,
    );
    expect(app.use).toHaveBeenCalledWith('/api/tenant/expert-templates', expect.any(Function));
    expect(mocked.createWebPushRouter).toHaveBeenCalledWith(undefined);
    expect(app.use).toHaveBeenCalledWith('/api/web-push', mocked.webPushRouter);
    expect(mocked.createTaskboardRouter).toHaveBeenCalledWith({
      service: undefined,
      executionService: undefined,
      userStore: undefined,
      agentCwd: '/agent',
      uploadManager: runtime.uploadManager,
      generateTaskTitle: expect.any(Function),
    });
    expect(app.use).toHaveBeenCalledWith(
      '/api/taskboard',
      expect.any(Function),
      mocked.taskboardRouter,
    );
    expect(app.use).toHaveBeenCalledWith('/api/org/connector-dictionary', expect.any(Function));
    expect(app.use).toHaveBeenCalledWith('/api/admin/system-prompts', mocked.systemPromptsRouter);
    expect(app.use).toHaveBeenCalledWith('/api/admin/agent-profiles', expect.any(Function));
    expect(app.use).toHaveBeenCalledWith('/api/admin/codex-subscription', expect.any(Function));
    expect(app.use).toHaveBeenCalledWith('/api/kb', expect.any(Function), mocked.kbFilesRouter);
    expect(app.use).toHaveBeenCalledWith('/api/feedback', mocked.feedbackRouter);
    expect(app.use).toHaveBeenCalledWith('/api/appeals', expect.any(Function));
    expect(app.use).toHaveBeenCalledWith('/api/tenant/appeals', expect.any(Function));
    expect(app.use).toHaveBeenCalledWith('/api', mocked.dwsRouter);
    expect(app.use).toHaveBeenCalledWith('/api/agent-dws-accounts', mocked.requireAdmin);
    expect(app.use).not.toHaveBeenCalledWith('/api', mocked.requireAdmin, expect.anything());
    expect(app.use).toHaveBeenCalledWith('/api/admin/qa', mocked.requireAdmin, mocked.orgQaRouter);
    expect(app.use).toHaveBeenCalledWith('/api', mocked.healthRouter);
    expect(mocked.configuredMobileTelemetryRouter).toHaveBeenCalledWith('/agent/data');
    expect(app.use).toHaveBeenCalledWith('/api', mocked.mobileTelemetryRouter);
    expect(app.use).toHaveBeenCalledWith('/api', mocked.appUpdateRouter);
    expect(app.use).toHaveBeenCalledWith('/api', mocked.uploadRouter);
    expect(app.use).toHaveBeenCalledWith('/api', mocked.fileRouter);
    expect(app.use).toHaveBeenCalledWith('/api', mocked.voiceRouter);
    expect(app.use).toHaveBeenCalledWith('/api', mocked.previewTokenRouter);
    expect(app.use).toHaveBeenCalledWith('/preview', mocked.previewServeRouter);
    expect(app.use).toHaveBeenCalledWith('/api/search', mocked.searchRouter);
    expect(app.use).toHaveBeenCalledWith('/api/scenarios', mocked.scenariosRouter);
    expect(app.use).toHaveBeenCalledWith('/api/contentops', mocked.contentOpsRouter);
    expect(app.use).toHaveBeenCalledWith('/api', mocked.sessionsRouter);
    expect(app.use).toHaveBeenCalledWith('/api', mocked.groupsRouter);
    expect(app.use).toHaveBeenCalledWith('/api/dingtalk', mocked.requireAdmin, mocked.dingtalkRouter);
    expect(app.use).toHaveBeenCalledWith('/api/admin/tenant-remote-hands', mocked.tenantRemoteHandsAdminRouter);
    expect(mocked.createTenantRemoteHandsAdminRouter).toHaveBeenCalledWith(expect.objectContaining({
      validateConfigReload: runtime.validateSharedConfigCandidate,
    }));
    expect(app.use).toHaveBeenCalledWith('/api/admin/runtime-operations', mocked.runtimeOperationsAdminRouter);
    expect(app.use).toHaveBeenCalledWith('/api/admin', mocked.requireAdmin, mocked.platformObservabilityRouter);
    expect(app.use).toHaveBeenCalledWith('/api/admin/system', mocked.requireAdmin, mocked.systemAdminRouter);
    expect(app.use).toHaveBeenCalledWith('/api/internal', mocked.internalAcsAlertsRouter);
    expect(app.use).toHaveBeenCalledWith('/api/admin/tool-controls', mocked.toolControlsAdminRouter);
    expect(app.use).toHaveBeenCalledWith('/api/admin/audio-transcribe', mocked.audioTranscribeAdminRouter);
    const toolOptions = (mocked.createToolControlsAdminRouter as any).mock.calls[0]?.[0];
    const audioOptions = (mocked.createAudioTranscribeAdminRouter as any).mock.calls[0]?.[0];
    expect(toolOptions).toEqual(expect.objectContaining({
      ensureConfigBaselineApplied: expect.any(Function), onConfigReloaded: expect.any(Function),
    }));
    expect(audioOptions).toEqual(expect.objectContaining({
      ensureConfigBaselineApplied: expect.any(Function), onConfigReloaded: expect.any(Function),
    }));
    await expect(toolOptions.ensureConfigBaselineApplied('tool-baseline')).resolves.toBe(true);
    await expect(audioOptions.ensureConfigBaselineApplied('audio-baseline')).resolves.toBe(true);
    expect(runtime.refreshSharedConfig).toHaveBeenNthCalledWith(1, true);
    expect(runtime.refreshSharedConfig).toHaveBeenNthCalledWith(2, true);
    expect(app.use).toHaveBeenCalledWith('/api/admin/connector-dictionary', mocked.connectorDictionaryAdminRouter);
    expect(app.use).toHaveBeenCalledWith('/api/admin/image-gen-pricing', expect.any(Function));
    expect(app.use).toHaveBeenCalledWith('/api/admin/memory-polling', expect.any(Function));
  });

  it('wires config identity into the real platform overview router and preserves its admin guard', async () => {
    const actualPlatformObservability = await vi.importActual<
      typeof import('../routes/platformObservability.js')
    >('../routes/platformObservability.js');
    (mocked.createPlatformObservabilityRouter as any).mockImplementationOnce(
      actualPlatformObservability.createPlatformObservabilityRouter,
    );

    const configIdentity: import('@agent/shared').ConfigIdentitySummary = {
      schemaVersion: 1,
      status: 'consistent',
      expected: { schemaVersion: 1, digest: `sha256:${'a'.repeat(64)}` },
      observed: {
        schemaVersion: 1,
        digest: `sha256:${'a'.repeat(64)}`,
        credentialVersionDigest: null,
        versionResolution: 'resolved',
        secretRefCount: 0,
      },
      releaseId: 'rc-register-routes-test',
      lastObservedAt: '2026-08-31T16:00:00.000Z',
    };
    const getConfigIdentitySummary = vi.fn(() => configIdentity);
    const registrationApp = { use: vi.fn(), get: vi.fn() };
    const runtime: any = {
      processRole: 'ws-only',
      config: {
        server: {},
        agent: { userOverrides: undefined },
        tenantRemoteHands: { hands: [] },
      },
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
      uploadManager: {
        getMetricsSnapshot: vi.fn(() => ({ activeUploads: 0 })),
      },
      cronRuntime: {
        service: null,
        cronRunsDir: '/runs',
      },
      groupStore: {},
      getConfigIdentitySummary,
    };

    registerRoutes(registrationApp as any, runtime);

    const platformOptions = (mocked.createPlatformObservabilityRouter as any).mock.calls.at(-1)?.[0];
    expect(platformOptions).toEqual(expect.objectContaining({
      getConfigIdentitySummary: expect.any(Function),
    }));
    expect(platformOptions?.getConfigIdentitySummary).not.toBe(getConfigIdentitySummary);

    const observabilityRouter = mocked.createPlatformObservabilityRouter.mock.results.at(-1)?.value;
    const registration = registrationApp.use.mock.calls.find(
      (call) => call[0] === '/api/admin' && call[2] === observabilityRouter,
    );
    expect(registration).toBeDefined();

    const app = express();
    app.use((req, _res, next) => {
      req.user = {
        sub: 'route-assembly-test',
        username: 'route-assembly-test',
        role: req.header('x-test-role') === 'user' ? 'user' : 'admin',
        tenantId: 'pantheon',
      };
      next();
    });
    app.use(registration![0], registration![1], registration![2]);
    const server = await new Promise<Server>((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });

    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('failed to bind test server');
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const forbidden = await fetch(`${baseUrl}/api/admin/overview/snapshot`, {
        headers: { 'x-test-role': 'user' },
      });
      expect(forbidden.status).toBe(403);
      expect(getConfigIdentitySummary).not.toHaveBeenCalled();

      const response = await fetch(`${baseUrl}/api/admin/overview/snapshot`);
      const responseBody = await response.json() as any;
      expect({ status: response.status, body: responseBody }).toEqual({
        status: 200,
        body: expect.objectContaining({ configIdentity }),
      });
      expect(getConfigIdentitySummary).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
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
      uploadManager: {
        getMetricsSnapshot: vi.fn(() => ({ activeUploads: 0 })),
      },
      cronRuntime: {
        service: cronService,
        cronRunsDir: '/runs',
      },
      groupStore: {},
      userStore: undefined,
    };

    registerRoutes(app as any, runtime);

    expect(mocked.createCronRouter).toHaveBeenCalledWith(cronService, '/runs', runtime.groupStore);
    // base routes + cron
    expect(app.use).toHaveBeenCalledWith('/api/cron', mocked.cronRouter);
  });
});

describe('activeOffboardingWriteFence', () => {
  it('store 缺失时相关写请求 fail-closed，读取与未认证请求仍放行', async () => {
    const middleware = activeOffboardingWriteFence({} as any);
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    const next = vi.fn();
    const user = { sub: 'user-1', tenantId: 'tenant-a' };

    await middleware({ method: 'POST', user } as any, { status, json } as any, next);
    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'OFFBOARDING_AUTHORITY_UNAVAILABLE' }));
    expect(next).not.toHaveBeenCalled();

    await middleware({ method: 'GET', user } as any, { status, json } as any, next);
    await middleware({ method: 'POST' } as any, { status, json } as any, next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('活跃离职流程阻止该用户继续写入 API，读取请求仍放行', async () => {
    const findActiveForTarget = vi.fn().mockResolvedValue({ jobId: 'job-1' });
    const middleware = activeOffboardingWriteFence({ governanceChangeJobStore: { findActiveForTarget } } as any);
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    const next = vi.fn();
    const user = { sub: 'user-1', tenantId: 'tenant-a' };

    await middleware({ method: 'POST', user } as any, { status, json } as any, next);
    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'USER_OFFBOARDING_ACTIVE' }));
    expect(next).not.toHaveBeenCalled();

    await middleware({ method: 'GET', user } as any, { status, json } as any, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
