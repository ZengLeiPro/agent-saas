/**
 * 「任务中心」入口可见性 —— 与 Web 侧边栏同一口径。
 *
 * 三个条件全部成立才露出入口：
 *   1. `getSidebarNavItems` 仍返回 cron 项（即 `personalAgentOnly` 门控通过）；
 *   2. 租户开关 `tenantFeatures.cronEnabled` 打开；
 *   3. 当前构建档位的 V1 allowlist 放行 `cron` 路由。
 * 任一不满足就整枚不渲染，而不是给一个点不动的假入口。
 */
import { getSidebarNavItems } from '@agent/shared';

export interface CronEntryVisibilityInput {
  isAdmin: boolean;
  personalAgentEnabled: boolean;
  cronEnabled: boolean;
  /** `isV1RouteAllowed('cron', profile)` 的结果 */
  routeAllowed: boolean;
}

export function isCronEntryVisible(input: CronEntryVisibilityInput): boolean {
  if (!input.cronEnabled || !input.routeAllowed) return false;
  return getSidebarNavItems({
    isAdmin: input.isAdmin,
    personalAgentEnabled: input.personalAgentEnabled,
  }).some((item) => item.tab === 'cron');
}
