export type GovernanceUserMenuEntry = {
  id: "settings";
  label: "设置";
};

/** 左下角头像菜单只保留统一设置入口，权限分流在设置侧边栏内完成。 */
export function getGovernanceUserMenuEntries(_access: { isAdmin: boolean; isPlatformAdmin: boolean }): GovernanceUserMenuEntry[] {
  return [{ id: "settings", label: "设置" }];
}
