import type { ManagementActionV1 } from "@agent/shared/types/governance";

export const SETTINGS_SCOPES = ["personal", "tenant", "platform"] as const;
export type SettingsScope = (typeof SETTINGS_SCOPES)[number];

export const PERSONAL_SETTINGS_GROUPS = ["personal", "preferences", "access", "data"] as const;
export type PersonalSettingsGroup = (typeof PERSONAL_SETTINGS_GROUPS)[number];

export type SettingsAccessAction = Extract<ManagementActionV1, `settings.${string}.view`>;

/** Metadata only: existing editors keep their current save/dirty implementation. */
export type SettingsDirtyPolicy = "guarded" | "immediate" | "component-owned";

interface SettingsRegistryBase {
  id: string;
  label: string;
  description?: string;
  iconKey: string;
  accessAction: SettingsAccessAction;
  dirtyPolicy: SettingsDirtyPolicy;
}

interface PersonalSettingsRegistryContract extends SettingsRegistryBase {
  scope: "personal";
  group: PersonalSettingsGroup;
  routeId: string;
  tabs?: readonly string[];
  defaultTab?: string;
}

interface AdminSettingsRegistryContract extends SettingsRegistryBase {
  scope: "tenant" | "platform";
  /** Existing governance route reached when the legacy settings path is normalized. */
  targetRouteId: string;
}

type SettingsRegistryContract = PersonalSettingsRegistryContract | AdminSettingsRegistryContract;
type SettingsPathPrefix<S extends SettingsScope> = S extends "personal"
  ? "/settings"
  : `/${S}-admin/settings`;
type RegistryEntryWithIdentity<T> = T extends { scope: infer S extends SettingsScope; id: infer Id extends string }
  ? T & { readonly key: `${S}:${Id}`; readonly path: `${SettingsPathPrefix<S>}/${Id}` }
  : never;
type RegistryWithIdentity<T extends readonly SettingsRegistryContract[]> = {
  readonly [Index in keyof T]: RegistryEntryWithIdentity<T[Index]>;
};

function defineSettingsRegistry<const T extends readonly SettingsRegistryContract[]>(entries: T): RegistryWithIdentity<T> {
  return entries.map((entry) => ({
    ...entry,
    key: `${entry.scope}:${entry.id}`,
    path: `/${entry.scope === "personal" ? "settings" : `${entry.scope}-admin/settings`}/${entry.id}`,
  })) as unknown as RegistryWithIdentity<T>;
}

/**
 * Pure-data source of truth for every leaf in the unified settings workspace.
 * Keep React/lucide imports in the menu projections, never in this module.
 */
