import type { AppTab } from '@/types/sidebar';
import type { SettingsSectionId } from '@/types/settings';
import { maybeNavigateWithUpdate } from '@/lib/swUpdate';

/**
 * 用 Record 穷举而非字面量数组：往 SettingsSectionId 加成员却漏配这里时，
 * TS 会直接报缺失属性，避免新 section 被静默 fallback 到 account。
 */
const SETTINGS_SECTION_ID_MAP: Record<SettingsSectionId, true> = {
  'account': true,
  'general': true,
  'personalization': true,
  'all-agents': true,
  'memory': true,
  'skills': true,
  'mcp': true,
  'files': true,
  'storage': true,
  'data': true,
};

const SETTINGS_SECTION_IDS: ReadonlySet<string> = new Set(Object.keys(SETTINGS_SECTION_ID_MAP));

/** 组织管理 modal 的合法 section（与 AdminShells.tenantSettingsSections 对齐） */
const TENANT_ADMIN_SETTINGS_SECTIONS: ReadonlySet<string> = new Set([
  'users', 'skills', 'org-agents', 'mcp', 'billing', 'files', 'company', 'instructions', 'settings',
]);
/** 平台管理 modal 的合法 section（与 AdminShells.platformSettingsSections 对齐） */
const PLATFORM_ADMIN_SETTINGS_SECTIONS: ReadonlySet<string> = new Set([
  'tenants', 'signup', 'models', 'billing', 'remote-hands', 'tool-controls', 'connector-dictionary', 'agent-profiles', 'system-prompts', 'memory-polling', 'global-mcp', 'skill-pool', 'egress', 'system',
]);

const PLATFORM_ADMIN_SECTIONS = [
  'overview',
  'tenants',
  'users',
  'sessions',
  'runs',
  'sandboxes',
  'infra',
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
  const set = target === 'tenant' ? TENANT_ADMIN_SETTINGS_SECTIONS : PLATFORM_ADMIN_SETTINGS_SECTIONS;
  const fallback = target === 'tenant' ? 'users' : 'tenants';
  return set.has(section || '') ? (section as string) : fallback;
}

export interface ParsedUrlState {
  tab: AppTab;
  sessionId: string | null;
  settingsSection: SettingsSectionId | null;
  /** 平台管理主分区，与 settings modal section 分离 */
  adminSection: PlatformAdminSection | null;
  adminEntityId: string | null;
  /** 组织分析页签，与组织管理 settings modal section 分离 */
  tenantAdminSection: TenantAdminSection | null;
  /** 命中 admin settings modal 路径时填充；否则为 null */
  adminSettings: AdminSettingsState | null;
  /** 旧 URL 或非法分区的纯函数 canonical 结果，由调用方统一 replaceState */
  canonicalPath: string | null;
}

export function normalizeSettingsSection(section?: string | null): SettingsSectionId {
  return SETTINGS_SECTION_IDS.has(section || '') ? (section as SettingsSectionId) : 'account';
}

export function isSettingsPath(pathname = window.location.pathname): boolean {
  return pathname === '/settings' || pathname.startsWith('/settings/');
}

