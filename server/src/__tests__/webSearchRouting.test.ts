import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WebToolProvider } from '../agent/webToolProvider.js';
import {
  SEARCH_PROVIDER_ALERT_THRESHOLD,
  resetSearchProviderFailureState,
  runRoutedWebSearch,
  setSearchProviderAlertHandler,
} from '../agent/web/searchRouter.js';
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

function zhipuResponse(title: string, content = '正文内容') {
  return new Response(JSON.stringify({
    search_result: [{ title, link: 'https://example.cn/a', content, media: '示例站', publish_date: '2026-08-01' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function tavilyResponse(title: string) {
  return new Response(JSON.stringify({
    results: [{ title, url: 'https://example.com/a', content: 'english snippet', score: '0.9' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

const cnConfig = { provider: 'zhipu' as const, apiKey: 'zhipu-secret-key' };
const globalConfig = { provider: 'tavily' as const, apiKey: 'tavily-secret-key' };

describe('WebSearch scope routing', () => {
  beforeEach(() => {
    resetSearchProviderFailureState();
    setSearchProviderAlertHandler(undefined);
  });

  it('routes scope=cn to the domestic provider and scope=global to the overseas one', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const href = url.toString();
      calls.push(href);
      return href.includes('bigmodel') ? zhipuResponse('中文结果') : tavilyResponse('English result');
    }) as unknown as typeof fetch;

    const cn = await runRoutedWebSearch({ ...cnConfig, global: globalConfig }, { query: 'q', count: 3 }, 'cn', fetchImpl);
    expect(cn.provider).toBe('zhipu');
    expect(cn.degraded).toBe(false);

    const global = await runRoutedWebSearch({ ...cnConfig, global: globalConfig }, { query: 'q', count: 3 }, 'global', fetchImpl);
    expect(global.provider).toBe('tavily');
    expect(calls[0]).toContain('bigmodel');
    expect(calls[1]).toContain('tavily');
  });

  it('falls back to the other side and marks the result as degraded', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (url.toString().includes('bigmodel')) {
        return new Response(JSON.stringify({ error: { code: '1113', message: '余额不足' } }), { status: 200 });
      }
      return tavilyResponse('fallback result');
    }) as unknown as typeof fetch;

    const outcome = await runRoutedWebSearch({ ...cnConfig, global: globalConfig }, { query: 'q', count: 3 }, 'cn', fetchImpl);
    expect(outcome.provider).toBe('tavily');
    expect(outcome.degraded).toBe(true);
    expect(outcome.requestedScope).toBe('cn');
    expect(outcome.primaryError).toContain('1113');
  });

  it('uses the domestic provider for scope=global when no overseas provider is configured', async () => {
    const fetchImpl = vi.fn(async () => zhipuResponse('中文结果')) as unknown as typeof fetch;
    const outcome = await runRoutedWebSearch(cnConfig, { query: 'q', count: 3 }, 'global', fetchImpl);
    expect(outcome.provider).toBe('zhipu');
    // 没有备用源可降级，不应谎报 degraded。
    expect(outcome.degraded).toBe(false);
  });

  it('reports both errors when every source fails', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    await expect(runRoutedWebSearch({ ...cnConfig, global: globalConfig }, { query: 'q', count: 3 }, 'cn', fetchImpl))
      .rejects.toThrow(/两个来源均失败[\s\S]*zhipu[\s\S]*tavily/);
  });

  it('raises an alert after consecutive provider failures and resets after a success', async () => {
    const alerts: Array<{ provider: string; consecutiveFailures: number }> = [];
    setSearchProviderAlertHandler((alert) => alerts.push(alert));
    const failing = vi.fn(async () => new Response('down', { status: 503 })) as unknown as typeof fetch;

    for (let i = 0; i < SEARCH_PROVIDER_ALERT_THRESHOLD; i += 1) {
      await expect(runRoutedWebSearch(cnConfig, { query: 'q', count: 3 }, 'cn', failing)).rejects.toThrow();
    }
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ provider: 'zhipu', consecutiveFailures: SEARCH_PROVIDER_ALERT_THRESHOLD });

    const healthy = vi.fn(async () => zhipuResponse('恢复')) as unknown as typeof fetch;
    await runRoutedWebSearch(cnConfig, { query: 'q', count: 3 }, 'cn', healthy);
    await expect(runRoutedWebSearch(cnConfig, { query: 'q', count: 3 }, 'cn', failing)).rejects.toThrow();
    // 成功后计数清零，单次失败不应再次告警。
    expect(alerts).toHaveLength(1);
  });

  it('does not fall back when the caller aborted', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => {
      controller.abort();
      throw new Error('aborted');
    }) as unknown as typeof fetch;
    await expect(runRoutedWebSearch(
      { ...cnConfig, global: globalConfig },
      { query: 'q', count: 3, signal: controller.signal },
      'cn',
      fetchImpl,
    )).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('WebSearch provider payloads', () => {
  beforeEach(() => {
    resetSearchProviderFailureState();
    setSearchProviderAlertHandler(undefined);
  });

  it('truncates the long zhipu content field so one search cannot flood the context', async () => {
    const long = '正'.repeat(5_000);
    const fetchImpl = vi.fn(async () => zhipuResponse('长正文', long)) as unknown as typeof fetch;
    const outcome = await runRoutedWebSearch(cnConfig, { query: 'q', count: 3 }, 'cn', fetchImpl);
    expect(outcome.results[0].snippet!.length).toBeLessThan(700);
    expect(outcome.results[0].snippet!.endsWith('…')).toBe(true);
  });

  it('sends the configured zhipu billing tier and passes domain filters to tavily natively', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return url.toString().includes('bigmodel') ? zhipuResponse('r') : tavilyResponse('r');
    }) as unknown as typeof fetch;

    await runRoutedWebSearch({ ...cnConfig, searchEngine: 'search_pro' }, { query: 'q', count: 3 }, 'cn', fetchImpl);
    expect(bodies[0]).toMatchObject({ search_engine: 'search_pro', search_query: 'q' });

    await runRoutedWebSearch(
      { ...cnConfig, global: globalConfig },
      { query: 'q', count: 3, allowedDomains: ['anthropic.com'] },
      'global',
      fetchImpl,
    );
    expect(bodies[1]).toMatchObject({ include_domains: ['anthropic.com'], search_depth: 'basic' });
  });

  it('keeps linkless zhipu results instead of dropping the whole query', async () => {
    // 真实观测：部分查询（如「Anthropic Claude 最新模型」）返回结果的 link 全为空。
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      search_result: [
        { title: '公众号解读', link: '', content: '正文很长'.repeat(400), publish_date: '2026-08-13' },
        { title: '有链接的结果', link: 'https://example.cn/b', content: '摘要' },
      ],
    }), { status: 200 })) as unknown as typeof fetch;

    const outcome = await runRoutedWebSearch(cnConfig, { query: 'q', count: 5 }, 'cn', fetchImpl);
    expect(outcome.results).toHaveLength(2);
    expect(outcome.results[0].url).toBeUndefined();
    // 无链接结果无法靠 WebFetch 补全，正文额度放宽到 1200。
    expect(outcome.results[0].snippet!.length).toBeGreaterThan(700);
    expect(outcome.results[1].url).toBe('https://example.cn/b');
  });

  it('excludes linkless results when the caller restricts domains', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      search_result: [
        { title: '无链接', link: '', content: '正文' },
        { title: '命中域名', link: 'https://kaiyan.net/x', content: '正文' },
      ],
    }), { status: 200 })) as unknown as typeof fetch;

    const outcome = await runRoutedWebSearch(
      cnConfig,
      { query: 'q', count: 5, allowedDomains: ['kaiyan.net'] },
      'cn',
      fetchImpl,
    );
    expect(outcome.results.map((r) => r.title)).toEqual(['命中域名']);
  });

  it('tells the model which results cannot be fetched', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      search_result: [{ title: '无链接', link: '', content: '正文' }],
    }), { status: 200 })) as unknown as typeof fetch;
    const provider = new WebToolProvider({ search: cnConfig }, fetchImpl);
    const result = await provider.invoke(
      { toolId: 'WebSearch', input: { query: 'q' }, callId: 'c1', approved: true } as never,
      context(),
    );
    expect(result?.content).toContain('"linklessResults": 1');
    expect(result?.content).toContain('不要臆造 URL');
  });

  it('exposes scope in tool metadata and surfaces degradation to the model', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (url.toString().includes('bigmodel')) return new Response('nope', { status: 500 });
      return tavilyResponse('fallback');
    }) as unknown as typeof fetch;
    const provider = new WebToolProvider({ search: { ...cnConfig, global: globalConfig } }, fetchImpl);
    const result = await provider.invoke(
      { toolId: 'WebSearch', input: { query: 'q', scope: 'cn' }, callId: 'c1', approved: true } as never,
      context(),
    );
    expect(result?.content).toContain('"scope": "cn"');
    expect(result?.content).toContain('"degraded": true');
    expect(result?.content).toContain('"provider": "tavily"');
  });
});
