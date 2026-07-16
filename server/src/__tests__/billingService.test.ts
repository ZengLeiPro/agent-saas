import { describe, expect, it, vi } from 'vitest';

import { BillingService } from '../data/billing/service.js';
import { PgBillingStore } from '../data/billing/pgBillingStore.js';
import { CREDIT_MICRO, type TenantBillingPolicy } from '../data/billing/types.js';

describe('BillingService hard cap guard', () => {
  it('summarizes parent and child-session debits as one current conversation', async () => {
    const store = {
      getTenantPolicy: vi.fn(async () => ({ showCost: true })),
      getSessionTreeLedgerSummary: vi.fn(async () => ({
        creditsUsedMicro: 2737.58 * CREDIT_MICRO,
        revenueYuanMicro: 547_502_908,
        actualCostYuanMicro: 547_502_908,
        childSessionCount: 7,
      })),
    };
    const service = new BillingService({ store: store as any });
    vi.spyOn(service, 'ensureProjected').mockResolvedValue();

    await expect(service.getSessionSummary('pantheon', 'parent-session')).resolves.toEqual({
      sessionId: 'parent-session',
      creditsUsed: 2737.58,
      revenueYuan: 547.502908,
      actualCostYuan: 547.502908,
      childSessionCount: 7,
    });
    expect(store.getSessionTreeLedgerSummary).toHaveBeenCalledWith('pantheon', 'parent-session');
  });

  it('allows internal billing tenants regardless of balance', async () => {
    const service = new BillingService({
      store: fakeStore({
        balanceCreditsMicro: -100 * CREDIT_MICRO,
        policy: { billingMode: 'internal', hardCapMode: 'stop_before_run' },
      }),
    });

    await expect(service.assertTenantCanStartRun('kaiyan')).resolves.toEqual({ ok: true });
  });

  it('blocks prepaid tenants when hard cap is enabled and effective balance is empty', async () => {
    const service = new BillingService({
      store: fakeStore({
        balanceCreditsMicro: 1 * CREDIT_MICRO,
        reservedCreditsMicro: 1 * CREDIT_MICRO,
        policy: { hardCapMode: 'stop_before_run', allowNegativeBalance: false },
      }),
    });

    await expect(service.assertTenantCanStartRun('wain-test')).resolves.toMatchObject({ ok: false });
  });

  it('respects negative balance allowance as an explicit credit line', async () => {
    const allowed = new BillingService({
      store: fakeStore({
        balanceCreditsMicro: -0.5 * CREDIT_MICRO,
        policy: {
          hardCapMode: 'stop_before_run',
          allowNegativeBalance: true,
          negativeLimitCreditsMicro: 1 * CREDIT_MICRO,
        },
      }),
    });
    const blocked = new BillingService({
      store: fakeStore({
        balanceCreditsMicro: -1 * CREDIT_MICRO,
        policy: {
          hardCapMode: 'stop_before_run',
          allowNegativeBalance: true,
          negativeLimitCreditsMicro: 1 * CREDIT_MICRO,
        },
      }),
    });

    await expect(allowed.assertTenantCanStartRun('trial')).resolves.toEqual({ ok: true });
    await expect(blocked.assertTenantCanStartRun('trial')).resolves.toMatchObject({ ok: false });
  });

  it('short-circuits dispatch when hard cap rejects the tenant', async () => {
    const service = new BillingService({
      store: fakeStore({
        balanceCreditsMicro: 0,
        policy: { hardCapMode: 'stop_before_run', allowNegativeBalance: false },
      }),
      logger: { warn: vi.fn() },
    });
    const dispatch = vi.fn(async function* () {
      yield { type: 'assistant_message', message: { role: 'assistant', content: 'should not run' } } as any;
    });

    const events = [];
    for await (const event of service.wrapDispatch(dispatch)(
      { type: 'message', content: 'hello' } as any,
      { user: { tenantId: 'blocked-tenant' } } as any,
    )) {
      events.push(event);
    }

    expect(dispatch).not.toHaveBeenCalled();
    expect(events).toEqual([{ type: 'error', error: '组织积分余额不足，当前计费策略已启用硬封顶。' }]);
  });

  it('advances runtime_events projection watermark across non-billable events', async () => {
    const store = {
      getProjectionState: vi.fn(async () => 0),
      listUnprojectedRuntimeEvents: vi.fn(async () => [
        {
          globalSequence: 1,
          eventId: 'event-delta',
          eventType: 'tool_output_delta',
          tenantId: 'tenant-1',
          timestamp: '2026-07-07T00:00:00.000Z',
          eventJson: { type: 'tool_output_delta' },
        },
        {
          globalSequence: 2,
          eventId: 'event-finished',
          eventType: 'run_finished',
          tenantId: 'tenant-1',
          timestamp: '2026-07-07T00:00:01.000Z',
          eventJson: { type: 'run_finished', runId: 'run-1' },
        },
      ]),
      settleRunDebit: vi.fn(async () => null),
      setProjectionState: vi.fn(async () => undefined),
    };
    const service = new BillingService({ store: store as any });

    await expect(service.projectRuntimeEvents()).resolves.toMatchObject({ lastProjectedSequence: 2 });

    expect(store.settleRunDebit).toHaveBeenCalledWith('tenant-1', 'run-1');
    expect(store.setProjectionState).toHaveBeenCalledWith('runtime_events', 2);
  });

  it('settles billable usage when a run pauses for user interaction', async () => {
    const store = {
      getProjectionState: vi.fn(async () => 0),
      listUnprojectedRuntimeEvents: vi.fn(async () => [
        {
          globalSequence: 1,
          eventId: 'event-usage',
          eventType: 'assistant_tool_calls',
          tenantId: 'tenant-1',
          timestamp: '2026-07-07T00:00:00.000Z',
          eventJson: {
            type: 'assistant_tool_calls',
            id: 'event-usage',
            runId: 'run-1',
            sessionId: 'session-1',
            model: 'glm-5.2',
            usage: { inputTokens: 1000, outputTokens: 100 },
          },
        },
        {
          globalSequence: 2,
          eventId: 'event-waiting',
          eventType: 'run_state_changed',
          tenantId: 'tenant-1',
          timestamp: '2026-07-07T00:00:01.000Z',
          eventJson: {
            type: 'run_state_changed',
            runId: 'run-1',
            sessionId: 'session-1',
            status: 'waiting_user',
          },
        },
      ]),
      insertUsageEvent: vi.fn(async () => ({ id: 'usage-1' })),
      settleRunDebit: vi.fn(async () => ({ id: 'ledger-1' })),
      setProjectionState: vi.fn(async () => undefined),
    };
    const service = new BillingService({ store: store as any });

    await expect(service.projectRuntimeEvents()).resolves.toMatchObject({
      usageEventsInserted: 1,
      debitEntriesInserted: 1,
      lastProjectedSequence: 2,
    });

    expect(store.insertUsageEvent).toHaveBeenCalledTimes(1);
    expect(store.settleRunDebit).toHaveBeenCalledWith('tenant-1', 'run-1');
  });

  it('projects independent image-understanding usage into the immutable billing ledger', async () => {
    const store = {
      getProjectionState: vi.fn(async () => 0),
      listUnprojectedRuntimeEvents: vi.fn(async () => [{
        globalSequence: 1,
        eventId: 'event-vision',
        eventType: 'image_understanding',
        tenantId: 'tenant-1',
        runModel: 'text-main',
        runChannel: 'web',
        timestamp: '2026-07-14T08:00:00.000Z',
        eventJson: {
          type: 'image_understanding',
          id: 'event-vision',
          runId: 'run-vision',
          sessionId: 'session-vision',
          model: 'vision-helper',
          status: 'completed',
          usage: { inputTokens: 800, outputTokens: 120 },
        },
      }]),
      insertUsageEvent: vi.fn(async () => ({ id: 'usage-vision' })),
      setProjectionState: vi.fn(async () => undefined),
    };
    const service = new BillingService({ store: store as any });

    await expect(service.projectRuntimeEvents()).resolves.toMatchObject({ usageEventsInserted: 1 });
    expect(store.insertUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      modelValue: 'vision-helper',
      runId: 'run-vision',
      usage: { inputTokens: 800, outputTokens: 120 },
    }));
  });

  it('projects failed Responses attempt usage before settling the failed run', async () => {
    const store = {
      getProjectionState: vi.fn(async () => 0),
      listUnprojectedRuntimeEvents: vi.fn(async () => [
        {
          globalSequence: 1,
          eventId: 'event-model-failed',
          eventType: 'model_request_finished',
          tenantId: 'tenant-1',
          runModel: 'gpt-5.6-sol',
          runChannel: 'web',
          timestamp: '2026-07-16T10:00:00.000Z',
          eventJson: {
            type: 'model_request_finished',
            runId: 'run-failed',
            sessionId: 'session-failed',
            diagnostic: {
              type: 'finished',
              modelRequestId: 'model-request-1',
              attemptId: 'attempt-1',
              attempt: 1,
              outcome: 'response_incomplete',
              durationMs: 200_000,
              terminalStatus: 'incomplete',
              errorCode: 'MODEL_RESPONSE_INCOMPLETE',
              usage: { inputTokens: 100, outputTokens: 4096, cacheReadInputTokens: 20 },
            },
          },
        },
        {
          globalSequence: 2,
          eventId: 'event-run-failed',
          eventType: 'run_finished',
          tenantId: 'tenant-1',
          timestamp: '2026-07-16T10:00:01.000Z',
          eventJson: { type: 'run_finished', runId: 'run-failed', sessionId: 'session-failed', subtype: 'error' },
        },
      ]),
      insertUsageEvent: vi.fn(async () => ({ id: 'usage-failed-attempt' })),
      settleRunDebit: vi.fn(async () => ({ id: 'ledger-failed-attempt' })),
      setProjectionState: vi.fn(async () => undefined),
    };
    const service = new BillingService({ store: store as any });

    await expect(service.projectRuntimeEvents()).resolves.toMatchObject({
      usageEventsInserted: 1,
      debitEntriesInserted: 1,
      lastProjectedSequence: 2,
    });
    expect(store.insertUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'usage:model-attempt:v1:attempt-1',
      tenantId: 'tenant-1',
      runId: 'run-failed',
      sessionId: 'session-failed',
      modelValue: 'gpt-5.6-sol',
      usage: { inputTokens: 100, outputTokens: 4096, cacheReadInputTokens: 20 },
      rawUsageJson: expect.objectContaining({
        attemptId: 'attempt-1',
        outcome: 'response_incomplete',
      }),
    }));
    expect(store.settleRunDebit).toHaveBeenCalledWith('tenant-1', 'run-failed');
  });

  it('does not double-project completed model diagnostics alongside assistant usage', async () => {
    const store = {
      getProjectionState: vi.fn(async () => 0),
      listUnprojectedRuntimeEvents: vi.fn(async () => [
        {
          globalSequence: 1,
          eventId: 'event-model-completed',
          eventType: 'model_request_finished',
          tenantId: 'tenant-1',
          runModel: 'glm-5.2',
          timestamp: '2026-07-16T10:00:00.000Z',
          eventJson: {
            type: 'model_request_finished',
            runId: 'run-1',
            sessionId: 'session-1',
            diagnostic: {
              type: 'finished',
              attemptId: 'attempt-completed',
              outcome: 'completed',
              usage: { inputTokens: 10, outputTokens: 2 },
            },
          },
        },
        {
          globalSequence: 2,
          eventId: 'event-assistant',
          eventType: 'assistant_message',
          tenantId: 'tenant-1',
          runModel: 'glm-5.2',
          timestamp: '2026-07-16T10:00:01.000Z',
          eventJson: {
            type: 'assistant_message',
            runId: 'run-1',
            sessionId: 'session-1',
            model: 'glm-5.2',
            usage: { inputTokens: 10, outputTokens: 2 },
          },
        },
      ]),
      insertUsageEvent: vi.fn(async () => ({ id: 'usage-success' })),
      setProjectionState: vi.fn(async () => undefined),
    };
    const service = new BillingService({ store: store as any });

    await expect(service.projectRuntimeEvents()).resolves.toMatchObject({ usageEventsInserted: 1 });
    expect(store.insertUsageEvent).toHaveBeenCalledTimes(1);
    expect(store.insertUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'usage:event:v1:event-assistant',
    }));
  });

  it('projects metered tool usage into a non-billable usage row plus an independent fixed debit', async () => {
    // 防双重扣费（最高优先级）：usage 行必须 billable=false（settleRunDebit 只认
    // billable 标志不认识 SKU），固定扣费由独立 source='tool:image_gen' debit 承载。
    const store = {
      getProjectionState: vi.fn(async () => 0),
      listUnprojectedRuntimeEvents: vi.fn(async () => [{
        globalSequence: 7,
        eventId: 'event-image',
        eventType: 'metered_tool_usage',
        tenantId: 'tenant-1',
        runChannel: 'web',
        timestamp: '2026-07-15T08:00:00.000Z',
        eventJson: {
          type: 'metered_tool_usage',
          id: 'event-image',
          runId: 'run-img',
          sessionId: 'session-img',
          toolId: 'GenerateImage',
          sku: 'image_gen:gpt-image-2',
          quantity: 2,
          unitCreditsMicro: 400_000_000,
          unitCostYuanMicro: 1_500_000,
          note: '1024x1024 quality=high',
        },
      }]),
      insertUsageEvent: vi.fn(async () => ({ id: 'usage-img' })),
      chargeFixedDebit: vi.fn(async () => ({ id: 'ledger-img' })),
      settleRunDebit: vi.fn(async () => null),
      setProjectionState: vi.fn(async () => undefined),
    };
    const service = new BillingService({ store: store as any });

    await expect(service.projectRuntimeEvents()).resolves.toMatchObject({
      usageEventsInserted: 1,
      debitEntriesInserted: 1,
      lastProjectedSequence: 7,
    });

    expect(store.insertUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'usage:event:v1:event-image',
      tenantId: 'tenant-1',
      billable: false,
      modelValue: 'image_gen:gpt-image-2',
      usage: { inputTokens: 0, outputTokens: 0, apiRequestCount: 2 },
      fixedCostYuanMicro: 3_000_000,
    }));
    expect(store.chargeFixedDebit).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-1',
      idempotencyKey: 'debit:tool:v1:event-image',
      source: 'tool:image_gen',
      creditsMicro: 800_000_000,
      actualCostYuanMicro: 3_000_000,
      relatedUsageEventIds: ['usage-img'],
      runId: 'run-img',
      sessionId: 'session-img',
      note: 'GenerateImage image_gen:gpt-image-2 ×2 (1024x1024 quality=high)',
    }));
    // metered_tool_usage 本身绝不触发 run 级 cost-plus 结算
    expect(store.settleRunDebit).not.toHaveBeenCalled();
  });

  it('exempts internal tenants and no-hard-cap tenants from the fixed fee preflight', async () => {
    const internal = new BillingService({
      store: fakeStore({
        balanceCreditsMicro: 0,
        policy: { billingMode: 'internal', hardCapMode: 'stop_before_run' },
      }),
    });
    const noCap = new BillingService({
      store: fakeStore({
        balanceCreditsMicro: 0,
        policy: { hardCapMode: 'none' },
      }),
    });

    await expect(internal.assertTenantCanAffordFixedFee('kaiyan', 100 * CREDIT_MICRO)).resolves.toEqual({ ok: true });
    await expect(noCap.assertTenantCanAffordFixedFee('postpaid-x', 100 * CREDIT_MICRO)).resolves.toEqual({ ok: true });
  });

  it('blocks the fixed fee when effective balance cannot cover the requested credits', async () => {
    // 与 assertTenantCanStartRun 的差异：感知即将发生的 N——余额 50 < 需 100 → 拒
    const service = new BillingService({
      store: fakeStore({
        balanceCreditsMicro: 50 * CREDIT_MICRO,
        policy: { hardCapMode: 'stop_before_run', allowNegativeBalance: false },
      }),
    });

    await expect(service.assertTenantCanAffordFixedFee('wain-test', 100 * CREDIT_MICRO))
      .resolves.toMatchObject({ ok: false });
    await expect(service.assertTenantCanAffordFixedFee('wain-test', 50 * CREDIT_MICRO))
      .resolves.toEqual({ ok: true });
  });

  it('respects the negative balance credit line for fixed fees', async () => {
    const store = fakeStore({
      balanceCreditsMicro: 10 * CREDIT_MICRO,
      policy: {
        hardCapMode: 'stop_before_run',
        allowNegativeBalance: true,
        negativeLimitCreditsMicro: 100 * CREDIT_MICRO,
      },
    });
    const service = new BillingService({ store });

    // 10 - 100 = -90，|-90| < 100 信用额度 → 放行
    await expect(service.assertTenantCanAffordFixedFee('trial', 100 * CREDIT_MICRO)).resolves.toEqual({ ok: true });
    // 10 - 120 = -110，超出信用额度 → 拒绝
    await expect(service.assertTenantCanAffordFixedFee('trial', 120 * CREDIT_MICRO)).resolves.toMatchObject({ ok: false });
  });

  it('settles billable usage when a run is cancelled without run_finished', async () => {
    const store = {
      getProjectionState: vi.fn(async () => 0),
      listUnprojectedRuntimeEvents: vi.fn(async () => [
        {
          globalSequence: 1,
          eventId: 'event-usage',
          eventType: 'assistant_message',
          tenantId: 'tenant-1',
          timestamp: '2026-07-07T00:00:00.000Z',
          eventJson: {
            type: 'assistant_message',
            id: 'event-usage',
            runId: 'run-1',
            sessionId: 'session-1',
            model: 'glm-5.2',
            usage: { inputTokens: 1000, outputTokens: 100 },
          },
        },
        {
          globalSequence: 2,
          eventId: 'event-cancelled',
          eventType: 'run_state_changed',
          tenantId: 'tenant-1',
          timestamp: '2026-07-07T00:00:01.000Z',
          eventJson: {
            type: 'run_state_changed',
            runId: 'run-1',
            sessionId: 'session-1',
            status: 'cancelled',
          },
        },
      ]),
      insertUsageEvent: vi.fn(async () => ({ id: 'usage-1' })),
      settleRunDebit: vi.fn(async () => ({ id: 'ledger-1' })),
      setProjectionState: vi.fn(async () => undefined),
    };
    const service = new BillingService({ store: store as any });

    await expect(service.projectRuntimeEvents()).resolves.toMatchObject({
      usageEventsInserted: 1,
      debitEntriesInserted: 1,
      lastProjectedSequence: 2,
    });

    expect(store.settleRunDebit).toHaveBeenCalledWith('tenant-1', 'run-1');
  });
});

