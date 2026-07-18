import { beforeEach, describe, expect, it, vi } from 'vitest';

import { initPlatform } from '../platform/context';
import type { PlatformDeps } from '../platform/types';
import { TOKEN_KEY } from './constants';
import { authFetch, setOnUnauthorized } from './authFetch';

// ── 构造一个最小可用的 platform，用真实的 initPlatform 注入 ──────────────
// secureStorage 用 in-memory 版，platformConfig.getBaseUrl 固定域名。
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

  it('网络错误（fetch reject）向上抛出', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('network down')),
    );

    await expect(authFetch('/api/foo')).rejects.toThrow('network down');
  });
});
