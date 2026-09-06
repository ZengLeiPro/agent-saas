import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWebSearch } from '../agent/web/searchProviders.js';
import {
  runRoutedWebSearch,
  resetSearchProviderFailureState,
  setSearchProviderAlertHandler,
} from '../agent/web/searchRouter.js';

const config = { provider: 'volcengine' as const, apiKey: 'test-plan-key' };
const input = { query: '测试搜索', count: 5 };
const success = () =>
  Response.json({
    ResponseMetadata: { RequestId: 'req-1' },
    Result: {
      LogId: 'log-1',
      ResultCount: 1,
      WebResults: [
        { Title: '标题', Url: 'https://example.com', Summary: '完整摘要', Snippet: '短摘要' },
      ],
    },
  });
const failure = (code: string | number, status = 200) =>
  Response.json(
    {
      ResponseMetadata: {
        RequestId: 'req-error',
        Error: { Code: code, Message: 'test-plan-key 不应外泄' },
      },
    },
    { status, headers: { 'retry-after': '0' } },
  );

afterEach(() => {
  vi.useRealTimers();
  resetSearchProviderFailureState();
  setSearchProviderAlertHandler(undefined);
});

describe('豆包 Agent Plan 搜索协议', () => {
  it('使用 Bearer、服务端排队和 URL 过滤，并优先返回 Summary 与诊断编号', async () => {
    const fetcher = vi.fn(async () => success());
    const result = await runWebSearch(
      config,
      { ...input, freshness: 'week', allowedDomains: ['example.com'] },
      fetcher,
    );
    expect(fetcher.mock.calls[0]).toBeDefined();
    const call = (fetcher.mock.calls as unknown as [string, RequestInit][])[0];
    expect(call[0]).toBe('https://open.feedcoopapi.com/search_api/web_search');
    expect(call[1].headers).toMatchObject({ Authorization: 'Bearer test-plan-key' });
    expect(JSON.parse(call[1].body as string)).toMatchObject({
      Query: '测试搜索',
      Count: 5,
      EnableWaiting: true,
      MaxWaitTime: 5000,
      TimeRange: 'OneWeek',
      Filter: { NeedUrl: true, Sites: 'example.com' },
    });
    expect(result.results[0].snippet).toBe('完整摘要');
    expect(result.diagnostics).toMatchObject({ attempts: 1, requestId: 'req-1', logId: 'log-1' });
  });

  it('可关闭排队，保留原有超时与数量配置', async () => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(JSON.parse(init!.body as string)).toMatchObject({ EnableWaiting: false, Count: 2 });
      expect(JSON.parse(init!.body as string)).not.toHaveProperty('MaxWaitTime');
      return success();
    });
    await runWebSearch(
      { ...config, enableWaiting: false, timeoutMs: 8000, maxResults: 2 },
      input,
      fetcher,
    );
  });

  it.each(['700429', 700429, '10500'])('业务临时错误 %s 最多重试一次', async (code) => {
    const fetcher = vi.fn().mockResolvedValueOnce(failure(code)).mockResolvedValueOnce(success());
    const result = await runWebSearch(config, input, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.diagnostics?.attempts).toBe(2);
  });

  it('HTTP 429 尊重 Retry-After，连续失败只发两次', async () => {
    const fetcher = vi.fn(
      async () => new Response('limited', { status: 429, headers: { 'retry-after': '0' } }),
    );
    await expect(runWebSearch(config, input, fetcher)).rejects.toThrow('429');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(['10403', '10406', '10410', '10412'])(
    '权限/额度错误 %s 不重试，并走既有境外降级',
    async (code) => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(failure(code))
        .mockResolvedValueOnce(Response.json({ results: [] }));
      const result = await runRoutedWebSearch(
        { ...config, global: { provider: 'tavily', apiKey: 'backup' } },
        input,
        'cn',
        fetcher,
      );
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({ provider: 'tavily', degraded: true });
      expect(result.primaryError).toContain(code);
      expect(result.primaryError).not.toContain(config.apiKey);
    },
  );

  it('调用方取消不降级，也不累计服务故障告警', async () => {
    const alerts = vi.fn();
    setSearchProviderAlertHandler(alerts);
    for (let i = 0; i < 6; i++) {
      const controller = new AbortController();
      const fetcher = vi.fn(async () => {
        controller.abort(new Error('用户取消'));
        throw controller.signal.reason;
      });
      await expect(
        runRoutedWebSearch(
          { ...config, global: { provider: 'tavily', apiKey: 'backup' } },
          { ...input, signal: controller.signal },
          'cn',
          fetcher,
        ),
      ).rejects.toThrow('用户取消');
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    expect(alerts).not.toHaveBeenCalled();
  });

  it('两次尝试共享总截止时间，不为重试重新计时', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(failure('700429'))
      .mockImplementationOnce(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
          }),
      );
    await expect(runWebSearch({ ...config, timeoutMs: 100 }, input, fetcher)).rejects.toThrow(
      'TIMEOUT',
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('限制正文响应与模型结果大小，不输出未限长 Content', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        Result: {
          WebResults: Array.from({ length: 10 }, () => ({
            Title: '标题',
            Url: 'https://example.com',
            Content: '长'.repeat(30_000),
          })),
        },
      }),
    );
    const result = await runWebSearch(config, { ...input, count: 10 }, fetcher);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result.results))).toBeLessThanOrEqual(48_000);
    expect(result.results[0].snippet!.length).toBeLessThanOrEqual(2000);
    await expect(
      runWebSearch(config, input, async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))),
    ).rejects.toThrow('RESPONSE_TOO_LARGE');
  });

  it('无效 JSON 不能伪装成空搜索，错误内容不回显凭据', async () => {
    await expect(
      runWebSearch(config, input, async () => new Response('test-plan-key')),
    ).rejects.toThrow('INVALID_RESPONSE');
    const error = await runWebSearch(config, input, async () => failure('test-plan-key')).catch(
      (value) => value,
    );
    expect(String(error)).not.toContain(config.apiKey);
    await expect(runWebSearch(config, input, async () => Response.json({}))).rejects.toThrow(
      'INVALID_RESPONSE',
    );
    expect(
      (await runWebSearch(config, input, async () => Response.json({ Result: { ResultCount: 0 } })))
        .results,
    ).toEqual([]);
  });

  it('本地输入错误不发请求、不降级、不触发服务故障告警', async () => {
    const fetcher = vi.fn();
    const alerts = vi.fn();
    setSearchProviderAlertHandler(alerts);
    for (let i = 0; i < 6; i++) {
      await expect(
        runRoutedWebSearch(
          { ...config, global: { provider: 'tavily', apiKey: 'backup' } },
          { ...input, query: '长'.repeat(101) },
          'cn',
          fetcher,
        ),
      ).rejects.toThrow('100');
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(alerts).not.toHaveBeenCalled();
  });

  it('超长查询和超额过滤条件在请求前报错，不静默截断', async () => {
    const fetcher = vi.fn();
    await expect(
      runWebSearch(config, { ...input, query: '长'.repeat(101) }, fetcher),
    ).rejects.toThrow('100');
    await expect(
      runWebSearch(config, { ...input, blockedDomains: Array(6).fill('example.com') }, fetcher),
    ).rejects.toThrow('5');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
