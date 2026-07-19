/**
 * PgBillingStore 定价版本 CRUD 补测（FakePg 内存假实现跑真实事务体，2026-07-19 第三批）
 *
 * 与现有 billing 测试的分工（不重复，只补缺口）：
 *   - billingStorePureFns.test.ts  已覆盖：normalizePricingConflictError 的错误包装语义
 *     （create 遇 23505 → BillingPricingConflictError 的 message/cause/ROLLBACK/release，
 *     非 23505 原样透传，update 切 active 并发 23505），以及 active→retired 守卫的
 *     错误类型/子串断言 —— 全部基于「查询必失败的 stub client」，不落数据。
 *   - billingStoreCoverage.test.ts 已覆盖：settleRunDebit / adjustAccount（spy 私有方法）。
 *   - billingConcurrency.test.ts   已覆盖：结算幂等 / usage ON CONFLICT（FakePg + RowLock）。
 *   - billingRouterRedact.test.ts  已覆盖：/audit 路由层脱敏（store 是假件，未测真 store）。
 *
 *   本文件专测（此前零覆盖的数据级/序列级行为）：
 *   1. updatePricingVersion 切 active 全流程：旧 active 被 retire、
 *      effective_to 的 COALESCE 语义（空则写 now、已有值不覆盖）、目标行 effective_to = NULL
 *      清除、retire 排除目标自身（version <> $3）、BEGIN→retire→patch→COMMIT 序列、
 *      返回值来自 COMMIT 后重查；active→draft 守卫（pureFns 只测了 retired 分支）的
 *      完整错误文案 + 零写入；动态 SET 拼装的列序/取整/NULL；not found 短路不开事务。
 *   2. createPricingVersion status='active' 先 retire 旧 active（序列 + effective_to =
 *      新版本 effectiveFrom）；默认 draft 不发 retire；PK 23505 时事务原子性 ——
 *      同事务内已执行的 retire 随 ROLLBACK 一并撤销（数据级断言，pureFns 的 stub 版本
 *      测不到）+ 连接释放 + 不发 COMMIT / 不重查。
 *   3. getAuditSummary 聚合/lowBalance/告警拼装（spy 子查询分发模式）：三条子查询的
 *      参数分发（tenantId / since）、days 夹取、毛利率告警文案、cost=0 告警、
 *      低余额租户映射与告警顺序。
 *
 * A/B/C 分类：FakePg 只实现「单连接顺序事务 + BEGIN 快照/ROLLBACK 还原」这一最小语义；
 * 以下不在本文件硬测、留真 PG 集成（B 类）：
 *   - partial unique one_active_idx 的跨事务并发冲突（真索引语义）；
 *   - updatePricingVersion 事务外读 currentRow 的 TOCTOU 竞态（见报告疑点）；
 *   - PG 对 UPDATE 重复列赋值的 42601 报错（本文件仅以 SQL 文本固化该缺陷，见下）。
 *
 * 已知缺陷记录（固化现状、不修源码，详见同日报告）：
 *   - createPricingVersion 的 created_at/updated_at 落为 effectiveFrom（$4 复用）而非当前
 *     时间，回填历史版本时审计时间失真；
 *   - updatePricingVersion 在「切 active + 显式传 effectiveTo」时生成的 UPDATE 对
 *     effective_to 赋值两次，真 PG 会以 42601 (multiple assignments to same column) 拒绝；
 *   - 23505 一律被归因为「已有另一个 active 价格版本」，版本号 PK 重复也用同一文案。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BillingPricingConflictError, PgBillingStore } from '../data/billing/pgBillingStore.js';

const FIXED_NOW = '2026-07-19T08:00:00.000Z';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(FIXED_NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// FakePricingPg：pricing_versions 单表内存假实现
//   - pool.query 直连；pool.connect 返回事务客户端
//   - BEGIN 打快照，ROLLBACK 还原，COMMIT 丢弃快照（单连接顺序使用，无并发语义）
//   - 记录全部 SQL 调用（via: pool|tx）供序列断言
// ---------------------------------------------------------------------------

interface PricingRow {
  version: string;
  name: string;
  status: 'draft' | 'active' | 'retired';
  effective_from: string;
  effective_to: string | null;
  credit_value_yuan_micro: number;
  default_target_margin_bps: number;
  fx_rate_to_cny: number;
  currency: string;
  created_by: string;
  created_at: string;
  updated_by: string | null;
  updated_at: string | null;
}

interface LogEntry {
  via: 'pool' | 'tx';
  sql: string;
  params: unknown[];
}

function pg23505(constraint: string): Error {
  return Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), {
    code: '23505',
    constraint,
  });
}

class FakePricingPg {
  rows = new Map<string, PricingRow>();
  log: LogEntry[] = [];
  released = 0;
  connectCount = 0;
  private snapshot: Map<string, PricingRow> | null = null;

  seed(over: Partial<PricingRow> & { version: string; status: PricingRow['status'] }): PricingRow {
    const row: PricingRow = {
      name: `pricing ${over.version}`,
      effective_from: '2026-01-01T00:00:00.000Z',
      effective_to: null,
      credit_value_yuan_micro: 10_000,
      default_target_margin_bps: 6000,
      fx_rate_to_cny: 7.2,
      currency: 'CNY',
      created_by: 'seed',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_by: null,
      updated_at: null,
      ...over,
    };
    this.rows.set(row.version, row);
    return row;
  }

  /** 事务体 SQL 序列（剥离 pool 直连查询），供 BEGIN/.../COMMIT 顺序断言 */
  txKinds(): string[] {
    return this.log
      .filter((e) => e.via === 'tx')
      .map((e) => {
        const sql = e.sql;
        if (/^\s*BEGIN/i.test(sql)) return 'BEGIN';
        if (/^\s*COMMIT/i.test(sql)) return 'COMMIT';
        if (/^\s*ROLLBACK/i.test(sql)) return 'ROLLBACK';
        if (/SET status = 'retired'/.test(sql)) return 'RETIRE';
        if (/^\s*INSERT/i.test(sql)) return 'INSERT';
        if (/^\s*UPDATE/i.test(sql)) return 'PATCH';
        return 'OTHER';
      });
  }

  query = async (sql: string, params: unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> => {
    this.log.push({ via: 'pool', sql, params });
    return this.exec(sql, params);
  };

  connect = async (): Promise<unknown> => {
    this.connectCount += 1;
    const client = {
      query: async (sql: string, params: unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> => {
        this.log.push({ via: 'tx', sql, params });
        if (/^\s*BEGIN/i.test(sql)) {
          this.snapshot = new Map([...this.rows].map(([k, v]) => [k, { ...v }]));
          return { rows: [] };
        }
        if (/^\s*COMMIT/i.test(sql)) {
          this.snapshot = null;
          return { rows: [] };
        }
        if (/^\s*ROLLBACK/i.test(sql)) {
          if (this.snapshot) {
            this.rows = this.snapshot;
            this.snapshot = null;
          }
          return { rows: [] };
        }
        return this.exec(sql, params);
      },
      release: () => {
        this.released += 1;
      },
    };
    return client;
  };

  private exec(sql: string, params: unknown[]): { rows: Array<Record<string, unknown>> } {
    // SELECT row_to_json ... WHERE version = $1（current 读 + COMMIT 后重查）
    if (/row_to_json/.test(sql) && /WHERE version = \$1/.test(sql)) {
      const row = this.rows.get(String(params[0]));
      return { rows: row ? [{ row_json: { ...row } }] : [] };
    }
    // getActivePricingVersion（本批流程未用到，保底实现防误配）
    if (/row_to_json/.test(sql) && /WHERE status = 'active'/.test(sql)) {
      const actives = [...this.rows.values()]
        .filter((r) => r.status === 'active')
        .sort((a, b) => b.effective_from.localeCompare(a.effective_from));
      return { rows: actives.slice(0, 1).map((r) => ({ row_json: { ...r } })) };
    }
    // retire 旧 active：SET status = 'retired', effective_to = COALESCE(effective_to, $1),
    //   updated_by = $2, updated_at = $1 WHERE status = 'active' [AND version <> $3]
    if (/SET status = 'retired'/.test(sql)) {
      const ts = String(params[0]);
      const actor = String(params[1]);
      const excludeVersion = /version <> \$3/.test(sql) ? String(params[2]) : null;
      for (const row of this.rows.values()) {
        if (row.status !== 'active') continue;
        if (excludeVersion !== null && row.version === excludeVersion) continue;
        row.status = 'retired';
        row.effective_to = row.effective_to ?? ts; // COALESCE：已有值不覆盖
        row.updated_by = actor;
        row.updated_at = ts;
      }
      return { rows: [] };
    }
    // createPricingVersion INSERT（参数序对齐源码 VALUES ($1..$8, created_at=$4, updated_by=$8, updated_at=$4)）
    if (/INSERT INTO \S*billing_pricing_versions/i.test(sql)) {
      const [version, name, status, effectiveFrom, creditValue, marginBps, fxRate, createdBy] = params as [
        string, string, PricingRow['status'], string, number, number, number, string,
      ];
      if (this.rows.has(version)) throw pg23505('runtime_billing_pricing_versions_pkey');
      if (status === 'active' && [...this.rows.values()].some((r) => r.status === 'active')) {
        throw pg23505('runtime_billing_pricing_versions_one_active_idx');
      }
      this.rows.set(version, {
        version,
        name,
        status,
        effective_from: effectiveFrom,
        effective_to: null,
        credit_value_yuan_micro: creditValue,
        default_target_margin_bps: marginBps,
        fx_rate_to_cny: fxRate,
        currency: 'CNY',
        created_by: createdBy,
        created_at: effectiveFrom, // 源码 $4 复用（已知缺陷，见文件头）
        updated_by: createdBy,
        updated_at: effectiveFrom,
      });
      return { rows: [] };
    }
    // updatePricingVersion 动态 PATCH：UPDATE t SET col = $n[, ...][, effective_to = NULL] WHERE version = $N
    if (/^\s*UPDATE/i.test(sql) && /WHERE version = \$\d+/.test(sql)) {
      const whereMatch = sql.match(/WHERE version = \$(\d+)/)!;
      const version = String(params[Number(whereMatch[1]) - 1]);
      const row = this.rows.get(version);
      if (!row) return { rows: [] };
      const setClause = sql.slice(sql.indexOf('SET ') + 4, sql.indexOf(' WHERE'));
      for (const part of setClause.split(',').map((s) => s.trim())) {
        const bound = part.match(/^(\w+) = \$(\d+)$/);
        if (bound) {
          (row as unknown as Record<string, unknown>)[bound[1]!] = params[Number(bound[2]) - 1];
          continue;
        }
        if (/^effective_to = NULL$/i.test(part)) {
          // 注意：真 PG 遇到同列二次赋值会直接报 42601；FakePg 按「后写覆盖」执行，
          // 该差异由「已知缺陷记录」用例以 SQL 文本固化。
          row.effective_to = null;
          continue;
        }
        throw new Error(`FakePricingPg: unhandled SET fragment: ${part}`);
      }
      return { rows: [] };
    }
    throw new Error(`FakePricingPg: unhandled SQL: ${sql.slice(0, 140)}`);
  }
}

function makeStore(fake: FakePricingPg): PgBillingStore {
  return new PgBillingStore({ pool: fake as unknown as InstanceType<typeof PgBillingStore>['pool'] });
}

// ===========================================================================
// ① updatePricingVersion
// ===========================================================================

describe('updatePricingVersion 切 active（draft → active）', () => {
  it('旧 active 被 retire（effective_to=now、updated_by 落章）、目标行 effective_to 清 NULL、事务序列与重查', async () => {
    const fake = new FakePricingPg();
    fake.seed({ version: 'v-old', status: 'active', effective_from: '2026-06-01T00:00:00.000Z' });
    const histSeed = { ...fake.seed({
      version: 'v-hist',
      status: 'retired',
      effective_to: '2026-05-31T00:00:00.000Z',
    }) };
    // 目标 draft 预置了 effective_to，激活后必须被 effective_to = NULL 清掉
    fake.seed({
      version: 'v-new',
      status: 'draft',
      effective_from: '2026-07-01T00:00:00.000Z',
      effective_to: '2026-06-30T00:00:00.000Z',
    });
    const store = makeStore(fake);

    const result = await store.updatePricingVersion('v-new', { status: 'active', updatedBy: 'ops' });

    // 事务序列：BEGIN → retire 旧 active → 动态 PATCH → COMMIT；连接释放一次
    expect(fake.txKinds()).toEqual(['BEGIN', 'RETIRE', 'PATCH', 'COMMIT']);
    expect(fake.released).toBe(1);

    // retire 语句：now/updatedBy 参数 + 排除目标自身（version <> $3）
    const retire = fake.log.find((e) => /SET status = 'retired'/.test(e.sql))!;
    expect(retire.sql).toContain('version <> $3');
    expect(retire.params).toEqual([FIXED_NOW, 'ops', 'v-new']);

    // 动态 PATCH：SET 列序 + effective_to = NULL 字面量
    const patch = fake.log.find((e) => e.via === 'tx' && /WHERE version = \$\d+/.test(e.sql))!;
    expect(patch.sql).toContain('SET status = $1, updated_by = $2, updated_at = $3, effective_to = NULL WHERE version = $4');
    expect(patch.params).toEqual(['active', 'ops', FIXED_NOW, 'v-new']);

    // 旧 active：retired + effective_to 由 COALESCE 写为 now（激活时刻，非新版本 effectiveFrom——见报告疑点）
    const old = fake.rows.get('v-old')!;
    expect(old.status).toBe('retired');
    expect(old.effective_to).toBe(FIXED_NOW);
    expect(old.updated_by).toBe('ops');
    expect(old.updated_at).toBe(FIXED_NOW);

    // 旁观者（已 retired 的历史版本）不被触碰
    expect(fake.rows.get('v-hist')).toEqual(histSeed);

    // 返回值来自 COMMIT 后重查：active 且 effectiveTo 键被清除
    expect(result.status).toBe('active');
    expect(result).not.toHaveProperty('effectiveTo');
    expect(result.updatedBy).toBe('ops');
    expect(result.updatedAt).toBe(FIXED_NOW);
    const last = fake.log[fake.log.length - 1]!;
    expect(last.via).toBe('pool');
    expect(last.params).toEqual(['v-new']);
  });

  it('COALESCE 语义：旧 active 已有 effective_to 时不被覆盖（只改 status/updated_*）', async () => {
    const fake = new FakePricingPg();
    fake.seed({ version: 'v-old', status: 'active', effective_to: '2026-05-01T00:00:00.000Z' });
    fake.seed({ version: 'v-new', status: 'draft' });
    const store = makeStore(fake);

    await store.updatePricingVersion('v-new', { status: 'active', updatedBy: 'ops' });

    const old = fake.rows.get('v-old')!;
    expect(old.status).toBe('retired');
    expect(old.effective_to).toBe('2026-05-01T00:00:00.000Z'); // COALESCE 保留原值
    expect(old.updated_at).toBe(FIXED_NOW);
  });
});

describe('updatePricingVersion active 退役守卫（补 pureFns 未测的 draft 分支）', () => {
  it('active → draft：完整错误文案、事务内零写入（BEGIN 后直接 ROLLBACK）、数据不变', async () => {
    const fake = new FakePricingPg();
    const seeded = { ...fake.seed({ version: 'v-cur', status: 'active' }) };
    const store = makeStore(fake);

    const err = await store.updatePricingVersion('v-cur', { status: 'draft', updatedBy: 'root' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(BillingPricingConflictError); // 守卫错误不得伪装成 409 冲突
    expect((err as Error).message).toBe('当前 active 版本不能直接退役或改成 draft，请先激活另一个版本。');
    // patch.status !== 'active' → 不触发 retire；守卫先于字段 PATCH → 事务内无任何 UPDATE
    expect(fake.txKinds()).toEqual(['BEGIN', 'ROLLBACK']);
    expect(fake.rows.get('v-cur')).toEqual(seeded);
    expect(fake.released).toBe(1);
  });

  it('active → active（仅改名）：守卫不触发、不发 retire、不清 effective_to', async () => {
    const fake = new FakePricingPg();
    fake.seed({ version: 'v-cur', status: 'active' });
    const store = makeStore(fake);

    const result = await store.updatePricingVersion('v-cur', { status: 'active', name: '改名', updatedBy: 'root' });

    expect(fake.txKinds()).toEqual(['BEGIN', 'PATCH', 'COMMIT']); // 无 RETIRE
    const patch = fake.log.find((e) => e.via === 'tx' && /WHERE version = \$\d+/.test(e.sql))!;
    expect(patch.sql).not.toContain('effective_to = NULL'); // currentRow 已是 active，不追加清除
    expect(result.name).toBe('改名');
    expect(result.status).toBe('active');
  });
});

describe('updatePricingVersion 字段 PATCH 拼装', () => {
  it('全字段 PATCH：列序/参数序、金额与 bps 取整、effectiveTo 显式置 null', async () => {
    const fake = new FakePricingPg();
    fake.seed({ version: 'v-d', status: 'draft', effective_to: '2026-06-30T00:00:00.000Z' });
    const store = makeStore(fake);

    const result = await store.updatePricingVersion('v-d', {
      name: '2026Q4 定价',
      effectiveFrom: '2026-10-01T00:00:00.000Z',
      effectiveTo: null,
      creditValueYuanMicro: 12_345.6, // → round 12346
      defaultTargetMarginBps: 5_499.5, // → round 5500
      fxRateToCny: 6.9,
      updatedBy: 'root',
    });

    const patch = fake.log.find((e) => e.via === 'tx' && /WHERE version = \$\d+/.test(e.sql))!;
    expect(patch.sql).toContain(
      'SET name = $1, effective_from = $2, effective_to = $3, credit_value_yuan_micro = $4, '
      + 'default_target_margin_bps = $5, fx_rate_to_cny = $6, updated_by = $7, updated_at = $8 WHERE version = $9',
    );
    expect(patch.params).toEqual([
      '2026Q4 定价', '2026-10-01T00:00:00.000Z', null, 12_346, 5_500, 6.9, 'root', FIXED_NOW, 'v-d',
    ]);
    // 未传 status → 不触发守卫也不触发 retire
    expect(fake.txKinds()).toEqual(['BEGIN', 'PATCH', 'COMMIT']);
    expect(result.name).toBe('2026Q4 定价');
    expect(result.creditValueYuanMicro).toBe(12_346);
    expect(result.defaultTargetMarginBps).toBe(5_500);
    expect(result.fxRateToCny).toBe(6.9);
    expect(result).not.toHaveProperty('effectiveTo'); // null → normalize 时省略键
  });

  it('版本不存在：报 not found，且不开事务（connect 不被调用）', async () => {
    const fake = new FakePricingPg();
    const store = makeStore(fake);

    await expect(store.updatePricingVersion('ghost', { updatedBy: 'root' }))
      .rejects.toThrow('Pricing version not found: ghost');
    expect(fake.connectCount).toBe(0);
    expect(fake.log).toHaveLength(1); // 仅事务外 current 读
  });

  it('已知缺陷记录：切 active + 显式 effectiveTo → 同一 UPDATE 对 effective_to 赋值两次（真 PG 42601）', async () => {
    // 源码 L377 push('effective_to', $n) 与 L384-386 追加 'effective_to = NULL' 并存。
    // 真 PG 对 UPDATE 同列多次赋值直接报错（42601 multiple assignments to same column），
    // 即「激活草稿同时带 effectiveTo 字段」的请求在生产库必失败。此处以 SQL 文本固化现状。
    const fake = new FakePricingPg();
    fake.seed({ version: 'v-old', status: 'active' });
    fake.seed({ version: 'v-new', status: 'draft' });
    const store = makeStore(fake);

    await store.updatePricingVersion('v-new', { status: 'active', effectiveTo: null, updatedBy: 'root' });

    const patch = fake.log.find((e) => e.via === 'tx' && /WHERE version = \$\d+/.test(e.sql))!;
    const assignments = patch.sql.match(/effective_to = (\$\d+|NULL)/g) ?? [];
    expect(assignments).toEqual(['effective_to = $2', 'effective_to = NULL']); // 双重赋值 → 非法 SQL
  });
});

// ===========================================================================
// ② createPricingVersion
// ===========================================================================

describe('createPricingVersion', () => {
  it("status='active'：先 retire 旧 active（effective_to=新版本 effectiveFrom）再 INSERT，序列/取整/默认汇率/返回值", async () => {
    const fake = new FakePricingPg();
    fake.seed({ version: 'v-old', status: 'active', effective_from: '2026-06-01T00:00:00.000Z' });
    const store = makeStore(fake);

    const result = await store.createPricingVersion({
      version: 'v-2026q4',
      name: '2026Q4 提价',
      status: 'active',
      effectiveFrom: '2026-08-01T00:00:00.000Z',
      creditValueYuanMicro: 12_000.4, // → round 12000
      defaultTargetMarginBps: 5_999.6, // → round 6000
      createdBy: 'root',
      // fxRateToCny 缺省 → DEFAULT 7.2
    });

    expect(fake.txKinds()).toEqual(['BEGIN', 'RETIRE', 'INSERT', 'COMMIT']);
    expect(fake.released).toBe(1);

    // retire：create 路径不排除自身（无 version <> 子句），时间戳用 effectiveFrom 而非 now
    const retire = fake.log.find((e) => /SET status = 'retired'/.test(e.sql))!;
    expect(retire.sql).not.toContain('version <>');
    expect(retire.params).toEqual(['2026-08-01T00:00:00.000Z', 'root']);

    // 旧 active 的结束点 = 新版本生效点（区间连续语义）
    const old = fake.rows.get('v-old')!;
    expect(old.status).toBe('retired');
    expect(old.effective_to).toBe('2026-08-01T00:00:00.000Z');
    expect(old.updated_by).toBe('root');

    // INSERT 参数：取整 + 默认汇率
    const insert = fake.log.find((e) => /INSERT/.test(e.sql))!;
    expect(insert.params).toEqual([
      'v-2026q4', '2026Q4 提价', 'active', '2026-08-01T00:00:00.000Z', 12_000, 6_000, 7.2, 'root',
    ]);

    // 返回值来自 COMMIT 后重查
    expect(result).toMatchObject({
      version: 'v-2026q4',
      status: 'active',
      effectiveFrom: '2026-08-01T00:00:00.000Z',
      creditValueYuanMicro: 12_000,
      defaultTargetMarginBps: 6_000,
      fxRateToCny: 7.2,
      currency: 'CNY',
      createdBy: 'root',
    });
    expect(result).not.toHaveProperty('effectiveTo');
  });

  it('status 缺省 → draft：不发 retire，旧 active 不受影响', async () => {
    const fake = new FakePricingPg();
    const oldSeed = { ...fake.seed({ version: 'v-old', status: 'active' }) };
    const store = makeStore(fake);

    const result = await store.createPricingVersion({
      version: 'v-draft',
      name: '草稿',
      creditValueYuanMicro: 10_000,
      defaultTargetMarginBps: 6_000,
      fxRateToCny: 6.8,
      createdBy: 'ops',
    });

    expect(fake.txKinds()).toEqual(['BEGIN', 'INSERT', 'COMMIT']); // 无 RETIRE
    expect(fake.rows.get('v-old')).toEqual(oldSeed);
    expect(result.status).toBe('draft');
    expect(result.fxRateToCny).toBe(6.8); // 显式汇率生效
  });

  it('版本号 PK 冲突（23505）：BillingPricingConflictError + 事务原子回滚（同事务 retire 被撤销）+ 连接释放', async () => {
    // pureFns 已用 stub client 断言过错误包装与 ROLLBACK 调用；本例补数据级原子性：
    // 「先 retire 旧 active、后 INSERT 失败」时旧 active 必须随 ROLLBACK 恢复，
    // 否则会出现「全库无 active 定价版本」的悬空态。
    const fake = new FakePricingPg();
    fake.seed({ version: 'v-old', status: 'active' });
    fake.seed({ version: 'v-dup', status: 'draft' });
    const store = makeStore(fake);

    const err = await store.createPricingVersion({
      version: 'v-dup', // 与既有版本号撞 PK
      name: '重复版本号',
      status: 'active',
      creditValueYuanMicro: 10_000,
      defaultTargetMarginBps: 6_000,
      createdBy: 'root',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BillingPricingConflictError);
    // 已知缺陷记录：PK 撞版本号也被归因为「已有另一个 active 价格版本」，文案误导
    expect((err as BillingPricingConflictError).message).toBe('已有另一个 active 价格版本，请刷新后重试');
    expect(((err as BillingPricingConflictError).cause as { code?: string }).code).toBe('23505');

    // 序列：INSERT 失败 → ROLLBACK；不发 COMMIT、不做 COMMIT 后重查
    expect(fake.txKinds()).toEqual(['BEGIN', 'RETIRE', 'INSERT', 'ROLLBACK']);
    expect(fake.log.filter((e) => e.via === 'pool')).toHaveLength(0);
    expect(fake.released).toBe(1);

    // 原子性：同事务内已执行的 retire 被撤销，旧 active 完好
    const old = fake.rows.get('v-old')!;
    expect(old.status).toBe('active');
    expect(old.effective_to).toBeNull();
    expect(fake.rows.get('v-dup')!.status).toBe('draft');
  });

  it('已知缺陷记录：created_at/updated_at 落为 effectiveFrom 而非当前时间（回填历史版本时审计时间失真）', async () => {
    // 源码 INSERT VALUES 里 created_at/updated_at 复用 $4（effectiveFrom）。
    // 传入回溯的 effectiveFrom 时，"创建时间" 被伪造成历史时刻，审计链路无法还原真实操作时间。
    const fake = new FakePricingPg();
    const store = makeStore(fake);

    const result = await store.createPricingVersion({
      version: 'v-backfill',
      name: '回填 2020 历史价',
      effectiveFrom: '2020-01-01T00:00:00.000Z',
      creditValueYuanMicro: 10_000,
      defaultTargetMarginBps: 6_000,
      createdBy: 'root',
    });

    expect(result.createdAt).toBe('2020-01-01T00:00:00.000Z'); // ≠ FIXED_NOW：当前行为即失真
    expect(result.updatedAt).toBe('2020-01-01T00:00:00.000Z');
    expect(result.createdAt).not.toBe(FIXED_NOW);
  });
});

// ===========================================================================
// ③ getAuditSummary（spy 子查询分发：ledger 聚合 / unpriced 计数 / lowBalance JOIN）
// ===========================================================================

interface AuditRig {
  pool: { query: ReturnType<typeof vi.fn> };
  calls: Array<{ kind: 'ledger' | 'unpriced' | 'lowBalance'; params: unknown[] }>;
}

function makeAuditRig(data: {
  ledger?: Partial<Record<'actual_cost_yuan_micro' | 'revenue_yuan_micro' | 'credits_charged_micro' | 'gross_profit_yuan_micro', string>>;
  unpricedCount?: string;
  lowBalanceRows?: Array<{ tenant_id: string; balance_micro: string; low_balance_threshold_credits_micro: string }>;
} = {}): AuditRig {
  const calls: AuditRig['calls'] = [];
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    if (/FROM \S*billing_credit_ledger/.test(sql)) {
      calls.push({ kind: 'ledger', params });
      return {
        rows: [{
          actual_cost_yuan_micro: '0',
          revenue_yuan_micro: '0',
          credits_charged_micro: '0',
          gross_profit_yuan_micro: '0',
          ...data.ledger,
        }],
      };
    }
    if (/COUNT\(\*\)/.test(sql) && /FROM \S*billing_usage_events/.test(sql)) {
      calls.push({ kind: 'unpriced', params });
      return { rows: [{ count: data.unpricedCount ?? '0' }] };
    }
    if (/FROM \S*billing_credit_accounts/.test(sql) && /JOIN \S*billing_tenant_policies/.test(sql)) {
      calls.push({ kind: 'lowBalance', params });
      return { rows: data.lowBalanceRows ?? [] };
    }
    throw new Error(`AuditRig: unexpected SQL: ${sql.slice(0, 120)}`);
  });
  return { pool: { query }, calls };
}

function makeAuditStore(rig: AuditRig): PgBillingStore {
  return new PgBillingStore({ pool: rig.pool as unknown as InstanceType<typeof PgBillingStore>['pool'] });
}

describe('getAuditSummary 聚合与参数分发', () => {
  it('健康数据：字符串行转数值、毛利率计算、三条子查询的 tenantId/since 参数、零告警', async () => {
    const rig = makeAuditRig({
      ledger: {
        actual_cost_yuan_micro: '3000000',
        revenue_yuan_micro: '10000000',
        credits_charged_micro: '1000000000',
        gross_profit_yuan_micro: '7000000',
      },
    });
    const store = makeAuditStore(rig);

    const summary = await store.getAuditSummary({ tenantId: 'wain-test' });

    expect(summary).toEqual({
      tenantId: 'wain-test',
      days: 7, // 缺省 7 天
      actualCostYuanMicro: 3_000_000,
      revenueYuanMicro: 10_000_000,
      creditsChargedMicro: 1_000_000_000,
      grossProfitYuanMicro: 7_000_000,
      grossMarginBps: 7_000, // 7/10 → 70% ≥ 45%，无告警
      unpricedUsageEvents: 0,
      lowBalanceTenants: [],
      alerts: [],
    });

    // 参数分发：ledger/unpriced 收 [tenantId, since]，lowBalance 只收 [tenantId]
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    expect(rig.calls.map((c) => c.kind)).toEqual(['ledger', 'unpriced', 'lowBalance']);
    expect(rig.calls[0]!.params).toEqual(['wain-test', since]);
    expect(rig.calls[1]!.params).toEqual(['wain-test', since]);
    expect(rig.calls[2]!.params).toEqual(['wain-test']);
  });

  it.each([
    [undefined, 7],
    [200, 90], // 上限夹取
    [0, 1],    // 下限夹取（0 经 ?? 保留后被 max(1) 抬起）
  ])('days=%s → 夹取为 %i 并反映到 since 参数', async (input, expected) => {
    const rig = makeAuditRig();
    const store = makeAuditStore(rig);

    const summary = await store.getAuditSummary(input === undefined ? {} : { days: input });

    expect(summary.days).toBe(expected);
    const since = new Date(Date.now() - expected * 24 * 60 * 60 * 1000).toISOString();
    expect(rig.calls[0]!.params[1]).toBe(since);
  });

  it('毛利率低于 45%：拼装精确告警文案（bps → 两位小数百分比）', async () => {
    const rig = makeAuditRig({
      ledger: { revenue_yuan_micro: '10000000', gross_profit_yuan_micro: '4000000' },
    });
    const store = makeAuditStore(rig);

    const summary = await store.getAuditSummary({ tenantId: 'wain-test', days: 30 });

    expect(summary.grossMarginBps).toBe(4_000);
    expect(summary.alerts).toEqual(['最近 30 天平台/筛选范围毛利率低于 45%：40.00%']);
  });

  it('revenue=0：毛利率为 null（不除零）且不触发低毛利告警', async () => {
    const rig = makeAuditRig({
      ledger: { revenue_yuan_micro: '0', gross_profit_yuan_micro: '0', actual_cost_yuan_micro: '500000' },
    });
    const store = makeAuditStore(rig);

    const summary = await store.getAuditSummary({ tenantId: 'wain-test' });

    expect(summary.grossMarginBps).toBeNull();
    expect(summary.alerts).toEqual([]);
    expect(summary.actualCostYuanMicro).toBe(500_000);
  });

  it('平台全景（无 tenantId）：$1=null 分发、低毛利+cost=0+低余额告警按序拼装、lowBalanceTenants 数值映射', async () => {
    const rig = makeAuditRig({
      ledger: { revenue_yuan_micro: '10000000', gross_profit_yuan_micro: '2000000' }, // 20%
      unpricedCount: '3',
      lowBalanceRows: [
        { tenant_id: 't-a', balance_micro: '500000', low_balance_threshold_credits_micro: '1000000' },
        { tenant_id: 't-b', balance_micro: '-200000', low_balance_threshold_credits_micro: '3000000' },
      ],
    });
    const store = makeAuditStore(rig);

    const summary = await store.getAuditSummary({});

    expect(summary).not.toHaveProperty('tenantId'); // 平台视图不带租户键
    expect(rig.calls[0]!.params[0]).toBeNull();
    expect(rig.calls[1]!.params[0]).toBeNull();
    expect(rig.calls[2]!.params).toEqual([null]);

    // 告警顺序固定：毛利率 → cost=0 → 逐低余额租户
    expect(summary.alerts).toEqual([
      '最近 7 天平台/筛选范围毛利率低于 45%：20.00%',
      '最近 7 天出现 3 条 cost=0 usage event',
      '租户 t-a 余额低于阈值',
      '租户 t-b 余额低于阈值',
    ]);
    expect(summary.unpricedUsageEvents).toBe(3);
    expect(summary.lowBalanceTenants).toEqual([
      { tenantId: 't-a', balanceCreditsMicro: 500_000, thresholdCreditsMicro: 1_000_000 },
      { tenantId: 't-b', balanceCreditsMicro: -200_000, thresholdCreditsMicro: 3_000_000 },
    ]);
  });
});
