/**
 * runtime 层 store 纯逻辑切片补测（2026-07-19 第三批）
 *
 * 与现有测试的分工：
 *   - runtimeSessionProjection.test.ts : projection sink 钩子、buildRuntimeSessionProjectionRecord、
 *     scanRuntimeSessionMetaFiles 的直接计数（本文件不重复）
 *   本文件专测两个 PG store 的 A 切片（可脱离真 PG 断言的 JS 逻辑）：
 *
 *   runStore.ts（经公开方法触达模块私有函数）：
 *   1. normalizeRunRecord —— snake/camel 双兼容映射、日期归一 ISO、null→undefined、
 *      metadata 默认 {}、cumulative_input_tokens 字符串解析（经 get() 假 pool 驱动）
 *   2. parseCount —— string/number/null/垃圾串（经 getActiveCounts() 驱动，含 blocking/total 派生）
 *   3. sanitizeIdentifier —— 非法 tablePrefix throw、合法前缀拼表名（经构造函数驱动）
 *   4. 现场增补：updateResponseSessionState 的动态 SET/参数位装配（纯 JS 分支，
 *      参数位漂移是真实风险；空 patch 短路回退 SELECT）——SQL 执行语义仍归 PG 集成
 *
 *   sessionProjectionStore.ts：
 *   5. list() 查询构造 —— limit clamp(1..100)、全过滤子句参数位、orgAgentId/hasOrgAgent
 *      优先级、cursor 双键条件、includeDeleted、hasMore→nextCursor（假 pool 捕获 SQL+params）
 *   6. planBackfill 差集计算 —— mkdtempSync 真文件 + 假 pool，wouldDeleteMissing/existingRows/
 *      wouldUpsert；PG 查询失败降级 null
 *   7. runtimeSessionsDdl / 构造函数的 sanitizeIdentifier 与 pool 守卫
 *
 * 明确不测（B 类，归真 PG 集成）：runStore 的 terminal-sink CASE WHEN、lease WHERE、
 * upsertPending ON CONFLICT、init DDL；sessionProjectionStore 的 upsertFromMeta / get /
 * reconcileFromFileSystem 的 SQL 执行语义。假 pool 只断言"发出了什么"，不假装验证 PG 行为。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PgRunStore } from '../runtime/runStore.js';
import { PgSessionProjectionStore, runtimeSessionsDdl } from '../runtime/sessionProjectionStore.js';

// ────────── 假 pool rig（参照 billingStorePureFns.test.ts 的参数捕获模式） ──────────

function makeRunStoreRig(rows: unknown[] = []) {
  const query = vi.fn(async (..._args: unknown[]) => ({ rows }));
  const store = new PgRunStore({ pool: { query } as any });
  return { store, query };
}

/** 经公开方法 get() 驱动模块私有 normalizeRunRecord：假 pool 回吐一行 row_json。 */
async function normalizeViaGet(rowJson: Record<string, unknown>) {
  const { store } = makeRunStoreRig([{ row_json: rowJson }]);
  const record = await store.get('run-x');
  expect(record).not.toBeNull();
  return record!;
}

function makeSessionRig(rows: unknown[] = []) {
  const query = vi.fn(async (..._args: unknown[]) => ({ rows }));
  const store = new PgSessionProjectionStore({ pool: { query } as any });
  return { store, query };
}

// ════════════════════════ runStore.ts ════════════════════════

