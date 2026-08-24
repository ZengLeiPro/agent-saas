import type { IPlatformConfig } from '@agent/shared';

// 前端与 API 分域部署时（web 静态托管在 OSS、API 在 api.agent.kaiyan.net），
// 构建时注入 VITE_API_BASE=https://api.agent.kaiyan.net。
// 留空则保持同源相对路径：本地 dev 走 vite proxy，ECS 同域部署走 nginx 反代。
const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '');
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