function matchAdminSettingsPath(pathname: string): AdminSettingsState | null {
  if (pathname === '/tenant-admin/settings' || pathname.startsWith('/tenant-admin/settings/')) {
    const sec = pathname === '/tenant-admin/settings'
      ? ''
      : decodeURIComponent(pathname.slice('/tenant-admin/settings/'.length));
    return { target: 'tenant', section: normalizeAdminSettingsSection('tenant', sec) };
  }
  if (pathname === '/platform-admin/settings' || pathname.startsWith('/platform-admin/settings/')) {
    const sec = pathname === '/platform-admin/settings'
      ? ''
      : decodeURIComponent(pathname.slice('/platform-admin/settings/'.length));
    return { target: 'platform', section: normalizeAdminSettingsSection('platform', sec) };
  }
  return null;
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

function parsed(state: Omit<ParsedUrlState, 'adminSection' | 'adminEntityId' | 'tenantAdminSection' | 'canonicalPath'> & Partial<Pick<ParsedUrlState, 'adminSection' | 'adminEntityId' | 'tenantAdminSection' | 'canonicalPath'>>): ParsedUrlState {
  return {
    ...state,
    adminSection: state.adminSection ?? null,
    adminEntityId: state.adminEntityId ?? null,
    tenantAdminSection: state.tenantAdminSection ?? null,
    canonicalPath: state.canonicalPath ?? null,
  };
}

/** 解析 pathname → URL state；search 只由 platform-admin 路由读取，常规 buildUrl 仍只管理 pathname */
export function parseUrl(pathname = window.location.pathname, search = window.location.search): ParsedUrlState {
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
  const adminSettings = matchAdminSettingsPath(pathname);
  if (adminSettings) {
    // admin settings modal 浮在对应 admin frame 上；activeTab 跟随 target
    const tab: AppTab = adminSettings.target === 'tenant' ? 'tenant-admin' : 'platform-admin';
    return parsed({ tab, sessionId: null, settingsSection: null, adminSettings });
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
  if (pathname === '/cron') return parsed({ tab: 'cron', sessionId: null, settingsSection: null, adminSettings: null });
  if (pathname === '/files') return parsed({ tab: 'chat', sessionId: null, settingsSection: 'files', adminSettings: null });
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
  if (tab === 'cron') return '/cron';
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

export function buildSettingsUrl(section: SettingsSectionId): string {
  return `/settings/${encodeURIComponent(normalizeSettingsSection(section))}`;
}

/** pushState（创建历史记录，用于用户主动操作） */
export function pushUrl(tab: AppTab, sessionId: string | null): void {
  const next = buildUrl(tab, sessionId);
  if (window.location.pathname !== next) {
    // update-on-navigation：有 pending SW 更新且无守门条件时，
    // 本次跳转改为整页导航直达新版本（swUpdate.ts）
    if (maybeNavigateWithUpdate(next)) return;
    window.history.pushState({}, '', next);
  }
}

/** replaceState（不创建历史，用于内部状态修正） */
export function replaceUrl(tab: AppTab, sessionId: string | null): void {
  const next = buildUrl(tab, sessionId);
  if (window.location.pathname !== next) {
    window.history.replaceState({}, '', next);
  }
}

export function pushPlatformAdminUrl(state: { section?: PlatformAdminSection | null; entityId?: string | null; search?: string | URLSearchParams | Record<string, string | number | boolean | null | undefined> } = {}): void {
  const next = buildPlatformAdminUrl(state);
  if (`${window.location.pathname}${window.location.search}` !== next) {
    if (maybeNavigateWithUpdate(next)) return;
    window.history.pushState({}, '', next);
  }
}

export function replacePlatformAdminUrl(state: { section?: PlatformAdminSection | null; entityId?: string | null; search?: string | URLSearchParams | Record<string, string | number | boolean | null | undefined> } = {}): void {
  const next = buildPlatformAdminUrl(state);
  if (`${window.location.pathname}${window.location.search}` !== next) {
    window.history.replaceState({}, '', next);
  }
}

export function pushSettingsUrl(section: SettingsSectionId): void {
  const next = buildSettingsUrl(section);
  if (window.location.pathname !== next) {
    if (maybeNavigateWithUpdate(next)) return;
    window.history.pushState({}, '', next);
  }
}

export function replaceSettingsUrl(section: SettingsSectionId): void {
  const next = buildSettingsUrl(section);
  if (window.location.pathname !== next) {
    window.history.replaceState({}, '', next);
  }
}

export function buildAdminSettingsUrl(target: AdminSettingsTarget, section?: string | null): string {
  const sec = normalizeAdminSettingsSection(target, section);
  const prefix = target === 'tenant' ? '/tenant-admin/settings' : '/platform-admin/settings';
  return `${prefix}/${encodeURIComponent(sec)}`;
}

export function pushAdminSettingsUrl(target: AdminSettingsTarget, section?: string | null): void {
  const next = buildAdminSettingsUrl(target, section);
  if (window.location.pathname !== next) {
    if (maybeNavigateWithUpdate(next)) return;
    window.history.pushState({}, '', next);
  }
}

export function replaceAdminSettingsUrl(target: AdminSettingsTarget, section?: string | null): void {
  const next = buildAdminSettingsUrl(target, section);
  if (window.location.pathname !== next) {
    window.history.replaceState({}, '', next);
  }
}

export function pushTenantAdminUrl(state: { section?: TenantAdminSection | null; search?: string | URLSearchParams | Record<string, string | number | boolean | null | undefined> } = {}): void {
  const next = buildTenantAdminUrl(state);
  if (`${window.location.pathname}${window.location.search}` !== next) {
    if (maybeNavigateWithUpdate(next)) return;
    window.history.pushState({}, '', next);
  }
}

export function replaceTenantAdminUrl(state: { section?: TenantAdminSection | null; search?: string | URLSearchParams | Record<string, string | number | boolean | null | undefined> } = {}): void {
  const next = buildTenantAdminUrl(state);
  if (`${window.location.pathname}${window.location.search}` !== next) {
    window.history.replaceState({}, '', next);
  }
}

// ───────────────────────── 「土制路由」的唯一派发点 ─────────────────────────
//
// 没有前端 router，`window.history.pushState` 不会触发 popstate，因此每一处程序化跳转
// 都必须手工补一次 `dispatchEvent(new PopStateEvent('popstate'))` 让 useChatAppState /
// useAdminUrlQuery 的订阅者重新读 URL。改造前全仓有 16 处手写派发——新增一个导航调用点
// 只要漏了这一行就静默失效（URL 变了、界面不动）。
//
// 下面的 navigate* 是唯一允许调用 notifyRouteChange 的地方；调用点只用 navigate*。

/** push URL 之后通知所有 URL 订阅者重新解析（pushState 不触发 popstate） */
function notifyRouteChange(): void {
  window.dispatchEvent(new PopStateEvent('popstate'));
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
    if (maybeNavigateWithUpdate(href)) return;
    window.history.pushState({}, '', href);
  }
  notifyRouteChange();
}
