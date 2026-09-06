import type { IPlatformConfig } from '@agent/shared';

// 同一份不可变 Web 制品先在 Staging 验证、再晋升到生产。制品始终绑定生产 API，
// 仅 Staging 的精确公开域名在运行时改写到隔离 API；本地 dev 仍保持同源相对路径。
const STAGING_API_BY_WEB_HOST: Readonly<Record<string, string>> = {
  'staging-agent.kaiyan.net': 'https://staging-agent-api.kaiyan.net',
};

export function resolveApiBase(compiledBase: string | undefined, hostname: string): string {
  return (STAGING_API_BY_WEB_HOST[hostname] ?? compiledBase ?? '').replace(/\/+$/, '');
}

const API_BASE = resolveApiBase(import.meta.env.VITE_API_BASE, window.location.hostname);
// AuthContext owns the authoritative startup probe. WS consumers mount only after
// that probe settles, so they can reuse its result instead of deliberately
// generating an anonymous 401 against /api/auth/me on every page load.
let authEnabled = true;
let authRevalidation: Promise<boolean> | null = null;

export function setWebAuthEnabled(enabled: boolean): void {
  authEnabled = enabled;
}

async function isAuthEnabled(): Promise<boolean> {
  if (authEnabled) return true;
  if (!authRevalidation) {
    const request = fetch(`${API_BASE}/api/health`, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) return authEnabled;
        const status = (await response.json()) as { authEnabled?: unknown };
        // Old servers omit this field. Only a literal true may upgrade a live
        // no-auth page into authenticated mode during a rolling restart.
        if (status.authEnabled === true) authEnabled = true;
        return authEnabled;
      })
      .catch(() => authEnabled)
      .finally(() => {
        if (authRevalidation === request) authRevalidation = null;
      });
    authRevalidation = request;
  }
  return authRevalidation;
}

export const webConfig: IPlatformConfig = {
  platform: 'web',
  getBaseUrl(): string {
    return API_BASE;
  },
  getWsUrl(): string {
    if (API_BASE) {
      // https:// -> wss://，http:// -> ws://
      return `${API_BASE.replace(/^http/, 'ws')}/ws`;
    }
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/ws`;
  },
  isAuthEnabled,
};
