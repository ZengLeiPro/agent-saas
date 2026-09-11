import { describe, expect, it, vi } from 'vitest';

import {
  fetchZhipuCodingPlanQuota,
  normalizeZhipuCodingPlanQuota,
  ZHIPU_CODING_PLAN_QUOTA_URL,
} from './zhipuCodingPlanQuota.js';

const now = new Date('2026-09-11T08:00:00Z');
const envelope = (limits: unknown[], extra = {}) => ({
  code: 200,
  success: true,
  data: { limits, ...extra },
});
const credit = (extra = {}) => ({
  type: 'CREDIT_LIMIT', unit: 3, number: 5, percentage: 25, ...extra,
});

describe('Zhipu Coding Plan quota normalization', () => {
  it('keeps distinct five-hour, weekly and monthly-tool windows in a legacy response', () => {
    const result = normalizeZhipuCodingPlanQuota(envelope([
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 10 },
      { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 82 },
      { type: 'TIME_LIMIT', unit: 5, number: 1, usage: 1000, currentValue: 40, percentage: 4 },
    ], { level: 'max' }), now);
    expect(result.plan).toEqual({ type: 'max' });
    expect(result.windows).toMatchObject([
      { id: 'tokens_limit:3:5', label: '5 小时模型额度', windowSeconds: 18_000, usedPercent: 10, unit: '配额单位' },
      { id: 'tokens_limit:6:1', label: '每周模型额度', windowSeconds: 604_800, usedPercent: 82 },
      { id: 'time_limit:5:1', label: '每月工具调用', usedPercent: 4, used: 40, quota: 1000, unit: '次' },
    ]);
    expect(result.windows[2]?.windowSeconds).toBeUndefined();
    expect(result.windows[2]?.resetAt).toBeUndefined();
    expect(result.limitReached).toBe(false);
  });

  it('accepts newer CREDIT_LIMIT responses and prefers exact counts over rounded percentages', () => {
    const result = normalizeZhipuCodingPlanQuota(envelope([
      credit({ usage: 28000, currentValue: 2585, percentage: 9 }),
      credit({ unit: 6, number: 1, usage: 140000, currentValue: 58386, percentage: 41 }),
    ]), now);
    expect(result.windows[0]?.usedPercent).toBeCloseTo(2585 / 28000 * 100);
    expect(result.windows[1]?.usedPercent).toBeCloseTo(58386 / 140000 * 100);
    expect(result.windows[0]?.unit).toBe('积分');
    expect(result.plan).toBeUndefined();
  });

  it('derives used counts from remaining, preserves over-limit values and accepts numeric strings', () => {
    const result = normalizeZhipuCodingPlanQuota(envelope([
      credit({ usage: '100', remaining: '20', percentage: '0' }),
      credit({ unit: 6, number: 1, usage: 100, currentValue: 110, percentage: 100 }),
    ]), now);
    expect(result.windows[0]).toMatchObject({ used: 80, quota: 100, usedPercent: 80 });
    expect(result.windows[1]).toMatchObject({ usedPercent: 110, limitReached: true });
    expect(result.limitReached).toBe(true);
  });

  it('does not infer missing plan details, absolute usage, periods or reset dates', () => {
    const result = normalizeZhipuCodingPlanQuota({ limits: [
      { type: 'TOKENS_LIMIT', percentage: 0 },
      { type: 'FUTURE_LIMIT', unit: 99, number: 1, percentage: 30 },
    ] }, now);
    expect(result.plan).toBeUndefined();
    expect(result.windows[0]).toMatchObject({ label: '周期未返回模型额度', usedPercent: 0 });
    expect(result.windows[1]?.label).toContain('未知周期');
    for (const window of result.windows) {
      expect(window.used).toBeUndefined();
      expect(window.quota).toBeUndefined();
      expect(window.windowSeconds).toBeUndefined();
      expect(window.resetAt).toBeUndefined();
    }
  });

  it('uses type and period for stable IDs rather than array positions', () => {
    const entries = [credit(), credit({ unit: 6, number: 1 })];
    const before = normalizeZhipuCodingPlanQuota(envelope(entries), now);
    const after = normalizeZhipuCodingPlanQuota(envelope([...entries].reverse()), now);
    expect(after.windows.map((window) => window.id)).toEqual(before.windows.map((window) => window.id).reverse());
    const duplicates = normalizeZhipuCodingPlanQuota(envelope([credit(), credit()]), now);
    expect(new Set(duplicates.windows.map((window) => window.id)).size).toBe(2);
  });

  it('normalizes explicit timestamps but suppresses implausibly distant five-hour resets', () => {
    const result = normalizeZhipuCodingPlanQuota(envelope([
      credit({ nextResetTime: Date.parse('2026-09-11T11:00:00Z') }),
      credit({ nextResetTime: Date.parse('2026-09-11T18:00:00Z') }),
      credit({ unit: 6, number: 1, nextResetTime: Date.parse('2026-09-15T00:00:00Z') / 1000 }),
      credit({ nextResetTime: '2026-09-11T19:00:00+08:00' }),
      credit({ nextResetTime: '2026-09-11 19:00:00' }),
    ]), now);
    expect(result.windows[0]?.resetAt).toBe('2026-09-11T11:00:00.000Z');
    expect(result.windows[1]?.resetAt).toBeUndefined();
    expect(result.windows[2]?.resetAt).toBe('2026-09-15T00:00:00.000Z');
    expect(result.windows[3]?.resetAt).toBe('2026-09-11T11:00:00.000Z');
    expect(result.windows[4]?.resetAt).toBeUndefined();
  });

  it.each([
    null, [], {}, { data: {} }, envelope([]),
    envelope([credit({ percentage: null })]),
    envelope([credit({ percentage: true })]),
    envelope([credit({ percentage: '' })]),
    envelope([credit({ percentage: -1 })]),
    envelope([credit({ percentage: Infinity })]),
    envelope([{ type: 'bad\nlabel', percentage: 2 }]),
    envelope(Array.from({ length: 101 }, () => credit())),
  ])('rejects invalid or empty quota rather than fabricating healthy zero usage: %j', (payload) => {
    expect(() => normalizeZhipuCodingPlanQuota(payload, now)).toThrow();
  });

  it('does not expose upstream business-error messages', () => {
    expect(() => normalizeZhipuCodingPlanQuota({
      code: 401, msg: 'echoed-private-key', data: { limits: [credit()] },
    }, now)).toThrow('业务错误');
    try {
      normalizeZhipuCodingPlanQuota({ success: false, msg: 'echoed-private-key' }, now);
    } catch (error) {
      expect(String(error)).not.toContain('echoed-private-key');
    }
  });
});

