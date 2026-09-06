/**
 * WP3 Phase B：逻辑调用状态机的三条链（规范 §6.2-4 / §6.2-5，DoD 第一条）。
 *
 * read / write / unknown 三条链在这里用假出站钉死；
 * 与 mock 定制项目的端到端在 `mockApp.e2e.test.ts`。
 */
import { describe, expect, it } from 'vitest';

import type { KyAppOutbound, KyAppOutboundRequest, KyAppOutboundResult } from '../outbound.js';
import { KyAppOutboundError } from '../outbound.js';
import { AppLogicalCallRunner, MAX_RETRY_AFTER_MS, READ_RETRY_BACKOFF_MS } from './lcid.js';
import type { AppCapabilityEntry } from './snapshot.js';

const CONFIG = {
  logicalCallDeadlineMs: 60_000,
  executionPollIntervalMs: 2_000,
  maxResponseBytes: 6_000,
};

function readEntry(overrides: Partial<AppCapabilityEntry> = {}): AppCapabilityEntry {
  return {
    installationId: 'iid-1',
    systemId: 'demo_erp',
    systemName: '演示 ERP',
    capabilityId: 'order.search',
    toolName: 'app__demo_erp__order_search',
    capabilityName: '查订单',
    description: '查订单',
    riskLevel: 'read_only',
    safeToRetry: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    registeredDigest: 'a'.repeat(64),
    baseUrl: 'https://erp.example.com',
    ...overrides,
  };
}

function writeEntry(overrides: Partial<AppCapabilityEntry> = {}): AppCapabilityEntry {
  return readEntry({
    capabilityId: 'order.create',
    toolName: 'app__demo_erp__order_create',
    capabilityName: '建订单',
    riskLevel: 'external_write',
    safeToRetry: false,
    ...overrides,
  });
}

type Step = KyAppOutboundResult | KyAppOutboundError | Error;

function ok(body: unknown, retryAfterMs: number | null = null): KyAppOutboundResult {
  const text = JSON.stringify(body);
  return { status: 200, text, json: body, retryAfterMs };
}

function status(
  code: number,
  body: unknown = null,
  retryAfterMs: number | null = null,
): KyAppOutboundResult {
  const text = body === null ? '' : JSON.stringify(body);
  return { status: code, text, json: body, retryAfterMs };
}

const TIMEOUT = new KyAppOutboundError('出站请求超过 15000 毫秒', 'timeout');

interface Harness {
  runner: AppLogicalCallRunner;
  requests: KyAppOutboundRequest[];
  satClaims: Array<Record<string, unknown>>;
  slept: number[];
  at: () => number;
}

function makeHarness(steps: Step[] | ((request: KyAppOutboundRequest) => Step)): Harness {
  let now = 1_000_000;
  const requests: KyAppOutboundRequest[] = [];
  const satClaims: Array<Record<string, unknown>> = [];
  const slept: number[] = [];
  const queue = Array.isArray(steps) ? [...steps] : null;

  const outbound: KyAppOutbound = {
    async request(request) {
      requests.push(request);
      const step = queue ? queue.shift() : (steps as (r: KyAppOutboundRequest) => Step)(request);
      if (step === undefined) throw new Error(`未预期的第 ${requests.length} 次出站`);
      if (step instanceof Error) throw step;
      return step;
    },
  };

  const runner = new AppLogicalCallRunner({
    issuer: {
      async issue(request) {
        satClaims.push(request as unknown as Record<string, unknown>);
        return {
          token: `sat-${satClaims.length}`,
          expiresAt: 0,
          kid: 'k',
          jti: `j${satClaims.length}`,
        };
      },
    },
    outbound,
    config: CONFIG,
    now: () => now,
    async sleep(ms) {
      slept.push(ms);
      now += ms;
    },
    newLcid: () => 'lc-fixed',
    newRequestId: () => 'rid-fixed',
  });
  return { runner, requests, satClaims, slept, at: () => now };
}

const CALL = {
  tenantId: 'org-1',
  userId: 'u-1',
  sessionId: 'sess-1',
  tenantAdmin: false,
  input: { keyword: '张三' },
};

