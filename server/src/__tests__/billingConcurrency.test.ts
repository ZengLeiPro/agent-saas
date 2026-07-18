import { describe, expect, it, vi } from 'vitest';

import { PgBillingStore } from '../data/billing/pgBillingStore.js';
import { CREDIT_MICRO, type TenantBillingPolicy } from '../data/billing/types.js';

/**
 * 计费并发回归测试（B2 settleRunDebit / B1 insertUsageEvent 投影去重）。
 *
 * 背景（见 assets/20260718/核实-计费并发多扣.md）：
 *   - 当前**不会**多扣客户钱。真正的闭合点不是 UNIQUE(idempotency_key)，
 *     而是 `listDebitedUsageEventIds` 在账户行 FOR UPDATE 事务【内】按
 *     related_usage_event_ids 反查、对已扣 usage_event 串行去重。
 *   - 幂等键会漂移（`debit:usage:v1:${runId}:${sha1(sorted pending ids)}`），
 *     不同 pending 子集 → 不同 key，所以 UNIQUE 兜不住——但也不需要它兜。
 *   - B1 usage 层的闭合是真的：`insertUsageEvent` 用稳定幂等键
 *     `usage:event:v1:${eventId}` + `ON CONFLICT (idempotency_key) DO NOTHING`。
 *
 * 本文件补的是【防回归 + 固化隐性闭合】：
 *   ① 固化"幂等键会漂移"这一事实（说明为何不能只靠 UNIQUE(idempotency_key)）；
 *   ② 固化 B1 usage 层 ON CONFLICT 去重（重复 eventId 只落一条）；
 *   ③ 固化 B2 串行去重闭合——【不】spy 掉 listDebitedUsageEventIds（那正是闭合层），
 *      用能反映"锁内串行去重"的可控内存 client 跑真实 settleRunDebit 事务体。
 *
 * 隔离手段：可控内存 pg 假实现（FakePg），实现了 credit_accounts 的
 * 账户行 FOR UPDATE 串行互斥、credit_ledger 的 UNIQUE(idempotency_key)、
 * usage_events 的 ON CONFLICT(idempotency_key) DO NOTHING、以及
 * unnest(related_usage_event_ids) 反查。**没有**用真 PG / testcontainers。
 * 需要真实 FOR UPDATE 行锁阻塞语义的用例见文件末尾 describe.skip 集成骨架。
 */

// ---------------------------------------------------------------------------
// 可控内存 pg 假实现
// ---------------------------------------------------------------------------

interface UsageRow {
  id: string;
  idempotency_key: string;
  tenant_id: string;
  run_id: string | null;
  session_id: string | null;
  billable: boolean;
  actual_cost_yuan_micro: number;
  created_at: string;
  // normalizeUsageEvent 读取的其余字段（给足默认值即可通过 normalize）
  [k: string]: unknown;
}

interface LedgerRow {
  id: string;
  idempotency_key: string;
  tenant_id: string;
  run_id: string | null;
  type: string;
  source: string;
  related_usage_event_ids: string[];
  [k: string]: unknown;
}

interface AccountRow {
  tenant_id: string;
  balance_micro: number;
  reserved_micro: number;
  updated_at: string;
}

/**
 * 每租户账户行的串行锁：模拟 SELECT ... FOR UPDATE 只有一个事务能持有，
 * 直到 COMMIT/ROLLBACK 才释放。这是 B2 闭合的核心——把它做成真实互斥，
 * 才能验证"第二个进锁者一定看到第一个已提交的 debit"。
 */
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
    if (next) {
      next(); // 锁保持 locked，直接移交给下一个 waiter
    } else {
      this.locked = false;
    }
  }
}

class FakePg {
  usageEvents: UsageRow[] = [];
  ledger: LedgerRow[] = [];
  accounts = new Map<string, AccountRow>();
  private locks = new Map<string, RowLock>();

  private lockFor(tenantId: string): RowLock {
    let l = this.locks.get(tenantId);
    if (!l) {
      l = new RowLock();
      this.locks.set(tenantId, l);
    }
    return l;
  }

  // pool.query —— 无事务的直连查询（insertUsageEvent / listUsageEvents / ensureAccount）
  query = async (sql: string, params: unknown[] = []): Promise<{ rows: any[] }> => {
    return this.exec(sql, params, null);
  };

