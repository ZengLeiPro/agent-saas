/** §3.4 目录陈旧度门禁。 */
import { DIRECTORY_STALENESS_SECONDS } from '@kaiyan/ky-app-contract';

export interface DirectoryStalenessGate {
  /** > 30 分钟：告警（不阻断）。 */
  warn: boolean;
  /** > 2 小时：所有写入口拒绝 `directory_stale`。 */
  allowWrite: boolean;
  /** > 24 小时：`pathPrefixes` 内全部拒绝，仅 `/me` 与只读 health 可用。 */
  allowRead: boolean;
  ageSeconds: number;
}

/**
 * 由陈旧度秒数得出三级门禁。**兜底模式不受此门禁约束**（使用本地快照，§3.4），
 * 调用方在兜底态直接跳过本函数。
 */
export function directoryStalenessGate(ageSeconds: number): DirectoryStalenessGate {
  const age = Number.isFinite(ageSeconds) ? Math.max(0, ageSeconds) : Number.POSITIVE_INFINITY;
  return {
    warn: age > DIRECTORY_STALENESS_SECONDS.warn,
    allowWrite: age <= DIRECTORY_STALENESS_SECONDS.blockWrite,
    allowRead: age <= DIRECTORY_STALENESS_SECONDS.blockRead,
    ageSeconds: age,
  };
}

/** 从未同步过（checkpoint 为空）时的陈旧度：视为无穷大，fail-closed。 */
export const NEVER_SYNCED_AGE_SECONDS = Number.POSITIVE_INFINITY;