describe('PgBillingStore.chargeFixedDebit', () => {
  // 私有方法经 spy 隔离 PG：本组只验证 chargeFixedDebit 自身的守卫/幂等/落账语义，
  // SQL 层由集成环境覆盖。
  function fixedDebitStore(input: {
    policy?: Partial<TenantBillingPolicy>;
    balanceCreditsMicro?: number;
  } = {}) {
    const store = new PgBillingStore({ pool: {} as any });
    vi.spyOn(store, 'getTenantPolicy').mockResolvedValue({
      tenantId: 'wain-test',
      policyVersion: 'test',
      billingEnabled: true,
      pricingVersion: 'test',
      billingMode: 'prepaid',
      defaultTargetMarginBps: 6000,
      organizationMultiplierBps: 10000,
      allowNegativeBalance: false,
      negativeLimitCreditsMicro: 0,
      lowBalanceThresholdCreditsMicro: 0,
      hardCapMode: 'stop_before_run',
      showBalance: true,
      showUsageCredits: true,
      showCost: false,
      showGrossMargin: false,
      updatedBy: 'test',
      updatedAt: '2026-07-15T00:00:00.000Z',
      ...(input.policy ?? {}),
    } as any);
    vi.spyOn(store, 'getActivePricingVersion').mockResolvedValue({
      version: 'test-v1',
      creditValueYuanMicro: 10_000, // 0.01 元/积分
    } as any);
    const getByKey = vi.spyOn(store as any, 'getLedgerByIdempotencyKey').mockResolvedValue(null);
    const insert = vi.spyOn(store as any, 'insertLedgerAndUpdateAccount')
      .mockImplementation(async (...args: unknown[]) => ({
        id: 'ledger-fixed-1',
        createdAt: '2026-07-15T00:00:00.000Z',
        ...(args[1] as Record<string, unknown>),
      }));
    const lock = vi.spyOn(store as any, 'withAccountLock')
      .mockImplementation(async (...args: unknown[]) => {
        const fn = args[1] as (client: unknown, account: unknown) => Promise<unknown>;
        return fn({}, {
          tenantId: 'wain-test',
          balanceCreditsMicro: Math.trunc(input.balanceCreditsMicro ?? 1000 * CREDIT_MICRO),
          reservedCreditsMicro: 0,
          updatedAt: '2026-07-15T00:00:00.000Z',
        });
      });
    return { store, getByKey, insert, lock };
  }

  const baseInput = {
    tenantId: 'wain-test',
    idempotencyKey: 'debit:tool:v1:event-image',
    source: 'tool:image_gen',
    creditsMicro: 800 * CREDIT_MICRO, // 400 积分/张 × 2 张
    actualCostYuanMicro: 3_000_000,
    relatedUsageEventIds: ['usage-img'],
    note: 'GenerateImage image_gen:gpt-image-2 ×2',
  };

  it('exempts internal tenants: no ledger write at all', async () => {
    const { store, insert, lock } = fixedDebitStore({ policy: { billingMode: 'internal' } });
    await expect(store.chargeFixedDebit(baseInput)).resolves.toBeNull();
    expect(lock).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it('exempts billing-disabled tenants: no ledger write at all', async () => {
    const { store, insert, lock } = fixedDebitStore({ policy: { billingEnabled: false } });
    await expect(store.chargeFixedDebit(baseInput)).resolves.toBeNull();
    expect(lock).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it('writes a fixed-value debit with flat pricing (not cost-plus) on first charge', async () => {
    const { store, insert } = fixedDebitStore({ balanceCreditsMicro: 1000 * CREDIT_MICRO });
    const entry = await store.chargeFixedDebit(baseInput);
    expect(entry).toMatchObject({
      type: 'debit',
      source: 'tool:image_gen',
      idempotencyKey: 'debit:tool:v1:event-image',
      creditsDeltaMicro: -800 * CREDIT_MICRO,
      balanceBeforeMicro: 1000 * CREDIT_MICRO,
      balanceAfterMicro: 200 * CREDIT_MICRO,
      // 固定面值：revenue = 800 积分 × 0.01 元 = 8 元；毛利审计对生图同样生效
      revenueYuanMicro: 8_000_000,
      actualCostYuanMicro: 3_000_000,
      grossProfitYuanMicro: 5_000_000,
      relatedUsageEventIds: ['usage-img'],
      pricingVersion: 'test-v1',
    });
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('is idempotent on replay: the anchored key returns the existing entry without a second insert', async () => {
    // 投影重跑 / runtime_events 归档重放（rebuildFromJsonl）场景：
    // 幂等键锚定 eventId → 第二次投影拿回首笔 ledger，绝不重复扣。
    const { store, getByKey, insert } = fixedDebitStore();
    const first = await store.chargeFixedDebit(baseInput);
    expect(first).not.toBeNull();
    expect(insert).toHaveBeenCalledTimes(1);

    getByKey.mockResolvedValue(first);
    const replay = await store.chargeFixedDebit(baseInput);
    expect(replay).toBe(first);
    expect(insert).toHaveBeenCalledTimes(1); // 无第二次落账
  });

  it('still charges into negative when generation already happened (warn, not throw)', async () => {
    // 并发穿透容忍度与 token 路径一致：外部成本已发生，不回滚，事后由 audit 暴露。
    const warn = vi.fn();
    const { store } = fixedDebitStore({ balanceCreditsMicro: 100 * CREDIT_MICRO });
    (store as any).options.logger = { warn };
    const entry = await store.chargeFixedDebit(baseInput);
    expect(entry).toMatchObject({ balanceAfterMicro: -700 * CREDIT_MICRO });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('fixed debit makes tenant negative'));
  });
});

function fakeStore(input: {
  balanceCreditsMicro: number;
  reservedCreditsMicro?: number;
  policy?: Partial<TenantBillingPolicy>;
}) {
  return {
    getAccount: vi.fn(async (tenantId: string) => ({
      tenantId,
      balanceCreditsMicro: Math.trunc(input.balanceCreditsMicro),
      reservedCreditsMicro: Math.trunc(input.reservedCreditsMicro ?? 0),
      updatedAt: '2026-06-28T00:00:00.000Z',
    })),
    getTenantPolicy: vi.fn(async (tenantId: string) => ({
      tenantId,
      policyVersion: 'test',
      billingEnabled: true,
      pricingVersion: 'test',
      billingMode: 'prepaid',
      defaultTargetMarginBps: 6000,
      organizationMultiplierBps: 10000,
      allowNegativeBalance: false,
      negativeLimitCreditsMicro: 0,
      lowBalanceThresholdCreditsMicro: 0,
      hardCapMode: 'none',
      showBalance: true,
      showUsageCredits: true,
      showCost: false,
      showGrossMargin: false,
      updatedBy: 'test',
      updatedAt: '2026-06-28T00:00:00.000Z',
      ...(input.policy ?? {}),
    })),
    projectRuntimeEvents: vi.fn(),
  } as any;
}
