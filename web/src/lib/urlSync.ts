import { startTransition } from 'react';
import type { AppTab } from '@/types/sidebar';
import type { CanonicalSettingsSectionId, SettingsSectionInput } from '@/types/settings';
import { analysisHistoryStateForNavigation, readAnalysisHistoryState } from '@/lib/analysisHistory';
export { analysisHistoryStateForNavigation } from '@/lib/analysisHistory';
import {
  buildGovernanceUrl,
  governanceRoute,
  parseGovernanceUrl,
  type GovernanceRouteState,
} from '@/lib/governanceNavigation';
import { pushAppHistoryState, replaceAppHistoryState } from '@/lib/appHistory';
import { maybeNavigateWithUpdate } from '@/lib/swUpdate';
import { preferredTaskCenterPath } from '@/lib/taskCenterRoute';
import {
  getSettingsSection,
  isSettingsSectionId,
  settingsFallbackSection,
  settingsSectionsForScope,
} from '@/lib/unifiedSettingsRegistry';

const LEGACY_SETTINGS_SECTION_MAP: Readonly<Record<string, CanonicalSettingsSectionId>> = {
  account: 'account-security',
  general: 'chat-model',
  personalization: 'appearance-layout',
  'all-agents': 'my-agent',
  memory: 'my-agent',
  skills: 'my-permissions',
  mcp: 'connections',
  files: 'files-storage',
  storage: 'files-storage',
  data: 'trash',
};

const PLATFORM_ADMIN_SECTIONS = [
  'overview',
  'tenants',
  'users',
  'sessions',
  'runs',
  'sandboxes',
  'infra',
  'provider-quota',
  'audit',
  'efficiency',
] as const;

const PLATFORM_ADMIN_SECTION_IDS: ReadonlySet<string> = new Set(PLATFORM_ADMIN_SECTIONS);
const LEGACY_PLATFORM_ADMIN_SECTION_REDIRECTS: Readonly<Record<string, PlatformAdminSection>> = {
  'run-trace': 'runs',
  runtime: 'sandboxes',
};

/**
 * 组织分析（tenant-admin）的四个页签，与 `TenantAdminHeaderControls` 的导航项一一对应。
 * 改造前 tenant 侧只有 `/tenant-admin` 一个裸路径，页签是本机 useState —— 刷新回到第一个 tab，
 * 且客户无法把「筛到某个月的用量」链接发给同事（交互审计 §2）。
 */
const TENANT_ADMIN_SECTIONS = [
  'overview',
  'usage',
  'qa',
  'audit',
] as const;

const TENANT_ADMIN_SECTION_IDS: ReadonlySet<string> = new Set(TENANT_ADMIN_SECTIONS);

/**
 * 旧的一级路径 → tenant-admin 页签。这些链接已经分享出去，必须继续可用。
 * `/users` / `/skills` 是组织管理弹窗的旧入口，没有对应的分析页签，仍落到 overview。
 */
const LEGACY_TENANT_ADMIN_PATH_SECTIONS: Readonly<Record<string, TenantAdminSection>> = {
  '/usage': 'usage',
};

export type AdminSettingsTarget = 'tenant' | 'platform';
export type PlatformAdminSection = typeof PLATFORM_ADMIN_SECTIONS[number];
export type TenantAdminSection = typeof TENANT_ADMIN_SECTIONS[number];

export interface AdminSettingsState {
  target: AdminSettingsTarget;
  section: string;
}

export interface PlatformAdminRouteState {
  section: PlatformAdminSection;
  entityId: string | null;
  canonicalPath: string | null;
}

export interface TenantAdminRouteState {
  section: TenantAdminSection;
  canonicalPath: string | null;
}

export function normalizeAdminSettingsSection(target: AdminSettingsTarget, section?: string | null): string {
  return isSettingsSectionId(target, section) ? section : settingsFallbackSection(target);
}

