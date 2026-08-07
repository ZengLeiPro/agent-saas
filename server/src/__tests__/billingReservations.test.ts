import { describe, expect, it, vi } from 'vitest';

import { PgBillingStore } from '../data/billing/pgBillingStore.js';
import { CREDIT_MICRO, type TenantBillingPolicy } from '../data/billing/types.js';

interface AccountRow {
  tenant_id: string;
  balance_micro: number;
  reserved_micro: number;
  updated_at: string;
}

interface BudgetRow {
  tenant_id: string;
  user_id: string;
  monthly_limit_micro: number | null;
  enforcement_mode: 'notify' | 'stop_new_runs';
  per_run_limit_micro: number | null;
  active: boolean;
  version: number;
}

interface PeriodRow {
  tenant_id: string;
  user_id: string;
  period_start: string;
  used_micro: number;
  reserved_micro: number;
  updated_at: string;
}

interface ReservationRow {
  tenant_id: string;
  run_id: string;
  user_id: string | null;
  username_snapshot: string | null;
  session_id: string | null;
  period_start: string;
  granted_micro: number;
  remaining_micro: number;
  status: 'active' | 'settled' | 'released' | 'expired';
  created_at: string;
  updated_at: string;
  released_at: string | null;
}

interface HoldRow {
  tenant_id: string;
  run_id: string;
  hold_key: string;
  credits_micro: number;
  status: 'active' | 'captured' | 'released';
  created_at: string;
  updated_at: string;
}

class RowLock {
  private locked = false;
  private waiters: Array<() => void> = [];

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.locked = false;
  }
}

class ReservationPg {
  accounts = new Map<string, AccountRow>();
  budgets = new Map<string, BudgetRow>();
  periods = new Map<string, PeriodRow>();
  reservations = new Map<string, ReservationRow>();
  holds = new Map<string, HoldRow>();
  ledger: Array<Record<string, unknown>> = [];
  private locks = new Map<string, RowLock>();

  private accountLock(tenantId: string): RowLock {
    let lock = this.locks.get(tenantId);
    if (!lock) {
      lock = new RowLock();
      this.locks.set(tenantId, lock);
    }
    return lock;
  }

  query = async (sql: string, params: unknown[] = []): Promise<{ rows: any[] }> => this.exec(sql, params);

  connect = async (): Promise<any> => {
    let heldTenant: string | null = null;
    const release = () => {
      if (!heldTenant) return;
      this.accountLock(heldTenant).release();
      heldTenant = null;
    };
    return {
      query: async (sql: string, params: unknown[] = []) => {
        if (/^\s*BEGIN/i.test(sql)) return { rows: [] };
        if (/^\s*(COMMIT|ROLLBACK)/i.test(sql)) {
          release();
          return { rows: [] };
        }
        if (/FOR UPDATE/i.test(sql) && /credit_accounts/i.test(sql)) {
          const tenantId = String(params[0]);
          await this.accountLock(tenantId).acquire();
          heldTenant = tenantId;
        }
        return this.exec(sql, params);
      },
      release,
    };
  };

