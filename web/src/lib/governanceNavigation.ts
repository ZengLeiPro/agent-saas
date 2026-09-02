import {
  getSettingsSection,
  settingsSectionsForScope,
  type PersonalSettingsSectionId,
  type SettingsRegistryEntryForScope,
} from "@/lib/unifiedSettingsRegistry";

/**
 * V2 治理导航的单一事实源。
 *
 * 本文件只描述稳定 URL、导航层级与迁移规则，不代表对应页面或治理能力已交付。
 * Shell 接线时必须复用这里的 registry / parse / build，不能再维护第二份 section Set。
 */

export type GovernanceArea = "platform" | "organization" | "settings";
export type EntityMode = "none" | "optional" | "required";

export interface GovernanceRouteDefinition {
  id: string;
  area: GovernanceArea;
  workspace: string;
  page: string;
  label: string;
  path: readonly string[];
  navigation: "workspace" | "leaf" | "detail";
  entity: EntityMode;
  tabs?: readonly string[];
  defaultTab?: string;
  parentId?: string;
}

export interface GovernanceWorkspaceDefinition {
  id: string;
  label: string;
  routes: readonly GovernanceRouteDefinition[];
}

const route = (
  area: GovernanceArea,
  workspace: string,
  page: string,
  label: string,
  path: readonly string[],
  options: Partial<Pick<GovernanceRouteDefinition, "navigation" | "entity" | "tabs" | "defaultTab" | "parentId">> = {},
): GovernanceRouteDefinition => ({
  id: `${area}.${workspace}.${page}`,
  area,
  workspace,
  page,
  label,
  path,
  navigation: options.navigation ?? "leaf",
  entity: options.entity ?? "none",
  tabs: options.tabs,
  defaultTab: options.defaultTab,
  parentId: options.parentId,
});

const platformWorkspaces: readonly GovernanceWorkspaceDefinition[] = [
  {
    id: "overview", label: "总览", routes: [
      route("platform", "overview", "overview", "平台概览", ["platform-console", "overview", "overview"], { navigation: "workspace" }),
    ],
  },
  {
    id: "org-business", label: "组织与商业", routes: [
      route("platform", "org-business", "tenants", "组织", ["platform-console", "org-business", "tenants"], {
        entity: "optional",
        tabs: ["overview", "configuration", "entitlements", "resource-scope", "billing", "security-lifecycle"],
        defaultTab: "overview",
      }),
      route("platform", "org-business", "users", "跨组织用户检索", ["platform-console", "org-business", "users"], { entity: "optional" }),
      route("platform", "org-business", "entitlements-billing", "权益与计费", ["platform-console", "org-business", "entitlements-billing"]),
      route("platform", "org-business", "signup", "注册管理", ["platform-console", "org-business", "signup"]),
      route("platform", "org-business", "platform-admins", "平台管理员", ["platform-console", "org-business", "platform-admins"], { entity: "optional" }),
    ],
  },
  {
    id: "resource-center", label: "资源中心", routes: [
      route("platform", "resource-center", "agent-templates", "智能体模板", ["platform-console", "resource-center", "agent-templates"], { entity: "optional" }),
      route("platform", "resource-center", "models", "模型", ["platform-console", "resource-center", "models"], { entity: "optional" }),
      route("platform", "resource-center", "skills", "技能", ["platform-console", "resource-center", "skills"], { entity: "optional" }),
      route("platform", "resource-center", "connectors", "连接器", ["platform-console", "resource-center", "connectors"], { entity: "optional" }),
      route("platform", "resource-center", "environment-templates", "环境模板", ["platform-console", "resource-center", "environment-templates"], { entity: "optional" }),
      route("platform", "resource-center", "tools", "工具目录与全局策略", ["platform-console", "resource-center", "tools"], { entity: "optional" }),
    ],
  },
  {
    id: "runtime", label: "运行与可观测", routes: [
      route("platform", "runtime", "sessions", "会话", ["platform-console", "runtime", "sessions"], { entity: "optional" }),
      route("platform", "runtime", "runs", "运行", ["platform-console", "runtime", "runs"], { entity: "optional" }),
      route("platform", "runtime", "execution-providers", "执行提供方", ["platform-console", "runtime", "execution-providers"], { entity: "optional" }),
      route("platform", "runtime", "environments", "沙箱与环境实例", ["platform-console", "runtime", "environments"], { entity: "optional" }),
      route("platform", "runtime", "infra", "系统资源", ["platform-console", "runtime", "infra"]),
      route("platform", "runtime", "efficiency", "执行效率", ["platform-console", "runtime", "efficiency"]),
    ],
  },
  {
    id: "governance", label: "治理与系统", routes: [
      route("platform", "governance", "audit", "操作记录", ["platform-console", "governance", "audit"], { entity: "optional" }),
      route("platform", "governance", "network-security", "网络与安全", ["platform-console", "governance", "network-security"]),
      route("platform", "governance", "system-prompts", "系统提示语", ["platform-console", "governance", "system-prompts"]),
      route("platform", "governance", "memory-policy", "记忆策略", ["platform-console", "governance", "memory-policy"]),
      route("platform", "governance", "system-settings", "系统配置", ["platform-console", "governance", "system-settings"]),
      route("platform", "governance", "config-status", "配置状态", ["platform-console", "governance", "config-status"]),
    ],
  },
];