export interface ParsedUrlState {
  tab: AppTab;
  sessionId: string | null;
  settingsSection: CanonicalSettingsSectionId | null;
  /** 平台管理主分区，与 settings modal section 分离 */
  adminSection: PlatformAdminSection | null;
  adminEntityId: string | null;
  /** 组织分析页签，与组织管理 settings modal section 分离 */
  tenantAdminSection: TenantAdminSection | null;
  /** 命中 admin settings modal 路径时填充；否则为 null */
  adminSettings: AdminSettingsState | null;
  /** V2 治理控制台/个人设置的稳定路由；非治理页面为 null。 */
  governanceRoute: GovernanceRouteState | null;
  /** 旧 URL 或非法分区的纯函数 canonical 结果，由调用方统一 replaceState */
  canonicalPath: string | null;
}

const SETTINGS_SECTION_BY_ROUTE: ReadonlyMap<string, CanonicalSettingsSectionId> = new Map(
  settingsSectionsForScope('personal').map((entry) => [entry.routeId, entry.id] as const),
);

const PLATFORM_SECTION_BY_ROUTE: Readonly<Record<string, PlatformAdminSection>> = {
  'platform.overview.overview': 'overview',
  'platform.org-business.tenants': 'tenants',
  'platform.org-business.users': 'users',
  'platform.runtime.sessions': 'sessions',
  'platform.runtime.runs': 'runs',
  'platform.runtime.environments': 'sandboxes',
  'platform.runtime.infra': 'infra',
  'platform.runtime.provider-quota': 'provider-quota',
  'platform.runtime.efficiency': 'efficiency',
  'platform.governance.audit': 'audit',
};

const TENANT_SECTION_BY_ROUTE: Readonly<Record<string, TenantAdminSection>> = {
  'organization.overview.overview': 'overview',
  'organization.governance.usage': 'usage',
  'organization.governance.qa': 'qa',
  'organization.governance.audit': 'audit',
};

export function normalizeSettingsSection(section?: string | null): CanonicalSettingsSectionId {
  if (isSettingsSectionId('personal', section)) return section;
  return LEGACY_SETTINGS_SECTION_MAP[section || ''] ?? settingsFallbackSection('personal');
}

export function governanceSettingsRoute(section: SettingsSectionInput): GovernanceRouteState {
  const target = getSettingsSection('personal', normalizeSettingsSection(section));
  return governanceRoute(target.routeId, section === 'memory' ? { tab: 'memory' } : {});
}

