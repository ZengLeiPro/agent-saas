import { describe, expect, it, vi } from 'vitest';

import {
  WEB_FETCH_CONSECUTIVE_FAILURE_LIMIT,
  WebFetchCircuitOpenError,
  WebToolProvider,
} from '../agent/webToolProvider.js';
import type { ToolCallContext } from '../agent/toolRuntime.js';

function context(): ToolCallContext {
  return {
    channelContext: { channel: 'web' },
    workspace: {
      root: '/tmp/workspace',
      userId: 'user-1',
      username: 'alice',
      sessionId: 'session-1',
      executionTarget: 'server-local',
    },
  };
}

describe('WebToolProvider', () => {
  it('exposes WebSearch only when search config is enabled', () => {
    expect(new WebToolProvider({ fetch: {} }).list().map((tool) => tool.id)).toEqual(['WebFetch']);
    expect(new WebToolProvider({
      search: { provider: 'brave', apiKey: 'brave-secret-token' },
      fetch: { enabled: false },
    }).list().map((tool) => tool.id)).toEqual(['WebSearch']);
    expect(new WebToolProvider({ enabled: false, fetch: {} }).list()).toEqual([]);
  });

  it('normalizes Brave search results without leaking provider credentials', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ 'X-Subscription-Token': 'brave-secret-token' });
      return new Response(JSON.stringify({
        web: {
          results: [
            {
              title: 'OpenClaw web tool',
              url: 'https://github.com/openclaw/openclaw',
              description: 'A browser and search tool implementation.',
              profile: { name: 'GitHub' },
            },
          ],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const provider = new WebToolProvider({
      search: { provider: 'brave', apiKey: 'brave-secret-token' },
      fetch: { enabled: false },
    }, fetchImpl);

    const result = await provider.invoke(
      {
        toolId: 'WebSearch',
        input: { query: 'agent web search', count: 1, allowedDomains: ['github.com'] },
        authorization: { approved: true, source: 'policy_auto' },
      },
      context(),
    );

    expect(result?.content).toContain('WEB_SEARCH_RESULTS');
    expect(result?.content).toContain('<untrusted-web-content>');
    expect(result?.content).toContain('OpenClaw web tool');
    expect(result?.content).not.toContain('brave-secret-token');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('normalizes Volcengine search results without leaking provider credentials', async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(url).toBe('https://open.feedcoopapi.com/search_api/web_search');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer volcengine-secret-token',
        'Content-Type': 'application/json',
      });
      expect(JSON.parse(String(init?.body))).toMatchObject({
        Query: 'agent search',
        SearchType: 'web',
        Count: 2,
        TimeRange: 'OneWeek',
        Filter: {
          NeedUrl: true,
          Sites: 'volcengine.com',
        },
        ContentFormats: 'markdown',
      });
      return new Response(JSON.stringify({
        ResponseMetadata: { RequestId: 'req-1' },
        Result: {
          ResultCount: 2,
          WebResults: [
            {
              Title: '豆包搜索 Custom版',
              SiteName: '火山引擎',
              Url: 'https://www.volcengine.com/docs/87772/2272953',
              Snippet: '独立搜索 API。',
              PublishTime: '2026-06-29',
            },
          ],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const provider = new WebToolProvider({
      search: { provider: 'volcengine', apiKey: 'volcengine-secret-token' },
      fetch: { enabled: false },
    }, fetchImpl);

    const result = await provider.invoke(
      {
        toolId: 'WebSearch',
        input: { query: 'agent search', count: 2, freshness: 'week', allowedDomains: ['https://volcengine.com/docs'] },
        authorization: { approved: true, source: 'policy_auto' },
      },
      context(),
    );

    expect(result?.content).toContain('WEB_SEARCH_RESULTS');
    expect(result?.content).toContain('"provider": "volcengine"');
    expect(result?.content).toContain('豆包搜索 Custom版');
    expect(result?.content).not.toContain('volcengine-secret-token');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('fetches and extracts readable HTML behind an untrusted-content boundary', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      '<html><head><title>Demo Page</title><script>steal()</script></head><body><main><h1>Demo Page</h1><p>Hello from the public web.</p></main></body></html>',
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
    )) as unknown as typeof fetch;
    const provider = new WebToolProvider({
      fetch: {},
      egress: { allowedHosts: ['93.184.216.34'] },
    }, fetchImpl);

    const result = await provider.invoke(
      {
        toolId: 'WebFetch',
        input: { url: 'https://93.184.216.34/demo', maxChars: 500 },
        authorization: { approved: true, source: 'policy_auto' },
      },
      context(),
    );

    expect(result?.content).toContain('WEB_FETCH_RESULT');
    expect(result?.content).toContain('<untrusted-web-content>');
    expect(result?.content).toContain('Demo Page');
    expect(result?.content).toContain('Hello from the public web.');
    expect(result?.content).not.toContain('steal()');
  });

  it('blocks private-network URL literals before fetch is called', async () => {
    const fetchImpl = vi.fn(async () => new Response('should not fetch')) as unknown as typeof fetch;
    const provider = new WebToolProvider({ fetch: {} }, fetchImpl);

    await expect(provider.invoke(
      {
        toolId: 'WebFetch',
        input: { url: 'http://127.0.0.1/latest/meta-data' },
        authorization: { approved: true, source: 'policy_auto' },
      },
      context(),
    )).rejects.toThrow(/Blocked internal address/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('truncates fetched content at the requested character cap', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      `<html><body><article><p>${'a'.repeat(500)}</p></article></body></html>`,
      { status: 200, headers: { 'content-type': 'text/html' } },
    )) as unknown as typeof fetch;
    const provider = new WebToolProvider({
      fetch: {},
      egress: { allowedHosts: ['93.184.216.34'] },
    }, fetchImpl);

    const result = await provider.invoke(
      {
        toolId: 'WebFetch',
        input: { url: 'https://93.184.216.34/long', maxChars: 100 },
        authorization: { approved: true, source: 'policy_auto' },
      },
      context(),
    );

    expect(result?.content).toContain('[Content truncated at 100 chars.]');
  });

  it('opens a per-run circuit after consecutive failures and skips later network calls', async () => {
    const fetchImpl = vi.fn(async () => new Response('missing', {
      status: 404,
      statusText: 'Not Found',
      headers: { 'content-type': 'text/plain' },
    })) as unknown as typeof fetch;
    const provider = new WebToolProvider({
      fetch: {},
      egress: { allowedHosts: ['93.184.216.34'] },
    }, fetchImpl);
    const failedRun = { ...context(), runId: 'run-failing' };
    const call = {
      toolId: 'WebFetch',
      input: { url: 'https://93.184.216.34/missing' },
      authorization: { approved: true as const, source: 'policy_auto' as const },
    };

    for (let i = 1; i < WEB_FETCH_CONSECUTIVE_FAILURE_LIMIT; i += 1) {
      await expect(provider.invoke(call, failedRun)).rejects.toThrow(/HTTP 404/);
    }
    await expect(provider.invoke(call, failedRun)).rejects.toBeInstanceOf(WebFetchCircuitOpenError);
    await expect(provider.invoke(call, failedRun)).rejects.toBeInstanceOf(WebFetchCircuitOpenError);
    expect(fetchImpl).toHaveBeenCalledTimes(WEB_FETCH_CONSECUTIVE_FAILURE_LIMIT);

    await expect(provider.invoke(call, { ...context(), runId: 'run-independent' })).rejects.toThrow(/HTTP 404/);
    expect(fetchImpl).toHaveBeenCalledTimes(WEB_FETCH_CONSECUTIVE_FAILURE_LIMIT + 1);
  });

  it('opens a circuit when the rolling failure rate reaches the threshold', async () => {
    const outcomes = [
      false, false, true,
      false, false, true,
      false, false, true,
      false, false, true,
      false, true,
      false, true,
      false, true,
      false, true,
    ];
    const fetchImpl = vi.fn(async () => {
      const succeeded = outcomes[fetchImpl.mock.calls.length - 1];
      return succeeded
        ? new Response('<html><body>useful evidence</body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          })
        : new Response('missing', {
            status: 404,
            statusText: 'Not Found',
            headers: { 'content-type': 'text/plain' },
          });
    });
    const provider = new WebToolProvider({
      fetch: {},
      egress: { allowedHosts: ['93.184.216.34'] },
    }, fetchImpl as unknown as typeof fetch);
    const runContext = { ...context(), runId: 'run-rolling-failures' };

    for (let i = 0; i < outcomes.length; i += 1) {
      const call = {
        toolId: 'WebFetch',
        input: { url: `https://93.184.216.34/page-${i}` },
        authorization: { approved: true as const, source: 'policy_auto' as const },
      };
      if (outcomes[i]) {
        await expect(provider.invoke(call, runContext)).resolves.toBeTruthy();
      } else {
        await expect(provider.invoke(call, runContext)).rejects.toThrow(/HTTP 404/);
      }
    }

    await expect(provider.invoke({
      toolId: 'WebFetch',
      input: { url: 'https://93.184.216.34/page-after-threshold' },
      authorization: { approved: true, source: 'policy_auto' },
    }, runContext)).rejects.toBeInstanceOf(WebFetchCircuitOpenError);
    expect(fetchImpl).toHaveBeenCalledTimes(outcomes.length);
  });
});