describe('Zhipu quota HTTP client', () => {
  it('uses only the fixed official endpoint, raw-key authorization, a timeout and no redirects', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(envelope([credit()]))));
    const result = await fetchZhipuCodingPlanQuota(fetchImpl as typeof fetch, ' test-key ', now);
    expect(result.windows).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledWith(ZHIPU_CODING_PLAN_QUOTA_URL, expect.objectContaining({
      method: 'GET', headers: { Authorization: 'test-key', Accept: 'application/json' },
      redirect: 'error', signal: expect.any(AbortSignal),
    }));
  });

  it.each([401, 403, 429, 500])('sanitizes HTTP %i response bodies', async (status) => {
    const fetchImpl = vi.fn(async () => new Response('echoed-private-key', { status }));
    await expect(fetchZhipuCodingPlanQuota(fetchImpl as typeof fetch, 'test-key', now))
      .rejects.toThrow(`HTTP ${status}`);
    await expect(fetchZhipuCodingPlanQuota(fetchImpl as typeof fetch, 'test-key', now))
      .rejects.not.toThrow('echoed-private-key');
  });

  it('sanitizes connection and JSON errors and validates a Key before any request', async () => {
    const failedFetch = vi.fn(async () => { throw new Error('echoed-private-key'); });
    await expect(fetchZhipuCodingPlanQuota(failedFetch as typeof fetch, 'test-key', now))
      .rejects.toThrow('连接失败或超时');
    const invalidJson = vi.fn(async () => new Response('<html>echoed-private-key</html>'));
    await expect(fetchZhipuCodingPlanQuota(invalidJson as typeof fetch, 'test-key', now))
      .rejects.toThrow('不是有效 JSON');
    const untouched = vi.fn();
    await expect(fetchZhipuCodingPlanQuota(untouched as typeof fetch, '', now)).rejects.toThrow('有效的智谱');
    await expect(fetchZhipuCodingPlanQuota(untouched as typeof fetch, 'a\nb', now)).rejects.toThrow('有效的智谱');
    expect(untouched).not.toHaveBeenCalled();
  });
});
