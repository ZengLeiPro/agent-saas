/**
 * WP3：Gateway 与 runtime dispatch 的装配桥。
 *
 * 为什么是进程级绑定而不是 `RawRuntimeRunDispatchConfig` 字段：
 * Gateway 在 `registerKyAppRoutes`（`app/kyAppRoutes.ts`）里随 `KyAppAssembly` 一起装配，
 * 那时 `rawRuntimeConfig`（`app/runtime.ts:1623`）早已构造完毕，而
 * `app/runtime.ts`(3004) 与 `app/routes.ts`(1112) 都顶在 max-lines 棘轮上，
 * 没法为一个可选依赖加参数管道。`AppRuntime.kyAppShutdown` 用的是同一种就地挂载模式。
 *
 * `kyApp` 未配置 → 绑定为 `null` → `collectRuntimeTooling` 不投影任何 `app__` 工具，
 * 现有生产行为零变化。
 */
import type { AppToolSnapshotService } from './snapshot.js';
import type { AppCapabilityToolProvider } from './toolProvider.js';

export interface AppCapabilityGatewayBinding {
  provider: AppCapabilityToolProvider;
  snapshots: AppToolSnapshotService;
  /** §6.2-3 的审批 TTL（`kyApp.gateway.approvalTtlMs`）。channel 侧建确认卡片时要用。 */
  approvalTtlMs: number;
}

let current: AppCapabilityGatewayBinding | null = null;

/** 装配时调用；传 `null` 解绑（`kyApp` 关闭或进程停止）。 */
export function setAppCapabilityGateway(binding: AppCapabilityGatewayBinding | null): void {
  current = binding;
}

export function getAppCapabilityGateway(): AppCapabilityGatewayBinding | null {
  return current;
}

/** 仅供测试：解绑，避免用例之间互相污染。 */
export function resetAppCapabilityGatewayForTest(): void {
  current = null;
}