  // pool.connect —— 返回一个事务客户端，BEGIN 会尝试独占该租户账户行锁
  connect = async (): Promise<any> => {
    let heldTenant: string | null = null;
    const release = () => {
      if (heldTenant) {
        this.lockFor(heldTenant).release();
        heldTenant = null;
      }
    };
    const client = {
      query: async (sql: string, params: unknown[] = []): Promise<{ rows: any[] }> => {
        if (/^\s*BEGIN/i.test(sql)) return { rows: [] };
        if (/^\s*COMMIT/i.test(sql)) { release(); return { rows: [] }; }
        if (/^\s*ROLLBACK/i.test(sql)) { release(); return { rows: [] }; }
        // SELECT ... FOR UPDATE：拿锁（模拟行锁阻塞）
        if (/FOR UPDATE/i.test(sql)) {
          const tenantId = String(params[0]);
          await this.lockFor(tenantId).acquire();
          heldTenant = tenantId;
        }
        return this.exec(sql, params, client);
      },
      release: () => { release(); },
    };
    return client;
  };

  private exec(sql: string, params: unknown[], _client: unknown): { rows: any[] } {
    // -- ensureAccount: INSERT INTO ..._credit_accounts ... ON CONFLICT DO NOTHING
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

    // -- withAccountLock: SELECT row_to_json(a.*) ... FROM ..._credit_accounts a WHERE tenant_id=$1 FOR UPDATE
    if (/FROM\s+\S*credit_accounts/i.test(sql) && /row_to_json/i.test(sql)) {
      const tenantId = String(params[0]);
      const acc = this.accounts.get(tenantId);
      return { rows: acc ? [{ row_json: { ...acc } }] : [] };
    }

    // -- insertLedgerAndUpdateAccount UPDATE balance
    if (/UPDATE\s+\S*credit_accounts/i.test(sql)) {
      const tenantId = String(params[0]);
      const acc = this.accounts.get(tenantId);
      if (acc) {
        acc.balance_micro = Number(params[1]);
        acc.updated_at = String(params[2]);
      }
      return { rows: [] };
    }

    // -- getLedgerByIdempotencyKey: SELECT ... FROM ..._credit_ledger l WHERE idempotency_key=$1
    if (/FROM\s+\S*credit_ledger\s+l\b/i.test(sql) && /idempotency_key\s*=\s*\$1/i.test(sql)) {
      const key = String(params[0]);
      const row = this.ledger.find((r) => r.idempotency_key === key);
      return { rows: row ? [{ row_json: { ...row } }] : [] };
    }

    // -- listDebitedUsageEventIds: SELECT DISTINCT unnest(related_usage_event_ids) ... FROM ..._credit_ledger
    //    WHERE tenant_id=$1 AND run_id=$2 AND type='debit' AND source='usage_event'
    if (/unnest\(related_usage_event_ids\)/i.test(sql)) {
      const tenantId = String(params[0]);
      const runId = String(params[1]);
      const ids = new Set<string>();
      for (const r of this.ledger) {
        if (r.tenant_id === tenantId && r.run_id === runId && r.type === 'debit' && r.source === 'usage_event') {
          for (const id of r.related_usage_event_ids) ids.add(id);
        }
      }
      return { rows: [...ids].map((id) => ({ usage_event_id: id })) };
    }

    // -- insertLedgerAndUpdateAccount INSERT INTO ..._credit_ledger ... RETURNING row_to_json(...)
    if (/INSERT INTO\s+\S*credit_ledger/i.test(sql)) {
      const [
        id, idempotency_key, tenant_id, account_id, type, source, related_usage_event_ids,
        session_id, run_id, message_id, credits_delta_micro, balance_before_micro, balance_after_micro,
        credit_value_yuan_micro, revenue_yuan_micro, actual_cost_yuan_micro, gross_profit_yuan_micro,
        gross_margin_bps, pricing_version, billing_policy_version, note, created_by, created_at,
      ] = params as any[];
      // UNIQUE(idempotency_key) 约束（键漂移场景下故意击穿不了它）
      if (this.ledger.some((r) => r.idempotency_key === idempotency_key)) {
        const err: any = new Error('duplicate key value violates unique constraint "credit_ledger_idempotency_key_key"');
        err.code = '23505';
        throw err;
      }
      const row: LedgerRow = {
        id, idempotency_key, tenant_id, account_id, type, source,
        related_usage_event_ids: Array.isArray(related_usage_event_ids) ? [...related_usage_event_ids] : [],
        session_id: session_id ?? null, run_id: run_id ?? null, message_id: message_id ?? null,
        credits_delta_micro, balance_before_micro, balance_after_micro, credit_value_yuan_micro,
        revenue_yuan_micro, actual_cost_yuan_micro, gross_profit_yuan_micro,
        gross_margin_bps, pricing_version, billing_policy_version, note, created_by, created_at,
      };
      this.ledger.push(row);
      return { rows: [{ row_json: { ...row } }] };
    }

    // -- insertUsageEvent: INSERT INTO ..._usage_events ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING ...
    if (/INSERT INTO\s+\S*usage_events/i.test(sql)) {
      const id = String(params[0]);
      const idempotency_key = String(params[1]);
      // ON CONFLICT (idempotency_key) DO NOTHING → 已存在则不插、RETURNING 空
      if (this.usageEvents.some((r) => r.idempotency_key === idempotency_key)) {
        return { rows: [] };
      }
      const row = usageRowFromInsertParams(id, idempotency_key, params);
      this.usageEvents.push(row);
      return { rows: [{ row_json: { ...row } }] };
    }

    // -- listUsageEvents: SELECT row_to_json(u.*) FROM ..._usage_events u WHERE ... billable=$4 ...
    if (/FROM\s+\S*usage_events\s+u\b/i.test(sql)) {
      const [tenantId, runId, sessionId, billable] = params as any[];
      const rows = this.usageEvents
        .filter((r) => (tenantId == null || r.tenant_id === tenantId))
        .filter((r) => (runId == null || r.run_id === runId))
        .filter((r) => (sessionId == null || r.session_id === sessionId))
        .filter((r) => (billable == null || r.billable === billable))
        .map((r) => ({ row_json: { ...r } }));
      return { rows };
    }

    throw new Error(`FakePg: unhandled SQL: ${sql.slice(0, 120)}`);
  }
}