describe('normalizeRunRecord（经 PgRunStore.get 驱动）', () => {
  it('snake_case 全字段映射 + 日期归一 ISO（含带时区偏移的 requested_at）', async () => {
    const record = await normalizeViaGet({
      run_id: 'run-1',
      session_id: 'sess-1',
      user_id: 'u1',
      tenant_id: 'kaiyan',
      status: 'completed',
      status_reason: 'done',
      model: 'glm-5.2',
      channel: 'web',
      requested_at: '2026-07-18T10:00:00+08:00',
      started_at: '2026-07-18T02:00:01.000Z',
      updated_at: '2026-07-18T02:00:05.000Z',
      completed_at: '2026-07-18T02:00:05.000Z',
      failed_at: null,
      cancelled_at: null,
      worker_id: 'w1',
      lease_expires_at: '2026-07-18T02:10:00.000Z',
      idempotency_key: 'idem-1',
      execution_target: 'server-local',
      workspace_id: 'ws-1',
      sandbox_scope_id: 'sb-1',
      metadata: { a: 1 },
      last_response_id: 'resp-1',
      last_response_expire_at: '2026-07-21T02:00:00.000Z',
      actual_model_seen: 'glm-5.2-alias',
      last_response_model: 'glm-5.2',
      cumulative_input_tokens: '12345',
    });
    expect(record).toEqual({
      runId: 'run-1',
      sessionId: 'sess-1',
      userId: 'u1',
      tenantId: 'kaiyan',
      status: 'completed',
      statusReason: 'done',
      model: 'glm-5.2',
      channel: 'web',
      requestedAt: '2026-07-18T02:00:00.000Z', // +08:00 归一为 UTC ISO
      startedAt: '2026-07-18T02:00:01.000Z',
      updatedAt: '2026-07-18T02:00:05.000Z',
      completedAt: '2026-07-18T02:00:05.000Z',
      workerId: 'w1',
      leaseExpiresAt: '2026-07-18T02:10:00.000Z',
      idempotencyKey: 'idem-1',
      executionTarget: 'server-local',
      workspaceId: 'ws-1',
      sandboxScopeId: 'sb-1',
      metadata: { a: 1 },
      lastResponseId: 'resp-1',
      lastResponseExpireAt: '2026-07-21T02:00:00.000Z',
      actualModelSeen: 'glm-5.2-alias',
      lastResponseModel: 'glm-5.2',
      cumulativeInputTokens: 12345,
    });
    // null 的 snake 日期列不映射为 null，而是 undefined
    expect(record.failedAt).toBeUndefined();
    expect(record.cancelledAt).toBeUndefined();
  });

  it('snake_case 可空列为 null 时全部收敛为 undefined，metadata null 兜底为 {}', async () => {
    const record = await normalizeViaGet({
      run_id: 'run-2',
      session_id: 'sess-2',
      user_id: null,
      tenant_id: null,
      status: 'pending',
      status_reason: null,
      model: null,
      channel: null,
      requested_at: '2026-07-18T00:00:00.000Z',
      started_at: null,
      updated_at: '2026-07-18T00:00:00.000Z',
      worker_id: null,
      lease_expires_at: null,
      idempotency_key: null,
      execution_target: null,
      workspace_id: null,
      sandbox_scope_id: null,
      metadata: null,
      last_response_id: null,
      last_response_expire_at: null,
      actual_model_seen: null,
      last_response_model: null,
      cumulative_input_tokens: null,
    });
    expect(record).toEqual({
      runId: 'run-2',
      sessionId: 'sess-2',
      status: 'pending',
      requestedAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T00:00:00.000Z',
      metadata: {},
    });
    expect(record.userId).toBeUndefined();
    expect(record.startedAt).toBeUndefined();
    expect(record.cumulativeInputTokens).toBeUndefined();
  });

  it('camelCase 输入（内存态记录回灌）同样被接受', async () => {
    const record = await normalizeViaGet({
      runId: 'run-3',
      sessionId: 'sess-3',
      userId: 'u3',
      tenantId: 'wain',
      status: 'running',
      requestedAt: '2026-07-18T01:00:00.000Z',
      startedAt: undefined,
      updatedAt: '2026-07-18T01:02:00.000Z',
      workerId: 'w3',
      idempotencyKey: 'idem-3',
      metadata: { source: 'memory' },
      lastResponseId: 'resp-3',
      cumulativeInputTokens: 42,
    });
    expect(record).toEqual({
      runId: 'run-3',
      sessionId: 'sess-3',
      userId: 'u3',
      tenantId: 'wain',
      status: 'running',
      requestedAt: '2026-07-18T01:00:00.000Z',
      updatedAt: '2026-07-18T01:02:00.000Z',
      workerId: 'w3',
      idempotencyKey: 'idem-3',
      metadata: { source: 'memory' },
      lastResponseId: 'resp-3',
      cumulativeInputTokens: 42,
    });
  });

  it.each([
    ['12345', 12345],
    [678, 678],
    ['12abc', 12], // parseInt 前缀解析：宽松但当前如此
    ['abc', 0], // NaN || 0 → 0
    [undefined, undefined], // 双写法均缺失 → undefined
  ])('cumulative_input_tokens=%j → cumulativeInputTokens=%j', async (input, expected) => {
    const record = await normalizeViaGet({
      run_id: 'run-c',
      session_id: 'sess-c',
      status: 'pending',
      requested_at: '2026-07-18T00:00:00.000Z',
      updated_at: '2026-07-18T00:00:00.000Z',
      metadata: {},
      ...(input === undefined ? {} : { cumulative_input_tokens: input }),
    });
    expect(record.cumulativeInputTokens).toBe(expected);
  });

  it('camelCase 输入的可空日期字段为 null 时统一收敛为 undefined', async () => {
    const record = await normalizeViaGet({
      runId: 'run-4',
      sessionId: 'sess-4',
      status: 'running',
      requestedAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T00:00:00.000Z',
      startedAt: null,
      completedAt: null,
      failedAt: null,
      cancelledAt: null,
      leaseExpiresAt: null,
      lastResponseExpireAt: null,
      metadata: {},
    });
    expect(record.startedAt).toBeUndefined();
    expect(record.completedAt).toBeUndefined();
    expect(record.failedAt).toBeUndefined();
    expect(record.cancelledAt).toBeUndefined();
    expect(record.leaseExpiresAt).toBeUndefined();
    expect(record.lastResponseExpireAt).toBeUndefined();
  });
});