const organizationWorkspaces: readonly GovernanceWorkspaceDefinition[] = [
  {
    id: "overview", label: "组织总览", routes: [
      route("organization", "overview", "overview", "综合分析", ["tenant-admin", "overview"], { navigation: "workspace" }),
    ],
  },
  {
    id: "members", label: "成员与权限", routes: [
      route("organization", "members", "list", "成员", ["tenant-admin", "members", "list"]),
      route("organization", "members", "owners", "组织所有者与管理员", ["tenant-admin", "members", "owners"]),
      route("organization", "members", "policies", "权限策略", ["tenant-admin", "members", "policies"]),
      route("organization", "members", "groups", "部门/群组", ["tenant-admin", "members", "groups"]),
      route("organization", "members", "offboarding", "离职撤权与资源交接", ["tenant-admin", "members", "offboarding"], { entity: "optional" }),
      route("organization", "members", "member", "成员详情", ["tenant-admin", "members", "member"], {
        navigation: "detail",
        entity: "required",
        tabs: ["profile", "access", "assignments", "usage-policy", "security-audit"],
        defaultTab: "profile",
        parentId: "organization.members.list",
      }),
    ],
  },
  {
    id: "agents", label: "智能体与资源", routes: [
      route("organization", "agents", "org-agents", "组织智能体", ["tenant-admin", "agents", "org-agents"], { entity: "optional" }),
      route("organization", "agents", "workflows", "工作流", ["tenant-admin", "agents", "workflows"]),
      route("organization", "agents", "dingtalk-accounts", "钉钉账号", ["tenant-admin", "agents", "dingtalk-accounts"]),
      route("organization", "agents", "skills", "技能", ["tenant-admin", "agents", "skills"], { entity: "optional" }),
      route("organization", "agents", "connectors", "连接器与凭据", ["tenant-admin", "agents", "connectors"], { entity: "optional" }),
      route("organization", "agents", "connector-mappings", "连接器映射", ["tenant-admin", "agents", "connector-mappings"]),
      route("organization", "agents", "memory-knowledge", "记忆与知识", ["tenant-admin", "agents", "memory-knowledge"], { entity: "optional" }),
      route("organization", "agents", "files-data", "文件与数据", ["tenant-admin", "agents", "files-data"]),
      route("organization", "agents", "model-tools", "模型与工具策略", ["tenant-admin", "agents", "model-tools"]),
      route("organization", "agents", "environments", "环境可用范围", ["tenant-admin", "agents", "environments"], { entity: "optional" }),
    ],
  },
  {
    id: "governance", label: "用量与治理", routes: [
      route("organization", "governance", "automation", "自动化任务", ["tenant-admin", "governance", "automation"], { entity: "optional" }),
      route("organization", "governance", "usage", "用量、预算与计费", ["tenant-admin", "governance", "usage"]),
      route("organization", "governance", "qa", "会话质检", ["tenant-admin", "governance", "qa"], { entity: "optional" }),
      route("organization", "governance", "audit", "操作记录", ["tenant-admin", "governance", "audit"], { entity: "optional" }),
    ],
  },
  {
    id: "settings", label: "组织设置", routes: [
      route("organization", "settings", "profile", "组织资料", ["tenant-admin", "settings", "profile"]),
      route("organization", "settings", "rules", "智能体规则", ["tenant-admin", "settings", "rules"]),
      route("organization", "settings", "general", "功能与配额", ["tenant-admin", "settings", "general"]),
      route("organization", "settings", "brand", "品牌", ["tenant-admin", "settings", "brand"]),
      route("organization", "settings", "security", "登录与安全", ["tenant-admin", "settings", "security"]),
    ],
  },
];