describe('read 链（safeToRetry:true）', () => {
  it('一次成功：带幂等键、SAT 携带 dig/lcid/sid/rid，结果含 resultLink', async () => {
    const { runner, requests, satClaims } = makeHarness([
      ok({ ok: true, data: { orderId: 'A1' } }),
    ]);
    const result = await runner.run({
      ...CALL,
      entry: readEntry({ resultLink: { path: '/orders/{data.orderId}', label: '查看订单' } }),
    });

    expect(result.outcome).toMatchObject({ kind: 'success', data: { orderId: 'A1' } });
    if (result.outcome.kind === 'success') {
      expect(result.outcome.resultLink).toMatchObject({ path: '/orders/A1', label: '查看订单' });
    }
    expect(result.attempts).toBe(1);
    expect(requests[0]!.path).toBe('/ky/v1/capabilities/order.search');
    expect(requests[0]!.headers?.['X-KY-Idempotency-Key']).toBe('lc-fixed');
    expect(requests[0]!.headers?.['X-KY-Request-Id']).toBe('rid-fixed');
    expect(satClaims[0]).toMatchObject({
      act: 'agent',
      cap: 'order.search',
      lcid: 'lc-fixed',
      rid: 'rid-fixed',
      sid: 'sess-1',
      dig: 'a'.repeat(64),
    });
    // read_only 不带审批。
    expect(satClaims[0]).not.toHaveProperty('apr');
  });

  it('无响应重试 ≤ 2 次，退避 1s / 3s，每个 attempt 新签一枚 SAT', async () => {
    const { runner, slept, satClaims } = makeHarness([
      TIMEOUT,
      TIMEOUT,
      ok({ ok: true, data: { rows: [] } }),
    ]);
    const result = await runner.run({ ...CALL, entry: readEntry() });
    expect(result.outcome.kind).toBe('success');
    expect(result.attempts).toBe(3);
    expect(slept).toEqual([...READ_RETRY_BACKOFF_MS]);
    expect(satClaims).toHaveLength(3);
    expect(new Set(satClaims.map((claim) => claim.lcid))).toEqual(new Set(['lc-fixed']));
    expect(result.countsTowardBreaker).toBe(true);
  });

  it('三次都无响应 → 报暂时不可用，不再重试', async () => {
    const { runner, slept } = makeHarness([TIMEOUT, TIMEOUT, TIMEOUT]);
    const result = await runner.run({ ...CALL, entry: readEntry() });
    expect(result.outcome).toMatchObject({ kind: 'failure', code: 'upstream_unavailable' });
    expect(result.attempts).toBe(3);
    expect(slept).toEqual([...READ_RETRY_BACKOFF_MS]);
  });

  it('502/503/504 重试，其它 5xx 不重试', async () => {
    const retried = makeHarness([status(503), status(502), ok({ ok: true, data: {} })]);
    const first = await retried.runner.run({ ...CALL, entry: readEntry() });
    expect(first.outcome.kind).toBe('success');
    expect(first.attempts).toBe(3);

    const notRetried = makeHarness([status(500, { ok: false, error: { code: 'internal' } })]);
    const second = await notRetried.runner.run({ ...CALL, entry: readEntry() });
    expect(second.outcome).toMatchObject({ kind: 'failure', code: 'internal' });
    expect(second.attempts).toBe(1);
  });

  it('429 按 Retry-After 重试 1 次；超过 10 s 或第二次 429 不再重试', async () => {
    const once = makeHarness([
      status(429, { ok: false, error: { code: 'rate_limited' } }, 2_000),
      ok({ ok: true, data: {} }),
    ]);
    const first = await once.runner.run({ ...CALL, entry: readEntry() });
    expect(first.outcome.kind).toBe('success');
    expect(once.slept).toEqual([2_000]);

    const tooLong = makeHarness([
      status(429, { ok: false, error: { code: 'rate_limited' } }, MAX_RETRY_AFTER_MS + 1),
    ]);
    const second = await tooLong.runner.run({ ...CALL, entry: readEntry() });
    expect(second.outcome).toMatchObject({ kind: 'failure', code: 'rate_limited' });
    expect(tooLong.slept).toEqual([]);

    const twice = makeHarness([status(429, null, 1_000), status(429, null, 1_000)]);
    const third = await twice.runner.run({ ...CALL, entry: readEntry() });
    expect(third.outcome).toMatchObject({ kind: 'failure', code: 'rate_limited' });
    expect(twice.slept).toEqual([1_000]);
  });

  it('响应体超 6,000 字节 → response_too_large，不把超长正文塞给模型', async () => {
    const big = { ok: true, data: { note: '中'.repeat(2_500) } };
    const { runner } = makeHarness([ok(big)]);
    const result = await runner.run({ ...CALL, entry: readEntry() });
    expect(result.outcome).toMatchObject({ kind: 'failure', code: 'response_too_large' });
  });

  it('定制项目的 message 只进日志，不进结果的客户面通道', async () => {
    const { runner } = makeHarness([
      status(403, {
        ok: false,
        error: { code: 'forbidden', message: 'role X missing on table orders', requestId: 'r' },
      }),
    ]);
    const result = await runner.run({ ...CALL, entry: readEntry() });
    expect(result.outcome).toMatchObject({ kind: 'failure', code: 'forbidden' });
    if (result.outcome.kind === 'failure') {
      expect(result.outcome.logMessage).toContain('role X missing');
    }
  });
});

