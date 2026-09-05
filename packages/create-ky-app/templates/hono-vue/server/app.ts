/**
 * __SYSTEM_NAME__ 的服务端装配：把 `@kaiyan/ky-app-server` 的各块按参考方式接起来，
 * 挂上业务路由，并托管前端生产构建产物。
 *
 * 契约端点全部来自 SDK（`/ky/v1/*`、`/ky-local/*`），本文件只负责「接线」与业务侧。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { manifestDigest, type Manifest } from '@kaiyan/ky-app-contract';
import {
  PgBreakGlassStore,
  PgDirectoryStore,
  PgExecutionStore,
  PgInstallationStateStore,
  PgJtiStore,
  buildMe,
  createAttestationIssuer,
  createBreakGlass,
  createDirectoryClient,
  createEventsHandler,
  createLocalKeyRing,
  type DirectoryClient,
} from '@kaiyan/ky-app-server';
import {
  CONTENT_SECURITY_POLICY,
  SHELL_ORIGIN,
  createKyAppRouter,
  type KyAppRouter,
  type KyAppRuntime,
  type KyRequestIdentity,
} from '@kaiyan/ky-app-server/hono';
import type { Pool } from 'pg';

import { createCapabilityRuntime, buildContext, type CapabilityDeps } from './capabilities.js';
import { createPool, runMigrations } from './db.js';
import { PERMISSION_TABLE, effectiveRoles, permVersionOf, permissionsFor } from './permissions.js';
import { projectRoot, webDistDir } from './paths.js';
import { registerPageApi } from './routes/pageApi.js';
import { serveWebDist } from './static.js';
import { createTestHooks } from './testHooks.js';
import { getUserRoles } from './services/users.service.js';
import type { AppConfig } from './config.js';

export interface BuiltApp {
  app: KyAppRouter;
  runtime: KyAppRuntime;
  pool: Pool;
  manifest: Manifest;
  manifestDigest: string;
  directory: DirectoryClient;
  close(): Promise<void>;
}

/**
 * §5.1 的 CSP。本地 / 一致性测试需要把 mock 壳的 origin 也放进 `frame-ancestors`，
 * 否则跨源 iframe 直接被浏览器拦掉；生产环境 `shellOrigin` 恒为 undefined。
 */
export function contentSecurityPolicy(shellOrigin?: string): string {
  if (shellOrigin === undefined) return CONTENT_SECURITY_POLICY;
  return CONTENT_SECURITY_POLICY.replace(
    `frame-ancestors ${SHELL_ORIGIN}`,
    `frame-ancestors ${SHELL_ORIGIN} ${shellOrigin}`,
  );
}