export function isSettingsPath(pathname = window.location.pathname): boolean {
  return pathname === '/settings' || pathname.startsWith('/settings/');
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function formatSearch(search?: string | URLSearchParams | Record<string, string | number | boolean | null | undefined>): string {
  if (!search) return '';
  if (typeof search === 'string') {
    if (!search) return '';
    return search.startsWith('?') ? search : `?${search}`;
  }
  if (search instanceof URLSearchParams) {
    const query = search.toString();
    return query ? `?${query}` : '';
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (value === null || value === undefined || value === '') continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function normalizePlatformAdminSection(section?: string | null): PlatformAdminSection {
  return PLATFORM_ADMIN_SECTION_IDS.has(section || '') ? (section as PlatformAdminSection) : 'overview';
}

export function buildPlatformAdminUrl(state: {
  section?: PlatformAdminSection | null;
  entityId?: string | null;
  search?: string | URLSearchParams | Record<string, string | number | boolean | null | undefined>;
} = {}): string {
  const section = normalizePlatformAdminSection(state.section);
  const path = state.entityId
    ? `/platform-admin/${encodeURIComponent(section)}/${encodeURIComponent(state.entityId)}`
    : `/platform-admin/${encodeURIComponent(section)}`;
  return `${path}${formatSearch(state.search)}`;
}

export function parsePlatformAdminPath(pathname: string, search = ''): PlatformAdminRouteState | null {
  if (pathname === '/platform-admin/settings' || pathname.startsWith('/platform-admin/settings/')) {
    const raw = pathname === '/platform-admin/settings'
      ? ''
      : decodeSegment(pathname.slice('/platform-admin/settings/'.length));
    const redirected = LEGACY_PLATFORM_ADMIN_SECTION_REDIRECTS[raw];
    if (!redirected) return null;
    const canonicalPath = buildPlatformAdminUrl({ section: redirected, search });
    return { section: redirected, entityId: null, canonicalPath };
  }

  if (pathname !== '/platform-admin' && !pathname.startsWith('/platform-admin/')) return null;

  const tail = pathname === '/platform-admin' ? '' : pathname.slice('/platform-admin/'.length);
  const [rawSection = '', rawEntityId = ''] = tail.split('/');
  if (!rawSection) return { section: 'overview', entityId: null, canonicalPath: null };

  const decodedSection = decodeSegment(rawSection);
  const section = normalizePlatformAdminSection(decodedSection);
  const entityId = rawEntityId ? decodeSegment(rawEntityId) : null;
  const canonicalPath = section === decodedSection
    ? null
    : buildPlatformAdminUrl({ section, search });
  return { section, entityId, canonicalPath };
}

export function normalizeTenantAdminSection(section?: string | null): TenantAdminSection {
  return TENANT_ADMIN_SECTION_IDS.has(section || '') ? (section as TenantAdminSection) : 'overview';
}

export function buildTenantAdminUrl(state: {
  section?: TenantAdminSection | null;
  search?: string | URLSearchParams | Record<string, string | number | boolean | null | undefined>;
} = {}): string {
  const section = normalizeTenantAdminSection(state.section);
  return `/tenant-admin/${encodeURIComponent(section)}${formatSearch(state.search)}`;
}

/**
 * 解析 tenant-admin 分析页路径。返回 null 表示「不是 tenant-admin 分析页」，
 * 交给后续分支（组织管理弹窗 `/tenant-admin/settings*` 由 matchAdminSettingsPath 处理）。
 */
export function parseTenantAdminPath(pathname: string, search = ''): TenantAdminRouteState | null {
  // 组织管理弹窗路径不是分析页签，必须先让路
  if (pathname === '/tenant-admin/settings' || pathname.startsWith('/tenant-admin/settings/')) return null;

  const legacySection = LEGACY_TENANT_ADMIN_PATH_SECTIONS[pathname];
  if (legacySection) {
    return { section: legacySection, canonicalPath: buildTenantAdminUrl({ section: legacySection, search }) };
  }

  if (pathname !== '/tenant-admin' && !pathname.startsWith('/tenant-admin/')) return null;

  const tail = pathname === '/tenant-admin' ? '' : pathname.slice('/tenant-admin/'.length);
  const [rawSection = ''] = tail.split('/');
  // 裸 /tenant-admin 保持原样（旧链接不变），由调用方的兜底 effect 补成 canonical 页签路径
  if (!rawSection) return { section: 'overview', canonicalPath: null };

  const decodedSection = decodeSegment(rawSection);
  const section = normalizeTenantAdminSection(decodedSection);
  const canonicalPath = section === decodedSection
    ? null
    : buildTenantAdminUrl({ section, search });
  return { section, canonicalPath };
}

/**
 * 跨 section 依然成立的「作用域」筛选键。
 *
 * 其余筛选键（kind / channel / status / phase / cursor …）是 section 私有的，
 * 跨 section 携带只会产生无意义筛选，因此导航时一律丢弃。
 */
export const CROSS_SECTION_SCOPE_KEYS = ['tenantId', 'userId'] as const;

/**
 * tenant-admin 侧跨页签成立的作用域键。
 * `org` = 平台管理员选中的目标组织（业务可读参数名，不用内部 `tenantId`）——
 * 切页签必须带着走，否则「看 T2 的用量」点到「审计」就跳回自己组织了。
 */
export const TENANT_ADMIN_SCOPE_KEYS = ['org'] as const;

/**
 * 从当前（或给定的）query string 里挑出白名单键，用于导航时透传。
 * 这是「导航丢筛选」的对症解法：既不整串复制（会把 section 私有筛选带到不认识它的页面），
 * 也不整串丢弃（当前的 bug：从 runs 筛了某组织点进详情再回列表，组织筛选没了）。
 */
export function preserveSearchKeys(
  keys: readonly string[],
  search: string = typeof window === 'undefined' ? '' : window.location.search,
): URLSearchParams {
  const from = new URLSearchParams(search);
  const next = new URLSearchParams();
  for (const key of keys) {
    const value = from.get(key);
    if (value) next.set(key, value);
  }
  return next;
}

/** `preserveSearchKeys(CROSS_SECTION_SCOPE_KEYS)` 的简写；`omit` 用于跳过目标实体自身代表的键 */
export function preserveScopeSearch(options: { omit?: readonly string[]; search?: string } = {}): URLSearchParams {
  const omit = new Set(options.omit ?? []);
  const keys = CROSS_SECTION_SCOPE_KEYS.filter((key) => !omit.has(key));
  return options.search === undefined
    ? preserveSearchKeys(keys)
    : preserveSearchKeys(keys, options.search);
}

function parsed(state: Omit<ParsedUrlState, 'adminSection' | 'adminEntityId' | 'tenantAdminSection' | 'governanceRoute' | 'canonicalPath'> & Partial<Pick<ParsedUrlState, 'adminSection' | 'adminEntityId' | 'tenantAdminSection' | 'governanceRoute' | 'canonicalPath'>>): ParsedUrlState {
  return {
    ...state,
    adminSection: state.adminSection ?? null,
    adminEntityId: state.adminEntityId ?? null,
    tenantAdminSection: state.tenantAdminSection ?? null,
    governanceRoute: state.governanceRoute ?? null,
    canonicalPath: state.canonicalPath ?? null,
  };
}

/** 解析 pathname → URL state；search 同时用于管理路由与旧任务中心深链的 canonical。 */
export function parseUrl(pathname = window.location.pathname, search = window.location.search): ParsedUrlState {
  // 旧管理设置 URL 也统一交给 Governance parser，canonical 到唯一管理路由。
  const governance = parseGovernanceUrl(`${pathname}${search}`);
  if (governance.kind === 'route') {
    const route = governance.route;
    if (route.area === 'platform') {
      return parsed({
        tab: 'platform-admin', sessionId: null, settingsSection: null, adminSettings: null,
        adminSection: PLATFORM_SECTION_BY_ROUTE[route.routeId] ?? 'overview',
        adminEntityId: route.entityId,
        governanceRoute: route,
        canonicalPath: governance.canonicalPath,
      });
    }
    if (route.area === 'organization') {
      return parsed({
        tab: 'tenant-admin', sessionId: null, settingsSection: null, adminSettings: null,
        tenantAdminSection: TENANT_SECTION_BY_ROUTE[route.routeId] ?? 'overview',
        governanceRoute: route,
        canonicalPath: governance.canonicalPath,
      });
    }
    return parsed({
      tab: 'chat', sessionId: null,
      settingsSection: SETTINGS_SECTION_BY_ROUTE.get(route.routeId) ?? settingsFallbackSection('personal'),
      adminSettings: null,
      governanceRoute: route,
      canonicalPath: governance.canonicalPath,
    });
  }

  const platformAdmin = parsePlatformAdminPath(pathname, search);
  if (platformAdmin) {
    return parsed({
      tab: 'platform-admin',
      sessionId: null,
      settingsSection: null,
      adminSection: platformAdmin.section,
      adminEntityId: platformAdmin.entityId,
      adminSettings: null,
      canonicalPath: platformAdmin.canonicalPath,
    });
  }
  const tenantAdmin = parseTenantAdminPath(pathname, search);
  if (tenantAdmin) {
    return parsed({
      tab: 'tenant-admin',
      sessionId: null,
      settingsSection: null,
      tenantAdminSection: tenantAdmin.section,
      adminSettings: null,
      canonicalPath: tenantAdmin.canonicalPath,
    });
  }
  if (pathname === '/settings/skills') {
    return parsed({ tab: 'capabilities', sessionId: null, settingsSection: null, adminSettings: null, canonicalPath: '/capabilities/skills' });
  }
  if (pathname === '/settings/cron') {
    return parsed({ tab: 'cron', sessionId: null, settingsSection: null, adminSettings: null, canonicalPath: '/cron' });
  }
  if (pathname === '/settings/mcp' || pathname === '/mcp') {
    return parsed({ tab: 'capabilities', sessionId: null, settingsSection: null, adminSettings: null, canonicalPath: '/capabilities/connectors' });
  }
  if (pathname === '/agents' || pathname === '/all-agents' || pathname === '/settings/all-agents') {
    return parsed({ tab: 'capabilities', sessionId: null, settingsSection: null, adminSettings: null, canonicalPath: '/capabilities/experts' });
  }
  if (isSettingsPath(pathname)) {
    const section = pathname === '/settings' ? 'account' : decodeURIComponent(pathname.slice('/settings/'.length));
    return parsed({ tab: 'chat', sessionId: null, settingsSection: normalizeSettingsSection(section), adminSettings: null });
  }
  if (pathname.startsWith('/chat/')) {
    const id = decodeURIComponent(pathname.slice(6));
    return parsed({ tab: 'chat', sessionId: id || null, settingsSection: null, adminSettings: null });
  }
  if (pathname === '/taskboard') return parsed({ tab: 'cron', sessionId: null, settingsSection: null, adminSettings: null });
  if (pathname === '/cron') {
    const query = new URLSearchParams(search);
    let canonicalPath: string | null = null;
    if (query.get('view') === 'board') {
      query.delete('view');
      const canonicalSearch = query.toString();
      canonicalPath = `/taskboard${canonicalSearch ? `?${canonicalSearch}` : ''}`;
    }
    return parsed({ tab: 'cron', sessionId: null, settingsSection: null, adminSettings: null, canonicalPath });
  }
  if (pathname === '/files') return parsed({ tab: 'chat', sessionId: null, settingsSection: 'files-storage', adminSettings: null, canonicalPath: '/settings/files-storage' });
  if (pathname === '/profile') return parsed({ tab: 'profile', sessionId: null, settingsSection: null, adminSettings: null });
  if (pathname === '/capabilities' || pathname === '/capabilities/templates' || pathname === '/capabilities/experts' || pathname === '/capabilities/skills' || pathname === '/capabilities/connectors') {
    return parsed({ tab: 'capabilities', sessionId: null, settingsSection: null, adminSettings: null });
  }
  if (pathname === '/templates' || pathname === '/scenarios') {
    return parsed({ tab: 'capabilities', sessionId: null, settingsSection: null, adminSettings: null, canonicalPath: '/capabilities/templates' });
  }
  // `/tenant-admin*` 与 `/usage` 已由 parseTenantAdminPath 接管；
  // `/users` / `/skills` 是组织管理弹窗的旧入口，没有对应分析页签，落 overview
  if (pathname === '/users' || pathname === '/skills') {
    return parsed({ tab: 'tenant-admin', sessionId: null, settingsSection: null, tenantAdminSection: 'overview', adminSettings: null });
  }
  if (pathname === '/tenants' || pathname === '/models') {
    return parsed({ tab: 'platform-admin', sessionId: null, settingsSection: null, adminSection: 'overview', adminSettings: null });
  }
  if (pathname === '/trash') return parsed({ tab: 'trash', sessionId: null, settingsSection: null, adminSettings: null });
  return parsed({ tab: 'chat', sessionId: null, settingsSection: null, adminSettings: null });
}

/** 构建 URL pathname */
export function buildUrl(tab: AppTab, sessionId: string | null): string {
  if (tab === 'cron') return preferredTaskCenterPath();
  if (tab === 'tenants') return '/tenants';
  if (tab === 'tenant-admin') return '/tenant-admin';
  if (tab === 'platform-admin') return '/platform-admin';
  if (tab === 'files') return '/files';
  if (tab === 'profile') return '/profile';
  if (tab === 'capabilities') return '/capabilities';
  if (tab === 'scenarios') return '/capabilities/templates';
  if (tab === 'skills') return '/skills';
  if (tab === 'usage') return '/usage';
  if (tab === 'mcp') return '/mcp';
  if (tab === 'models') return '/models';
  if (tab === 'settings') return '/settings';
  if (tab === 'trash') return '/trash';
  if (sessionId) return `/chat/${encodeURIComponent(sessionId)}`;
  return '/';
}

export function buildSettingsUrl(section: SettingsSectionInput): string {
  return buildGovernanceUrl(governanceSettingsRoute(section));
}

const PERSONAL_SETTINGS_HISTORY_KEY = '__personalSettingsV2';

export interface PersonalSettingsHistoryState {
  source: string;
  depth: number;
}

export function readPersonalSettingsHistoryState(state: unknown = window.history.state): PersonalSettingsHistoryState | null {
  if (!state || typeof state !== 'object') return null;
  const value = (state as Record<string, unknown>)[PERSONAL_SETTINGS_HISTORY_KEY];
  if (!value || typeof value !== 'object') return null;
  const source = (value as Record<string, unknown>).source;
  const depth = (value as Record<string, unknown>).depth;
  return typeof source === 'string' && source.startsWith('/') && typeof depth === 'number' && depth > 0
    ? { source, depth }
    : null;
}

function settingsHistoryState(navigation?: PersonalSettingsHistoryState): Record<string, unknown> {
  return navigation ? { [PERSONAL_SETTINGS_HISTORY_KEY]: navigation } : {};
}

/** Close every settings history leaf in one move; direct links are replaced, never pushed. */
export function closePersonalSettingsHistory(fallbackUrl: string): 'back' | 'replace' {
  const current = readPersonalSettingsHistoryState();
  if (current) {
    window.history.go(-current.depth);
    return 'back';
  }
  replaceAppHistoryState({}, fallbackUrl);
  return 'replace';
}

export function pushSettingsRoute(route: GovernanceRouteState, navigation?: PersonalSettingsHistoryState): void {
  const next = buildGovernanceUrl(route);
  if (`${window.location.pathname}${window.location.search}` !== next) {
    if (maybeNavigateWithUpdate(next)) return;
    pushAppHistoryState(settingsHistoryState(navigation), next);
  }
}

export function replaceSettingsRoute(route: GovernanceRouteState, navigation?: PersonalSettingsHistoryState): void {
  const next = buildGovernanceUrl(route);
  if (`${window.location.pathname}${window.location.search}` !== next) {
    replaceAppHistoryState(settingsHistoryState(navigation), next);
  }
}

/** pushState（创建历史记录，用于用户主动操作） */
export function pushUrl(tab: AppTab, sessionId: string | null): void {
  const next = buildUrl(tab, sessionId);
  if (window.location.pathname !== next) {
    // update-on-navigation：有 pending SW 更新且无守门条件时，
    // 本次跳转改为整页导航直达新版本（swUpdate.ts）
    if (maybeNavigateWithUpdate(next)) return;
    pushAppHistoryState({}, next);
  }
}

/** replaceState（不创建历史，用于内部状态修正） */
export function replaceUrl(tab: AppTab, sessionId: string | null): void {
  const next = buildUrl(tab, sessionId);
  if (window.location.pathname !== next) {
    replaceAppHistoryState({}, next);
  }
}

export function pushPlatformAdminUrl(state: { section?: PlatformAdminSection | null; entityId?: string | null; search?: string | URLSearchParams | Record<string, string | number | boolean | null | undefined> } = {}): void {
  const next = buildPlatformAdminUrl(state);
  if (`${window.location.pathname}${window.location.search}` !== next) {
    const historyState = analysisHistoryStateForNavigation('push', next);
    if (!readAnalysisHistoryState(historyState) && maybeNavigateWithUpdate(next)) return;
    pushAppHistoryState(historyState, next);
  }
}

export function replacePlatformAdminUrl(state: { section?: PlatformAdminSection | null; entityId?: string | null; search?: string | URLSearchParams | Record<string, string | number | boolean | null | undefined> } = {}): void {
  const next = buildPlatformAdminUrl(state);
  if (`${window.location.pathname}${window.location.search}` !== next) {
    replaceAppHistoryState(analysisHistoryStateForNavigation('replace', next), next);
  }
}

export function pushSettingsUrl(section: SettingsSectionInput, navigation?: PersonalSettingsHistoryState): void {
  pushSettingsRoute(governanceSettingsRoute(section), navigation);
}

export function replaceSettingsUrl(section: SettingsSectionInput, navigation?: PersonalSettingsHistoryState): void {
  replaceSettingsRoute(governanceSettingsRoute(section), navigation);
}

export function buildAdminSettingsUrl(target: AdminSettingsTarget, section?: string | null): string {
  const sec = normalizeAdminSettingsSection(target, section);
  return settingsSectionsForScope(target).find((item) => item.id === sec)!.path;
}

function scopedAdminSettingsUrl(target: AdminSettingsTarget, section?: string | null): string {
  const path = buildAdminSettingsUrl(target, section);
  const scope = target === 'tenant' ? preserveSearchKeys(TENANT_ADMIN_SCOPE_KEYS) : undefined;
  return `${path}${formatSearch(scope)}`;
}

export function pushAdminSettingsUrl(
  target: AdminSettingsTarget,
  section?: string | null,
  navigation?: PersonalSettingsHistoryState,
): void {
  const next = scopedAdminSettingsUrl(target, section);
  if (`${window.location.pathname}${window.location.search}` !== next) {
    if (maybeNavigateWithUpdate(next)) return;
    pushAppHistoryState(settingsHistoryState(navigation), next);
  }
}

export function replaceAdminSettingsUrl(
  target: AdminSettingsTarget,
  section?: string | null,
  navigation?: PersonalSettingsHistoryState,
): void {
  const next = scopedAdminSettingsUrl(target, section);
  if (`${window.location.pathname}${window.location.search}` !== next) {
    replaceAppHistoryState(settingsHistoryState(navigation), next);
  }
}

export function pushTenantAdminUrl(state: { section?: TenantAdminSection | null; search?: string | URLSearchParams | Record<string, string | number | boolean | null | undefined> } = {}): void {
  const next = buildTenantAdminUrl(state);
  if (`${window.location.pathname}${window.location.search}` !== next) {
    const historyState = analysisHistoryStateForNavigation('push', next);
    if (!readAnalysisHistoryState(historyState) && maybeNavigateWithUpdate(next)) return;
    pushAppHistoryState(historyState, next);
  }
}

export function replaceTenantAdminUrl(state: { section?: TenantAdminSection | null; search?: string | URLSearchParams | Record<string, string | number | boolean | null | undefined> } = {}): void {
  const next = buildTenantAdminUrl(state);
  if (`${window.location.pathname}${window.location.search}` !== next) {
    replaceAppHistoryState(analysisHistoryStateForNavigation('replace', next), next);
  }
}

/**
 * V2 治理 route 写入 history。
 *
 * 控制台内部菜单必须保持 SPA 跳转：不能让待应用的 SW 更新借一次菜单点击整页刷新，
 * 否则平台/组织控制台会随机出现白屏闪烁。更新仍由提示条、冷启动与真实浏览器导航处理。
 */
export function pushGovernanceUrl(state: GovernanceRouteState): void {
  const next = buildGovernanceUrl(state);
  if (`${window.location.pathname}${window.location.search}` !== next) {
    pushAppHistoryState(analysisHistoryStateForNavigation('push', next), next);
  }
}

export function replaceGovernanceUrl(state: GovernanceRouteState): void {
  const next = buildGovernanceUrl(state);
  if (`${window.location.pathname}${window.location.search}` !== next) {
    replaceAppHistoryState(analysisHistoryStateForNavigation('replace', next), next);
  }
}

// ───────────────────────── 「土制路由」的唯一派发点 ─────────────────────────
//
// 没有前端 router，`window.history.pushState` 不会触发 popstate，因此每一处程序化跳转
// 都必须手工补一次 `dispatchEvent(new PopStateEvent('popstate'))` 让 useChatAppState /
// useAdminUrlQuery 的订阅者重新读 URL。改造前全仓有 16 处手写派发——新增一个导航调用点
// 只要漏了这一行就静默失效（URL 变了、界面不动）。
//
// 所有 synthetic popstate 都由 notifyRouteChange 统一派发；常规调用点只用下面的 navigate*。

/** push/replace URL 之后通知所有 URL 订阅者重新解析（history API 不触发 popstate） */
export function notifyRouteChange(state: unknown = window.history.state): void {
  window.dispatchEvent(new PopStateEvent('popstate', { state }));
}

/** V2 治理 route 跳转（push + 通知）；前进/后退继续由同一 popstate 通道重解析。 */
export function navigateGovernance(state: GovernanceRouteState, options: { replace?: boolean } = {}): void {
  if (options.replace) replaceGovernanceUrl(state);
  else pushGovernanceUrl(state);
  // 路由目标含懒加载页面时保留当前控制台，chunk 就绪后再一次性切换。
  startTransition(notifyRouteChange);
}

/** 个人设置页内导航：继承来源并累计深度，关闭时可一次返回来源而不在后退中重开。 */
export function navigateSettingsRoute(state: GovernanceRouteState, options: { replace?: boolean } = {}): void {
  const current = readPersonalSettingsHistoryState();
  const navigation = current
    ? { source: current.source, depth: options.replace ? current.depth : current.depth + 1 }
    : undefined;
  if (options.replace) replaceSettingsRoute(state, navigation);
  else pushSettingsRoute(state, navigation);
  notifyRouteChange();
}

/** platform-admin section / entity 跳转（push + 通知） */
export function navigatePlatformAdmin(state: { section?: PlatformAdminSection | null; entityId?: string | null; search?: string | URLSearchParams | Record<string, string | number | boolean | null | undefined> } = {}): void {
  pushPlatformAdminUrl(state);
  notifyRouteChange();
}

/** tenant-admin 分析页签跳转（push + 通知） */
export function navigateTenantAdmin(state: { section?: TenantAdminSection | null; search?: string | URLSearchParams | Record<string, string | number | boolean | null | undefined> } = {}): void {
  pushTenantAdminUrl(state);
  notifyRouteChange();
}

/** 打开 tenant/platform 管理弹窗（push + 通知） */
export function navigateAdminSettings(target: AdminSettingsTarget, section?: string | null): void {
  pushAdminSettingsUrl(target, section);
  notifyRouteChange();
}

/**
 * 任意应用内 href 跳转（push + 通知）。
 * 用于已经持有完整 href 的调用点（全局搜索结果、登录日志里的 /chat/<id> 链接）。
 */
export function navigateToHref(href: string): void {
  if (`${window.location.pathname}${window.location.search}` !== href) {
    const historyState = analysisHistoryStateForNavigation('push', href);
    if (!readAnalysisHistoryState(historyState) && maybeNavigateWithUpdate(href)) return;
    pushAppHistoryState(historyState, href);
  }
  notifyRouteChange();
}