function personalSettingsRoute(entry: SettingsRegistryEntryForScope<"personal">): GovernanceRouteDefinition {
  const tabOptions = "tabs" in entry
    ? { tabs: entry.tabs, defaultTab: entry.defaultTab }
    : {};
  return {
    ...route("settings", entry.group, entry.id, entry.label, entry.path.split("/").filter(Boolean), tabOptions),
    id: entry.routeId,
  };
}

const settingsWorkspace: GovernanceWorkspaceDefinition = {
  id: "settings",
  label: "个人设置",
  routes: settingsSectionsForScope("personal").map(personalSettingsRoute),
};

export const GOVERNANCE_NAVIGATION = {
  platform: platformWorkspaces,
  organization: organizationWorkspaces,
  settings: [settingsWorkspace],
} as const;

export const GOVERNANCE_ROUTES: readonly GovernanceRouteDefinition[] = [
  ...platformWorkspaces.flatMap((workspace) => workspace.routes),
  ...organizationWorkspaces.flatMap((workspace) => workspace.routes),
  ...settingsWorkspace.routes,
];

const routesById = new Map(GOVERNANCE_ROUTES.map((definition) => [definition.id, definition]));
const routesByPath = [...GOVERNANCE_ROUTES].sort((a, b) => b.path.length - a.path.length);

export interface GovernanceRouteState {
  routeId: string;
  area: GovernanceArea;
  workspace: string;
  page: string;
  entityId: string | null;
  tab: string | null;
  orgId: string | null;
  search: string;
}

export type GovernanceParseResult =
  | { kind: "route"; route: GovernanceRouteState; canonicalPath: string | null; legacy: boolean }
  | { kind: "invalid"; reason: "not-governance" | "malformed" | "unknown-route" | "missing-entity" | "unexpected-entity" | "invalid-tab" | "forbidden-org" };

const PLATFORM_LEGACY: Readonly<Record<string, string>> = {
  overview: "platform.overview.overview",
  tenants: "platform.org-business.tenants",
  users: "platform.org-business.users",
  sessions: "platform.runtime.sessions",
  runs: "platform.runtime.runs",
  "run-trace": "platform.runtime.runs",
  sandboxes: "platform.runtime.environments",
  runtime: "platform.runtime.environments",
  infra: "platform.runtime.infra",
  audit: "platform.governance.audit",
  efficiency: "platform.runtime.efficiency",
};

const PLATFORM_SETTINGS_LEGACY: Readonly<Record<string, string>> = {
  ...Object.fromEntries(settingsSectionsForScope("platform").map((entry) => [entry.id, entry.targetRouteId])),
  "run-trace": "platform.runtime.runs",
  runtime: "platform.runtime.environments",
};

const TENANT_LEGACY: Readonly<Record<string, string>> = {
  "/tenant-admin": "organization.overview.overview",
  "/tenant-admin/usage": "organization.governance.usage",
  "/tenant-admin/qa": "organization.governance.qa",
  "/tenant-admin/audit": "organization.governance.audit",
  "/users": "organization.members.list",
  "/skills": "organization.agents.skills",
  "/usage": "organization.governance.usage",
};

const TENANT_SETTINGS_LEGACY: Readonly<Record<string, string>> = Object.fromEntries(
  settingsSectionsForScope("tenant").map((entry) => [entry.id, entry.targetRouteId]),
);

