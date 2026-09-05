/**
 * §4.3 能力实现。每个 handler 只做一件事：把 `ctx` 与已过 `inputSchema` 的输入
 * 交给 service，**绝不在这里写第二份查询**，也绝不回头 fetch 自己的 HTTP 接口（§9.2）。
 */
import type { Pool } from 'pg';

import type { Manifest } from '@kaiyan/ky-app-contract';
import {
  KyAppError,
  defineCapabilities,
  type CapabilityContext,
  type CapabilityHandler,
  type CapabilityRuntime,
  type DirectoryStore,
  type ExecutionStore,
} from '@kaiyan/ky-app-server';

import { cancelOrders, createOrder, searchOrders } from './services/orders.service.js';
import { getUserRoles } from './services/users.service.js';
import { testState } from './state.js';

export interface CapabilityDeps {
  pool: Pool;
  manifest: Manifest;
  manifestDigest: string;
  executionStore: ExecutionStore;
  directory: DirectoryStore;
  tenantId: string;
  installationId: string;
  /** §3.4：目录陈旧 > 2 小时时，`external_write` 能力必须拒绝。 */
  writeAllowed: () => Promise<boolean>;
  now?: () => number;
}

/** 一致性测试要造 `in_progress` 并发，需要一个可控的执行时长（仅 `KY_ENV=test` 生效）。 */
async function applyTestDelay(): Promise<void> {
  const delayMs = testState.capabilityDelayMs;
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function createCapabilityRuntime(deps: CapabilityDeps): CapabilityRuntime {
  const writeGuard =
    (handler: CapabilityHandler): CapabilityHandler =>
    async (ctx, input) => {
      if (!(await deps.writeAllowed())) {
        throw new KyAppError('directory_stale', {
          message: '组织目录已超过 2 小时未同步，写能力拒绝执行',
        });
      }
      await applyTestDelay();
      return handler(ctx, input);
    };

  const readOnly =
    (handler: CapabilityHandler): CapabilityHandler =>
    async (ctx, input) => {
      await applyTestDelay();
      return handler(ctx, input);
    };

  return defineCapabilities({
    manifest: deps.manifest,
    manifestDigest: deps.manifestDigest,
    executionStore: deps.executionStore,
    ...(deps.now === undefined ? {} : { now: deps.now }),
    createContext: (identity) =>
      buildContext(deps, { sub: identity.sub ?? '', tadm: identity.tadm }),
    handlers: {
      'order.search': readOnly(async (ctx, input) =>
        searchOrders(
          deps.pool,
          ctx,
          input as unknown as { keyword: string; limit?: number; cursor?: string },
        ),
      ),
      'order.create': writeGuard(async (ctx, input) =>
        createOrder(
          deps.pool,
          ctx,
          input as unknown as { customerId: string; lines: Array<{ sku: string; qty: number }> },
        ),
      ),
      'order.cancel': writeGuard(async (ctx, input) =>
        cancelOrders(deps.pool, ctx, input as unknown as { customerId: string }),
      ),
    },
  });
}

/** 验签中间件交出来的最小主体信息（SAT 与 Local Token 收敛成同一形态）。 */
export interface Principal {
  sub: string;
  /** §3.4 双通道：以令牌里的 `tadm` 为准，覆盖目录里的 `isTenantAdmin`。 */
  tadm: boolean;
}

/** §9.2：`ctx` 只由验签中间件构造，handler 永远拿不到原始 claims。 */
export async function buildContext(
  deps: CapabilityDeps,
  principal: Principal,
): Promise<CapabilityContext> {
  const sub = principal.sub;
  const [roles, profile] = await Promise.all([
    getUserRoles(deps.pool, {
      tenantId: deps.tenantId,
      installationId: deps.installationId,
      sub,
    }),
    deps.directory.getUser(sub),
  ]);
  return {
    tenantId: deps.tenantId,
    installationId: deps.installationId,
    userId: sub,
    roles,
    isTenantAdmin: principal.tadm,
    dataScope: { groupIds: profile?.groupIds ?? [] },
  };
}
