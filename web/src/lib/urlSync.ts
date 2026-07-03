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
  'tenants', 'models', 'billing', 'remote-hands', 'runtime', 'run-trace', 'tool-controls', 'global-mcp', 'skill-pool', 'system',
]);

export type AdminSettingsTarget = 'tenant' | 'platform';

export interface AdminSettingsState {
  target: AdminSettingsTarget;
  section: string;
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
  /** 命中 admin settings modal 路径时填充；否则为 null */
  adminSettings: AdminSettingsState | null;
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

/** 解析 pathname → { tab, sessionId, settingsSection, adminSettings } */
export function parseUrl(pathname = window.location.pathname): ParsedUrlState {
  const adminSettings = matchAdminSettingsPath(pathname);
  if (adminSettings) {
    // admin settings modal 浮在对应 admin frame 上；activeTab 跟随 target
    const tab: AppTab = adminSettings.target === 'tenant' ? 'tenant-admin' : 'platform-admin';
    return { tab, sessionId: null, settingsSection: null, adminSettings };
  }
  if (isSettingsPath(pathname)) {
    const section = pathname === '/settings' ? 'account' : decodeURIComponent(pathname.slice('/settings/'.length));
    return { tab: 'chat', sessionId: null, settingsSection: normalizeSettingsSection(section), adminSettings: null };
  }
  if (pathname.startsWith('/chat/')) {
    const id = decodeURIComponent(pathname.slice(6));
    return { tab: 'chat', sessionId: id || null, settingsSection: null, adminSettings: null };
  }
  if (pathname === '/cron') return { tab: 'chat', sessionId: null, settingsSection: 'cron', adminSettings: null };
  if (pathname === '/files') return { tab: 'chat', sessionId: null, settingsSection: 'files', adminSettings: null };
  if (pathname === '/agents' || pathname === '/all-agents') return { tab: 'chat', sessionId: null, settingsSection: 'all-agents', adminSettings: null };
  if (pathname === '/profile') return { tab: 'profile', sessionId: null, settingsSection: null, adminSettings: null };
  if (pathname === '/scenarios') return { tab: 'scenarios', sessionId: null, settingsSection: null, adminSettings: null };
  if (pathname === '/mcp') return { tab: 'chat', sessionId: null, settingsSection: 'mcp', adminSettings: null };
  if (pathname === '/users' || pathname === '/skills' || pathname === '/usage' || pathname === '/tenant-admin') {
    return { tab: 'tenant-admin', sessionId: null, settingsSection: null, adminSettings: null };
  }
  if (pathname === '/tenants' || pathname === '/models' || pathname === '/platform-admin') {
    return { tab: 'platform-admin', sessionId: null, settingsSection: null, adminSettings: null };
  }
  if (pathname === '/trash') return { tab: 'trash', sessionId: null, settingsSection: null, adminSettings: null };
  return { tab: 'chat', sessionId: null, settingsSection: null, adminSettings: null };
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
