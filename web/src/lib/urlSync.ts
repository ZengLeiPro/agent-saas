import type { AppTab } from '@/types/sidebar';
import type { SettingsSectionId } from '@/types/settings';
import { maybeNavigateWithUpdate } from '@/lib/swUpdate';

const SETTINGS_SECTION_IDS: ReadonlySet<string> = new Set([
  'account',
  'general',
  'personalization',
  'all-agents',
  'memory',
  'skills',
  'cron',
  'mcp',
  'files',
  'data',
]);

/** 组织管理 modal 的合法 section（与 AdminShells.tenantSettingsSections 对齐） */
const TENANT_ADMIN_SETTINGS_SECTIONS: ReadonlySet<string> = new Set([
  'users', 'skills', 'mcp', 'billing', 'files', 'company', 'settings',
]);
/** 平台管理 modal 的合法 section（与 AdminShells.platformSettingsSections 对齐） */
const PLATFORM_ADMIN_SETTINGS_SECTIONS: ReadonlySet<string> = new Set([
  'tenants', 'signup', 'models', 'billing', 'remote-hands', 'tool-controls', 'global-mcp', 'skill-pool', 'system',
]);

const PLATFORM_ADMIN_SECTIONS = [
  'overview',
  'tenants',
  'users',
  'sessions',
  'runs',
  'sandboxes',
  'audit',
  'efficiency',
] as const;

const PLATFORM_ADMIN_SECTION_IDS: ReadonlySet<string> = new Set(PLATFORM_ADMIN_SECTIONS);
const LEGACY_PLATFORM_ADMIN_SECTION_REDIRECTS: Readonly<Record<string, PlatformAdminSection>> = {
  'run-trace': 'runs',
  runtime: 'sandboxes',
};

export type AdminSettingsTarget = 'tenant' | 'platform';
export type PlatformAdminSection = typeof PLATFORM_ADMIN_SECTIONS[number];

export interface AdminSettingsState {
  target: AdminSettingsTarget;
  section: string;
}

export interface PlatformAdminRouteState {
  section: PlatformAdminSection;
  entityId: string | null;
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

function parsed(state: Omit<ParsedUrlState, 'adminSection' | 'adminEntityId' | 'canonicalPath'> & Partial<Pick<ParsedUrlState, 'adminSection' | 'adminEntityId' | 'canonicalPath'>>): ParsedUrlState {
  return {
    ...state,
    adminSection: state.adminSection ?? null,
    adminEntityId: state.adminEntityId ?? null,
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
  if (isSettingsPath(pathname)) {
    const section = pathname === '/settings' ? 'account' : decodeURIComponent(pathname.slice('/settings/'.length));
    return parsed({ tab: 'chat', sessionId: null, settingsSection: normalizeSettingsSection(section), adminSettings: null });
  }
  if (pathname.startsWith('/chat/')) {
    const id = decodeURIComponent(pathname.slice(6));
    return parsed({ tab: 'chat', sessionId: id || null, settingsSection: null, adminSettings: null });
  }
  if (pathname === '/cron') return parsed({ tab: 'chat', sessionId: null, settingsSection: 'cron', adminSettings: null });
  if (pathname === '/files') return parsed({ tab: 'chat', sessionId: null, settingsSection: 'files', adminSettings: null });
  if (pathname === '/agents' || pathname === '/all-agents') return parsed({ tab: 'chat', sessionId: null, settingsSection: 'all-agents', adminSettings: null });
  if (pathname === '/profile') return parsed({ tab: 'profile', sessionId: null, settingsSection: null, adminSettings: null });
  if (pathname === '/scenarios') return parsed({ tab: 'scenarios', sessionId: null, settingsSection: null, adminSettings: null });
  if (pathname === '/mcp') return parsed({ tab: 'chat', sessionId: null, settingsSection: 'mcp', adminSettings: null });
  if (pathname === '/users' || pathname === '/skills' || pathname === '/usage' || pathname === '/tenant-admin') {
    return parsed({ tab: 'tenant-admin', sessionId: null, settingsSection: null, adminSettings: null });
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
  if (tab === 'scenarios') return '/scenarios';
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
