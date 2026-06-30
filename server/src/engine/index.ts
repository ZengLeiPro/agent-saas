/**
 * Engine 层导出
 *
 * Dispatch 中间件基础设施。
 * 事件消费层（EventConsumer/toolNameResolver）已迁移到 channels/ 目录。
 * Agent 调度类型（AgentDispatch/AgentRunDispatch 等）在 agent/types.ts。
 */

export {
  createMiddlewareRunDispatch,
  type CreateRunDispatchOptions,
} from './dispatch.js';
export { DispatchMetricsStore, type DispatchMetricsSnapshot } from './metricsStore.js';
export type {
  DispatchMetrics,
  DispatchMetricsReporter,
  DispatchEngineOptions,
  RateLimitOptions,
  AuditOptions,
  ObservabilityOptions,
} from './types.js';
export {
  createMemoryMaintenanceHook,
  withMemoryMaintenance,
  type MemoryMaintenanceOptions,
  type CreateMemoryHookOptions,
} from './memoryHook.js';
