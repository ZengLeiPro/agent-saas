import { describe, expect, it, vi } from 'vitest';
import { isZhipuCodingPlanGroup } from '@agent/shared';
import {
  fetchZhipuCodingPlanQuota,
  normalizeZhipuCodingPlanQuota,
  ZHIPU_CODING_PLAN_QUOTA_URL,
} from './zhipuCodingPlanQuota.js';

const now = new Date('2026-09-11T08:00:00.000Z');
const root = (limits: unknown[], extra: Record<string, unknown> = {}) => ({
  success: true, code: 200, data: { limits, ...extra },
});
const token = { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 42 };

function mockFetch(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe('Zhipu quota contract', () => {
  it('uses upstream cycles and separates coding, weekly credit and monthly tool quotas', () => {
    const result = normalizeZhipuCodingPlanQuota(root([
      { ...token, nextResetTime: Date.parse('2026-09-11T10:00:00.000Z') },
      { type: 'CREDIT_LIMIT', unit: 6, number: 1, percentage: 10, usage: 1000, currentValue: 125 },
      { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 20, usage: 100, currentValue: 20 },
    ], { planName: 'Pro' }), now);
    expect(result.plan).toEqual({ type: 'Pro' });
    expect(result.windows).toHaveLength(3);
    expect(result.windows[0]).toMatchObject({
      id: 'tokens_limit:3:5', windowSeconds: 18_000, usedPercent: 42,
      resetAt: '2026-09-11T10:00:00.000Z',
    });
    expect(result.windows[1]).toMatchObject({
      windowSeconds: 604_800, usedPercent: 12.5, used: 125, quota: 1000, unit: '积分',
    });
    expect(result.windows[2]).toMatchObject({ label: '每月工具调用', used: 20, quota: 100, unit: '次' });
    expect(result.windows[2]?.windowSeconds).toBeUndefined();
    expect(result.windows[2]?.resetAt).toBeUndefined();
    expect(result.plan?.endTime).toBeUndefined();
    expect(result.limitReached).toBe(false);
  });

  it('retains unknown periods and raw percentages without inventing a 5-hour window', () => {
    const result = normalizeZhipuCodingPlanQuota(root([
      { type: 'TOKENS_LIMIT', percentage: 25 },
      { type: 'FUTURE_LIMIT', unit: 99, number: 1, percentage: 9 },
    ]), now);
    expect(result.windows.every((window) => window.windowSeconds === undefined)).toBe(true);
    expect(result.windows.map((window) => window.usedPercent)).toEqual([25, 9]);
    expect(result.plan).toBeUndefined();
  });

  it('keeps stable IDs when known windows change order', () => {
    const weekly = { ...token, unit: 6, number: 1 };
    const first = normalizeZhipuCodingPlanQuota(root([token, weekly])).windows;
    const second = normalizeZhipuCodingPlanQuota(root([weekly, token])).windows;
    expect(first.map((window) => window.id).sort()).toEqual(second.map((window) => window.id).sort());
    const duplicates = normalizeZhipuCodingPlanQuota(root([token, token])).windows;
    expect(new Set(duplicates.map((window) => window.id)).size).toBe(2);
  });

  it('derives usage from remaining only when both values are known, and preserves exhaustion', () => {
    const result = normalizeZhipuCodingPlanQuota(root([
      { ...token, usage: '100', remaining: '25', percentage: 0 },
      { ...token, percentage: 105 },
    ]));
    expect(result.windows[0]).toMatchObject({ used: 75, quota: 100, usedPercent: 75 });
    expect(result.windows[1]).toMatchObject({ usedPercent: 105, limitReached: true });
    expect(result.limitReached).toBe(true);
    expect(normalizeZhipuCodingPlanQuota(root([{ ...token, percentage: 0 }])).windows[0]?.usedPercent).toBe(0);
  });

  it.each([undefined, null, '', ' ', true, 'invalid', -1])('does not fabricate zero for missing/invalid percentage %s', (percentage) => {
    expect(() => normalizeZhipuCodingPlanQuota(root([{ ...token, percentage }]))).toThrow();
  });

  it.each([null, [], {}, { data: {} }, root([]), root([null]), root([{ percentage: 1 }])])(
    'rejects malformed or absent quota data', (payload) => {
      expect(() => normalizeZhipuCodingPlanQuota(payload)).toThrow();
    },
  );

  it('omits implausible five-hour resets but accepts milliseconds and seconds', () => {
    const future = Date.parse('2026-09-11T20:00:00Z');
    const result = normalizeZhipuCodingPlanQuota(root([
      { ...token, nextResetTime: future },
      { ...token, nextResetTime: Date.parse('2026-09-11T10:00:00Z') / 1000 },
      { ...token, nextResetTime: '2026-09-11 10:00:00' },
    ]), now);
    expect(result.windows[0]?.resetAt).toBeUndefined();
    expect(result.windows[1]?.resetAt).toBe('2026-09-11T10:00:00.000Z');
    expect(result.windows[2]?.resetAt).toBeUndefined();
  });

  it('uses the fixed official monitor endpoint, raw Authorization and a bounded non-redirecting request', async () => {
    const fetchImpl = mockFetch(root([token]));
    await fetchZhipuCodingPlanQuota(fetchImpl, ' dummy-test-key ', now);
    expect(fetchImpl).toHaveBeenCalledWith(ZHIPU_CODING_PLAN_QUOTA_URL, expect.objectContaining({
      method: 'GET', redirect: 'error', signal: expect.any(AbortSignal),
      headers: expect.objectContaining({ Authorization: 'dummy-test-key' }),
    }));
  });

  it.each([401, 403, 429, 500])('never echoes sensitive upstream error bodies (HTTP %s)', async (status) => {
    const fetchImpl = mockFetch({ message: 'dummy-sensitive-value' }, status);
    await expect(fetchZhipuCodingPlanQuota(fetchImpl, 'dummy-test-key')).rejects.toThrow(`HTTP ${status}`);
    try {
      await fetchZhipuCodingPlanQuota(fetchImpl, 'dummy-test-key');
    } catch (error) {
      expect(String(error)).not.toContain('dummy-sensitive-value');
      expect(String(error)).not.toContain('dummy-test-key');
    }
  });

  it('sanitizes business and network errors and rejects invalid JSON', async () => {
    expect(() => normalizeZhipuCodingPlanQuota({ code: 401, success: false, msg: 'dummy-sensitive-value' }))
      .toThrow('业务错误');
    const fail = vi.fn(async () => { throw new Error('dummy-sensitive-value'); }) as unknown as typeof fetch;
    await expect(fetchZhipuCodingPlanQuota(fail, 'dummy-test-key')).rejects.toThrow('连接失败或超时');
    const invalid = vi.fn(async () => new Response('<html>not JSON</html>')) as unknown as typeof fetch;
    await expect(fetchZhipuCodingPlanQuota(invalid, 'dummy-test-key')).rejects.toThrow('有效 JSON');
  });

  it.each(['', ' ', 'dummy\nkey', 'dummy\rkey'])('rejects invalid credentials before fetching', async (key) => {
    const fetchImpl = mockFetch(root([token]));
    await expect(fetchZhipuCodingPlanQuota(fetchImpl, key)).rejects.toThrow('API Key');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('Zhipu automatic source selection', () => {
  it.each(['/api/coding/paas/v4', '/api/anthropic', '/api/paas/v4', '/'])('recognizes official HTTPS origin at %s', (path) => {
    expect(isZhipuCodingPlanGroup({ baseUrl: `https://open.bigmodel.cn${path}` })).toBe(true);
  });
  it.each([
    undefined, '', 'http://open.bigmodel.cn', 'https://open.bigmodel.cn.example.com',
    'https://open.bigmodel.cn:444', 'https://user@open.bigmodel.cn',
    'https://example.com/?upstream=open.bigmodel.cn', 'https://api.z.ai',
  ])('does not auto-enable unrelated/unsafe endpoints %s', (baseUrl) => {
    expect(isZhipuCodingPlanGroup({ baseUrl })).toBe(false);
  });
  it('honors explicit opt-out and supports explicit Zhipu monitoring for a proxied model group', () => {
    expect(isZhipuCodingPlanGroup({ baseUrl: 'https://open.bigmodel.cn', quotaSource: { provider: 'none' } })).toBe(false);
    expect(isZhipuCodingPlanGroup({ baseUrl: 'https://open.bigmodel.cn', quotaSource: { provider: 'volcengine_ark_plan' } })).toBe(false);
    expect(isZhipuCodingPlanGroup({ baseUrl: 'https://proxy.example', quotaSource: { provider: 'zhipu_coding_plan' } })).toBe(true);
  });
});
