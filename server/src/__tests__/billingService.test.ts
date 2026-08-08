import { describe, expect, it, vi } from 'vitest';

import { BillingService } from '../data/billing/service.js';
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

  it('fails closed when hard cap is enabled without an organization per-run limit', async () => {
    const service = new BillingService({
      store: fakeStore({
        balanceCreditsMicro: 100 * CREDIT_MICRO,
        policy: { hardCapMode: 'stop_before_run', maxRunCreditsMicro: undefined },
      }),
    });

    await expect(service.assertTenantCanStartRun('wain-test')).resolves.toMatchObject({
      ok: false,
      code: 'BILLING_RUN_LIMIT_NOT_CONFIGURED',
    });
  });

  it('blocks prepaid tenants when hard cap is enabled and actual balance is empty', async () => {
    const service = new BillingService({
      store: fakeStore({
        balanceCreditsMicro: 0,
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

  it('下一计费动作前严格按“投影 → 结算上一用量 → 实际额度门禁”执行', async () => {
    const order: string[] = [];
    const store = {
      getProjectionState: vi.fn(async () => 0),
      listUnprojectedRuntimeEvents: vi.fn(async () => []),
      setProjectionState: vi.fn(async () => undefined),
      settleRunDebit: vi.fn(async () => { order.push('settle'); return null; }),
      authorizeRun: vi.fn(async () => { order.push('authorize-run'); return { ok: true }; }),
      authorizeFixedFee: vi.fn(async () => { order.push('authorize-fixed'); return { ok: true }; }),
    };
    const service = new BillingService({ store: store as any });
    vi.spyOn(service, 'projectRuntimeEvents').mockImplementation(async () => {
      order.push('project');
      return { usageEventsInserted: 0, debitEntriesInserted: 0, lastProjectedSequence: 0 };
    });

    await service.authorizeRun({ tenantId: 'tenant-1', userId: 'user-1', runId: 'run-1' });
    expect(order).toEqual(['project', 'settle', 'authorize-run']);

    order.length = 0;
    await service.authorizeFixedFee({
      tenantId: 'tenant-1', userId: 'user-1', runId: 'run-1', creditsMicro: 400 * CREDIT_MICRO,
    });
    expect(order).toEqual(['project', 'settle', 'authorize-fixed']);
  });

  it('defers hard-cap decisions to raw dispatch so Steering/resume use the real Run context', async () => {
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

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(events).toEqual([{ type: 'assistant_message', message: { role: 'assistant', content: 'should not run' } }]);
  });

  it('dispatch 抛错时仍异步触发实际用量投影', async () => {
    const service = new BillingService({ store: fakeStore({ balanceCreditsMicro: 100 * CREDIT_MICRO }) });
    const project = vi.spyOn(service, 'projectRuntimeEvents').mockResolvedValue({
      usageEventsInserted: 0, debitEntriesInserted: 0, lastProjectedSequence: 0,
    });
    const dispatch = vi.fn(async function* () {
      throw new Error('model failed');
    });

    await expect(async () => {
      for await (const _event of service.wrapDispatch(dispatch)(
        { type: 'message', content: 'hello' } as any,
        { user: { tenantId: 'tenant-1' } } as any,
      )) { /* no-op */ }
    }).rejects.toThrow('model failed');
    await vi.waitFor(() => expect(project).toHaveBeenCalledTimes(1));
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

  it('异步投影后立即结算实际用量，即使 Run 正等待用户交互', async () => {
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

  it('settles late usage after an earlier terminal event even when the usage row is an idempotent replay', async () => {
    const store = {
      getProjectionState: vi.fn(async () => 10),
      listUnprojectedRuntimeEvents: vi.fn(async () => [{
        globalSequence: 11,
        eventId: 'late-usage',
        eventType: 'assistant_message',
        tenantId: 'tenant-1',
        timestamp: '2026-07-07T00:10:00.000Z',
        eventJson: {
          type: 'assistant_message',
          runId: 'run-terminal',
          sessionId: 'session-1',
          model: 'glm-5.2',
          usage: { inputTokens: 1000, outputTokens: 100 },
        },
      }]),
      insertUsageEvent: vi.fn(async () => null),
      settleRunDebit: vi.fn(async () => ({ id: 'ledger-late' })),
      setProjectionState: vi.fn(async () => undefined),
    };
    const service = new BillingService({ store: store as any });

    await expect(service.projectRuntimeEvents()).resolves.toMatchObject({ usageEventsInserted: 0 });
    expect(store.settleRunDebit).toHaveBeenCalledWith('tenant-1', 'run-terminal');
  });

  it('projects compaction usage even though compaction has no assistant message', async () => {
    const store = {
      getProjectionState: vi.fn(async () => 0),
      listUnprojectedRuntimeEvents: vi.fn(async () => [{
        globalSequence: 1,
        eventId: 'compact-usage',
        eventType: 'compaction_usage',
        tenantId: 'tenant-1',
        timestamp: '2026-07-07T00:00:00.000Z',
        eventJson: {
          type: 'compaction_usage',
          runId: 'run-compact',
          sessionId: 'session-1',
          model: 'glm-5.2',
          usage: { inputTokens: 2000, outputTokens: 200 },
        },
      }]),
      insertUsageEvent: vi.fn(async () => ({ id: 'usage-compact' })),
      settleRunDebit: vi.fn(async () => ({ id: 'ledger-compact' })),
      setProjectionState: vi.fn(async () => undefined),
    };
    const service = new BillingService({ store: store as any });

    await expect(service.projectRuntimeEvents()).resolves.toMatchObject({ usageEventsInserted: 1 });
    expect(store.insertUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-compact',
      modelValue: 'glm-5.2',
    }));
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
      settleRunDebit: vi.fn(async () => ({ id: 'ledger-vision' })),
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
      settleRunDebit: vi.fn(async () => ({ id: 'ledger-success' })),
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

describe('BillingService utility 模型 Run', () => {
  function utilityStore(overrides: Record<string, unknown> = {}) {
    return {
      getProjectionState: vi.fn(async () => 0),
      listUnprojectedRuntimeEvents: vi.fn(async () => []),
      setProjectionState: vi.fn(async () => undefined),
      authorizeRun: vi.fn(async () => ({ ok: true })),
      insertUsageEvent: vi.fn(async (input: Record<string, unknown>) => ({ id: 'usage-utility', ...input })),
      settleRunDebit: vi.fn(async () => null),
      ...overrides,
    };
  }

  it('每个 fallback 调用前先结算上一调用并重检，逐次写 usage', async () => {
    const store = utilityStore();
    const service = new BillingService({ store: store as any });
    const run = await service.beginUtilityModelRun({
      tenantId: 'tenant-1', userId: 'user-1', username: 'alice', sessionId: 'session-1', channel: 'title',
    });

    await run.beforeModelCall();
    await run.recordUsage('title-main', { inputTokens: 10, outputTokens: 2, apiRequestCount: 1 });
    await run.beforeModelCall();
    await run.recordUsage('title-fallback', { inputTokens: 8, outputTokens: 1, apiRequestCount: 1 });
    await run.finalize();
    await run.finalize();

    expect(store.authorizeRun).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-1', userId: 'user-1', runId: run.runId,
    }));
    expect(store.authorizeRun).toHaveBeenCalledTimes(3);
    expect(store.insertUsageEvent.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ modelValue: 'title-main', requestIndex: 1, runId: run.runId }),
      expect.objectContaining({ modelValue: 'title-fallback', requestIndex: 2, runId: run.runId }),
    ]);
    expect(store.settleRunDebit).toHaveBeenCalledTimes(4);
  });

  it('启动或逐轮实际用量门禁拒绝时阻止 utility 模型调用', async () => {
    const deniedStart = utilityStore({
      authorizeRun: vi.fn(async () => ({ ok: false, code: 'BILLING_ORG_BALANCE_EXHAUSTED', reason: '余额不足' })),
    });
    await expect(new BillingService({ store: deniedStart as any }).beginUtilityModelRun({
      tenantId: 'tenant-1', username: 'alice', channel: 'guardrail',
    })).rejects.toThrow(/BILLING_ORG_BALANCE_EXHAUSTED.*余额不足/);

    const authorizeRun = vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, code: 'BILLING_RUN_LIMIT_EXCEEDED', reason: 'Run 上限' });
    const deniedTurn = utilityStore({ authorizeRun });
    const run = await new BillingService({ store: deniedTurn as any }).beginUtilityModelRun({
      tenantId: 'tenant-1', username: 'alice', channel: 'guardrail',
    });
    await expect(run.beforeModelCall()).rejects.toThrow(/BILLING_RUN_LIMIT_EXCEEDED.*Run 上限/);
    await run.finalize();
    expect(deniedTurn.insertUsageEvent).not.toHaveBeenCalled();
  });
});

function fakeStore(input: {
  balanceCreditsMicro: number;
  policy?: Partial<TenantBillingPolicy>;
}) {
  return {
    getAccount: vi.fn(async (tenantId: string) => ({
      tenantId,
      balanceCreditsMicro: Math.trunc(input.balanceCreditsMicro),
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
      maxRunCreditsMicro: 1000 * CREDIT_MICRO,
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
