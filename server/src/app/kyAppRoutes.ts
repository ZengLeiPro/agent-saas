/**
 * WP2a 定制项目对接的统一注册点（施工总则 §3.2 端点表）。
 *
 * `routes.ts` 与 `runtime.ts` 都在大文件行数棘轮上，因此本模块承担三件事：
 * 1. 解析 `config.json` 的 `kyApp` 域并装配全部 store/服务（`kyapp/assembly.ts`）；
 * 2. 注册全部路由：`/api/app-contract/v1/*`、`/api/systems/mine`，
 *    以及 `/api` 之外公开的 `GET /.well-known/ky-app-jwks.json`；
 * 3. 顺带把后台循环挂起来（仅 runtime worker 角色），并把停止钩子挂进 `AppRuntime`，
 *    由 `index.ts` 的 `shutdownCleanup` 统一调用（与 `notionAuthFlowShutdown` 等同一模式）。
 *
 * `kyApp` 未配置（或治理库不是 PG、SecretVault 未装配）→ 整体不注册，返回 `false`。
 */
import type { Express } from 'express';

import { buildKyAppAssembly, type KyAppAssembly } from '../kyapp/assembly.js';
import { loadKyAppConfig, resolveKyAppConfig, KyAppConfigError } from '../kyapp/config.js';
import {
  createKyAppHandshakeRouter,
  createTenantAdminResolver,
} from '../kyapp/routes/handshake.js';
import { createKyAppInstallationsRouter } from '../kyapp/routes/installations.js';
import { createKyAppJwksHandler, createKyAppKeysRouter } from '../kyapp/routes/keys.js';
import { createKyAppMineRouter } from '../kyapp/routes/mine.js';
import { createKyAppSystemsRouter } from '../kyapp/routes/systems.js';
import type { KyAppToolRegistrationDryRun } from '../kyapp/systems/publishGate.js';
import { createKyAppToolRegistrationDryRun } from '../kyapp/gateway/registrationDryRun.js';
import { serverLogger } from '../utils/logger.js';
import type { AppRuntime } from './runtime.js';

/** §3.2：平台管理端点统一前缀。 */
export const KY_APP_CONTRACT_BASE_PATH = '/api/app-contract/v1';

export interface RegisterKyAppRoutesOptions {
  /** 测试注入：跳过磁盘 config.json，直接给配置对象。 */
  rawConfig?: unknown;
  fetchImpl?: typeof fetch;
  /** WP3 填充：模型端工具注册 dry-run。 */
  toolRegistrationDryRun?: KyAppToolRegistrationDryRun;
  /** 测试注入：跳过建表与后台循环。 */
  autoStart?: boolean;
}

/**
 * 注册定制项目对接的全部路由。返回装配结果（未启用时为 `null`）。
 * 调用方只关心「是否注册成功」，测试需要内部服务时用返回值。
 */
export function registerKyAppRoutes(
  app: Express,
  runtime: AppRuntime,
  options: RegisterKyAppRoutesOptions = {},
): KyAppAssembly | null {
  let config;
  try {
    config =
      options.rawConfig === undefined
        ? loadKyAppConfig(runtime.processCwd)
        : resolveKyAppConfig(options.rawConfig);
  } catch (error) {
    if (error instanceof KyAppConfigError) {
      // fail-closed：配置写错就整体关闭，不带着半截配置上线。
      serverLogger.error(`kyApp 配置无效，定制项目对接功能已关闭：${error.message}`);
      return null;
    }
    throw error;
  }
  if (!config) return null;

  const assembly = buildKyAppAssembly({
    runtime,
    config,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  if (!assembly) {
    serverLogger.warn('kyApp 已配置，但治理库不是 PG 或 SecretVault 未装配，功能保持关闭');
    return null;
  }

  app.use(
    KY_APP_CONTRACT_BASE_PATH,
    createKyAppSystemsRouter({
      systems: assembly.systems,
      ...(runtime.governanceAuditStore ? { audit: runtime.governanceAuditStore } : {}),
      // WP3 填充 WP2a 预留的钩子：未显式注入时用 Gateway 自带的真实注册 dry-run
      // （`skipped` 不等于通过，所以这里必须给默认值，不能留空）。
      toolRegistrationDryRun: options.toolRegistrationDryRun ?? createKyAppToolRegistrationDryRun(),
    }),
  );
  app.use(
    KY_APP_CONTRACT_BASE_PATH,
    createKyAppInstallationsRouter({
      systems: assembly.systems,
      installations: assembly.installations,
      credentials: assembly.credentials,
      runtimeStore: assembly.runtimeStore,
    }),
  );
  app.use(
    KY_APP_CONTRACT_BASE_PATH,
    createKyAppHandshakeRouter({
      handshake: assembly.handshake,
      ...(runtime.userStore ? { userStore: runtime.userStore } : {}),
      isTenantAdmin: createTenantAdminResolver(runtime.membershipStore),
    }),
  );
  app.use(
    KY_APP_CONTRACT_BASE_PATH,
    createKyAppKeysRouter({
      keys: assembly.keys,
      dispatcher: assembly.dispatcher,
      ...(runtime.governanceAuditStore ? { audit: runtime.governanceAuditStore } : {}),
    }),
  );
  app.use(
    '/api',
    createKyAppMineRouter({
      systems: assembly.systems,
      ...(runtime.assignmentStore ? { assignments: runtime.assignmentStore } : {}),
    }),
  );
  // JWKS 挂 app 级：`/api` 之外天然公开，不经会话中间件（`index.ts:251` 只挂 `/api`）。
  app.get(config.jwksPath, createKyAppJwksHandler(assembly.keys));

  if (options.autoStart !== false) {
    void assembly.start().catch((error: unknown) => {
      serverLogger.error(
        `kyApp 后台装配失败：${error instanceof Error ? error.message : String(error)}`,
      );
    });
    // 与 notionAuthFlowShutdown / dwsAuthKeepaliveShutdown 同一模式：
    // 由 index.ts 的 shutdownCleanup 统一调用。
    (runtime as { kyAppShutdown?: () => void }).kyAppShutdown = () => assembly.stop();
  }
  return assembly;
}