export const SETTINGS_REGISTRY = defineSettingsRegistry([
  { scope: "personal", id: "account-security", label: "账户与安全", description: "账号资料、安全和登录状态。", group: "personal", iconKey: "user", accessAction: "settings.personal.view", dirtyPolicy: "immediate", routeId: "settings.personal.account-security" },
  { scope: "personal", id: "my-agent", label: "我的 Agent", description: "资料与长期 Memory。", group: "personal", iconKey: "bot", accessAction: "settings.personal.view", dirtyPolicy: "immediate", routeId: "settings.personal.my-agent", tabs: ["agent-profile", "memory"], defaultTab: "agent-profile" },
  { scope: "personal", id: "chat-model", label: "对话与模型", description: "默认模型与对话展示偏好。", group: "preferences", iconKey: "message-square", accessAction: "settings.personal.view", dirtyPolicy: "guarded", routeId: "settings.preferences.chat-model" },
  { scope: "personal", id: "appearance-layout", label: "外观与布局", description: "侧边栏、会话列表和界面偏好。", group: "preferences", iconKey: "palette", accessAction: "settings.personal.view", dirtyPolicy: "immediate", routeId: "settings.preferences.appearance-layout" },
  { scope: "personal", id: "my-permissions", label: "我的权限", description: "服务端权威有效资源与权限解释。", group: "access", iconKey: "admin", accessAction: "settings.personal.view", dirtyPolicy: "immediate", routeId: "settings.access.my-permissions" },
  { scope: "personal", id: "connections", label: "连接与授权", description: "长期账号授权与运行时工具批准。", group: "access", iconKey: "link", accessAction: "settings.personal.view", dirtyPolicy: "immediate", routeId: "settings.access.connections" },
  { scope: "personal", id: "files-storage", label: "文件与存储", description: "浏览文件、查看用量并清理附件。", group: "data", iconKey: "hard-drive", accessAction: "settings.personal.view", dirtyPolicy: "immediate", routeId: "settings.data.files-storage" },
  { scope: "personal", id: "trash", label: "回收站", description: "恢复或彻底清理已删除会话。", group: "data", iconKey: "trash", accessAction: "settings.personal.view", dirtyPolicy: "immediate", routeId: "settings.data.trash" },

  { scope: "tenant", id: "users", label: "成员", iconKey: "members", accessAction: "settings.tenant.view", dirtyPolicy: "component-owned", targetRouteId: "organization.members.list" },
  { scope: "tenant", id: "skills", label: "技能", iconKey: "skill", accessAction: "settings.tenant.view", dirtyPolicy: "component-owned", targetRouteId: "organization.agents.skills" },
  { scope: "tenant", id: "org-agents", label: "组织智能体", iconKey: "expert", accessAction: "settings.tenant.view", dirtyPolicy: "component-owned", targetRouteId: "organization.agents.org-agents" },
  { scope: "tenant", id: "mcp", label: "连接器", iconKey: "connector", accessAction: "settings.tenant.view", dirtyPolicy: "component-owned", targetRouteId: "organization.agents.connectors" },
  { scope: "tenant", id: "connector-dictionary", label: "连接器映射", iconKey: "connector", accessAction: "settings.tenant.view", dirtyPolicy: "component-owned", targetRouteId: "organization.agents.connectors" },
  { scope: "tenant", id: "billing", label: "计费", iconKey: "billing", accessAction: "settings.tenant.view", dirtyPolicy: "component-owned", targetRouteId: "organization.governance.usage" },
  { scope: "tenant", id: "files", label: "文件与数据", iconKey: "files", accessAction: "settings.tenant.view", dirtyPolicy: "component-owned", targetRouteId: "organization.agents.files-data" },
  { scope: "tenant", id: "company", label: "公司信息", iconKey: "company-info", accessAction: "settings.tenant.view", dirtyPolicy: "component-owned", targetRouteId: "organization.settings.profile" },
  { scope: "tenant", id: "instructions", label: "自定义规则", iconKey: "tenant-instructions", accessAction: "settings.tenant.view", dirtyPolicy: "component-owned", targetRouteId: "organization.settings.rules" },
  { scope: "tenant", id: "settings", label: "组织管理", iconKey: "org", accessAction: "settings.tenant.view", dirtyPolicy: "component-owned", targetRouteId: "organization.settings.security" },

  { scope: "platform", id: "tenants", label: "组织", iconKey: "org", accessAction: "settings.platform.view", dirtyPolicy: "component-owned", targetRouteId: "platform.org-business.tenants" },
  { scope: "platform", id: "signup", label: "注册管理", iconKey: "signup", accessAction: "settings.platform.view", dirtyPolicy: "component-owned", targetRouteId: "platform.org-business.signup" },
  { scope: "platform", id: "platform-admins", label: "平台管理员", iconKey: "admin", accessAction: "settings.platform.view", dirtyPolicy: "component-owned", targetRouteId: "platform.org-business.platform-admins" },
  { scope: "platform", id: "agent-templates", label: "智能体模板", iconKey: "expert", accessAction: "settings.platform.view", dirtyPolicy: "component-owned", targetRouteId: "platform.resource-center.agent-templates" },
  { scope: "platform", id: "environment-templates", label: "环境模板", iconKey: "runtime-pool", accessAction: "settings.platform.view", dirtyPolicy: "component-owned", targetRouteId: "platform.resource-center.environment-templates" },
  { scope: "platform", id: "models", label: "模型", iconKey: "model", accessAction: "settings.platform.view", dirtyPolicy: "component-owned", targetRouteId: "platform.resource-center.models" },
  { scope: "platform", id: "billing", label: "计费", iconKey: "billing", accessAction: "settings.platform.view", dirtyPolicy: "component-owned", targetRouteId: "platform.org-business.entitlements-billing" },
  { scope: "platform", id: "remote-hands", label: "执行环境池", iconKey: "runtime-pool", accessAction: "settings.platform.view", dirtyPolicy: "component-owned", targetRouteId: "platform.runtime.execution-providers" },
  { scope: "platform", id: "tool-controls", label: "工具开关", iconKey: "tool-controls", accessAction: "settings.platform.view", dirtyPolicy: "component-owned", targetRouteId: "platform.resource-center.tools" },
  { scope: "platform", id: "connector-dictionary", label: "连接器映射", iconKey: "connector", accessAction: "settings.platform.view", dirtyPolicy: "component-owned", targetRouteId: "platform.resource-center.connectors" },
  { scope: "platform", id: "agent-profiles", label: "系统智能体", iconKey: "runtime-pool", accessAction: "settings.platform.view", dirtyPolicy: "component-owned", targetRouteId: "platform.governance.system-settings" },
  { scope: "platform", id: "system-prompts", label: "系统提示语", iconKey: "system-prompts", accessAction: "settings.platform.view", dirtyPolicy: "component-owned", targetRouteId: "platform.governance.system-prompts" },
  { scope: "platform", id: "memory-polling", label: "记忆轮询", iconKey: "memory-polling", accessAction: "settings.platform.view", dirtyPolicy: "component-owned", targetRouteId: "platform.governance.memory-policy" },
  { scope: "platform", id: "global-mcp", label: "全局 MCP", iconKey: "connector", accessAction: "settings.platform.view", dirtyPolicy: "component-owned", targetRouteId: "platform.resource-center.connectors" },
  { scope: "platform", id: "skill-pool", label: "技能池", iconKey: "skill", accessAction: "settings.platform.view", dirtyPolicy: "component-owned", targetRouteId: "platform.resource-center.skills" },
  { scope: "platform", id: "egress", label: "网络出口", iconKey: "egress", accessAction: "settings.platform.view", dirtyPolicy: "component-owned", targetRouteId: "platform.governance.network-security" },
  { scope: "platform", id: "system", label: "系统配置", iconKey: "system-config", accessAction: "settings.platform.view", dirtyPolicy: "component-owned", targetRouteId: "platform.governance.system-settings" },
] as const satisfies readonly SettingsRegistryContract[]);

