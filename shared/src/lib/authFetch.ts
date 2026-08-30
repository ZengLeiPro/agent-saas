import { getPlatform } from '../platform/context';
import { TOKEN_KEY } from './constants';

let onUnauthorized: (() => void) | null = null;
let sensitiveTransportAllowed = true;

/** Mobile M30-02 gate. Locked/offline-shell modes fail closed before reading tokens. */
export function setSensitiveTransportAllowed(allowed: boolean): void {
  sensitiveTransportAllowed = allowed;
}

export function isSensitiveTransportAllowed(): boolean {
  return sensitiveTransportAllowed;
}

export function setOnUnauthorized(fn: () => void) {
  onUnauthorized = fn;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (typeof input === 'object' && input !== null && 'url' in input) {
    return String(input.url);
  }
  return String(input);
}

async function guardedAuthFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  localUnlockValidation = false,
): Promise<Response> {
  if (!sensitiveTransportAllowed && !localUnlockValidation) {
    throw new Error('LOCAL_APP_LOCK_BLOCKED');
  }
  const platform = getPlatform();

  // Prepend baseUrl for relative paths (RN needs absolute URLs), then enforce
  // the final transport policy before even reading a credential.
  let url: RequestInfo | URL = input;
  if (typeof input === 'string' && input.startsWith('/')) {
    url = platform.platformConfig.getBaseUrl() + input;
  }
  platform.platformConfig.assertTrustedUrl?.(requestUrl(url), 'http');

  const token = await platform.secureStorage.getItem(TOKEN_KEY);
  const headers = new Headers(init?.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
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
  if (refreshToken && sensitiveTransportAllowed) {
    platform.secureStorage.setItem(TOKEN_KEY, refreshToken).catch((e) => {
      console.warn('[authFetch] Failed to save refreshed token:', e);
    });
  }

  return response;
}

export function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return guardedAuthFetch(input, init);
}

/** Dedicated credential revalidation path; it cannot refresh tokens while the local gate is closed. */
export function authFetchForLocalUnlockValidation(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return guardedAuthFetch(input, init, true);
}