/**
 * 从 insertUsageEvent 的参数数组重建一行 usage_event（含 normalizeUsageEvent 需要的字段）。
 * 参数顺序对齐 pgBillingStore.insertUsageEvent 的 VALUES 绑定。
 */
function usageRowFromInsertParams(id: string, idempotencyKey: string, params: unknown[]): UsageRow {
  const p = params as any[];
  // 索引对齐 insertUsageEvent：见 pgBillingStore.ts INSERT INTO ..._usage_events 的 params 列表
  return {
    id,
    idempotency_key: idempotencyKey,
    tenant_id: String(p[2]),
    user_id: p[3] ?? null,
    username: String(p[4]),
    session_id: p[5] ?? null,
    run_id: p[6] ?? null,
    channel: String(p[7]),
    billable: Boolean(p[8]),
    model_value: String(p[9]),
    actual_model: p[10] ?? null,
    provider: p[11] ?? null,
    model_tier: p[12] ?? null,
    request_index: Number(p[13]),
    response_id: p[14] ?? null,
    input_tokens: Number(p[15]),
    uncached_input_tokens: Number(p[16]),
    cached_input_tokens: Number(p[17]),
    cache_creation_tokens: Number(p[18]),
    cache_storage_tokens: 0,
    cache_storage_hours: 0,
    output_tokens: Number(p[19]),
    reasoning_tokens: Number(p[20]),
    api_request_count: Number(p[21]),
    input_segment: String(p[22]),
    usage_accounting: String(p[23]),
    pricing_version: String(p[24]),
    fx_rate_to_cny: Number(p[25]),
    actual_cost_yuan_micro: Number(p[26]),
    raw_usage_json: p[27],
    created_at: String(p[28]),
  };
}

// ---------------------------------------------------------------------------
// 装配：只 spy 掉纯配置 getter，其余走真实代码 + FakePg
// ---------------------------------------------------------------------------

function basePolicy(overrides: Partial<TenantBillingPolicy> = {}): TenantBillingPolicy {
  return {
    tenantId: 'wain-test',
    policyVersion: 'pol-v1',
    billingEnabled: true,
    pricingVersion: 'price-v1',
    billingMode: 'prepaid',
    defaultTargetMarginBps: 6000,
    organizationMultiplierBps: 10000,
    allowNegativeBalance: true, // 允许扣负，避免余额守卫干扰并发断言
    negativeLimitCreditsMicro: Number.MAX_SAFE_INTEGER,
    lowBalanceThresholdCreditsMicro: 0,
    hardCapMode: 'stop_before_run',
    showBalance: true,
    showUsageCredits: true,
    showCost: false,
    showGrossMargin: false,
    updatedBy: 'test',
    updatedAt: '2026-07-15T00:00:00.000Z',
    ...overrides,
  };
}

