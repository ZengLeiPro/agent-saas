/** M30-01 OAuth callback transaction kernel. Pure, platform-independent logic. */
export const OAUTH_CALLBACK_TRANSACTION_TTL_MS = 10 * 60 * 1000;

export interface OAuthCallbackIdentity {
  userId: string;
  tenantId: string;
  generation: number;
}

export interface OAuthCallbackTransaction {
  state: string;
  pkceVerifier: string;
  provider: string;
  redirectUri: string;
  identity: OAuthCallbackIdentity;
  createdAt: number;
}

export interface NativeOAuthStartBinding {
  nativeDeviceId: string;
  nativeState: string;
  nativePkceChallenge: string;
  nativeProvider: string;
  nativeRedirectUri: string;
  nativeIdentityGeneration: number;
  nativeCreatedAt: number;
}

export interface OAuthCallbackPayload {
  state: string;
  code?: string;
  error?: string;
  provider: string;
  redirectUri: string;
  generation: number;
}

export type OAuthCallbackValidation =
  | { ok: true; transaction: OAuthCallbackTransaction; payload: OAuthCallbackPayload }
  | { ok: false; code: string; retryable: true };

/** Length-independent, constant-work comparison for state values. */
export function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export function normalizeCallbackBase(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash || url.search) return null;
    const custom = url.protocol !== 'https:' && url.hostname === 'oauth' && url.pathname === '/callback';
    const https = url.protocol === 'https:' && !!url.hostname && url.pathname === '/oauth/callback';
    if (!custom && !https) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function parseOAuthCallbackUrl(rawUrl: string, allowlist: readonly string[]): OAuthCallbackPayload | null {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return null; }
  const base = new URL(url.toString());
  base.search = '';
  base.hash = '';
  const allowed = allowlist.some(candidate => {
    const normalized = normalizeCallbackBase(candidate);
    return normalized !== null && constantTimeEqual(normalized, base.toString());
  });
  if (!allowed || url.hash || url.username || url.password) return null;
  const state = url.searchParams.get('state') ?? '';
  const code = url.searchParams.get('code') ?? undefined;
  const error = url.searchParams.get('error') ?? undefined;
  const provider = url.searchParams.get('provider') ?? '';
  const redirectUri = url.searchParams.get('redirect') ?? base.toString();
  const generation = Number(url.searchParams.get('generation'));
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(state)
    || !/^[A-Za-z0-9._:-]{1,200}$/.test(provider)
    || normalizeCallbackBase(redirectUri) !== base.toString()
    || !Number.isSafeInteger(generation) || generation < 0
    || (!!code === !!error)
    || (code && !/^[A-Za-z0-9_-]{48}$/.test(code))
    || (error && !/^[A-Z0-9_:-]{1,120}$/.test(error))) return null;
  return { state, ...(code ? { code } : {}), ...(error ? { error } : {}), provider, redirectUri, generation };
}

export function validateOAuthCallback(input: {
  transaction: OAuthCallbackTransaction | null;
  payload: OAuthCallbackPayload;
  currentIdentity: OAuthCallbackIdentity | null;
  now: number;
  ttlMs?: number;
}): OAuthCallbackValidation {
  const { transaction, payload, currentIdentity, now } = input;
  if (!transaction) return { ok: false, code: 'OAUTH_TRANSACTION_NOT_FOUND', retryable: true };
  if (!constantTimeEqual(transaction.state, payload.state)) return { ok: false, code: 'OAUTH_STATE_MISMATCH', retryable: true };
  if (now < transaction.createdAt || now - transaction.createdAt > (input.ttlMs ?? OAUTH_CALLBACK_TRANSACTION_TTL_MS)) {
    return { ok: false, code: 'OAUTH_TRANSACTION_EXPIRED', retryable: true };
  }
  if (!currentIdentity
    || transaction.identity.userId !== currentIdentity.userId
    || transaction.identity.tenantId !== currentIdentity.tenantId
    || transaction.identity.generation !== currentIdentity.generation
    || payload.generation !== currentIdentity.generation) {
    return { ok: false, code: 'OAUTH_IDENTITY_BOUNDARY_CHANGED', retryable: true };
  }
  if (!constantTimeEqual(transaction.provider, payload.provider)) return { ok: false, code: 'OAUTH_PROVIDER_MISMATCH', retryable: true };
  if (!constantTimeEqual(transaction.redirectUri, payload.redirectUri)) return { ok: false, code: 'OAUTH_REDIRECT_MISMATCH', retryable: true };
  return { ok: true, transaction, payload };
}
