import { getPlatform } from '../platform/context';
import { TOKEN_KEY } from './constants';
import { AUTH_SESSION_KEY } from './authLifecycle';

let onUnauthorized: (() => void) | null = null;
let sensitiveTransportAllowed = true;
let sensitiveTransportGeneration = 0;

/** Mobile M30-02 gate. Locked/offline-shell modes fail closed before reading tokens. */
export function setSensitiveTransportAllowed(allowed: boolean): void {
  if (sensitiveTransportAllowed !== allowed) {
    sensitiveTransportAllowed = allowed;
    sensitiveTransportGeneration += 1;
  }
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

  const requestTransportGeneration = sensitiveTransportGeneration;
  const [token, authBinding] = await Promise.all([
    platform.secureStorage.getItem(TOKEN_KEY),
    platform.secureStorage.getItem(AUTH_SESSION_KEY),
  ]);
  if (requestTransportGeneration !== sensitiveTransportGeneration) {
    throw new Error('AUTH_IDENTITY_CHANGED');
  }
  const headers = new Headers(init?.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(url, { ...init, headers });
  const [currentToken, currentAuthBinding] = await Promise.all([
    platform.secureStorage.getItem(TOKEN_KEY),
    platform.secureStorage.getItem(AUTH_SESSION_KEY),
  ]);
  if (
    requestTransportGeneration !== sensitiveTransportGeneration
    || currentToken !== token
    || currentAuthBinding !== authBinding
  ) {
    throw new Error('AUTH_IDENTITY_CHANGED');
  }
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

  // Sliding expiry and N-1 upgrade are one fail-closed persistence boundary.
  const refreshToken = response.headers.get('X-Refresh-Token');
  const authEpoch = Number(response.headers.get('X-Auth-Epoch'));
  const generation = Number(response.headers.get('X-Auth-Generation'));
  if (refreshToken && sensitiveTransportAllowed) {
    try {
      await platform.secureStorage.setItem(TOKEN_KEY, refreshToken);
      if (Number.isSafeInteger(authEpoch) && authEpoch > 0 && Number.isSafeInteger(generation) && generation > 0) {
        await platform.secureStorage.setItem(AUTH_SESSION_KEY, JSON.stringify({ authEpoch, generation }));
      }
    } catch (error) {
      await Promise.allSettled([
        platform.secureStorage.removeItem(TOKEN_KEY),
        platform.secureStorage.removeItem(AUTH_SESSION_KEY),
      ]);
      console.warn('[authFetch] Failed to persist refreshed auth generation:', error);
      onUnauthorized?.();
      throw new Error('AUTH_BINDING_PERSIST_FAILED');
    }
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