function makeStore(fake: FakePg, opts: { policy?: Partial<TenantBillingPolicy>; startBalanceMicro?: number } = {}) {
  const store = new PgBillingStore({ pool: fake as any });
  // 仅 spy 纯配置 getter（非闭合层），其余 settleRunDebit / withAccountLock /
  // listDebitedUsageEventIds / getLedgerByIdempotencyKey / insertLedgerAndUpdateAccount /
  // listUsageEvents / insertUsageEvent / usageEventIdHash 全走真实代码。
  vi.spyOn(store, 'getTenantPolicy').mockResolvedValue(basePolicy(opts.policy));
  vi.spyOn(store, 'getActivePricingVersion').mockResolvedValue({
    version: 'price-v1',
    creditValueYuanMicro: 10_000,
  } as any);
  // 预置账户初始余额
  fake.accounts.set('wain-test', {
    tenant_id: 'wain-test',
    balance_micro: Math.trunc(opts.startBalanceMicro ?? 1000 * CREDIT_MICRO),
    reserved_micro: 0,
    updated_at: '2026-07-15T00:00:00.000Z',
  });
  return store;
}

/** 直接往 FakePg.usageEvents 塞一条 billable usage（跳过 insertUsageEvent 的定价换算）。 */
function seedUsageEvent(fake: FakePg, over: Partial<UsageRow> & { id: string }): void {
  fake.usageEvents.push({
    idempotency_key: `usage:event:v1:${over.id}`,
    tenant_id: 'wain-test',
    run_id: 'run-1',
    session_id: 'sess-1',
    billable: true,
    actual_cost_yuan_micro: 3_000_000,
    username: 'alice',
    channel: 'web',
    model_value: 'glm-5.2',
    request_index: 1,
    input_tokens: 0,
    uncached_input_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_tokens: 0,
    cache_storage_tokens: 0,
    cache_storage_hours: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    api_request_count: 1,
    input_segment: '<=32k',
    usage_accounting: 'default',
    pricing_version: 'price-v1',
    fx_rate_to_cny: 7.2,
    raw_usage_json: {},
    created_at: '2026-07-15T00:00:00.000Z',
    ...over,
  } as UsageRow);
}

// ===========================================================================
// ① 幂等键漂移：固化"键会随 pending 子集变化而漂移"这一事实
// ===========================================================================

describe('计费幂等键漂移（为何不能只靠 UNIQUE(idempotency_key)）', () => {
  it('不同 pending usage_event 子集 → settleRunDebit 算出【不同】幂等键', async () => {
    // 观测手段：不 spy 键构造，而是让两次结算落到不同 pending 集，
    // 从写入 ledger 的 idempotencyKey 读回真实的键，断言二者不同。
    const fakeA = new FakePg();
    const storeA = makeStore(fakeA);
    seedUsageEvent(fakeA, { id: 'e1' });
    const entryA = await storeA.settleRunDebit('wain-test', 'run-1'); // pending = {e1}

    const fakeB = new FakePg();
    const storeB = makeStore(fakeB);
    seedUsageEvent(fakeB, { id: 'e1' });
    seedUsageEvent(fakeB, { id: 'e2' });
    const entryB = await storeB.settleRunDebit('wain-test', 'run-1'); // pending = {e1, e2}

    expect(entryA!.idempotencyKey).toMatch(/^debit:usage:v1:run-1:/);
    expect(entryB!.idempotencyKey).toMatch(/^debit:usage:v1:run-1:/);
    // 键漂移：pending 集不同 → 哈希不同 → 幂等键不同。
    // 这正是"UNIQUE(idempotency_key) 挡不住重叠子集"的根因。
    expect(entryA!.idempotencyKey).not.toBe(entryB!.idempotencyKey);
  });

  it('相同 pending 集（顺序无关）→ 幂等键稳定（sha1(sorted ids)）', async () => {
    const run = async (seedIds: string[]) => {
      const fake = new FakePg();
      const store = makeStore(fake);
      for (const id of seedIds) seedUsageEvent(fake, { id });
      const entry = await store.settleRunDebit('wain-test', 'run-1');
      return entry!.idempotencyKey;
    };
    // listUsageEvents 无稳定排序，但 usageEventIdHash 内部对 ids 做 sort，
    // 因此同一集合无论落库顺序，键都稳定。
    const k1 = await run(['e1', 'e2']);
    const k2 = await run(['e2', 'e1']);
    expect(k1).toBe(k2);
  });
});