const personalSettingsRouteId = (id: PersonalSettingsSectionId) => getSettingsSection("personal", id).routeId;
const LEGACY_SETTINGS_TAB_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "settings.personal.my-agent": { persona: "agent-profile" },
};
const SETTINGS_LEGACY: Readonly<Record<string, { routeId: string; tab?: string }>> = {
  "/settings": { routeId: personalSettingsRouteId("account-security") },
  "/settings/account": { routeId: personalSettingsRouteId("account-security") },
  "/settings/general": { routeId: personalSettingsRouteId("chat-model") },
  "/settings/personalization": { routeId: personalSettingsRouteId("appearance-layout") },
  "/settings/all-agents": { routeId: personalSettingsRouteId("my-agent") },
  "/settings/memory": { routeId: personalSettingsRouteId("my-agent"), tab: "memory" },
  "/settings/skills": { routeId: personalSettingsRouteId("my-permissions") },
  "/settings/mcp": { routeId: personalSettingsRouteId("connections") },
  "/settings/files": { routeId: personalSettingsRouteId("files-storage") },
  "/settings/storage": { routeId: personalSettingsRouteId("files-storage") },
  "/settings/data": { routeId: personalSettingsRouteId("trash") },
};

function decodeParts(pathname: string): string[] | null {
  if (!pathname.startsWith("/") || pathname.startsWith("//") || pathname.includes("\\")) return null;
  const raw = pathname.split("/").slice(1);
  if (raw[raw.length - 1] === "") raw.pop();
  const result: string[] = [];
  for (const value of raw) {
    try {
      const decoded = decodeURIComponent(value);
      if (!decoded || decoded === "." || decoded === ".." || /[\\/\0]/.test(decoded)) return null;
      result.push(decoded);
    } catch {
      return null;
    }
  }
  return result;
}

function splitRelativeUrl(input: string): { pathname: string; params: URLSearchParams } | null {
  if (!input.startsWith("/") || input.startsWith("//") || /[\u0000-\u001f\\]/.test(input)) return null;
  const hashIndex = input.indexOf("#");
  const withoutHash = hashIndex >= 0 ? input.slice(0, hashIndex) : input;
  const queryIndex = withoutHash.indexOf("?");
  const pathname = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
  const query = queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : "";
  return decodeParts(pathname) ? { pathname, params: new URLSearchParams(query) } : null;
}

function normalizedSearch(params: URLSearchParams): string {
  params.sort();
  const value = params.toString();
  return value ? `?${value}` : "";
}

function makeState(
  definition: GovernanceRouteDefinition,
  options: Partial<Pick<GovernanceRouteState, "entityId" | "tab" | "orgId" | "search">> = {},
): GovernanceRouteState {
  return {
    routeId: definition.id,
    area: definition.area,
    workspace: definition.workspace,
    page: definition.page,
    entityId: options.entityId ?? null,
    tab: options.tab ?? definition.defaultTab ?? null,
    orgId: options.orgId ?? null,
    search: options.search ?? "",
  };
}

function encodeSegment(value: string, name: string): string {
  if (!value || value === "." || value === ".." || /[\\/\0]/.test(value)) throw new Error(`Invalid ${name}`);
  return encodeURIComponent(value);
}

function buildFromDefinition(definition: GovernanceRouteDefinition, state: GovernanceRouteState): string {
  if (definition.entity === "required" && !state.entityId) throw new Error(`Route ${definition.id} requires entityId`);
  if (definition.entity === "none" && state.entityId) throw new Error(`Route ${definition.id} does not accept entityId`);
  if (state.tab && (!definition.tabs || !definition.tabs.includes(state.tab))) throw new Error(`Invalid tab ${state.tab} for ${definition.id}`);
  if (state.orgId && !isCustomerOrganizationId(state.orgId)) throw new Error("pantheon is not a customer organization scope");
  if (definition.id === "platform.org-business.tenants" && state.entityId && !isCustomerOrganizationId(state.entityId)) {
    throw new Error("pantheon is not a customer organization");
  }

  const path = [...definition.path];
  if (state.entityId) {
    path.push(encodeSegment(state.entityId, "entityId"));
    if (definition.tabs) path.push(encodeSegment(state.tab ?? definition.defaultTab ?? definition.tabs[0], "tab"));
  }
  const params = new URLSearchParams(state.search.startsWith("?") ? state.search.slice(1) : state.search);
  params.delete("org");
  params.delete("tab");
  if (definition.area === "organization" && state.orgId) params.set("org", state.orgId);
  if (definition.area === "settings" && definition.tabs && state.tab && state.tab !== definition.defaultTab) params.set("tab", state.tab);
  return `/${path.join("/")}${normalizedSearch(params)}`;
}