  private exec(sql: string, params: unknown[]): { rows: any[] } {
    if (/pg_advisory_xact_lock/i.test(sql)) return { rows: [] };

    if (/INSERT INTO\s+\S*credit_accounts/i.test(sql)) {
      const tenantId = String(params[0]);
      if (!this.accounts.has(tenantId)) {
        this.accounts.set(tenantId, {
          tenant_id: tenantId,
          balance_micro: 0,
          reserved_micro: 0,
          updated_at: String(params[1]),
        });
      }
      return { rows: [] };
    }

    if (/FROM\s+\S*credit_accounts\s+a/i.test(sql) && /row_to_json/i.test(sql)) {
      const row = this.accounts.get(String(params[0]));
      return { rows: row ? [{ row_json: { ...row } }] : [] };
    }

    if (/UPDATE\s+\S*credit_accounts/i.test(sql) && /reserved_micro\s*=\s*reserved_micro\s*\+/i.test(sql)) {
      const row = this.accounts.get(String(params[0]));
      if (row) {
        row.reserved_micro += Number(params[1]);
        row.updated_at = String(params[2]);
      }
      return { rows: [] };
    }

    if (/UPDATE\s+\S*credit_accounts/i.test(sql) && /reserved_micro\s*=\s*GREATEST/i.test(sql)) {
      const row = this.accounts.get(String(params[0]));
      if (row) {
        row.reserved_micro = Math.max(0, row.reserved_micro - Number(params[1]));
        row.updated_at = String(params[2]);
      }
      return { rows: [] };
    }

    if (/UPDATE\s+\S*credit_accounts/i.test(sql) && /SET\s+balance_micro\s*=\s*\$2/i.test(sql)) {
      const row = this.accounts.get(String(params[0]));
      if (row) {
        row.balance_micro = Number(params[1]);
        row.updated_at = String(params[2]);
      }
      return { rows: [] };
    }

    if (/FROM\s+\S*member_budgets\s+b/i.test(sql) && /row_to_json/i.test(sql)) {
      const row = this.budgets.get(`${params[0]}:${params[1]}`);
      return { rows: row ? [{ row_json: { ...row } }] : [] };
    }

    if (/SELECT\s+1\s+FROM\s+\S*member_budgets/i.test(sql)) {
      return { rows: this.budgets.has(`${params[0]}:${params[1]}`) ? [{ '?column?': 1 }] : [] };
    }

    if (/INSERT INTO\s+\S*member_period_accounts/i.test(sql)) {
      const key = `${params[0]}:${params[1]}:${params[2]}`;
      if (!this.periods.has(key)) {
        this.periods.set(key, {
          tenant_id: String(params[0]),
          user_id: String(params[1]),
          period_start: String(params[2]),
          used_micro: 0,
          reserved_micro: 0,
          updated_at: String(params[3]),
        });
      }
      return { rows: [] };
    }

    if (/FROM\s+\S*member_period_accounts\s+p/i.test(sql) && /row_to_json/i.test(sql)) {
      const row = this.periods.get(`${params[0]}:${params[1]}:${params[2]}`);
      return { rows: row ? [{ row_json: { ...row } }] : [] };
    }

    if (/SELECT\s+1\s+FROM\s+\S*member_period_accounts/i.test(sql)) {
      return { rows: this.periods.has(`${params[0]}:${params[1]}:${params[2]}`) ? [{ '?column?': 1 }] : [] };
    }

    if (/UPDATE\s+\S*member_period_accounts/i.test(sql) && /reserved_micro\s*=\s*reserved_micro\s*\+/i.test(sql)) {
      const row = this.periods.get(`${params[0]}:${params[1]}:${params[2]}`);
      if (row) {
        row.reserved_micro += Number(params[3]);
        row.updated_at = String(params[4]);
      }
      return { rows: [] };
    }

    if (/SELECT\s+user_id,\s*period_start\s+FROM\s+\S*run_reservations/i.test(sql)) {
      const row = this.reservations.get(`${params[0]}:${params[1]}`);
      return { rows: row ? [{ user_id: row.user_id, period_start: row.period_start }] : [] };
    }

    if (/FROM\s+\S*run_reservations\s+r/i.test(sql) && /row_to_json/i.test(sql)) {
      const row = this.reservations.get(`${params[0]}:${params[1]}`);
      return { rows: row ? [{ row_json: { ...row } }] : [] };
    }

    if (/UPDATE\s+\S*run_reservations/i.test(sql) && /remaining_micro\s*=\s*GREATEST/i.test(sql)) {
      const row = this.reservations.get(`${params[0]}:${params[1]}`);
      if (row?.status === 'active') {
        row.remaining_micro = Math.max(0, row.remaining_micro - Number(params[2]));
        row.updated_at = String(params[3]);
      }
      return { rows: [] };
    }

    if (/INSERT INTO\s+\S*run_reservations/i.test(sql)) {
      const row: ReservationRow = {
        tenant_id: String(params[0]),
        run_id: String(params[1]),
        user_id: params[2] == null ? null : String(params[2]),
        username_snapshot: params[3] == null ? null : String(params[3]),
        session_id: params[4] == null ? null : String(params[4]),
        period_start: String(params[5]),
        granted_micro: Number(params[6]),
        remaining_micro: Number(params[6]),
        status: 'active',
        created_at: String(params[7]),
        updated_at: String(params[7]),
        released_at: null,
      };
      this.reservations.set(`${row.tenant_id}:${row.run_id}`, row);
      return { rows: [{ row_json: { ...row } }] };
    }

    if (/FROM\s+\S*run_fixed_fee_holds\s+h/i.test(sql) && /row_to_json/i.test(sql)) {
      const row = this.holds.get(`${params[0]}:${params[1]}:${params[2]}`);
      return { rows: row ? [{ row_json: { ...row } }] : [] };
    }

    if (/SUM\(credits_micro\)/i.test(sql) && /run_fixed_fee_holds/i.test(sql)) {
      const amount = [...this.holds.values()]
        .filter((row) => row.tenant_id === params[0] && row.run_id === params[1] && row.status === 'active')
        .reduce((sum, row) => sum + row.credits_micro, 0);
      return { rows: [{ total_micro: String(amount) }] };
    }

    if (/UPDATE\s+\S*run_fixed_fee_holds/i.test(sql) && /SET\s+status\s*=\s*'active'/i.test(sql)) {
      const row = this.holds.get(`${params[0]}:${params[1]}:${params[2]}`);
      if (!row || row.status !== 'released') return { rows: [] };
      row.status = 'active';
      row.updated_at = String(params[3]);
      return { rows: [{ row_json: { ...row } }] };
    }

    if (/UPDATE\s+\S*run_fixed_fee_holds/i.test(sql) && /SET\s+status\s*=\s*'captured'/i.test(sql)) {
      const row = this.holds.get(`${params[0]}:${params[1]}:${params[2]}`);
      if (row?.status === 'active' || row?.status === 'released') {
        row.status = 'captured';
        row.updated_at = String(params[3]);
      }
      return { rows: [] };
    }

    if (/INSERT INTO\s+\S*run_fixed_fee_holds/i.test(sql)) {
      const row: HoldRow = {
        tenant_id: String(params[0]),
        run_id: String(params[1]),
        hold_key: String(params[2]),
        credits_micro: Number(params[3]),
        status: 'active',
        created_at: String(params[4]),
        updated_at: String(params[4]),
      };
      this.holds.set(`${row.tenant_id}:${row.run_id}:${row.hold_key}`, row);
      return { rows: [{ row_json: { ...row } }] };
    }

    if (/FROM\s+\S*credit_ledger\s+l\s+WHERE\s+idempotency_key/i.test(sql)) {
      const row = this.ledger.find((entry) => entry.idempotency_key === params[0]);
      return { rows: row ? [{ row_json: { ...row } }] : [] };
    }

    if (/INSERT INTO\s+\S*credit_ledger/i.test(sql)) {
      const row = {
        id: String(params[0]), idempotency_key: String(params[1]), tenant_id: String(params[2]),
        account_id: String(params[3]), type: String(params[4]), source: String(params[5]),
        related_usage_event_ids: params[6], user_id: params[7], username_snapshot: params[8],
        session_id: params[9], run_id: params[10], message_id: params[11],
        credits_delta_micro: Number(params[12]), balance_before_micro: Number(params[13]),
        balance_after_micro: Number(params[14]), credit_value_yuan_micro: Number(params[15]),
        revenue_yuan_micro: Number(params[16]), actual_cost_yuan_micro: Number(params[17]),
        gross_profit_yuan_micro: Number(params[18]), gross_margin_bps: params[19],
        pricing_version: String(params[20]), billing_policy_version: String(params[21]),
        note: params[22], created_by: params[23], created_at: String(params[24]),
      };
      this.ledger.push(row);
      return { rows: [{ row_json: { ...row } }] };
    }

    if (/unnest\(related_usage_event_ids\)/i.test(sql)) return { rows: [] };
    if (/FROM\s+\S*usage_events\s+u/i.test(sql)) return { rows: [] };

    throw new Error(`ReservationPg: unhandled SQL: ${sql.replace(/\s+/g, ' ').slice(0, 180)}`);
  }
}

