import { describe, expect, it, vi } from 'vitest';

import {
  VolcengineOpenApiError,
  fetchVolcengineArkPlanQuota,
  normalizeAfpUsage,
  normalizePersonalPlan,
} from './volcengineArkPlanQuota.js';

// 2026-09-05 真实 GetAFPUsage / GetPersonalPlan 响应（数值原样）。
const afpResult = {
  PlanType: 'max',
  AFPFiveHour: {
    Quota: 50000,
    Used: 241.9083,
    SubscribeTime: 1788587522000,
    ResetTime: 1788605522000,
  },
  AFPWeekly: {
    Quota: 175000,
    Used: 37965.9378,
    SubscribeTime: 1788105600000,
    ResetTime: 1788710400000,
  },
  AFPMonthly: {
    Quota: 401822.3695,
    Used: 378005.7772,
    SubscribeTime: 1786246057000,
    ResetTime: 1788969599000,
  },
  AFPDaily: { Quota: 250000, Used: 0, SubscribeTime: 1788537600000, ResetTime: 1788624000000 },
};
const planResult = {
  PlanType: 'Max',
  Status: 'Running',
  StartTime: '2026-08-09T03:27:37Z',
  EndTime: '2026-09-09T15:59:59Z',
  AutoRenew: false,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const credentials = { accessKeyId: 'AK', secretAccessKey: 'SK', region: 'cn-beijing' };

describe('normalizeAfpUsage', () => {
  it('把四个滚动窗口归一化为百分比、重置时间与撞限标记（顺序固定）', () => {
    const usage = normalizeAfpUsage(afpResult);
    expect(usage.planType).toBe('max');
    expect(usage.windows.map((w) => w.id)).toEqual(['five_hour', 'daily', 'weekly', 'monthly']);
    const monthly = usage.windows.find((w) => w.id === 'monthly')!;
    expect(monthly.usedPercent).toBeCloseTo(94.07, 2);
    expect(monthly.unit).toBe('AFP');
    expect(monthly.quota).toBe(401822.3695);
    expect(monthly.resetAt).toBe(new Date(1788969599000).toISOString());
    expect(monthly.limitReached).toBe(false);
    expect(usage.windows.find((w) => w.id === 'daily')!.usedPercent).toBe(0);
    expect(usage.limitReached).toBe(false);
  });

  it('Quota/Used 为字符串（文档示例形态）也能解析，Used ≥ Quota 视为撞限', () => {
    const usage = normalizeAfpUsage({
      AFPFiveHour: { Quota: '50.0', Used: '50.0', ResetTime: 1778806800000 },
    });
    expect(usage.windows).toHaveLength(1);
    expect(usage.windows[0]!.usedPercent).toBe(100);
    expect(usage.limitReached).toBe(true);
  });

  it('非对象输入返回空窗口而不是抛错', () => {
    expect(normalizeAfpUsage(null)).toEqual({ windows: [], limitReached: false });
  });
});

describe('normalizePersonalPlan', () => {
  it('只保留已知字段', () => {
    expect(normalizePersonalPlan({ ...planResult, Unknown: 1 })).toEqual({
      type: 'Max',
      status: 'Running',
      startTime: '2026-08-09T03:27:37Z',
      endTime: '2026-09-09T15:59:59Z',
      autoRenew: false,
    });
  });
});

describe('fetchVolcengineArkPlanQuota', () => {
  it('依次调用 GetAFPUsage 与 GetPersonalPlan，并带 AccessKey 签名头', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const action = new URL(String(url)).searchParams.get('Action');
      expect(String(url)).toContain('https://ark.cn-beijing.volcengineapi.com/?Action=');
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toMatch(
        /^HMAC-SHA256 Credential=AK\/\d{8}\/cn-beijing\/ark\/request, SignedHeaders=/u,
      );
      if (action === 'GetAFPUsage')
        return jsonResponse({ ResponseMetadata: { Action: action }, Result: afpResult });
      expect(init?.body).toBe('{"Plan":"AgentPlan"}');
      return jsonResponse({ ResponseMetadata: { Action: action }, Result: planResult });
    }) as unknown as typeof fetch;
    const result = await fetchVolcengineArkPlanQuota(fetchImpl, credentials);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.plan).toMatchObject({
      type: 'Max',
      status: 'Running',
      endTime: '2026-09-09T15:59:59Z',
    });
    expect(result.windows).toHaveLength(4);
    expect(result.planError).toBeUndefined();
  });

  it('GetPersonalPlan 失败（如未购买）不阻断用量，只记录 planError', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const action = new URL(String(url)).searchParams.get('Action');
      if (action === 'GetAFPUsage')
        return jsonResponse({ ResponseMetadata: {}, Result: afpResult });
      return jsonResponse(
        {
          ResponseMetadata: { Error: { Code: 'ResourceNotFound.Plan', Message: 'plan not found' } },
        },
        404,
      );
    }) as unknown as typeof fetch;
    const result = await fetchVolcengineArkPlanQuota(fetchImpl, credentials);
    expect(result.windows).toHaveLength(4);
    expect(result.plan).toEqual({ type: 'max' });
    expect(result.planError).toContain('ResourceNotFound.Plan');
  });

  it('鉴权失败抛出带 Code 的 VolcengineOpenApiError', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          ResponseMetadata: {
            Error: {
              CodeN: 100024,
              Code: 'InvalidAuthorization',
              Message: "Invalid 'Authorization' header",
            },
          },
        },
        400,
      ),
    ) as unknown as typeof fetch;
    await expect(fetchVolcengineArkPlanQuota(fetchImpl, credentials)).rejects.toMatchObject({
      name: 'VolcengineOpenApiError',
      action: 'GetAFPUsage',
      status: 400,
      code: 'InvalidAuthorization',
    } satisfies Partial<VolcengineOpenApiError>);
  });
});
