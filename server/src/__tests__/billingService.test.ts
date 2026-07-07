import { describe, expect, it, vi } from 'vitest';

import { BillingService } from '../data/billing/service.js';
import { CREDIT_MICRO, type TenantBillingPolicy } from '../data/billing/types.js';

describe('BillingService hard cap guard', () => {
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