describe('parseCount（经 PgRunStore.getActiveCounts 驱动）', () => {
  it('PG COUNT 字符串/数字/null 混合解析，blocking=pending+running，total=五态之和', async () => {
    const { store } = makeRunStoreRig([{
      pending: '2',
      running: 3, // number 直通
      waiting_approval: '1',
      waiting_user: '0',
      waiting_hand: null, // null → 0
    }]);
    await expect(store.getActiveCounts()).resolves.toEqual({
      pending: 2,
      running: 3,
      waitingApproval: 1,
      waitingUser: 0,
      waitingHand: 0,
      blocking: 5,
      total: 6,
    });
  });

  it('空结果集（rows 无行）与垃圾串一律归零', async () => {
    const { store: emptyStore } = makeRunStoreRig([]);
    await expect(emptyStore.getActiveCounts()).resolves.toEqual({
      pending: 0,
      running: 0,
      waitingApproval: 0,
      waitingUser: 0,
      waitingHand: 0,
      blocking: 0,
      total: 0,
    });

    const { store: junkStore } = makeRunStoreRig([{
      pending: 'abc',
      running: '',
      waiting_approval: undefined,
      waiting_user: '7',
      waiting_hand: '0',
    }]);
    const counts = await junkStore.getActiveCounts();
    expect(counts.pending).toBe(0); // parseInt('abc') → NaN || 0
    expect(counts.running).toBe(0); // parseInt('') → NaN || 0
    expect(counts.waitingApproval).toBe(0); // undefined → 0
    expect(counts.waitingUser).toBe(7);
    expect(counts.total).toBe(7);
  });
});

describe('sanitizeIdentifier（经 PgRunStore 构造函数驱动）', () => {
  it.each(['1bad', 'bad-prefix', 'bad;DROP TABLE x', 'bad prefix', ''])(
    '非法 tablePrefix %j 构造即 throw，错误消息回显原值',
    (prefix) => {
      expect(() => new PgRunStore({ pool: {} as any, tablePrefix: prefix }))
        .toThrow(`非法 PG tablePrefix: ${prefix}`);
    },
  );

  it('合法前缀拼出 <prefix>_runs；缺省 runtime；下划线起头合法', () => {
    expect(new PgRunStore({ pool: {} as any }).runsTable).toBe('runtime_runs');
    expect(new PgRunStore({ pool: {} as any, tablePrefix: 'runtime_v2' }).runsTable).toBe('runtime_v2_runs');
    expect(new PgRunStore({ pool: {} as any, tablePrefix: '_x9' }).runsTable).toBe('_x9_runs');
  });

  it('pool 与 connectionString 均缺失时构造 throw', () => {
    expect(() => new PgRunStore({})).toThrow('PgRunStore requires either pool or connectionString');
  });
});

