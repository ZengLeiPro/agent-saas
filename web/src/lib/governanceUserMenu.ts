export type GovernanceUserMenuEntry = {
  id: "settings" | "organization" | "platform";
  label: string;
};

export function getGovernanceUserMenuEntries(access: { isAdmin: boolean; isPlatformAdmin: boolean }): GovernanceUserMenuEntry[] {
  return [
    { id: "settings", label: "个人设置" },
    ...(access.isAdmin ? [{ id: "organization" as const, label: "组织控制台" }] : []),
    ...(access.isPlatformAdmin ? [{ id: "platform" as const, label: "平台控制台" }] : []),
  ];
}
