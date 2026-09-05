import { describe, expect, it, vi } from 'vitest';

import {
  CODEX_USAGE_ENDPOINT,
  fetchCodexUsage,
  normalizeCodexUsage,
} from './codexSubscriptionQuota.js';

// 2026-09-05 真实 wham/usage 响应（账号/时间原样，仅用于解析验证）。
const usageSample = {
  user_id: 'user-x',
  account_id: 'd7fd463b-57f3-421d-9b34-8db8057e7c4e',
  email: 'kaiyankeji.3@gmail.com',
  plan_type: 'pro',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 68,
      limit_window_seconds: 604800,
      reset_after_seconds: 523636,
      reset_at: 1789109685,
    },
    secondary_window: null,
  },
  code_review_rate_limit: null,
  additional_rate_limits: [
    {
      limit_name: 'GPT-5.3-Codex-Spark',
      metered_feature: 'codex_bengalfox',
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 0,
          limit_window_seconds: 18000,
          reset_after_seconds: 18000,
          reset_at: 1788604050,
        },
        secondary_window: {
          used_percent: 46,
          limit_window_seconds: 604800,
          reset_after_seconds: 564605,
          reset_at: 1789150654,
        },
      },
      normal_model_slug: null,
    },
  ],
  model_usage: {
    'gpt-6-astra': { available: true, available_at: null, credits_would_enable: false },
  },
  credits: { has_credits: false, unlimited: false, overage_limit_reached: false, balance: '0' },
  rate_limit_reached_type: null,
};

describe('normalizeCodexUsage', () => {
  it('主窗口 + 附加模型限额展开为窗口列表，带邮箱/档位/credits', () => {
    const usage = normalizeCodexUsage(usageSample);
    expect(usage.email).toBe('kaiyankeji.3@gmail.com');
    expect(usage.planType).toBe('pro');
    expect(usage.limitReached).toBe(false);
    expect(usage.windows.map((w) => [w.id, w.label, w.usedPercent])).toEqual([
      ['primary', '每周', 68],
      ['codex_bengalfox:primary', 'GPT-5.3-Codex-Spark · 5 小时', 0],
      ['codex_bengalfox:secondary', 'GPT-5.3-Codex-Spark · 每周', 46],
    ]);
    expect(usage.windows[0]!.resetAt).toBe(new Date(1789109685 * 1000).toISOString());
    expect(usage.extra).toEqual({ credits: { balance: '0', hasCredits: false, unlimited: false } });
  });

  it('limit_reached=true 时所有主窗口标记撞限', () => {
    const usage = normalizeCodexUsage({
      ...usageSample,
      rate_limit: {
        ...usageSample.rate_limit,
        limit_reached: true,
        primary_window: { ...usageSample.rate_limit.primary_window, used_percent: 100 },
      },
      rate_limit_reached_type: 'primary',
    });
    expect(usage.limitReached).toBe(true);
    expect(usage.windows[0]!.limitReached).toBe(true);
    expect(usage.extra.rateLimitReachedType).toBe('primary');
  });

  it('缺字段时返回空窗口', () => {
    expect(normalizeCodexUsage({})).toMatchObject({ windows: [], limitReached: false });
  });
});

describe('fetchCodexUsage', () => {
  it('GET wham/usage 并带 Bearer 与账号头', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(CODEX_USAGE_ENDPOINT);
      expect(init?.method).toBe('GET');
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer tok');
      expect(headers['ChatGPT-Account-Id']).toBe('acct');
      return new Response(JSON.stringify(usageSample), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(
      fetchCodexUsage(fetchImpl, { accessToken: 'tok', accountId: 'acct' }),
    ).resolves.toMatchObject({ plan_type: 'pro' });
  });

  it('非 2xx 抛错并带状态码与正文片段', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{"detail":"Unauthorized"}', { status: 401 }),
    ) as unknown as typeof fetch;
    await expect(
      fetchCodexUsage(fetchImpl, { accessToken: 'tok', accountId: 'acct' }),
    ).rejects.toThrow(/HTTP 401.*Unauthorized/u);
  });
});