export type SettingsRegistryEntry = (typeof SETTINGS_REGISTRY)[number];
export type SettingsRegistryEntryForScope<S extends SettingsScope> = Extract<SettingsRegistryEntry, { scope: S }>;
export type SettingsSectionIdForScope<S extends SettingsScope> = SettingsRegistryEntryForScope<S>["id"];
export type PersonalSettingsSectionId = SettingsSectionIdForScope<"personal">;
export type TenantSettingsSectionId = SettingsSectionIdForScope<"tenant">;
export type PlatformSettingsSectionId = SettingsSectionIdForScope<"platform">;
export type PersonalSettingsIconKey = SettingsRegistryEntryForScope<"personal">["iconKey"];
export type TenantSettingsIconKey = SettingsRegistryEntryForScope<"tenant">["iconKey"];
export type PlatformSettingsIconKey = SettingsRegistryEntryForScope<"platform">["iconKey"];

export function settingsSectionsForScope<S extends SettingsScope>(scope: S): readonly SettingsRegistryEntryForScope<S>[] {
  return SETTINGS_REGISTRY.filter((entry) => entry.scope === scope) as unknown as readonly SettingsRegistryEntryForScope<S>[];
}

export function isSettingsSectionId<S extends SettingsScope>(
  scope: S,
  value: string | null | undefined,
): value is SettingsSectionIdForScope<S> {
  return settingsSectionsForScope(scope).some((entry) => entry.id === value);
}

export function getSettingsSection<S extends SettingsScope>(
  scope: S,
  id: SettingsSectionIdForScope<S>,
): SettingsRegistryEntryForScope<S> {
  return settingsSectionsForScope(scope).find((item) => item.id === id)!;
}

export function settingsFallbackSection<S extends SettingsScope>(scope: S): SettingsSectionIdForScope<S> {
  return settingsSectionsForScope(scope)[0]!.id as SettingsSectionIdForScope<S>;
}

export function groupPersonalSettingsSections<T extends { group: PersonalSettingsGroup }>(items: readonly T[]) {
  return PERSONAL_SETTINGS_GROUPS
    .map((group) => ({ group, items: items.filter((item) => item.group === group) }))
    .filter((group) => group.items.length > 0);
}