// ===========================================================================
// ② B1 usage 层 ON CONFLICT 去重：同 eventId 并发/重复插入只落一条
// ===========================================================================

describe('B1 usage_events 层 ON CONFLICT 去重（稳定幂等键闭合）', () => {
  const usageInput = (eventId: string) => ({
    idempotencyKey: `usage:event:v1:${eventId}`, // 稳定幂等键，锚定不可变 eventId
    tenantId: 'wain-test',
    username: 'alice',
    channel: 'web' as const,
    sessionId: 'sess-1',
    runId: 'run-1',
    modelValue: 'glm-5.2',
    requestIndex: 1,
    billable: true,
    usage: { inputTokens: 100, outputTokens: 50 },
    occurredAt: '2026-07-15T00:00:00.000Z',
  });

  it('重复插入同 eventId：usage_events 只落一条（第二次命中 ON CONFLICT DO NOTHING）', async () => {
    const fake = new FakePg();
    const store = makeStore(fake);
    const first = await store.insertUsageEvent(usageInput('evt-A') as any);
    const second = await store.insertUsageEvent(usageInput('evt-A') as any);

    expect(first).not.toBeNull(); // 首插返回行
    expect(second).toBeNull(); // 二次命中 ON CONFLICT → RETURNING 空 → null
    expect(fake.usageEvents.filter((r) => r.idempotency_key === 'usage:event:v1:evt-A')).toHaveLength(1);
  });

  it('并发插入同 eventId：仍只落一条（同稳定键，Promise.all 交错）', async () => {
    const fake = new FakePg();
    const store = makeStore(fake);
    const results = await Promise.all([
      store.insertUsageEvent(usageInput('evt-B') as any),
      store.insertUsageEvent(usageInput('evt-B') as any),
      store.insertUsageEvent(usageInput('evt-B') as any),
    ]);
    const inserted = results.filter((r) => r !== null);
    expect(inserted).toHaveLength(1); // 只有一个 Promise 拿到插入的行
    expect(fake.usageEvents.filter((r) => r.idempotency_key === 'usage:event:v1:evt-B')).toHaveLength(1);
  });

  it('不同 eventId 各自落一条（键不冲突不去重）', async () => {
    const fake = new FakePg();
    const store = makeStore(fake);
    await store.insertUsageEvent(usageInput('evt-C') as any);
    await store.insertUsageEvent(usageInput('evt-D') as any);
    expect(fake.usageEvents).toHaveLength(2);
  });
});

// ===========================================================================
// ③ B2 串行去重闭合：不 spy listDebitedUsageEventIds，用真实事务体验证
//    "第二次结算读到第一次已 debit 的集合并剔除交集 → e1 只被扣一次"
// ===========================================================================

