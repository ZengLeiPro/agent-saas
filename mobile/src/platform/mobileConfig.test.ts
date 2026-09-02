import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
}));

const storage = vi.mocked(AsyncStorage);

function configurePreviewEnv() {
  vi.stubEnv('EXPO_PUBLIC_V1_PROFILE', 'preview');
  vi.stubEnv('EXPO_PUBLIC_MOBILE_API_ORIGIN', 'https://preview-a.mobile.test');
  vi.stubEnv(
    'EXPO_PUBLIC_MOBILE_API_ALLOWLIST',
    'https://preview-a.mobile.test,https://preview-b.mobile.test',
  );
  vi.stubEnv('EXPO_PUBLIC_MOBILE_WS_ALLOWLIST', '');
}

async function loadConfigModule() {
  vi.resetModules();
  return import('./mobileConfig');
}

beforeEach(() => {
  configurePreviewEnv();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  storage.getItem.mockResolvedValue(null);
  storage.setItem.mockResolvedValue(undefined);
  storage.removeItem.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('mobile auth-enabled probe caching', () => {
  it('singleflights per trusted base URL and caches true', async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const { mobileConfig } = await loadConfigModule();

    const first = mobileConfig.isAuthEnabled!();
    const second = mobileConfig.isAuthEnabled!();
    expect(first).toBe(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch(new Response(null, { status: 200 }));
    await expect(first).resolves.toBe(true);
    await expect(mobileConfig.isAuthEnabled!()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries after a 404 false result, then caches true', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { mobileConfig } = await loadConfigModule();

    await expect(mobileConfig.isAuthEnabled!()).resolves.toBe(false);
    await expect(mobileConfig.isAuthEnabled!()).resolves.toBe(true);
    await expect(mobileConfig.isAuthEnabled!()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails safe on network errors and allows a later retry', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('temporary network failure'))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { mobileConfig } = await loadConfigModule();

    await expect(mobileConfig.isAuthEnabled!()).resolves.toBe(true);
    await expect(mobileConfig.isAuthEnabled!()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('M10-01 runtime configuration contract', () => {
  it('fails closed without production API/allowlist and never returns a fallback URL', async () => {
    vi.stubEnv('EXPO_PUBLIC_V1_PROFILE', 'production');
    vi.stubEnv('EXPO_PUBLIC_MOBILE_API_ORIGIN', '');
    vi.stubEnv('EXPO_PUBLIC_MOBILE_API_ALLOWLIST', '');
    vi.stubEnv('EXPO_PUBLIC_MOBILE_WS_ALLOWLIST', '');
    const {
      getServiceConfigSnapshot,
      loadServerUrl,
      mobileConfig,
    } = await loadConfigModule();
    const invalidateSession = vi.fn(async () => {});

    expect(getServiceConfigSnapshot()).toMatchObject({
      profile: 'production',
      ready: false,
      editable: false,
      lanEnabled: false,
      apiOrigin: null,
      wsUrl: null,
    });
    expect(() => mobileConfig.getBaseUrl()).toThrow(/可信服务清单|尚未就绪/);
    expect(() => mobileConfig.getWsUrl()).toThrow(/可信服务清单|尚未就绪/);
    await expect(loadServerUrl(invalidateSession)).resolves.toMatchObject({
      ready: false,
    });
    expect(invalidateSession).toHaveBeenCalledTimes(1);
  });

  it('origin switch invalidates the session before persisting and requires re-login', async () => {
    const events: string[] = [];
    storage.setItem.mockImplementation(async (key) => {
      events.push(`persist:${key}`);
    });
    const invalidateSession = vi.fn(async () => {
      events.push('invalidate-session');
    });
    const { setServerUrl } = await loadConfigModule();

    const result = await setServerUrl(
      'https://preview-b.mobile.test',
      invalidateSession,
    );

    expect(result).toMatchObject({
      changed: true,
      requiresReauthentication: true,
      policy: {
        apiOrigin: 'https://preview-b.mobile.test',
        wsUrl: 'wss://preview-b.mobile.test/ws',
      },
    });
    expect(invalidateSession).toHaveBeenCalledTimes(1);
    expect(events[0]).toBe('invalidate-session');
    expect(events.slice(1)).toEqual([
      'persist:agentChat.serverUrl',
      'persist:agentChat.trustedServiceOrigin',
    ]);
  });

  it('same-origin selection does not clear login state', async () => {
    const invalidateSession = vi.fn(async () => {});
    const { setServerUrl } = await loadConfigModule();

    await expect(setServerUrl(
      'https://preview-a.mobile.test/',
      invalidateSession,
    )).resolves.toMatchObject({
      changed: false,
      requiresReauthentication: false,
    });
    expect(invalidateSession).not.toHaveBeenCalled();
  });

  it('production refuses application-side origin editing', async () => {
    vi.stubEnv('EXPO_PUBLIC_V1_PROFILE', 'production');
    vi.stubEnv('EXPO_PUBLIC_MOBILE_API_ORIGIN', 'https://api.mobile.test');
    vi.stubEnv('EXPO_PUBLIC_MOBILE_API_ALLOWLIST', 'https://api.mobile.test');
    const invalidateSession = vi.fn(async () => {});
    const { setServerUrl } = await loadConfigModule();

    await expect(setServerUrl(
      'https://other.mobile.test',
      invalidateSession,
    )).rejects.toMatchObject({ code: 'ORIGIN_EDIT_DISABLED' });
    expect(invalidateSession).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('initial origin binding clears legacy LAN and invalidates once before activation', async () => {
    storage.getItem.mockResolvedValue(null);
    const invalidateSession = vi.fn(async () => {});
    const { loadServerUrl } = await loadConfigModule();

    const policy = await loadServerUrl(invalidateSession);
    expect(policy.ready).toBe(true);
    expect(invalidateSession).toHaveBeenCalledTimes(1);
    expect(storage.removeItem).toHaveBeenCalledWith('agentChat.lanUrl');
    expect(storage.setItem).toHaveBeenCalledWith(
      'agentChat.trustedServiceOrigin',
      'https://preview-a.mobile.test',
    );
  });
});
