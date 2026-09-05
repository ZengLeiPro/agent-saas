/**
 * 「文件中心」入口可见性 —— 与 Web 侧边栏「文件」同一口径。
 *
 * 两个条件全部成立才露出入口：
 *   1. 租户开关 `tenantFeatures.filesEnabled` 打开（Web `TenantSettingsPanel`
 *      的「文件能力」开关，关掉后 Web 侧边栏同样不给文件入口）；
 *   2. 当前构建档位的 V1 allowlist 放行 `files` 路由。
 * 任一不满足就整枚 pill 不渲染，而不是给一个点不动的假入口
 * （P3-3c 之前「文件」pill 是 disabled 占位，本次一并去掉）。
 */

export interface FilesEntryVisibilityInput {
  /** `tenantFeatures.filesEnabled` */
  filesEnabled: boolean;
  /** `isV1RouteAllowed('files', profile)` 的结果 */
  routeAllowed: boolean;
}

export function isFilesEntryVisible(input: FilesEntryVisibilityInput): boolean {
  return input.filesEnabled && input.routeAllowed;
}