describe('B2 settleRunDebit 串行去重闭合（listDebitedUsageEventIds + 账户行 FOR UPDATE）', () => {
  it('两次结算共享 run：第二次剔除已扣 e1，e1 只被扣一次', async () => {
    const fake = new FakePg();
    const store = makeStore(fake);
    seedUsageEvent(fake, { id: 'e1' });

    // 第一次结算：pending = {e1}，落 ledger#1(related=[e1])
    const first = await store.settleRunDebit('wain-test', 'run-1');
    expect(first).not.toBeNull();
    expect(first!.relatedUsageEventIds).toEqual(['e1']);

    // e2 随后落库
    seedUsageEvent(fake, { id: 'e2' });

    // 第二次结算：listDebitedUsageEventIds 读到 {e1}（锁内反查已提交 ledger），
    // pending = {e1,e2} \ {e1} = {e2}，落 ledger#2(related=[e2])
    const second = await store.settleRunDebit('wain-test', 'run-1');
    expect(second).not.toBeNull();
    expect(second!.relatedUsageEventIds).toEqual(['e2']);

    // 关键断言：e1 只出现在一条 debit 的 related 里 → 只被扣一次。
    const debitLedgers = fake.ledger.filter((l) => l.type === 'debit' && l.source === 'usage_event');
    const e1Occurrences = debitLedgers.filter((l) => l.related_usage_event_ids.includes('e1'));
    expect(e1Occurrences).toHaveLength(1);
    // e2 同理只被扣一次。
    expect(debitLedgers.filter((l) => l.related_usage_event_ids.includes('e2'))).toHaveLength(1);
  });

  it('并发两个 settleRunDebit 同 run：账户行 FOR UPDATE 串行化，e1 不被重复扣', async () => {
    // 通过 FakePg 的 RowLock 复现"账户行 FOR UPDATE 只有一个事务能持有"。
    // 两个 settle 并发发起，第二个进锁者必然看到第一个已 COMMIT 的 debit。
    const fake = new FakePg();
    const store = makeStore(fake);
    seedUsageEvent(fake, { id: 'e1' });
    seedUsageEvent(fake, { id: 'e2' });

    const [r1, r2] = await Promise.all([
      store.settleRunDebit('wain-test', 'run-1'),
      store.settleRunDebit('wain-test', 'run-1'),
    ]);

    // 一个事务扣掉 {e1,e2}，另一个进锁时 pending 集被 listDebitedUsageEventIds 清空 → null。
    const nonNull = [r1, r2].filter((x) => x !== null);
    expect(nonNull).toHaveLength(1);

    const debitLedgers = fake.ledger.filter((l) => l.type === 'debit' && l.source === 'usage_event');
    // 每个 usage_event 恰好落一条 debit（无重复计费）。
    const allRelated = debitLedgers.flatMap((l) => l.related_usage_event_ids);
    expect(allRelated.filter((id) => id === 'e1')).toHaveLength(1);
    expect(allRelated.filter((id) => id === 'e2')).toHaveLength(1);
  });

  it('回归护栏：一旦把去重集置空（模拟 listDebitedUsageEventIds 挪出事务 / 失效），e1 会被扣两次', async () => {
    // 反证——固化"闭合点在哪"。这里【显式】把 listDebitedUsageEventIds 打桩成永远返回空集，
    // 等价于未来有人把它挪出 FOR UPDATE 事务、或误删该反查。断言此时确实退化为多扣，
    // 从而证明本闭合层不可移除。注意：这是【故意破坏】以做回归对照，正常路径见上两例。
    const fake = new FakePg();
    const store = makeStore(fake);
    seedUsageEvent(fake, { id: 'e1' });

    vi.spyOn(store as any, 'listDebitedUsageEventIds').mockResolvedValue(new Set<string>());

    const first = await store.settleRunDebit('wain-test', 'run-1'); // pending={e1}, 落 ledger#1
    seedUsageEvent(fake, { id: 'e2' });
    const second = await store.settleRunDebit('wain-test', 'run-1'); // 去重失效 → pending={e1,e2}, 再扣 e1

    expect(first!.relatedUsageEventIds).toEqual(['e1']);
    expect(second!.relatedUsageEventIds).toEqual(expect.arrayContaining(['e1', 'e2']));

    // e1 出现在两条 debit 的 related 里 → 被多扣。固化"去掉护栏即回归"。
    const debitLedgers = fake.ledger.filter((l) => l.type === 'debit' && l.source === 'usage_event');
    expect(debitLedgers.filter((l) => l.related_usage_event_ids.includes('e1'))).toHaveLength(2);
  });
});

// ===========================================================================
// 集成骨架（需真 PG / testcontainers）：真实 FOR UPDATE 行锁阻塞语义
// ---------------------------------------------------------------------------
// 上面用 FakePg.RowLock 复现了"账户行 FOR UPDATE 串行化"的语义，但那是【手写模拟】，
// 不能证明真实 Postgres 的 SELECT ... FOR UPDATE 在跨连接、真并发下的阻塞/可见性
// 保证。要真正坐实 B2 的隐性闭合在生产 PG 上成立（尤其：第二个进锁事务能看到第一个
// 已 COMMIT 的 debit 反查），必须跑真 PG。当前仓库【未】安装 pg-mem / testcontainers，
// 且任务约束禁止擅自加依赖，故留 skip 骨架 + 说明，待集成环境接入。
// ===========================================================================

describe.skip('[集成｜需 testcontainers 真 PG] B2 真实 FOR UPDATE 串行去重', () => {
  it.todo('真并发两连接 settleRunDebit 同 run：第二连接 FOR UPDATE 阻塞至第一连接 COMMIT，随后 listDebitedUsageEventIds 反查到 e1 并剔除 → e1 仅一条 debit');
  it.todo('移除账户行 FOR UPDATE（改普通 SELECT）后重跑上例：断言退化为 e1 落两条 debit（真 PG 下坐实闭合点）');
  it.todo('将 listUsageEvents 候选全集也挪进同一 FOR UPDATE 事务内读：断言锁外快照错配窗口被彻底消除');
});
