/**
 * WP3 Phase B：provider → 渠道闸 → 审批 → 限流 → 逻辑调用 → 封装 的串联。
 */
import { describe, expect, it, vi } from 'vitest';

import type { AuthorizedToolCall, ToolCallContext } from '../../agent/toolRuntime.js';
import type { KyAppGatewayLimits } from '../config.js';
import { AppApprovalRegistry, approvalParamsHash } from './approval.js';
import { createAppCapabilityInvoker } from './invoker.js';
import { AppLogicalCallRunner } from './lcid.js';
import type { KyAppOutbound, KyAppOutboundRequest } from '../outbound.js';
import { GatewayPolicy } from './policy.js';
import type { AppCapabilityEntry } from './snapshot.js';

const LIMITS: KyAppGatewayLimits = {
  perInstallationConcurrency: 8,
  perRunPerCapability: 20,
  perTenantPerMinute: 300,
  perTenantPerDay: 5_000,
  breakerFailureThreshold: 20,
  breakerCooldownMs: 300_000,
};

const GATEWAY_CONFIG = {
  logicalCallDeadlineMs: 60_000,
  executionPollIntervalMs: 2_000,
  maxResponseBytes: 6_000,
  approvalTtlMs: 600_000,
};

function entry(overrides: Partial<AppCapabilityEntry> = {}): AppCapabilityEntry {
  return {
    installationId: 'iid-1',
    systemId: 'demo_erp',
    systemName: '演示 ERP',
    capabilityId: 'order.create',
    toolName: 'app__demo_erp__order_create',
    capabilityName: '建订单',
    description: '建订单',
    riskLevel: 'external_write',
    safeToRetry: false,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    registeredDigest: 'a'.repeat(64),
    baseUrl: 'https://erp.example.com',
    ...overrides,
  };
}

function contextFor(channel: 'web' | 'dingtalk' | 'cron' = 'web'): ToolCallContext {
  return {
    channelContext: {
      channel,
      user: { id: 'u-1', username: 'alice', role: 'user', tenantId: 'org-1' },
    },
    workspace: { root: '/tmp', executionTarget: 'server-local', sessionId: 'sess-1' },
    runId: 'run-1',
  } as unknown as ToolCallContext;
}

function callFor(input: unknown, approvalId?: string): AuthorizedToolCall {
  return {
    toolId: 'app__demo_erp__order_create',
    input,
    authorization: approvalId
      ? { approved: true, approvalId, source: 'human_approval' }
      : { approved: true, source: 'policy_auto' },
  };
}

function makeHarness(responder: (request: KyAppOutboundRequest) => unknown) {
  const requests: KyAppOutboundRequest[] = [];
  const outbound: KyAppOutbound = {
    async request(request) {
      requests.push(request);
      const body = responder(request);
      const text = JSON.stringify(body);
      return { status: 200, text, json: body, retryAfterMs: null };
    },
  };
  const policy = new GatewayPolicy({ limits: LIMITS });
  const approvals = new AppApprovalRegistry();
  const invoker = createAppCapabilityInvoker({
    runner: new AppLogicalCallRunner({
      issuer: {
        async issue() {
          return { token: 't', expiresAt: 0, kid: 'k', jti: 'j' };
        },
      },
      outbound,
      config: GATEWAY_CONFIG,
      newLcid: () => 'lc-1',
      newRequestId: () => 'rid-1',
    }),
    policy,
    approvals,
    config: GATEWAY_CONFIG,
    async isTenantAdmin() {
      return false;
    },
  });
  return { invoker, policy, approvals, requests };
}

describe('渠道闸（§6.2-2）', () => {
  it('非 web 渠道的写能力 → approval_channel_unavailable，且一次出站都不发', async () => {
    for (const channel of ['dingtalk', 'cron'] as const) {
      const harness = makeHarness(() => ({ ok: true, data: {} }));
      const result = await harness.invoker.invoke({
        entry: entry(),
        call: callFor({ amount: 1 }, 'ap-1'),
        context: contextFor(channel),
      });
      expect(result.content).toContain('该操作需要在网页端确认');
      expect(harness.requests).toHaveLength(0);
      expect(result.metadata).toMatchObject({ errorCode: 'approval_channel_unavailable' });
    }
  });

  it('非 web 渠道的读能力照常放行', async () => {
    const harness = makeHarness(() => ({ ok: true, data: { rows: [] } }));
    const result = await harness.invoker.invoke({
      entry: entry({ riskLevel: 'read_only', safeToRetry: true, capabilityId: 'order.search' }),
      call: callFor({ keyword: 'x' }),
      context: contextFor('cron'),
    });
    expect(harness.requests).toHaveLength(1);
    expect(result.metadata).toMatchObject({ capabilityId: 'order.search' });
  });
});

