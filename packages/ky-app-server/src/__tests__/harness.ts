/** Hono 适配器测试用的完整装配：把包里所有模块按参考方式接起来，再挂两条业务路由。 */
import type { MeResponse } from '@kaiyan/ky-app-contract';

import { createBreakGlass, type BreakGlass } from '../breakGlass/service.js';
import { MemoryBreakGlassStore } from '../breakGlass/store.js';
import { defineCapabilities } from '../capabilities/define.js';
import { MemoryExecutionStore } from '../capabilities/executionStore.js';
import { directoryStalenessGate, type DirectoryStalenessGate } from '../directory/staleness.js';
import { createEventsHandler } from '../events/handler.js';
import { MemoryInstallationStateStore } from '../events/store.js';
import { createJwksClient } from '../jwks/client.js';
import { createAttestationIssuer } from '../local/attest.js';
import { createLocalKeyRing } from '../local/keys.js';
import { buildMe, type PermissionMenu } from '../me/build.js';
import { MemoryJtiStore } from '../sat/jtiStore.js';
import { requireUser } from '../hono/middleware.js';
import { createKyAppRouter } from '../hono/router.js';
import type { KyAppRouterConfig, KyRequestIdentity } from '../hono/types.js';
import {
  BASE_NOW_MS,
  TEST_MANIFEST,
  TEST_MANIFEST_DIGEST,
  createClock,
  createFakeJwksServer,
  createSatSigner,
  createTestConfig,
} from './helpers.js';

export const PERMISSION_TABLE: PermissionMenu[] = [
  { menuKey: 'orders', label: '订单', path: '/orders', requiredPermission: 'orders.read' },
  {
    menuKey: 'settings',
    label: '设置',
    path: '/settings',
    children: [
      {
        menuKey: 'settings.roles',
        label: '角色权限',
        path: '/settings/roles',
        requiredPermission: 'settings.roles.manage',
      },
    ],
  },
];

export interface HarnessOptions {
  /** 兜底模式初始是否开启（会实际走一次 enable）。 */
  env?: 'test' | 'prod';
  staleness?: () => DirectoryStalenessGate;
  /** §5.1 响应头覆盖（本地 mock 壳需要额外的 frame-ancestors）。 */
  securityHeaders?: KyAppRouterConfig['securityHeaders'];
}

export async function createHarness(options: HarnessOptions = {}) {
  const config = createTestConfig(
    options.env === 'prod'
      ? {
          env: 'prod',
          issuer: 'https://agent.kaiyan.net',
          jwksUrl: 'https://api.agent.kaiyan.net/.well-known/ky-app-jwks.json',
        }
      : {},
  );
  const clock = createClock();
  const signer = await createSatSigner();
  const jwksServer = createFakeJwksServer([signer.jwk]);
  const jwks = createJwksClient({ url: config.jwksUrl, fetch: jwksServer.fetch, now: clock.now });
  const jtiStore = new MemoryJtiStore(clock.now);
  const executionStore = new MemoryExecutionStore();
  const eventsStore = new MemoryInstallationStateStore();
  const events = createEventsHandler({ config, store: eventsStore, jwks, now: clock.now });
  const localKeys = createLocalKeyRing(config, { rotatedAt: BASE_NOW_MS });
  const breakGlassStore = new MemoryBreakGlassStore();
  const breakGlass: BreakGlass = createBreakGlass({
    config,
    keys: localKeys,
    store: breakGlassStore,
    pathPrefixes: TEST_MANIFEST.pathPrefixes,
    installationState: () => 'enabled',
    now: clock.now,
  });
  const capabilities = defineCapabilities({
    manifest: TEST_MANIFEST,
    manifestDigest: TEST_MANIFEST_DIGEST,
    executionStore,
    now: clock.now,
    createContext: async (identity) => ({
      tenantId: config.tenantId,
      installationId: config.installationId,
      userId: identity.sub ?? '',
      roles: ['sales'],
      isTenantAdmin: identity.tadm,
      dataScope: { groupIds: ['g1'] },
    }),
    handlers: {
      'order.search': async () => ({ items: [{ orderId: 'SO-1' }], hasMore: false }),
      'order.create': async () => ({ orderId: 'SO-9' }),
    },
  });
  const attestation = createAttestationIssuer({
    config,
    keys: localKeys,
    manifestDigest: () => TEST_MANIFEST_DIGEST,
    now: clock.now,
  });

  const permissionsFor = (identity: KyRequestIdentity): string[] => {
    const base = ['orders.read'];
    return identity.tadm ? [...base, 'settings.roles.manage'] : base;
  };

  const routerConfig: KyAppRouterConfig = {
    config,
    manifest: TEST_MANIFEST,
    manifestDigest: TEST_MANIFEST_DIGEST,
    jwks,
    jtiStore,
    capabilities,
    events,
    localKeys,
    attestation,
    breakGlass,
    now: clock.now,
    ...(options.staleness === undefined
      ? {}
      : { directoryStaleness: async () => options.staleness!() }),
    directorySync: async () => ({ checkpoint: 42, ageSeconds: 10 }),
    permVersion: (identity) => (identity.tadm ? 'pv_admin' : 'pv_member'),
    buildMe: async (identity): Promise<MeResponse> =>
      buildMe({
        permissionTable: PERMISSION_TABLE,
        user: {
          id: identity.sub ?? '',
          displayName: '张三',
          roles: identity.tadm ? ['admin'] : ['sales'],
          isTenantAdmin: identity.tadm,
        },
        permissions: permissionsFor(identity),
        capabilities: capabilities.listForMe(),
        permVersion: identity.tadm ? 'pv_admin' : 'pv_member',
        manifest: TEST_MANIFEST,
      }),
    health: { appVersion: '1.0.0' },
    ...(options.securityHeaders === undefined ? {} : { securityHeaders: options.securityHeaders }),
    testHooks: {
      provision: async (input) => input,
      // §9.3-12：一致性测试用它触发一轮目录消费并读回本地状态。
      directory: async (input) => ({ echoed: input }),
    },
  };

  const { router, runtime } = createKyAppRouter(routerConfig);

  // 业务路由：中间件必须先于路由注册，否则 Hono 的处理链会跳过它。
  router.use('/api/app/*', requireUser(runtime));
  router.use('/api/admin/*', requireUser(runtime));
  router.get('/api/app/orders', (c) => c.json({ items: [] }));
  router.post('/api/app/orders', (c) => c.json({ ok: true }));
  // 故意也挂上鉴权：`/api/apps` 不在 `pathPrefixes.user` 的 segment 前缀内，
  // 必须被 requireUser 判成 403 而不是靠「没挂中间件」侥幸不可达。
  router.use('/api/apps', requireUser(runtime));
  router.get('/api/apps', (c) => c.json({ leaked: true }));
  router.get('/api/admin/roles', (c) => c.json({ roles: [] }));

  return {
    config,
    clock,
    signer,
    jwksServer,
    jwks,
    jtiStore,
    executionStore,
    eventsStore,
    events,
    localKeys,
    breakGlass,
    breakGlassStore,
    capabilities,
    attestation,
    router,
    runtime,
    stalenessGate: directoryStalenessGate,
  };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;
