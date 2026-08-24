import { z } from 'zod';

export const runtimeSchedulerConfigSchema = z.object({
  /** 默认 true：PG Web chat 默认 enqueue-only，并由 scheduler 调用 wakeRuntimeSession 执行。 */
  autoWake: z.boolean().optional(),
  pollIntervalMs: z.number().int().positive().optional(),
  leaseMs: z.number().int().positive().optional(),
  renewIntervalMs: z.number().int().positive().optional(),
  /** 顶层 run 全局并发；lease 模式默认 16，dual 迁移态强制不超过 4。 */
  maxConcurrentRuns: z.number().int().positive().optional(),
  /** 为普通前台消息保留的全局 lease 槽；低优先级任务不得占用。默认 10。 */
  foregroundReservedRuns: z.number().int().nonnegative().max(10_000).optional(),
  /** 平台管理员热调并发的部署级安全上限；默认 64，提升需显式改部署配置。 */
  maxConfigurableConcurrentRuns: z.number().int().positive().max(10_000).optional(),
  /** 首次发布保持 dual 兼容旧 advisory-lock；全量升级后切 lease。 */
  sessionLockMode: z.enum(['dual', 'lease']).optional(),
  /** waiting_approval 超过该时间自动 rejected + cancelled。默认 24h；设 0 关闭。 */
  approvalTimeoutMs: z.number().int().nonnegative().optional(),
});
