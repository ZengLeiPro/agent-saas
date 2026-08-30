import { beforeEach, describe, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => new Map<string, string>());
const storage = vi.hoisted(() => ({
  getItem: vi.fn(async (key: string) => memory.get(key) ?? null),
  setItem: vi.fn(async (key: string, value: string) => { memory.set(key, value); }),
  removeItem: vi.fn(async (key: string) => { memory.delete(key); }),
}));
const authFetch = vi.hoisted(() => vi.fn());
vi.mock('../platform/mobileSecureStorage', () => ({ mobileSecureStorage: storage }));
vi.mock('../platform/nativeOAuthCallbackPolicy', () => ({ getNativeOAuthCallbackAllowlist: () => ['agent-saas://oauth/callback', 'https://mobile.example.test/oauth/callback'] }));
vi.mock('@agent/shared', async importOriginal => ({ ...(await importOriginal<object>()), authFetch }));
import * as service from './nativeOAuthHandoff';

const identity = { userId: 'user-a', tenantId: 'tenant-a', generation: 4 };
function callback(tx: { state: string; provider: string; redirectUri: string }, extras: Record<string, string> = {}) {
  const q = new URLSearchParams({ state: tx.state, code: 'c'.repeat(48), provider: tx.provider, redirect: tx.redirectUri, generation: '4', ...extras });
  return `${tx.redirectUri}?${q}`;
}

beforeEach(() => {
  memory.clear(); vi.clearAllMocks(); service.resetNativeOAuthHandoffForTests();
  authFetch.mockResolvedValue({ ok: true, json: async () => ({ connectorId: 'google-workspace', status: 'succeeded' }) });
});

describe('M30-01 native OAuth thin bridge', () => {
  it('securely persists state, PKCE verifier, provider, redirect, generation and createdAt before start', async () => {
    const binding = await service.beginNativeOAuthTransaction('google-workspace', identity);
    const tx = JSON.parse(memory.get('native-oauth-transaction-v2')!);
    expect(tx).toMatchObject({ provider: 'google-workspace', redirectUri: 'agent-saas://oauth/callback', identity, createdAt: expect.any(Number) });
    expect(tx.state).toHaveLength(64); expect(tx.pkceVerifier).toHaveLength(64);
    expect(binding.nativePkceChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('100-way device initialization is single-flight', async () => {
    const ids = await Promise.all(Array.from({ length: 100 }, () => service.getOrCreateNativeOAuthDeviceId()));
    expect(new Set(ids).size).toBe(1);
    expect(storage.setItem.mock.calls.filter(([key]) => key === 'native-oauth-device-id-v1')).toHaveLength(1);
  });

  it('concurrent and duplicate warm/cold callback exchange only once', async () => {
    await service.beginNativeOAuthTransaction('google-workspace', identity);
    const tx = JSON.parse(memory.get('native-oauth-transaction-v2')!);
    const url = callback(tx);
    const results = await Promise.all(Array.from({ length: 20 }, () => service.consumeNativeOAuthCallback(url, identity)));
    expect(results.every(result => result.status === 'succeeded')).toBe(true);
    expect(authFetch).toHaveBeenCalledTimes(1);
    await expect(service.consumeNativeOAuthCallback(url, identity)).rejects.toThrow('OAUTH_TRANSACTION_NOT_FOUND');
  });

  it.each([
    ['state mismatch', { state: 'x'.repeat(64) }, identity, 'OAUTH_STATE_MISMATCH'],
    ['provider mismatch', { provider: 'other' }, identity, 'OAUTH_PROVIDER_MISMATCH'],
    ['generation mismatch', { generation: '5' }, identity, 'OAUTH_IDENTITY_BOUNDARY_CHANGED'],
  ])('rejects %s and clears transaction for retry', async (_name, extras, current, error) => {
    await service.beginNativeOAuthTransaction('google-workspace', identity);
    const tx = JSON.parse(memory.get('native-oauth-transaction-v2')!);
    await expect(service.consumeNativeOAuthCallback(callback(tx, extras), current)).rejects.toThrow(error);
    expect(memory.has('native-oauth-transaction-v2')).toBe(false);
    expect(authFetch).not.toHaveBeenCalled();
  });

  it('rejects expired transaction and A-account start/B-account return', async () => {
    await service.beginNativeOAuthTransaction('google-workspace', identity);
    let tx = JSON.parse(memory.get('native-oauth-transaction-v2')!);
    vi.spyOn(Date, 'now').mockReturnValue(700_001);
    await expect(service.consumeNativeOAuthCallback(callback(tx), identity)).rejects.toThrow('EXPIRED');
      await service.beginNativeOAuthTransaction('google-workspace', identity);
    tx = JSON.parse(memory.get('native-oauth-transaction-v2')!);
    await expect(service.consumeNativeOAuthCallback(callback(tx), { ...identity, userId: 'user-b' })).rejects.toThrow('IDENTITY_BOUNDARY');
  });

  it('accepts HTTPS callback and handles cancellation/error without exchange', async () => {
    await service.beginNativeOAuthTransaction('google-workspace', identity);
    const tx = JSON.parse(memory.get('native-oauth-transaction-v2')!);
    tx.redirectUri = 'https://mobile.example.test/oauth/callback';
    memory.set('native-oauth-transaction-v2', JSON.stringify(tx));
    const result = await service.consumeNativeOAuthCallback(callback(tx, { code: '', error: 'ACCESS_DENIED' }), identity);
    expect(result).toMatchObject({ status: 'failed', errorCode: 'ACCESS_DENIED' });
    expect(authFetch).not.toHaveBeenCalled();
  });

  it('fails closed for unknown domain and route', async () => {
    await service.beginNativeOAuthTransaction('google-workspace', identity);
    const tx = JSON.parse(memory.get('native-oauth-transaction-v2')!);
    await expect(service.consumeNativeOAuthCallback(callback({ ...tx, redirectUri: 'https://evil.test/oauth/callback' }), identity)).rejects.toThrow('不可信');
    await expect(service.consumeNativeOAuthCallback(`${tx.redirectUri}/other`, identity)).rejects.toThrow('不可信');
  });
});
