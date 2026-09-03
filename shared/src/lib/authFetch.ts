import { getPlatform } from '../platform/context';
import { TOKEN_KEY } from './constants';
import { AUTH_SESSION_KEY } from './authLifecycle';

let onUnauthorized: (() => void) | null = null;
let sensitiveTransportAllowed = true;
let authSideEffectGeneration = 0;
let credentialMutationTail: Promise<void> = Promise.resolve();

function authIdentityChanged(): Error {
  return new Error('AUTH_IDENTITY_CHANGED');
}

function isAuthIdentityChanged(error: unknown): boolean {
  return error instanceof Error && error.message === 'AUTH_IDENTITY_CHANGED';
}

/**
 * Invalidates every earlier HTTP side effect synchronously, then waits until an
 * already-started credential mutation has either committed or failed closed.
 * Auth lifecycle transitions must await this before writing the next identity.
 */
export function fenceAuthSideEffects(): Promise<void> {
  authSideEffectGeneration += 1;
  return credentialMutationTail;
}

/** Mobile M30-02 gate. Locked/offline-shell modes fail closed before reading tokens. */
export function setSensitiveTransportAllowed(allowed: boolean): void {
  if (sensitiveTransportAllowed !== allowed) {
    sensitiveTransportAllowed = allowed;
    authSideEffectGeneration += 1;
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

function serializeCredentialMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const result = credentialMutationTail.then(mutation, mutation);
  credentialMutationTail = result.then(() => undefined, () => undefined);
  return result;
}

async function assertRequestIdentity(
  platform: ReturnType<typeof getPlatform>,
  requestGeneration: number,
  token: string | null,
  authBinding: string | null,
): Promise<void> {
  const [currentToken, currentAuthBinding] = await Promise.all([
    platform.secureStorage.getItem(TOKEN_KEY),
    platform.secureStorage.getItem(AUTH_SESSION_KEY),
  ]);
  if (
    requestGeneration !== authSideEffectGeneration
    || currentToken !== token
    || currentAuthBinding !== authBinding
  ) {
    throw authIdentityChanged();
  }
}

async function clearStaleCredentialWrite(
  platform: ReturnType<typeof getPlatform>,
  refreshToken: string,
  previousBinding: string | null,
  nextBinding: string | null,
): Promise<void> {
  const [currentToken, currentBinding] = await Promise.all([
    platform.secureStorage.getItem(TOKEN_KEY),
    platform.secureStorage.getItem(AUTH_SESSION_KEY),
  ]);
  const removals: Promise<void>[] = [];
  if (currentToken === refreshToken) {
    removals.push(Promise.resolve(platform.secureStorage.removeItem(TOKEN_KEY)));
  }
  if (currentBinding === previousBinding || (nextBinding !== null && currentBinding === nextBinding)) {
    removals.push(Promise.resolve(platform.secureStorage.removeItem(AUTH_SESSION_KEY)));
  }
  await Promise.allSettled(removals);
}

async function persistRefreshIfCurrent(input: {
  platform: ReturnType<typeof getPlatform>;
  requestGeneration: number;
  token: string | null;
  authBinding: string | null;
  refreshToken: string;
  nextBinding: string | null;
}): Promise<void> {
  const {
    platform,
    requestGeneration,
    token,
    authBinding,
    refreshToken,
    nextBinding,
  } = input;
  await serializeCredentialMutation(async () => {
    await assertRequestIdentity(platform, requestGeneration, token, authBinding);
    try {
      await platform.secureStorage.setItem(TOKEN_KEY, refreshToken);
      if (requestGeneration !== authSideEffectGeneration) {
        await clearStaleCredentialWrite(platform, refreshToken, authBinding, nextBinding);
        throw authIdentityChanged();
      }
      if (nextBinding !== null) {
        await platform.secureStorage.setItem(AUTH_SESSION_KEY, nextBinding);
        if (requestGeneration !== authSideEffectGeneration) {
          await clearStaleCredentialWrite(platform, refreshToken, authBinding, nextBinding);
          throw authIdentityChanged();
        }
      }
    } catch (error) {
      if (isAuthIdentityChanged(error)) throw error;
      await Promise.allSettled([
        platform.secureStorage.removeItem(TOKEN_KEY),
        platform.secureStorage.removeItem(AUTH_SESSION_KEY),
      ]);
      console.warn('[authFetch] Failed to persist refreshed auth generation:', error);
      onUnauthorized?.();
      throw new Error('AUTH_BINDING_PERSIST_FAILED');
    }
  });
}

async function guardedAuthFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  localUnlockValidation = false,
  returnUnauthorized = false,
): Promise<Response> {
  if (!sensitiveTransportAllowed && !localUnlockValidation) {
    throw new Error('LOCAL_APP_LOCK_BLOCKED');
  }
  const platform = getPlatform();

  let url: RequestInfo | URL = input;
  if (typeof input === 'string' && input.startsWith('/')) {
    url = platform.platformConfig.getBaseUrl() + input;
  }
  platform.platformConfig.assertTrustedUrl?.(requestUrl(url), 'http');

  const requestGeneration = authSideEffectGeneration;
  const [token, authBinding] = await Promise.all([
    platform.secureStorage.getItem(TOKEN_KEY),
    platform.secureStorage.getItem(AUTH_SESSION_KEY),
  ]);
  if (requestGeneration !== authSideEffectGeneration) throw authIdentityChanged();
  const headers = new Headers(init?.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const response = await fetch(url, { ...init, headers });
  await assertRequestIdentity(platform, requestGeneration, token, authBinding);
  if (response.status === 401) {
    if (!returnUnauthorized) onUnauthorized?.();
  } else if (response.status === 403) {
    try {
      const body = await response.clone().json() as { code?: string };
      await assertRequestIdentity(platform, requestGeneration, token, authBinding);
      if (body.code === 'USER_DISABLED') onUnauthorized?.();
    } catch (error) {
      if (isAuthIdentityChanged(error)) throw error;
    }
  }

  const refreshToken = response.headers.get('X-Refresh-Token');
  const authEpoch = Number(response.headers.get('X-Auth-Epoch'));
  const generation = Number(response.headers.get('X-Auth-Generation'));
  const nextBinding = Number.isSafeInteger(authEpoch) && authEpoch > 0
    && Number.isSafeInteger(generation) && generation > 0
    ? JSON.stringify({ authEpoch, generation })
    : null;
  if (refreshToken && sensitiveTransportAllowed) {
    await persistRefreshIfCurrent({
      platform,
      requestGeneration,
      token,
      authBinding,
      refreshToken,
      nextBinding,
    });
  }

  return response;
}

export function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return guardedAuthFetch(input, init);
}

/** 资源凭证 401 只返回调用方，不得失效当前登录会话。 */
export function authFetchResource(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return guardedAuthFetch(input, init, false, true);
}

/** 专用凭证复核通道；本地门禁关闭时不得刷新 token。 */
export function authFetchForLocalUnlockValidation(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return guardedAuthFetch(input, init, true);
}