describe('updateResponseSessionState 动态 SET/参数位装配（现场增补的 A 切片）', () => {
  it('全量 patch：SET 片段按固定顺序编号 $3..$7，delta 走累加而非覆盖', async () => {
    const { store, query } = makeRunStoreRig([]);
    await store.updateResponseSessionState('run-9', {
      lastResponseId: 'resp-9',
      lastResponseExpireAt: '2026-07-22T00:00:00.000Z',
      actualModelSeen: 'glm-actual',
      lastResponseModel: 'glm-5.2',
      cumulativeInputTokensDelta: 1234,
    });
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0]! as [string, unknown[]];
    expect(sql).toContain(
      'SET updated_at = $2, last_response_id = $3, last_response_expire_at = $4, '
      + 'actual_model_seen = $5, last_response_model = $6, '
      + 'cumulative_input_tokens = cumulative_input_tokens + $7',
    );
    expect(params[0]).toBe('run-9');
    expect(typeof params[1]).toBe('string'); // updated_at = now ISO
    expect(params.slice(2)).toEqual(['resp-9', '2026-07-22T00:00:00.000Z', 'glm-actual', 'glm-5.2', 1234]);
  });

  it('显式 null 清空：参与 SET 且参数为 null；undefined 字段不进 SET', async () => {
    const { store, query } = makeRunStoreRig([]);
    await store.updateResponseSessionState('run-10', {
      lastResponseId: null,
      lastResponseModel: null,
      // lastResponseExpireAt / actualModelSeen / delta 均 undefined → 保留原值
    });
    const [sql, params] = query.mock.calls[0]! as [string, unknown[]];
    expect(sql).toContain('SET updated_at = $2, last_response_id = $3, last_response_model = $4');
    expect(sql).not.toContain('last_response_expire_at');
    expect(sql).not.toContain('actual_model_seen');
    expect(sql).not.toContain('cumulative_input_tokens');
    expect(params.slice(2)).toEqual([null, null]);
  });

  it('空 patch 与 delta=0 短路：不发 UPDATE，回退为 get() 的 SELECT', async () => {
    const { store, query } = makeRunStoreRig([]);
    const result = await store.updateResponseSessionState('run-11', { cumulativeInputTokensDelta: 0 });
    expect(result).toBeNull(); // 假 pool 无行 → get 返回 null
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0]! as [string, unknown[]];
    expect(sql).toContain('SELECT row_to_json');
    expect(sql).not.toContain('UPDATE');
    expect(params).toEqual(['run-11']);
  });
});

// ════════════════════════ sessionProjectionStore.ts ════════════════════════

