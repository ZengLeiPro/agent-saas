import { beforeEach, describe, expect, it, vi } from 'vitest';

import { initPlatform } from '../platform/context';
import type { PlatformDeps } from '../platform/types';
import { TOKEN_KEY } from './constants';
import { AUTH_SESSION_KEY } from './authLifecycle';
import { authFetch, authFetchForLocalUnlockValidation, setOnUnauthorized, setSensitiveTransportAllowed } from './authFetch';

// ── 构造一个最小可用的 platform，用真实的 initPlatform 注入 ──────────────
// secureStorage 用 in-memory 版，platformConfig 可注入最终传输策略。
function makePlatform(): {
  platform: PlatformDeps;
  store: Map<string, string>;
} {
  const store = new Map<string, string>();
  const platform = {
    storage: {} as PlatformDeps['storage'],
    secureStorage: {
      getItem: (k: string) => Promise.resolve(store.get(k) ?? null),
      setItem: (k: string, v: string) => {
        store.set(k, v);
        return Promise.resolve();
      },
      removeItem: (k: string) => {
        store.delete(k);
        return Promise.resolve();
      },
    },
    messageCache: {} as PlatformDeps['messageCache'],
    platformConfig: {
      getBaseUrl: () => 'https://api.example.com',
      getWsUrl: () => '',
      platform: 'web' as const,
    },
    scheduleFlush: () => 0,
    cancelFlush: () => {},
  };
  return { platform, store };
}

// 构造 mock Response，可自定义 status / headers / json body。
function makeResponse(opts: {
  status?: number;
  headers?: Record<string, string>;
  jsonBody?: unknown;
}): Response {
  const headers = new Headers(opts.headers);
  const jsonBody = opts.jsonBody;
  const res = {
    status: opts.status ?? 200,
    headers,
    json: vi.fn().mockResolvedValue(jsonBody),
    clone() {
      return res;
    },
  };
  return res as unknown as Response;
}

describe('authFetch', () => {
  let store: Map<string, string>;

  beforeEach(() => {
    const built = makePlatform();
    store = built.store;
    initPlatform(built.platform);
    setOnUnauthorized(() => {}); // 复位回调，避免测试间串扰
    setSensitiveTransportAllowed(true);
    vi.restoreAllMocks();
  });

  it('有 token 时给请求加 Authorization header，并对相对路径拼上 baseUrl', async () => {
    store.set(TOKEN_KEY, 'my-token');
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeResponse({ status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await authFetch('/api/foo', { method: 'GET' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.com/api/foo');
    expect(init.method).toBe('GET');
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer my-token');
  });

  it('无 token 时不加 Authorization header', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeResponse({ status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await authFetch('/api/foo');

    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Headers).get('Authorization')).toBeNull();
  });

  it('绝对 URL 不被 baseUrl 前缀污染', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeResponse({ status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await authFetch('https://other.example.com/x');

    expect(fetchMock.mock.calls[0][0]).toBe('https://other.example.com/x');
  });

  it('401 时触发 onUnauthorized 回调', async () => {
    const onUnauthorized = vi.fn();
    setOnUnauthorized(onUnauthorized);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(makeResponse({ status: 401 })),
    );

    await authFetch('/api/foo');

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('403 且 body.code=USER_DISABLED 时触发 onUnauthorized', async () => {
    const onUnauthorized = vi.fn();
    setOnUnauthorized(onUnauthorized);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        makeResponse({ status: 403, jsonBody: { code: 'USER_DISABLED' } }),
      ),
    );

    await authFetch('/api/foo');

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('403 但非 USER_DISABLED 时不触发 onUnauthorized', async () => {
    const onUnauthorized = vi.fn();
    setOnUnauthorized(onUnauthorized);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        makeResponse({ status: 403, jsonBody: { code: 'FORBIDDEN' } }),
      ),
    );

    await authFetch('/api/foo');

    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('响应带 X-Refresh-Token 时写回 secureStorage（滑动过期）', async () => {
    store.set(TOKEN_KEY, 'old-token');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        makeResponse({
          status: 200,
          headers: { 'X-Refresh-Token': 'new-token' },
        }),
      ),
    );

    await authFetch('/api/foo');
    // setItem 是异步的，等待微任务队列刷新
    await Promise.resolve();

    expect(store.get(TOKEN_KEY)).toBe('new-token');
  });

  it('M30-01 persists an N-1 upgraded token binding before returning', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse({
      status: 200,
      headers: {
        'X-Refresh-Token': 'epoch-token',
        'X-Auth-Epoch': '7',
        'X-Auth-Generation': '9',
      },
    })));
    await authFetch('/api/auth/me');
    expect(store.get(TOKEN_KEY)).toBe('epoch-token');
    expect(JSON.parse(store.get(AUTH_SESSION_KEY)!)).toEqual({ authEpoch: 7, generation: 9 });
  });

  it('M30-02 blocks locked/offline sensitive transport before token read', async () => {
    store.set(TOKEN_KEY, 'secret');
    setSensitiveTransportAllowed(false);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(authFetch('/api/send', { method: 'POST' })).rejects.toThrow('LOCAL_APP_LOCK_BLOCKED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('M30-02 dedicated server validation cannot refresh the token while locked', async () => {
    store.set(TOKEN_KEY, 'old-token');
    setSensitiveTransportAllowed(false);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse({
      status: 200,
      headers: { 'X-Refresh-Token': 'must-not-save' },
    })));
    await authFetchForLocalUnlockValidation('/api/auth/me');
    await Promise.resolve();
    expect(store.get(TOKEN_KEY)).toBe('old-token');
  });

  it('网络错误（fetch reject）向上抛出', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('network down')),
    );

    await expect(authFetch('/api/foo')).rejects.toThrow('network down');
  });

  it('M10-01: policy rejection happens before token read or HTTP transport', async () => {
    const built = makePlatform();
    built.store.set(TOKEN_KEY, 'must-not-leave-storage');
    const tokenRead = vi.spyOn(built.platform.secureStorage, 'getItem');
    const policyGuard = vi.fn(() => {
      throw new Error('untrusted origin');
    });
    built.platform.platformConfig.assertTrustedUrl = policyGuard;
    initPlatform(built.platform);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(authFetch('https://attacker.test/api/upload', {
      method: 'POST',
      body: 'user-content',
    })).rejects.toThrow('untrusted origin');

    expect(policyGuard).toHaveBeenCalledWith(
      'https://attacker.test/api/upload',
      'http',
    );
    expect(tokenRead).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