function policy(overrides: Partial<TenantBillingPolicy> = {}): TenantBillingPolicy {
  return {
    tenantId: 'tenant-a',
    policyVersion: 'policy-v1',
    billingEnabled: true,
    pricingVersion: 'price-v1',
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
    updatedAt: '2026-08-07T00:00:00.000Z',
    ...overrides,
  };
}

function makeStore(fake: ReservationPg, policyOverrides: Partial<TenantBillingPolicy> = {}) {
  const store = new PgBillingStore({ pool: fake as any });
  vi.spyOn(store, 'getTenantPolicy').mockResolvedValue(policy(policyOverrides));
  vi.spyOn(store, 'getActivePricingVersion').mockResolvedValue({
    version: 'price-v1',
    creditValueYuanMicro: 10_000,
  } as any);
  fake.accounts.set('tenant-a', {
    tenant_id: 'tenant-a',
    balance_micro: 100 * CREDIT_MICRO,
    reserved_micro: 0,
    updated_at: '2026-08-07T00:00:00.000Z',
  });
  return store;
}

describe('Run reservation 双层并发门禁', () => {
  it('硬封顶未配置单 Run 上限时 fail-closed，不让首个 Run 独占全部余额', async () => {
    const fake = new ReservationPg();
    const store = makeStore(fake);

    const decision = await store.ensureRunReservation({ tenantId: 'tenant-a', runId: 'uncapped-run-1' });

    expect(decision).toMatchObject({ ok: false, code: 'BILLING_RUN_LIMIT_NOT_CONFIGURED' });
    expect(fake.accounts.get('tenant-a')?.reserved_micro).toBe(0);
    expect(fake.reservations).toHaveLength(0);
  });

  it('并发 Run 共享组织余额时由账户锁串行预占，不会共同透支', async () => {
    const fake = new ReservationPg();
    const store = makeStore(fake, { maxRunCreditsMicro: 80 * CREDIT_MICRO });

    const decisions = await Promise.all([
      store.ensureRunReservation({ tenantId: 'tenant-a', runId: 'run-1' }),
      store.ensureRunReservation({ tenantId: 'tenant-a', runId: 'run-2' }),
    ]);

    expect(decisions.every((decision) => decision.ok)).toBe(true);
    const grants = decisions
      .map((decision) => decision.ok ? decision.value?.grantedCreditsMicro ?? -1 : -1)
      .sort((a, b) => a - b);
    expect(grants).toEqual([20 * CREDIT_MICRO, 80 * CREDIT_MICRO]);
    expect(fake.accounts.get('tenant-a')?.reserved_micro).toBe(100 * CREDIT_MICRO);

    const third = await store.ensureRunReservation({ tenantId: 'tenant-a', runId: 'run-3' });
    expect(third).toMatchObject({ ok: false, code: 'BILLING_ORG_BALANCE_EXHAUSTED' });
  });

  it('员工月额度与单 Run 上限取最小值，并阻止第二个并发 Run 透支月额度', async () => {
    const fake = new ReservationPg();
    const store = makeStore(fake, { maxRunCreditsMicro: 100 * CREDIT_MICRO });
    fake.budgets.set('tenant-a:user-1', {
      tenant_id: 'tenant-a',
      user_id: 'user-1',
      monthly_limit_micro: 60 * CREDIT_MICRO,
      enforcement_mode: 'stop_new_runs',
      per_run_limit_micro: 50 * CREDIT_MICRO,
      active: true,
      version: 1,
    });
    const periodStart = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 8) + '01';
    fake.periods.set(`tenant-a:user-1:${periodStart}`, {
      tenant_id: 'tenant-a',
      user_id: 'user-1',
      period_start: periodStart,
      used_micro: 20 * CREDIT_MICRO,
      reserved_micro: 0,
      updated_at: '2026-08-07T00:00:00.000Z',
    });

    const first = await store.ensureRunReservation({ tenantId: 'tenant-a', userId: 'user-1', runId: 'member-run-1' });
    const second = await store.ensureRunReservation({ tenantId: 'tenant-a', userId: 'user-1', runId: 'member-run-2' });

    expect(first.ok && first.value?.grantedCreditsMicro).toBe(40 * CREDIT_MICRO);
    expect(second).toMatchObject({ ok: false, code: 'BILLING_MEMBER_MONTHLY_LIMIT_EXCEEDED' });
    expect(fake.periods.get(`tenant-a:user-1:${periodStart}`)?.reserved_micro).toBe(40 * CREDIT_MICRO);
  });

  it('同一 Run 的重放返回原 reservation，不会重复增加 reserved', async () => {
    const fake = new ReservationPg();
    const store = makeStore(fake, { maxRunCreditsMicro: 30 * CREDIT_MICRO });

    const first = await store.ensureRunReservation({ tenantId: 'tenant-a', runId: 'same-run' });
    const replay = await store.ensureRunReservation({ tenantId: 'tenant-a', runId: 'same-run' });

    expect(first.ok && replay.ok && replay.value?.grantedCreditsMicro).toBe(30 * CREDIT_MICRO);
    expect(fake.accounts.get('tenant-a')?.reserved_micro).toBe(30 * CREDIT_MICRO);
    expect(fake.reservations).toHaveLength(1);
  });

  it('已结算或释放的 reservation 不能被恢复路径复用', async () => {
    const fake = new ReservationPg();
    const store = makeStore(fake, { maxRunCreditsMicro: 30 * CREDIT_MICRO });
    await store.ensureRunReservation({ tenantId: 'tenant-a', runId: 'finished-run' });
    fake.reservations.get('tenant-a:finished-run')!.status = 'settled';

    await expect(store.ensureRunReservation({ tenantId: 'tenant-a', runId: 'finished-run' }))
      .resolves.toMatchObject({ ok: false, code: 'BILLING_RESERVATION_NOT_ACTIVE' });
    await expect(store.assertRunCanContinue('tenant-a', 'finished-run'))
      .resolves.toMatchObject({ ok: false, code: 'BILLING_RESERVATION_NOT_ACTIVE' });
  });

  it('固定费用 hold 幂等占用 Run 剩余额度，冲突或超额时在外部调用前拒绝', async () => {
    const fake = new ReservationPg();
    const store = makeStore(fake, { maxRunCreditsMicro: 40 * CREDIT_MICRO });
    await store.ensureRunReservation({ tenantId: 'tenant-a', runId: 'image-run' });

    const first = await store.reserveFixedFeeHold({ tenantId: 'tenant-a', runId: 'image-run', holdKey: 'image:1', creditsMicro: 25 * CREDIT_MICRO });
    const replay = await store.reserveFixedFeeHold({ tenantId: 'tenant-a', runId: 'image-run', holdKey: 'image:1', creditsMicro: 25 * CREDIT_MICRO });
    const conflict = await store.reserveFixedFeeHold({ tenantId: 'tenant-a', runId: 'image-run', holdKey: 'image:1', creditsMicro: 30 * CREDIT_MICRO });
    const exceeds = await store.reserveFixedFeeHold({ tenantId: 'tenant-a', runId: 'image-run', holdKey: 'image:2', creditsMicro: 20 * CREDIT_MICRO });
    const exact = await store.reserveFixedFeeHold({ tenantId: 'tenant-a', runId: 'image-run', holdKey: 'image:2', creditsMicro: 15 * CREDIT_MICRO });

    expect(first.ok && replay.ok).toBe(true);
    expect(conflict).toMatchObject({ ok: false, code: 'BILLING_HOLD_CONFLICT' });
    expect(exceeds).toMatchObject({ ok: false, code: 'BILLING_FIXED_FEE_LIMIT_EXCEEDED' });
    expect(exact.ok).toBe(true);
    expect([...fake.holds.values()].reduce((sum, row) => sum + row.credits_micro, 0)).toBe(40 * CREDIT_MICRO);

    const continueDecision = await store.assertRunCanContinue('tenant-a', 'image-run');
    expect(continueDecision).toMatchObject({ ok: false, code: 'BILLING_RUN_LIMIT_EXCEEDED' });
  });

  it('固定费用实际金额可小于 hold，按实际金额 capture 并保留剩余 Run 额度', async () => {
    const fake = new ReservationPg();
    const store = makeStore(fake, { maxRunCreditsMicro: 40 * CREDIT_MICRO });
    await store.ensureRunReservation({ tenantId: 'tenant-a', runId: 'partial-image-run' });
    await store.reserveFixedFeeHold({
      tenantId: 'tenant-a', runId: 'partial-image-run', holdKey: 'image:partial', creditsMicro: 40 * CREDIT_MICRO,
    });

    const entry = await store.chargeFixedDebit({
      tenantId: 'tenant-a',
      idempotencyKey: 'debit:image:partial',
      source: 'tool:image_gen',
      creditsMicro: 20 * CREDIT_MICRO,
      actualCostYuanMicro: 30_000,
      runId: 'partial-image-run',
      holdKey: 'image:partial',
    });

    expect(entry).not.toBeNull();
    expect(entry!.creditsDeltaMicro).toBe(-20 * CREDIT_MICRO);
    expect(fake.holds.get('tenant-a:partial-image-run:image:partial')?.status).toBe('captured');
    expect(fake.reservations.get('tenant-a:partial-image-run')?.remaining_micro).toBe(20 * CREDIT_MICRO);
    expect(fake.accounts.get('tenant-a')).toMatchObject({
      balance_micro: 80 * CREDIT_MICRO,
      reserved_micro: 20 * CREDIT_MICRO,
    });
  });

  it('固定费用实际金额超过 hold 时拒绝扣费', async () => {
    const fake = new ReservationPg();
    const store = makeStore(fake, { maxRunCreditsMicro: 40 * CREDIT_MICRO });
    await store.ensureRunReservation({ tenantId: 'tenant-a', runId: 'over-capture-run' });
    await store.reserveFixedFeeHold({
      tenantId: 'tenant-a', runId: 'over-capture-run', holdKey: 'image:over', creditsMicro: 20 * CREDIT_MICRO,
    });

    await expect(store.chargeFixedDebit({
      tenantId: 'tenant-a',
      idempotencyKey: 'debit:image:over',
      source: 'tool:image_gen',
      creditsMicro: 30 * CREDIT_MICRO,
      actualCostYuanMicro: 30_000,
      runId: 'over-capture-run',
      holdKey: 'image:over',
    })).rejects.toThrow(/实际金额超过预留金额/);
    expect(fake.holds.get('tenant-a:over-capture-run:image:over')?.status).toBe('active');
    expect(fake.ledger).toHaveLength(0);
  });

  it('durable 固定费事件可补 capture 已被终态清理释放的 hold', async () => {
    const fake = new ReservationPg();
    const store = makeStore(fake, { maxRunCreditsMicro: 40 * CREDIT_MICRO });
    await store.ensureRunReservation({ tenantId: 'tenant-a', runId: 'late-metered-run' });
    await store.reserveFixedFeeHold({
      tenantId: 'tenant-a', runId: 'late-metered-run', holdKey: 'image:late', creditsMicro: 20 * CREDIT_MICRO,
    });
    fake.holds.get('tenant-a:late-metered-run:image:late')!.status = 'released';
    fake.reservations.get('tenant-a:late-metered-run')!.status = 'settled';
    fake.reservations.get('tenant-a:late-metered-run')!.remaining_micro = 0;
    fake.accounts.get('tenant-a')!.reserved_micro = 0;

    await store.chargeFixedDebit({
      tenantId: 'tenant-a', idempotencyKey: 'debit:image:late', source: 'tool:image_gen',
      creditsMicro: 10 * CREDIT_MICRO, actualCostYuanMicro: 20_000,
      runId: 'late-metered-run', holdKey: 'image:late',
    });

    expect(fake.holds.get('tenant-a:late-metered-run:image:late')?.status).toBe('captured');
    expect(fake.accounts.get('tenant-a')).toMatchObject({
      balance_micro: 90 * CREDIT_MICRO,
      reserved_micro: 0,
    });
  });

  it('released hold 可按原金额重新预占，captured hold 禁止再次调用外部服务', async () => {
    const fake = new ReservationPg();
    const store = makeStore(fake, { maxRunCreditsMicro: 40 * CREDIT_MICRO });
    await store.ensureRunReservation({ tenantId: 'tenant-a', runId: 'retry-run' });
    await store.reserveFixedFeeHold({
      tenantId: 'tenant-a', runId: 'retry-run', holdKey: 'image:retry', creditsMicro: 20 * CREDIT_MICRO,
    });
    const hold = fake.holds.get('tenant-a:retry-run:image:retry')!;
    hold.status = 'released';

    const reactivated = await store.reserveFixedFeeHold({
      tenantId: 'tenant-a', runId: 'retry-run', holdKey: 'image:retry', creditsMicro: 20 * CREDIT_MICRO,
    });
    expect(reactivated.ok && reactivated.value?.status).toBe('active');

    hold.status = 'captured';
    const duplicate = await store.reserveFixedFeeHold({
      tenantId: 'tenant-a', runId: 'retry-run', holdKey: 'image:retry', creditsMicro: 20 * CREDIT_MICRO,
    });
    expect(duplicate).toMatchObject({ ok: false, code: 'BILLING_HOLD_CONFLICT' });
  });
});