describe('PgSessionProjectionStore.list 查询构造（假 pool 捕获 SQL+params）', () => {
  it('无过滤缺省：仅 deleted_at IS NULL 子句，limit 50→LIMIT 参数 51，双键降序排序', async () => {
    const { store, query } = makeSessionRig([]);
    const result = await store.list();
    expect(result).toEqual({ items: [] }); // 空结果无 nextCursor
    const [sql, params] = query.mock.calls[0]! as [string, unknown[]];
    expect(sql).toContain('WHERE deleted_at IS NULL');
    expect(sql).toContain('ORDER BY updated_at DESC, session_id DESC');
    expect(sql).toContain('LIMIT $1');
    expect(params).toEqual([51]); // limit+1 探测 hasMore
  });

  it.each([
    [0, 2], // clamp 下界 1 → +1
    [-5, 2],
    [1, 2],
    [100, 101], // clamp 上界 100
    [999, 101],
  ])('limit=%i clamp 后 LIMIT 参数为 %i', async (limit, expectedParam) => {
    const { store, query } = makeSessionRig([]);
    await store.list({ limit });
    const [, params] = query.mock.calls[0]! as [string, unknown[]];
    expect(params[params.length - 1]).toBe(expectedParam);
  });

  it('全过滤组合：子句参数位逐一对应，includeDeleted=true 时不加 deleted_at 子句', async () => {
    const { store, query } = makeSessionRig([]);
    await store.list({
      tenantId: 'kaiyan',
      userId: 'u1',
      titleContains: 'Foo',
      status: 'running',
      kind: 'subagent',
      model: 'glm-5.2',
      channel: 'web',
      orgAgentId: 'oa-1',
      updatedFrom: '2026-07-01T00:00:00.000Z',
      updatedTo: '2026-07-19T00:00:00.000Z',
      includeDeleted: true,
      cursor: { updatedAt: '2026-07-10T00:00:00.000Z', sessionId: 'sess-cursor' },
      limit: 10,
    });
    const [sql, params] = query.mock.calls[0]! as [string, unknown[]];
    expect(sql).toContain('tenant_id = $1');
    expect(sql).toContain('user_id = $2');
    expect(sql).toContain('title IS NOT NULL AND position(lower($3) in lower(title)) > 0');
    expect(sql).toContain('runtime_status = $4');
    expect(sql).toContain('kind = $5');
    expect(sql).toContain('model = $6');
    expect(sql).toContain('channel = $7');
    expect(sql).toContain(`meta_json->>'orgAgentId' = $8`);
    expect(sql).toContain('updated_at >= $9::timestamptz');
    expect(sql).toContain('updated_at <= $10::timestamptz');
    // cursor 双键条件：同刻并列行退化比较 session_id，参数位共享 $11
    expect(sql).toContain(
      '(updated_at < $11::timestamptz OR (updated_at = $11::timestamptz AND session_id < $12))',
    );
    expect(sql).toContain('LIMIT $13');
    expect(sql).not.toContain('deleted_at IS NULL');
    expect(params).toEqual([
      'kaiyan', 'u1', 'Foo', 'running', 'subagent', 'glm-5.2', 'web', 'oa-1',
      '2026-07-01T00:00:00.000Z', '2026-07-19T00:00:00.000Z',
      '2026-07-10T00:00:00.000Z', 'sess-cursor', 11,
    ]);
  });

  it('hasOrgAgent 单独生效走 IS NOT NULL（无参数）；orgAgentId 指定时优先于 hasOrgAgent', async () => {
    const { store: hasOnly, query: q1 } = makeSessionRig([]);
    await hasOnly.list({ hasOrgAgent: true });
    const [sql1, params1] = q1.mock.calls[0]! as [string, unknown[]];
    expect(sql1).toContain(`meta_json->>'orgAgentId' IS NOT NULL`);
    expect(params1).toEqual([51]);

    const { store: both, query: q2 } = makeSessionRig([]);
    await both.list({ orgAgentId: 'oa-2', hasOrgAgent: true });
    const [sql2, params2] = q2.mock.calls[0]! as [string, unknown[]];
    expect(sql2).toContain(`meta_json->>'orgAgentId' = $1`);
    expect(sql2).not.toContain('IS NOT NULL');
    expect(params2).toEqual(['oa-2', 51]);
  });

  it('cursor 单独使用时双键参数位为 $1/$2', async () => {
    const { store, query } = makeSessionRig([]);
    await store.list({
      cursor: { updatedAt: '2026-07-10T00:00:00.000Z', sessionId: 's-1' },
      limit: 5,
      includeDeleted: true,
    });
    const [sql, params] = query.mock.calls[0]! as [string, unknown[]];
    expect(sql).toContain(
      '(updated_at < $1::timestamptz OR (updated_at = $1::timestamptz AND session_id < $2))',
    );
    expect(params).toEqual(['2026-07-10T00:00:00.000Z', 's-1', 6]);
  });

  it('回吐 limit+1 行 → 截断为 limit 并给出末行 nextCursor；恰好 limit 行 → 无 nextCursor', async () => {
    const mkRow = (sessionId: string, updatedAt: string) => ({
      row_json: { session_id: sessionId, tenant_id: 'kaiyan', kind: 'user', updated_at: updatedAt, meta_json: {} },
    });
    const { store: more } = makeSessionRig([
      mkRow('s-3', '2026-07-18T03:00:00.000Z'),
      mkRow('s-2', '2026-07-18T02:00:00.000Z'),
      mkRow('s-1', '2026-07-18T01:00:00.000Z'), // 第 limit+1 行：仅用于 hasMore 探测，不进 items
    ]);
    const paged = await more.list({ limit: 2 });
    expect(paged.items.map((item) => item.sessionId)).toEqual(['s-3', 's-2']);
    expect(paged.nextCursor).toEqual({ updatedAt: '2026-07-18T02:00:00.000Z', sessionId: 's-2' });

    const { store: exact } = makeSessionRig([
      mkRow('s-3', '2026-07-18T03:00:00.000Z'),
      mkRow('s-2', '2026-07-18T02:00:00.000Z'),
    ]);
    const lastPage = await exact.list({ limit: 2 });
    expect(lastPage.items).toHaveLength(2);
    expect(lastPage.nextCursor).toBeUndefined();
  });
});