export function buildGovernanceUrl(state: GovernanceRouteState): string {
  const definition = routesById.get(state.routeId);
  if (!definition) throw new Error(`Unknown governance route: ${state.routeId}`);
  if (definition.area !== state.area || definition.workspace !== state.workspace || definition.page !== state.page) {
    throw new Error(`Route identity mismatch: ${state.routeId}`);
  }
  return buildFromDefinition(definition, state);
}

export function governanceRoute(routeId: string, options: Partial<Pick<GovernanceRouteState, "entityId" | "tab" | "orgId" | "search">> = {}): GovernanceRouteState {
  const definition = routesById.get(routeId);
  if (!definition) throw new Error(`Unknown governance route: ${routeId}`);
  return makeState(definition, options);
}

function parseRegistered(parts: readonly string[], params: URLSearchParams): GovernanceParseResult | null {
  for (const definition of routesByPath) {
    if (!definition.path.every((part, index) => parts[index] === part)) continue;
    const rest = parts.slice(definition.path.length);
    let entityId: string | null = null;
    let tab: string | null = definition.defaultTab ?? null;
    if (definition.entity === "none" && rest.length) return { kind: "invalid", reason: "unexpected-entity" };
    if (definition.entity === "required" && !rest[0]) return { kind: "invalid", reason: "missing-entity" };
    if (definition.entity !== "none" && rest[0]) entityId = rest[0];
    if (definition.id === "platform.org-business.tenants" && entityId && !isCustomerOrganizationId(entityId)) {
      return { kind: "invalid", reason: "forbidden-org" };
    }
    if (definition.tabs && entityId) {
      tab = rest[1] ?? definition.defaultTab ?? definition.tabs[0];
      if (!definition.tabs.includes(tab) || rest.length > 2) return { kind: "invalid", reason: "invalid-tab" };
    } else if (rest.length > (entityId ? 1 : 0)) {
      return { kind: "invalid", reason: "unexpected-entity" };
    }
    if (definition.area === "settings" && definition.tabs) {
      const requested = params.get("tab");
      if (requested) tab = LEGACY_SETTINGS_TAB_ALIASES[definition.id]?.[requested] ?? requested;
      if (tab && !definition.tabs.includes(tab)) return { kind: "invalid", reason: "invalid-tab" };
    }
    const orgId = definition.area === "organization" ? params.get("org") : null;
    if (orgId && !isCustomerOrganizationId(orgId)) return { kind: "invalid", reason: "forbidden-org" };
    const owned = new URLSearchParams(params);
    owned.delete("org");
    owned.delete("tab");
    const state = makeState(definition, { entityId, tab, orgId, search: normalizedSearch(owned) });
    const canonical = buildFromDefinition(definition, state);
    return { kind: "route", route: state, canonicalPath: canonical, legacy: false };
  }
  return null;
}

function legacyResult(routeId: string, params: URLSearchParams, entityId?: string, tab?: string): GovernanceParseResult {
  const definition = routesById.get(routeId);
  if (!definition) return { kind: "invalid", reason: "unknown-route" };
  const orgId = definition.area === "organization" ? params.get("org") : null;
  if (orgId && !isCustomerOrganizationId(orgId)) return { kind: "invalid", reason: "forbidden-org" };
  if (definition.id === "platform.org-business.tenants" && entityId && !isCustomerOrganizationId(entityId)) {
    return { kind: "invalid", reason: "forbidden-org" };
  }
  const owned = new URLSearchParams(params);
  owned.delete("org");
  owned.delete("tab");
  const state = makeState(definition, { entityId, tab, orgId, search: normalizedSearch(owned) });
  return { kind: "route", route: state, canonicalPath: buildFromDefinition(definition, state), legacy: true };
}

