import { getPlatform } from '../platform/context';
import { TOKEN_KEY } from './constants';

let onUnauthorized: (() => void) | null = null;

export function setOnUnauthorized(fn: () => void) {
  onUnauthorized = fn;
}

export async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const platform = getPlatform();
  const token = await platform.secureStorage.getItem(TOKEN_KEY);
  const headers = new Headers(init?.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  // Prepend baseUrl for relative paths (RN needs absolute URLs)
  let url: RequestInfo | URL = input;
  if (typeof input === 'string' && input.startsWith('/')) {
    url = platform.platformConfig.getBaseUrl() + input;
  }

  const response = await fetch(url, { ...init, headers });
  if (response.status === 401) {
    onUnauthorized?.();
  } else if (response.status === 403) {
    try {
      const cloned = response.clone();
      const body = await cloned.json() as { code?: string };
      if (body.code === 'USER_DISABLED') {
        onUnauthorized?.();
      }
    } catch { /* ignore parse errors */ }
  }

  // 滑动过期：后端在 token 即将过期时签发新 token
  const refreshToken = response.headers.get('X-Refresh-Token');
  if (refreshToken) {
    platform.secureStorage.setItem(TOKEN_KEY, refreshToken).catch((e) => {
      console.warn('[authFetch] Failed to save refreshed token:', e);
    });
  }

  return response;
}