describe('PgSessionProjectionStore.planBackfill 差集计算（真文件 + 假 pool）', () => {
  const cleanupDirs: string[] = [];

  afterEach(() => {
    for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
    cleanupDirs.length = 0;
  });

  function makeScanRoot(): { root: string; validId: string; subId: string } {
    const root = mkdtempSync(join(tmpdir(), 'runtime-stores-backfill-'));
    cleanupDirs.push(root);
    const userDir = join(root, 'kaiyan', 'ky1');
    mkdirSync(userDir, { recursive: true });
    const validId = randomUUID();
    const subId = `sub-${randomUUID()}`;
    const meta = JSON.stringify({ tenantId: 'kaiyan', userId: 'ky1', createdAt: '2026-07-01T00:00:00.000Z' });
    writeFileSync(join(userDir, `${validId}.meta.json`), meta);
    writeFileSync(join(userDir, `${subId}.meta.json`), meta);
    writeFileSync(join(userDir, 'agent-deadbeef.meta.json'), meta); // 非法 basename
    // 已知缺陷记录：合法 uuid basename 但 JSON 损坏，也被计入 skippedInvalidBasename
    // （sessionProjectionStore.ts L437-439 catch 复用同一计数器，计数器名与实际语义不符）
    writeFileSync(join(userDir, `${randomUUID()}.meta.json`), '{oops');
    writeFileSync(join(userDir, 'note.txt'), 'not a meta'); // 非 .meta.json：不计 scanned
    return { root, validId, subId };
  }

  it('磁盘现存 ∖ PG 已投影 差集：ghost 行计入 wouldDeleteMissing，损坏 JSON 计入 skipped', async () => {
    const { root, validId, subId } = makeScanRoot();
    const ghostId = randomUUID(); // 仅在 PG、不在磁盘 → 待删
    const { store, query } = makeSessionRig([
      { session_id: validId },
      { session_id: ghostId },
    ]);
    const plan = await store.planBackfill(root);
    expect(plan.root).toBe(root);
    expect(plan.scannedMetaFiles).toBe(4); // 3 合法命名 + 1 损坏 JSON；note.txt 不计
    expect(plan.validMetaFiles).toBe(2);
    expect(plan.skippedInvalidBasename).toBe(2); // 非法 basename 1 + 损坏 JSON 1
    expect(plan.existingRows).toBe(2);
    expect(plan.wouldUpsert).toBe(2);
    expect(plan.wouldDeleteMissing).toBe(1); // 只有 ghostId 不在磁盘集合
    expect([...plan.currentSessionIds].sort()).toEqual([validId, subId].sort());
    // 唯一一次 PG 交互是查已投影 session_id 全集
    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0]![0])).toContain('SELECT session_id FROM runtime_sessions');
  });

  it('PG 查询失败时降级：existingRows/wouldDeleteMissing 为 null，扫描侧结果不受影响', async () => {
    const { root, validId, subId } = makeScanRoot();
    const query = vi.fn(async () => {
      throw new Error('pg down');
    });
    const store = new PgSessionProjectionStore({ pool: { query } as any });
    const plan = await store.planBackfill(root);
    expect(plan.existingRows).toBeNull();
    expect(plan.wouldDeleteMissing).toBeNull();
    expect(plan.wouldUpsert).toBe(2);
    expect([...plan.currentSessionIds].sort()).toEqual([validId, subId].sort());
  });

  it('空目录：全零计数，PG 空表时差集为 0', async () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-stores-backfill-empty-'));
    cleanupDirs.push(root);
    const { store } = makeSessionRig([]);
    const plan = await store.planBackfill(root);
    expect(plan).toEqual({
      root,
      scannedMetaFiles: 0,
      validMetaFiles: 0,
      skippedInvalidBasename: 0,
      existingRows: 0,
      wouldUpsert: 0,
      wouldDeleteMissing: 0,
      currentSessionIds: [],
    });
  });
});

describe('sessionProjectionStore 的 sanitizeIdentifier 与构造守卫', () => {
  it('runtimeSessionsDdl 非法前缀 throw；缺省前缀产出 runtime_sessions 四条 DDL', () => {
    expect(() => runtimeSessionsDdl('bad-prefix')).toThrow('非法 PG tablePrefix: bad-prefix');
    const ddl = runtimeSessionsDdl();
    expect(ddl).toHaveLength(4);
    for (const statement of ddl) expect(statement).toContain('runtime_sessions');
    expect(ddl[0]).toContain('CREATE TABLE IF NOT EXISTS runtime_sessions');
  });

  it('构造函数：非法 tablePrefix throw、缺 pool/connectionString throw、合法前缀拼表名', () => {
    expect(() => new PgSessionProjectionStore({ pool: {} as any, tablePrefix: '9bad' }))
      .toThrow('非法 PG tablePrefix: 9bad');
    expect(() => new PgSessionProjectionStore({}))
      .toThrow('PgSessionProjectionStore requires either pool or connectionString');
    expect(new PgSessionProjectionStore({ pool: {} as any, tablePrefix: 'proj_v2' }).sessionsTable)
      .toBe('proj_v2_sessions');
  });
});