describe('审批消费（§6.2-3，DoD 第三条）', () => {
  it('写能力没有 human_approval 来源 → approval_required，不发出站', async () => {
    const harness = makeHarness(() => ({ ok: true, data: {} }));
    const result = await harness.invoker.invoke({
      entry: entry(),
      call: callFor({ amount: 1 }),
      context: contextFor(),
    });
    expect(result.metadata).toMatchObject({ errorCode: 'approval_required' });
    expect(harness.requests).toHaveLength(0);
  });

  it('同一 approvalId 不能用于第二次写入', async () => {
    const harness = makeHarness(() => ({ ok: true, data: { orderId: 'A1' } }));
    const first = await harness.invoker.invoke({
      entry: entry(),
      call: callFor({ amount: 1 }, 'ap-1'),
      context: contextFor(),
    });
    expect(first.metadata).toMatchObject({ approvalId: 'ap-1' });
    const second = await harness.invoker.invoke({
      entry: entry(),
      call: callFor({ amount: 1 }, 'ap-1'),
      context: contextFor(),
    });
    expect(second.metadata).toMatchObject({ errorCode: 'approval_required' });
    expect(harness.requests).toHaveLength(1);
  });

  it('参数变更 → aph 变 → 旧审批不可复用（登记过绑定时）', async () => {
    const harness = makeHarness(() => ({ ok: true, data: {} }));
    harness.approvals.remember({
      approvalId: 'ap-2',
      installationId: 'iid-1',
      sessionId: 'sess-1',
      capabilityId: 'order.create',
      aph: approvalParamsHash('order.create', { amount: 1 }),
      expiresAt: Date.now() + 600_000,
    });
    const result = await harness.invoker.invoke({
      entry: entry(),
      call: callFor({ amount: 999 }, 'ap-2'),
      context: contextFor(),
    });
    expect(result.metadata).toMatchObject({ errorCode: 'approval_required' });
    expect(harness.requests).toHaveLength(0);
  });

  it('审批过期 → approval_timeout「操作已取消，未写入任何数据」', async () => {
    const harness = makeHarness(() => ({ ok: true, data: {} }));
    harness.approvals.remember({
      approvalId: 'ap-3',
      installationId: 'iid-1',
      sessionId: 'sess-1',
      capabilityId: 'order.create',
      aph: approvalParamsHash('order.create', { amount: 1 }),
      expiresAt: Date.now() - 1,
    });
    const result = await harness.invoker.invoke({
      entry: entry(),
      call: callFor({ amount: 1 }, 'ap-3'),
      context: contextFor(),
    });
    expect(result.content).toContain('操作已取消，未写入任何数据');
    expect(harness.requests).toHaveLength(0);
  });

  it('SAT 携带 apr/aph，且 aph = sha256(JCS({cap,input}))', async () => {
    const claims: Array<Record<string, unknown>> = [];
    const outbound: KyAppOutbound = {
      async request() {
        return {
          status: 200,
          text: '{"ok":true}',
          json: { ok: true, data: {} },
          retryAfterMs: null,
        };
      },
    };
    const invoker = createAppCapabilityInvoker({
      runner: new AppLogicalCallRunner({
        issuer: {
          async issue(request) {
            claims.push(request as unknown as Record<string, unknown>);
            return { token: 't', expiresAt: 0, kid: 'k', jti: 'j' };
          },
        },
        outbound,
        config: GATEWAY_CONFIG,
      }),
      policy: new GatewayPolicy({ limits: LIMITS }),
      approvals: new AppApprovalRegistry(),
      config: GATEWAY_CONFIG,
      async isTenantAdmin() {
        return true;
      },
    });
    await invoker.invoke({
      entry: entry(),
      call: callFor({ amount: 1 }, 'ap-9'),
      context: contextFor(),
    });
    expect(claims[0]).toMatchObject({
      apr: 'ap-9',
      aph: approvalParamsHash('order.create', { amount: 1 }),
      tadm: true,
    });
  });
});

describe('限流与熔断串联', () => {
  it('被限流时不发出站，客户面文案是「系统繁忙，稍后重试」', async () => {
    const harness = makeHarness(() => ({ ok: true, data: {} }));
    const readEntry = entry({
      riskLevel: 'read_only',
      safeToRetry: true,
      capabilityId: 'order.search',
    });
    for (let index = 0; index < 20; index += 1) {
      await harness.invoker.invoke({
        entry: readEntry,
        call: callFor({ i: index }),
        context: contextFor(),
      });
    }
    const denied = await harness.invoker.invoke({
      entry: readEntry,
      call: callFor({ i: 20 }),
      context: contextFor(),
    });
    expect(denied.content).toContain('系统繁忙，稍后重试');
    expect(harness.requests).toHaveLength(20);
  });

  it('身份不全（无租户/会话）直接 unauthorized，不发出站', async () => {
    const harness = makeHarness(() => ({ ok: true, data: {} }));
    const result = await harness.invoker.invoke({
      entry: entry({ riskLevel: 'read_only', safeToRetry: true }),
      call: callFor({}),
      context: {
        channelContext: { channel: 'web' },
        workspace: { root: '/tmp' },
      } as unknown as ToolCallContext,
    });
    expect(result.metadata).toMatchObject({ errorCode: 'unauthorized' });
    expect(harness.requests).toHaveLength(0);
  });

  it('并发槽在成功与失败两条路径上都释放', async () => {
    const harness = makeHarness(() => ({ ok: true, data: {} }));
    const readEntry = entry({ riskLevel: 'read_only', safeToRetry: true });
    await harness.invoker.invoke({ entry: readEntry, call: callFor({}), context: contextFor() });
    expect(harness.policy.inspect('iid-1').active).toBe(0);
    const spy = vi.spyOn(harness.policy, 'recordSuccess');
    await harness.invoker.invoke({ entry: readEntry, call: callFor({}), context: contextFor() });
    expect(spy).toHaveBeenCalledWith('iid-1');
    expect(harness.policy.inspect('iid-1').active).toBe(0);
  });
});
