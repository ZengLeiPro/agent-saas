import {
  authFetch,
  parseOAuthCallbackUrl,
  validateOAuthCallback,
  type BoundaryIdentity,
  type OAuthCallbackPayload,
  type NativeOAuthStartBinding,
  type OAuthCallbackTransaction,
} from '@agent/shared';
import { mobileSecureStorage } from '../platform/mobileSecureStorage';
import { getNativeOAuthCallbackAllowlist } from '../platform/nativeOAuthCallbackPolicy';

const DEVICE_KEY = 'native-oauth-device-id-v1';
const TRANSACTION_KEY = 'native-oauth-transaction-v2';
let deviceIdInitialization: Promise<string> | undefined;
const callbackFlights = new Map<string, Promise<NativeOAuthResult>>();

export interface NativeOAuthResult { connectorId: string; status: 'succeeded' | 'failed'; errorCode?: string; }

function randomToken(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (!crypto?.randomUUID) throw new Error('设备安全随机数能力不可用');
  return `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
}

async function pkceChallenge(verifier: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('设备 PKCE SHA-256 能力不可用');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

async function initializeDeviceId(): Promise<string> {
  const existing = await mobileSecureStorage.getItem(DEVICE_KEY);
  if (existing) return existing;
  const deviceId = `device-${randomToken()}`;
  await mobileSecureStorage.setItem(DEVICE_KEY, deviceId);
  const persisted = await mobileSecureStorage.getItem(DEVICE_KEY);
  if (!persisted) throw new Error('OAuth 设备绑定 ID 未能安全持久化');
  return persisted;
}

export function getOrCreateNativeOAuthDeviceId(): Promise<string> {
  if (!deviceIdInitialization) {
    deviceIdInitialization = initializeDeviceId().catch(error => {
      deviceIdInitialization = undefined;
      throw error;
    });
  }
  return deviceIdInitialization;
}

export async function beginNativeOAuthTransaction(
  provider: string,
  identity: BoundaryIdentity,
): Promise<NativeOAuthStartBinding> {
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(provider)) throw new Error('OAuth provider 无效');
  const allowlist = getNativeOAuthCallbackAllowlist();
  const redirectUri = allowlist[0];
  if (!redirectUri) throw new Error('此构建未配置可信 OAuth callback，授权已阻止');
  const transaction: OAuthCallbackTransaction = {
    state: randomToken(),
    pkceVerifier: randomToken(),
    provider,
    redirectUri,
    identity: { userId: identity.userId, tenantId: identity.tenantId, generation: identity.generation },
    createdAt: Date.now(),
  };
  await mobileSecureStorage.setItem(TRANSACTION_KEY, JSON.stringify(transaction));
  const persisted = await mobileSecureStorage.getItem(TRANSACTION_KEY);
  if (!persisted) throw new Error('OAuth transaction 未能安全持久化');
  return {
    nativeDeviceId: await getOrCreateNativeOAuthDeviceId(),
    nativeState: transaction.state,
    nativePkceChallenge: await pkceChallenge(transaction.pkceVerifier),
    nativeProvider: provider,
    nativeRedirectUri: redirectUri,
    nativeIdentityGeneration: identity.generation,
    nativeCreatedAt: transaction.createdAt,
  };
}

export async function cancelNativeOAuthTransaction(): Promise<void> {
  await mobileSecureStorage.removeItem(TRANSACTION_KEY);
}

async function readTransaction(): Promise<OAuthCallbackTransaction | null> {
  const raw = await mobileSecureStorage.getItem(TRANSACTION_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as OAuthCallbackTransaction; }
  catch { await mobileSecureStorage.removeItem(TRANSACTION_KEY); return null; }
}

async function exchange(payload: OAuthCallbackPayload, currentIdentity: BoundaryIdentity): Promise<NativeOAuthResult> {
  const transaction = await readTransaction();
  const validation = validateOAuthCallback({ transaction, payload, currentIdentity, now: Date.now() });
  // Consume locally before network I/O. Duplicate/warm+cold/concurrent callbacks cannot exchange twice.
  await mobileSecureStorage.removeItem(TRANSACTION_KEY);
  if (!validation.ok) throw new Error(validation.code);
  if (payload.error) return { connectorId: payload.provider, status: 'failed', errorCode: payload.error };
  const deviceId = await mobileSecureStorage.getItem(DEVICE_KEY);
  if (!deviceId) throw new Error('本机没有匹配的 OAuth 授权事务');
  const response = await authFetch('/api/connectors/oauth/native/handoff', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code: payload.code, deviceId,
      state: transaction!.state, pkceVerifier: transaction!.pkceVerifier,
      provider: transaction!.provider, redirectUri: transaction!.redirectUri,
      identityGeneration: transaction!.identity.generation,
    }),
  });
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'OAuth 安全回跳校验失败');
  if (typeof body.connectorId !== 'string' || (body.status !== 'succeeded' && body.status !== 'failed')) throw new Error('OAuth 回跳响应合同无效');
  return { connectorId: body.connectorId, status: body.status, ...(typeof body.errorCode === 'string' ? { errorCode: body.errorCode } : {}) };
}

export function consumeNativeOAuthCallback(rawUrl: string, currentIdentity: BoundaryIdentity): Promise<NativeOAuthResult> {
  const payload = parseOAuthCallbackUrl(rawUrl, getNativeOAuthCallbackAllowlist());
  if (!payload) return Promise.reject(new Error('OAuth callback 域名、路由或参数不可信'));
  const existing = callbackFlights.get(payload.state);
  if (existing) return existing;
  const flight = exchange(payload, currentIdentity).finally(() => callbackFlights.delete(payload.state));
  callbackFlights.set(payload.state, flight);
  return flight;
}

/** @internal Test isolation for module-level single-flight state. */
export function resetNativeOAuthHandoffForTests(): void {
  deviceIdInitialization = undefined;
  callbackFlights.clear();
}