describe('write 链（safeToRetry:false）', () => {
  it('一次成功：SAT 成对携带 apr/aph', async () => {
    const { runner, satClaims } = makeHarness([ok({ ok: true, data: { orderId: 'B2' } })]);
    const result = await runner.run({
      ...CALL,
      entry: writeEntry(),
      approval: { approvalId: 'ap-1', aph: 'b'.repeat(64) },
    });
    expect(result.outcome.kind).toBe('success');
    expect(satClaims[0]).toMatchObject({ apr: 'ap-1', aph: 'b'.repeat(64) });
  });

  it('502/503/504 不重试（写不是幂等安全的）', async () => {
    const { runner, requests } = makeHarness([
      status(503, { ok: false, error: { code: 'maintenance' } }),
    ]);
    const result = await runner.run({ ...CALL, entry: writeEntry() });
    expect(result.outcome).toMatchObject({ kind: 'failure', code: 'maintenance' });
    expect(requests).toHaveLength(1);
  });

  it('429 不重试', async () => {
    const { runner, slept } = makeHarness([
      status(429, { ok: false, error: { code: 'rate_limited' } }, 1_000),
    ]);
    const result = await runner.run({ ...CALL, entry: writeEntry() });
    expect(result.outcome).toMatchObject({ kind: 'failure', code: 'rate_limited' });
    expect(slept).toEqual([]);
  });

  it('无响应 → 查 executions，绝不重发写请求；done 则取结果', async () => {
    const { runner, requests } = makeHarness([
      TIMEOUT,
      ok({ status: 'in_progress' }),
      ok({ status: 'done', result: { orderId: 'B2' } }),
    ]);
    const result = await runner.run({ ...CALL, entry: writeEntry() });
    expect(result.outcome).toMatchObject({ kind: 'success', data: { orderId: 'B2' } });
    // 只发了一次 POST，其余全是 GET executions。
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1);
    expect(requests[1]!.path).toBe('/ky/v1/capabilities/order.create/executions/lc-fixed');
    expect(requests[2]!.method).toBe('GET');
  });

  it('executions 报 failed → 按记录里的错误码报失败', async () => {
    const { runner } = makeHarness([
      TIMEOUT,
      ok({ status: 'failed', error: { code: 'invalid_input', message: 'amount must be > 0' } }),
    ]);
    const result = await runner.run({ ...CALL, entry: writeEntry() });
    expect(result.outcome).toMatchObject({ kind: 'failure', code: 'invalid_input' });
  });

  it('每一次 executions 查询也新签一枚 act=agent SAT', async () => {
    const { runner, satClaims } = makeHarness([
      TIMEOUT,
      ok({ status: 'in_progress' }),
      ok({ status: 'done', result: {} }),
    ]);
    await runner.run({ ...CALL, entry: writeEntry() });
    expect(satClaims).toHaveLength(3);
    expect(satClaims.every((claim) => claim.act === 'agent')).toBe(true);
    expect(new Set(satClaims.map((claim) => claim.jti ?? claim.rid))).toEqual(
      new Set(['rid-fixed']),
    );
  });
});

describe('unknown 链：禁止把超时说成未执行', () => {
  it('executions 一直 in_progress 到 60 s 总截止 → outcome_unknown', async () => {
    const steps: Step[] = [TIMEOUT];
    for (let index = 0; index < 40; index += 1) steps.push(ok({ status: 'in_progress' }));
    const { runner } = makeHarness(steps);
    const result = await runner.run({ ...CALL, entry: writeEntry() });
    expect(result.outcome).toMatchObject({ kind: 'failure', code: 'outcome_unknown' });
  });

  it('executions 返回 expired → outcome_unknown', async () => {
    const { runner } = makeHarness([TIMEOUT, ok({ status: 'expired' })]);
    const result = await runner.run({ ...CALL, entry: writeEntry() });
    expect(result.outcome).toMatchObject({ kind: 'failure', code: 'outcome_unknown' });
  });

  it('executions 查询本身一直失败 → 查到截止，仍是 outcome_unknown 而不是「未执行」', async () => {
    const steps: Step[] = [TIMEOUT];
    for (let index = 0; index < 40; index += 1) steps.push(TIMEOUT);
    const { runner } = makeHarness(steps);
    const result = await runner.run({ ...CALL, entry: writeEntry() });
    expect(result.outcome).toMatchObject({ kind: 'failure', code: 'outcome_unknown' });
    expect(result.countsTowardBreaker).toBe(true);
  });

  it('写能力在总截止后不再发起：结论是 outcome_unknown，读能力则是暂时不可用', async () => {
    const write = makeHarness([
      TIMEOUT,
      ...Array.from({ length: 40 }, () => ok({ status: 'not_started' })),
    ]);
    const writeResult = await write.runner.run({ ...CALL, entry: writeEntry() });
    expect(writeResult.outcome).toMatchObject({ code: 'outcome_unknown' });

    const read = makeHarness([TIMEOUT, TIMEOUT, TIMEOUT]);
    const readResult = await read.runner.run({ ...CALL, entry: readEntry() });
    expect(readResult.outcome).toMatchObject({ code: 'upstream_unavailable' });
  });
});
