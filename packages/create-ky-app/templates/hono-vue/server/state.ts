/**
 * 只在 `KY_ENV=test` 下由 `/ky/v1/test/*` 写入的进程内开关。
 * 生产路径不读它以外的任何全局状态。
 */
export const testState = {
  /** 能力 handler 的人为延迟（毫秒），用于制造 `in_progress` 并发（§9.3-6）。 */
  capabilityDelayMs: 0,
};
