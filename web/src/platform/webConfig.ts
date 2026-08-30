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
let authEnabledPromise: Promise<boolean> | undefined;

function isAuthEnabled(): Promise<boolean> {
  if (!authEnabledPromise) {
    const request: Promise<boolean> = fetch(`${API_BASE}/api/auth/me`)
      .then((response) => {
        const enabled = response.status !== 404;
        if (!enabled && authEnabledPromise === request) authEnabledPromise = undefined;
        return enabled;
      })
      .catch(() => {
        if (authEnabledPromise === request) authEnabledPromise = undefined;
        return true;
      });
    authEnabledPromise = request;
  }
  return authEnabledPromise;
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