function parseLegacy(pathname: string, parts: readonly string[], params: URLSearchParams): GovernanceParseResult | null {
  const settings = SETTINGS_LEGACY[pathname];
  if (settings) return legacyResult(settings.routeId, params, undefined, settings.tab);

  const tenant = TENANT_LEGACY[pathname];
  if (tenant) return legacyResult(tenant, params);
  if (parts[0] === "tenant-admin" && parts[1] === "settings" && parts.length <= 3) {
    const legacySection = parts[2] ?? "users";
    if (legacySection === "billing" && !params.has("usageSection")) params.set("usageSection", "billing");
    return legacyResult(TENANT_SETTINGS_LEGACY[legacySection] ?? "organization.members.list", params);
  }

  if (parts[0] !== "platform-admin") return null;
  if (parts[1] === "settings" && parts.length <= 3) {
    return legacyResult(PLATFORM_SETTINGS_LEGACY[parts[2] ?? "tenants"] ?? "platform.org-business.tenants", params);
  }
  if (parts.length > 3) return { kind: "invalid", reason: "unexpected-entity" };
  const routeId = PLATFORM_LEGACY[parts[1] ?? "overview"];
  if (!routeId) return { kind: "invalid", reason: "unknown-route" };
  return legacyResult(routeId, params, parts[2]);
}

export function parseGovernanceUrl(input: string): GovernanceParseResult {
  const split = splitRelativeUrl(input);
  if (!split) return { kind: "invalid", reason: "malformed" };
  const parts = decodeParts(split.pathname);
  if (!parts) return { kind: "invalid", reason: "malformed" };
  const registered = parseRegistered(parts, new URLSearchParams(split.params));
  if (registered) {
    if (registered.kind === "route") {
      const actual = `${split.pathname}${normalizedSearch(split.params)}`;
      registered.canonicalPath = actual === registered.canonicalPath ? null : registered.canonicalPath;
    }
    return registered;
  }
  const legacy = parseLegacy(split.pathname.replace(/\/$/, "") || "/", parts, new URLSearchParams(split.params));
  if (legacy) return legacy;
  const governancePrefix = ["platform-console", "platform-admin", "tenant-admin", "settings"].includes(parts[0] ?? "");
  return { kind: "invalid", reason: governancePrefix ? "unknown-route" : "not-governance" };
}

export function canonicalGovernanceUrl(input: string): string | null {
  const result = parseGovernanceUrl(input);
  return result.kind === "route" ? result.canonicalPath : null;
}

export function isCustomerOrganizationId(orgId: string): boolean {
  return orgId.trim().length > 0 && orgId.trim().toLowerCase() !== "pantheon";
}

export function filterCustomerOrganizations<T extends { id: string }>(organizations: readonly T[]): T[] {
  return organizations.filter((organization) => isCustomerOrganizationId(organization.id));
}

/** 切组织后保留工作区/叶子，清除实体、tab 与所有页内筛选；详情页退回其父叶子。 */
export function organizationSwitchRoute(current: GovernanceRouteState, nextOrgId: string): GovernanceRouteState {
  if (current.area !== "organization") throw new Error("Organization switch only accepts organization routes");
  if (!isCustomerOrganizationId(nextOrgId)) throw new Error("pantheon is not a customer organization scope");
  const currentDefinition = routesById.get(current.routeId);
  if (!currentDefinition) throw new Error(`Unknown governance route: ${current.routeId}`);
  const target = currentDefinition.parentId ? routesById.get(currentDefinition.parentId) : currentDefinition;
  if (!target) throw new Error(`Missing parent route for ${current.routeId}`);
  return makeState(target, { orgId: nextOrgId });
}

export function buildOrganizationSwitchUrl(current: GovernanceRouteState, nextOrgId: string): string {
  const next = organizationSwitchRoute(current, nextOrgId);
  return buildGovernanceUrl(next);
}

/** returnTo 只接受无控制字符、无反斜杠、无点段的站内绝对路径。 */
export function safeGovernanceReturnTo(value: string | null | undefined, fallback = "/"): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\u0000-\u001f\\]/.test(value)) return fallback;
  const hashIndex = value.indexOf("#");
  const beforeHash = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const queryIndex = beforeHash.indexOf("?");
  const pathname = queryIndex >= 0 ? beforeHash.slice(0, queryIndex) : beforeHash;
  if (!decodeParts(pathname)) return fallback;
  try {
    const url = new URL(value, "https://app.local");
    if (url.origin !== "https://app.local") return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}