export async function buildApp(config: AppConfig): Promise<BuiltApp> {
  const manifest = JSON.parse(
    await readFile(join(projectRoot(), 'ky-app.manifest.json'), 'utf8'),
  ) as Manifest;
  const digest = manifestDigest(manifest);

  const pool = createPool(config.databaseUrl);
  await runMigrations(pool);

  const jtiStore = new PgJtiStore(pool);
  const executionStore = new PgExecutionStore(pool);
  const eventsStore = new PgInstallationStateStore(pool);
  const directoryStore = new PgDirectoryStore(pool);
  const breakGlassStore = new PgBreakGlassStore(pool);

  // 各模块的时钟统一走 runtime（`/ky/v1/test/clock` 的偏移对它们同样生效）。
  let runtimeRef: KyAppRuntime | null = null;
  const now = (): number => runtimeRef?.now() ?? Date.now();

  const localKeys = createLocalKeyRing(config.ky, { now });

  // `jwks.probe` / `jwks.rotated` / `jwks.revoke` 要用 router 建出来的那个 JWKS 客户端，
  // 而 router 又要先拿到 events —— 用惰性构造打破这个循环。
  let lazyEvents: ReturnType<typeof createEventsHandler> | null = null;
  const eventsHandler = (): ReturnType<typeof createEventsHandler> => {
    lazyEvents ??= createEventsHandler({
      config: config.ky,
      store: eventsStore,
      jwks: runtime.jwks,
      now,
    });
    return lazyEvents;
  };

  const directory = createDirectoryClient({
    config: config.ky,
    store: directoryStore,
    baseUrl: config.directoryUrl,
    now,
  });

  const capabilityDeps: CapabilityDeps = {
    pool,
    manifest,
    manifestDigest: digest,
    executionStore,
    directory: directoryStore,
    tenantId: config.ky.tenantId,
    installationId: config.ky.installationId,
    writeAllowed: async () => (await directory.staleness()).allowWrite,
    now,
  };
  const capabilities = createCapabilityRuntime(capabilityDeps);

  const attestation = createAttestationIssuer({
    config: config.ky,
    keys: localKeys,
    manifestDigest: () => digest,
    now,
  });

  let installationState: 'enabled' | 'disabled' | 'deleted' = (await eventsStore.getState()).state;
  const breakGlass = createBreakGlass({
    config: config.ky,
    keys: localKeys,
    store: breakGlassStore,
    pathPrefixes: manifest.pathPrefixes,
    installationState: () => installationState,
    now,
  });

  /** 业务侧的 `ctx`：与能力 handler 共用同一份构造逻辑（§9.2）。 */
  const contextFor = async (identity: KyRequestIdentity): ReturnType<typeof buildContext> =>
    buildContext(capabilityDeps, { sub: identity.sub ?? '', tadm: identity.tadm });

  const rolesOf = async (identity: KyRequestIdentity): Promise<string[]> =>
    getUserRoles(pool, {
      tenantId: config.ky.tenantId,
      installationId: config.ky.installationId,
      sub: identity.sub ?? '',
    });

  const { router, runtime } = createKyAppRouter({
    config: config.ky,
    manifest,
    manifestDigest: digest,
    jtiStore,
    capabilities,
    events: {
      handle: async (event) => {
        const ack = await eventsHandler().handle(event);
        installationState = (await eventsStore.getState()).state;
        return ack;
      },
      state: () => eventsStore.getState(),
    },
    localKeys,
    attestation,
    breakGlass,
    directoryStaleness: () => directory.staleness(),
    directorySync: async () => {
      const checkpoint = await directoryStore.getCheckpoint();
      return checkpoint === null
        ? { checkpoint: 0, ageSeconds: Number.MAX_SAFE_INTEGER }
        : { checkpoint: checkpoint.seq, ageSeconds: (now() - checkpoint.at) / 1000 };
    },
    buildMe: async (identity) => {
      const roles = await rolesOf(identity);
      const profile = await directoryStore.getUser(identity.sub ?? '');
      return buildMe({
        permissionTable: PERMISSION_TABLE,
        user: {
          id: identity.sub ?? '',
          displayName: profile?.displayName ?? identity.sub ?? '',
          roles: effectiveRoles(roles, identity.tadm),
          isTenantAdmin: identity.tadm,
        },
        permissions: permissionsFor(roles, identity.tadm),
        capabilities: capabilities.listForMe(),
        permVersion: permVersionOf(roles, identity.tadm),
        manifest,
      });
    },
    permVersion: async (identity) => permVersionOf(await rolesOf(identity), identity.tadm),
    health: {
      appVersion: '0.1.0',
      db: async () => {
        await pool.query('SELECT 1');
        return true;
      },
    },
    securityHeaders: {
      contentSecurityPolicy: contentSecurityPolicy(config.shellOrigin),
    },
    testHooks: createTestHooks({
      pool,
      config: config.ky,
      breakGlass,
      directory,
      directoryStore,
    }),
  });
  runtimeRef = runtime;

  registerPageApi(router, {
    pool,
    runtime,
    tenantId: config.ky.tenantId,
    installationId: config.ky.installationId,
    contextFor,
  });

  // 静态托管放最后：契约端点与业务 API 都已注册，剩下的 GET 才走前端产物（含 SPA 兜底）。
  router.get('*', serveWebDist(webDistDir()));

  return {
    app: router,
    runtime,
    pool,
    manifest,
    manifestDigest: digest,
    directory,
    close: async () => {
      await pool.end();
    },
  };
}
