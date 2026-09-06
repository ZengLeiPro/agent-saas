import { describe, expect, it, vi } from 'vitest';

import { KyAppOutboundError, createKyAppOutbound, type KyAppOutboundOptions } from '../outbound.js';

const PUBLIC_LOOKUP = (async () => [{ address: '93.184.216.34', family: 4 }]) as never;

function outbound(overrides: Partial<KyAppOutboundOptions> = {}) {
  return createKyAppOutbound({
    config: { environment: 'prod', allowInsecureOutbound: false },
    lookup: PUBLIC_LOOKUP,
    fetchImpl: vi.fn(async () => new Response('{"ok":true}', { status: 200 })),
    ...overrides,
  });
}

async function expectBlocked(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(KyAppOutboundError);
  await promise.catch((error: KyAppOutboundError) => expect(error.code).toBe(code));
}

describe('kyapp outbound', () => {
  it('私网地址一律拒绝', async () => {
    const client = outbound({
      lookup: (async () => [{ address: '10.0.0.5', family: 4 }]) as never,
    });
    await expectBlocked(
      client.request({
        baseUrl: 'https://app.example.com',
        path: '/ky/v1/events',
        method: 'POST',
        requestId: 'req-1',
      }),
      'blocked',
    );
  });

  it('3xx 重定向不跟随，按 upstream_unavailable 处理', async () => {
    const client = outbound({
      fetchImpl: vi.fn(
        async () =>
          new Response(null, { status: 302, headers: { location: 'https://evil.example.com/' } }),
      ),
    });
    await expectBlocked(
      client.request({
        baseUrl: 'https://app.example.com',
        path: '/ky/v1/events',
        method: 'POST',
        requestId: 'req-2',
      }),
      'upstream_unavailable',
    );
  });

  it('超时抛 timeout', async () => {
    const client = outbound({
      timeoutMs: 5,
      fetchImpl: vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      ),
    });
    await expectBlocked(
      client.request({
        baseUrl: 'https://app.example.com',
        path: '/ky/v1/health/live',
        method: 'GET',
        requestId: 'req-3',
      }),
      'timeout',
    );
  });

  it('path 里带 host 也只会打到登记的 baseUrl origin', async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('{"ok":true}', { status: 200 }),
    );
    const client = outbound({ fetchImpl });
    await client.request({
      baseUrl: 'https://app.example.com',
      path: '/ky/v1/health/live',
      method: 'GET',
      requestId: 'req-4',
    });
    const [target, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(target)).toBe('https://app.example.com/ky/v1/health/live');
    expect(init?.redirect).toBe('manual');
  });

  it('协议相对路径与非绝对路径被拒', async () => {
    const client = outbound();
    await expectBlocked(
      client.request({
        baseUrl: 'https://app.example.com',
        path: '//evil.example.com/ky/v1/events',
        method: 'POST',
        requestId: 'req-5',
      }),
      'blocked',
    );
  });

  it('prod 下 http 一律拒绝；local 打开开关后允许 http 环回', async () => {
    await expectBlocked(
      outbound().request({
        baseUrl: 'http://app.example.com',
        path: '/ky/v1/health/live',
        method: 'GET',
        requestId: 'req-6',
      }),
      'blocked',
    );
    const fetchImpl = vi.fn(async () => new Response('{"status":"ok"}', { status: 200 }));
    const local = outbound({
      config: { environment: 'local', allowInsecureOutbound: true },
      fetchImpl,
    });
    const result = await local.request({
      baseUrl: 'http://localhost:8790',
      path: '/ky/v1/health/live',
      method: 'GET',
      requestId: 'req-7',
    });
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ status: 'ok' });
  });
});
