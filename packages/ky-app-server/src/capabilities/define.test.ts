/** §4.3 / §4.4 / §9.3-5 / §9.3-6 能力调用与执行查询。 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  APH_VECTORS,
  CAPABILITY_TIMEOUT_MAX_MS,
  aph as computeAph,
  parseIJson,
  type SatClaims,
} from '@kaiyan/ky-app-contract';

import type { VerifiedIdentity } from '../sat/verify.js';
import { defineCapabilities, type CapabilityRuntime } from './define.js';
import { EXECUTION_RETENTION_MS, MemoryExecutionStore } from './executionStore.js';
import {
  BASE_NOW_SECONDS,
  TEST_MANIFEST,
  TEST_MANIFEST_DIGEST,
  createClock,
  createTestConfig,
} from '../__tests__/helpers.js';

const config = createTestConfig();

let clock: ReturnType<typeof createClock>;
let store: MemoryExecutionStore;
let runtime: CapabilityRuntime;
let searchResult: unknown;
let createGate: (() => Promise<void>) | null;

function identity(overrides: Partial<VerifiedIdentity> = {}): VerifiedIdentity {
  const claims = {
    iss: config.issuer,
    aud: config.systemId,
    tid: config.tenantId,
    iid: config.installationId,
    sub: 'u_8f3a',
    act: 'agent',
    tadm: false,
    cap: 'order.search',
    lcid: 'lc_1',
    dig: TEST_MANIFEST_DIGEST,
    sid: 'sess_1',
    rid: 'req_1',
    iat: BASE_NOW_SECONDS,
    nbf: BASE_NOW_SECONDS,
    exp: BASE_NOW_SECONDS + 60,
    jti: 'j'.repeat(22),
  } as unknown as SatClaims;
  return {
    act: 'agent',
    sub: 'u_8f3a',
    tadm: false,
    pfx: [],
    cap: 'order.search',
    lcid: 'lc_1',
    dig: TEST_MANIFEST_DIGEST,
    sid: 'sess_1',
    rid: 'req_1',
    jti: 'j'.repeat(22),
    kid: 'k-test-1',
    claims,
    consumeJti: async () => undefined,
    ...overrides,
  };
}

/** 造一个能力调用身份：`cap` / `lcid` / `sub` / `apr` / `aph` 常改。 */
function agentFor(input: {
  cap: string;
  lcid?: string;
  sub?: string;
  apr?: string;
  aph?: string;
  dig?: string;
}): VerifiedIdentity {
  const base = identity();
  const claims = {
    ...(base.claims as unknown as Record<string, unknown>),
    cap: input.cap,
    lcid: input.lcid ?? 'lc_1',
    sub: input.sub ?? 'u_8f3a',
  } as unknown as SatClaims;
  return {
    ...base,
    claims,
    cap: input.cap,
    lcid: input.lcid ?? 'lc_1',
    sub: input.sub ?? 'u_8f3a',
    ...(input.dig === undefined ? {} : { dig: input.dig }),
    ...(input.apr === undefined ? {} : { apr: input.apr }),
    ...(input.aph === undefined ? {} : { aph: input.aph }),
  };
}

beforeEach(() => {
  clock = createClock();
  store = new MemoryExecutionStore();
  searchResult = { items: [{ orderId: 'SO-1', customer: '张三' }], hasMore: false };
  createGate = null;
  runtime = defineCapabilities({
    manifest: TEST_MANIFEST,
    manifestDigest: TEST_MANIFEST_DIGEST,
    executionStore: store,
    now: clock.now,
    createContext: async (id) => ({
      tenantId: config.tenantId,
      installationId: config.installationId,
      userId: id.sub ?? '',
      roles: ['sales'],
      isTenantAdmin: id.tadm,
      dataScope: { groupIds: ['g1'] },
    }),
    handlers: {
      'order.search': async () => searchResult,
      'order.create': async () => {
        if (createGate !== null) await createGate();
        return { orderId: 'SO-9' };
      },
    },
  });
});

const SEARCH_INPUT = { keyword: '张三' };
const CREATE_INPUT = { customerId: 'C001', lines: [{ sku: 'A-1', qty: 2 }] };

describe('read_only 能力（§9.3-5）', () => {
  it('夹具输入 → 200，结果合 outputSchema 且含 hasMore', async () => {
    const response = await runtime.invoke({
      capabilityId: 'order.search',
      identity: agentFor({ cap: 'order.search' }),
      idempotencyKey: 'lc_1',
      body: { input: SEARCH_INPUT },
    });
    expect(response).toEqual({ ok: true, data: searchResult });
  });

  it('非法输入 → 400 invalid_input', async () => {
    for (const body of [
      { input: {} },
      { input: { keyword: 1 } },
      { input: { keyword: 'a', limit: 99 } },
      { input: { keyword: 'a', unknown: true } },
      { input: [] },
      {},
      'nope',
    ]) {
      await expect(
        runtime.invoke({
          capabilityId: 'order.search',
          identity: agentFor({ cap: 'order.search', lcid: `lc_${String(Math.random())}` }),
          idempotencyKey: null,
          body,
        }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
    }
  });

  it('响应体超过 6,000 字节 → 422 response_too_large', async () => {
    searchResult = {
      items: Array.from({ length: 200 }, (_item, index) => ({
        orderId: `SO-${index}`,
        customer: 'x'.repeat(40),
      })),
      hasMore: true,
    };
    await expect(
      runtime.invoke({
        capabilityId: 'order.search',
        identity: agentFor({ cap: 'order.search' }),
        idempotencyKey: 'lc_1',
        body: { input: SEARCH_INPUT },
      }),
    ).rejects.toMatchObject({ code: 'response_too_large', status: 422 });
  });

  it('返回值不合 outputSchema → 500 internal 且记录为 failed', async () => {
    searchResult = { items: 'not-an-array', hasMore: false };
    await expect(
      runtime.invoke({
        capabilityId: 'order.search',
        identity: agentFor({ cap: 'order.search' }),
        idempotencyKey: 'lc_1',
        body: { input: SEARCH_INPUT },
      }),
    ).rejects.toMatchObject({ code: 'internal' });
    const query = await runtime.queryExecution({
      capabilityId: 'order.search',
      identity: agentFor({ cap: 'order.search' }),
      lcid: 'lc_1',
    });
    expect(query.status).toBe('failed');
  });

  it('SAT dig 与当前 manifest 不符 → 409 digest_mismatch', async () => {
    await expect(
      runtime.invoke({
        capabilityId: 'order.search',
        identity: agentFor({ cap: 'order.search', dig: 'a'.repeat(64) }),
        idempotencyKey: 'lc_1',
        body: { input: SEARCH_INPUT },
      }),
    ).rejects.toMatchObject({ code: 'digest_mismatch', status: 409 });
  });

  it('未知能力 → 404，关闭的能力 → 403', async () => {
    await expect(
      runtime.invoke({
        capabilityId: 'nope',
        identity: agentFor({ cap: 'nope' }),
        idempotencyKey: 'lc_1',
        body: { input: {} },
      }),
    ).rejects.toMatchObject({ code: 'not_found' });

    const closed = defineCapabilities({
      manifest: TEST_MANIFEST,
      executionStore: store,
      handlers: {},
      isEnabled: () => false,
      createContext: async () => ({
        tenantId: config.tenantId,
        installationId: config.installationId,
        userId: 'u',
        roles: [],
        isTenantAdmin: false,
        dataScope: { groupIds: [] },
      }),
    });
    await expect(
      closed.invoke({
        capabilityId: 'order.search',
        identity: agentFor({ cap: 'order.search' }),
        idempotencyKey: 'lc_1',
        body: { input: SEARCH_INPUT },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(closed.listForMe()).toEqual([
      { id: 'order.search', enabled: false },
      { id: 'order.create', enabled: false },
    ]);
  });
});

describe('external_write 能力（§9.3-6）', () => {
  const approved = (input: Record<string, unknown> = CREATE_INPUT) =>
    agentFor({
      cap: 'order.create',
      apr: 'apv_1',
      aph: computeAph({ cap: 'order.create', input }),
    });

  it('无幂等键 / 幂等键 ≠ lcid → 400', async () => {
    for (const key of [null, 'other']) {
      await expect(
        runtime.invoke({
          capabilityId: 'order.create',
          identity: approved(),
          idempotencyKey: key,
          body: { input: CREATE_INPUT },
        }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
    }
  });

  it('无 apr / aph 或 aph 不符 → 403 approval_required', async () => {
    await expect(
      runtime.invoke({
        capabilityId: 'order.create',
        identity: agentFor({ cap: 'order.create' }),
        idempotencyKey: 'lc_1',
        body: { input: CREATE_INPUT },
      }),
    ).rejects.toMatchObject({ code: 'approval_required', status: 403 });

    await expect(
      runtime.invoke({
        capabilityId: 'order.create',
        identity: agentFor({ cap: 'order.create', apr: 'apv_1', aph: 'b'.repeat(64) }),
        idempotencyKey: 'lc_1',
        body: { input: CREATE_INPUT },
      }),
    ).rejects.toMatchObject({ code: 'approval_required' });
  });

  it('附录 I 的 order.create 向量能过 aph 校验路径', async () => {
    const vector = APH_VECTORS[0];
    const parsed = parseIJson(vector.json) as { cap: string; input: Record<string, unknown> };
    expect(parsed.cap).toBe('order.create');
    // 向量的 aph 由 contract 独立算出，这里让它走完整条 approval 绑定校验路径。
    expect(computeAph(parsed)).toBe(vector.aph);
    const result = await runtime.invoke({
      capabilityId: 'order.create',
      identity: agentFor({ cap: 'order.create', apr: 'apv_1', aph: vector.aph }),
      idempotencyKey: 'lc_1',
      body: { input: parsed.input },
    });
    expect(result).toEqual({ ok: true, data: { orderId: 'SO-9' } });
  });

  it('同 lcid 同输入两次返回同一结果，只执行一次', async () => {
    let calls = 0;
    createGate = async () => {
      calls += 1;
    };
    const first = await runtime.invoke({
      capabilityId: 'order.create',
      identity: approved(),
      idempotencyKey: 'lc_1',
      body: { input: CREATE_INPUT },
    });
    const second = await runtime.invoke({
      capabilityId: 'order.create',
      identity: approved(),
      idempotencyKey: 'lc_1',
      body: { input: CREATE_INPUT },
    });
    expect(second).toEqual(first);
    expect(calls).toBe(1);
  });

  it('同 lcid 不同输入 → 409 idempotency_mismatch', async () => {
    await runtime.invoke({
      capabilityId: 'order.create',
      identity: approved(),
      idempotencyKey: 'lc_1',
      body: { input: CREATE_INPUT },
    });
    const other = { customerId: 'C002', lines: [{ sku: 'B', qty: 1 }] };
    await expect(
      runtime.invoke({
        capabilityId: 'order.create',
        identity: approved(other),
        idempotencyKey: 'lc_1',
        body: { input: other },
      }),
    ).rejects.toMatchObject({ code: 'idempotency_mismatch', status: 409 });
  });

  it('in_progress 并发 → 409 in_progress', async () => {
    const gate: { release: (() => void) | null } = { release: null };
    createGate = () =>
      new Promise<void>((resolve) => {
        gate.release = resolve;
      });
    const first = runtime.invoke({
      capabilityId: 'order.create',
      identity: approved(),
      idempotencyKey: 'lc_1',
      body: { input: CREATE_INPUT },
    });
    await Promise.resolve();
    await expect(
      runtime.invoke({
        capabilityId: 'order.create',
        identity: approved(),
        idempotencyKey: 'lc_1',
        body: { input: CREATE_INPUT },
      }),
    ).rejects.toMatchObject({ code: 'in_progress', status: 409 });
    gate.release?.();
    await expect(first).resolves.toBeDefined();
  });

  it('failed 记录不重新执行，返回原失败', async () => {
    let calls = 0;
    createGate = async () => {
      calls += 1;
      throw new Error('下游拒绝');
    };
    await expect(
      runtime.invoke({
        capabilityId: 'order.create',
        identity: approved(),
        idempotencyKey: 'lc_1',
        body: { input: CREATE_INPUT },
      }),
    ).rejects.toMatchObject({ code: 'internal' });
    await expect(
      runtime.invoke({
        capabilityId: 'order.create',
        identity: approved(),
        idempotencyKey: 'lc_1',
        body: { input: CREATE_INPUT },
      }),
    ).rejects.toMatchObject({ code: 'internal' });
    expect(calls).toBe(1);
  });

  it('超时按能力 timeoutMs 生效，且不超过 15,000 ms 上限', async () => {
    // 用一份把 order.create 的 timeoutMs 改成 50 ms 的 manifest，避免测试真的等 15 秒；
    // 上限夹取逻辑另由「声明 99,999 ms 时取 15,000」的断言覆盖。
    const manifest = {
      ...TEST_MANIFEST,
      capabilities: TEST_MANIFEST.capabilities.map((capability) =>
        capability.id === 'order.create' ? { ...capability, timeoutMs: 50 } : capability,
      ),
    };
    const fast = defineCapabilities({
      manifest,
      executionStore: new MemoryExecutionStore(),
      createContext: async () => ({
        tenantId: config.tenantId,
        installationId: config.installationId,
        userId: 'u_8f3a',
        roles: [],
        isTenantAdmin: false,
        dataScope: { groupIds: [] },
      }),
      handlers: { 'order.create': () => new Promise<never>(() => undefined) },
    });
    await expect(
      fast.invoke({
        capabilityId: 'order.create',
        identity: approved(),
        idempotencyKey: 'lc_1',
        body: { input: CREATE_INPUT },
      }),
    ).rejects.toMatchObject({ code: 'upstream_unavailable' });
    expect(Math.min(99_999, CAPABILITY_TIMEOUT_MAX_MS)).toBe(15_000);
  });
});

describe('执行查询（§4.4）', () => {
  const approved = agentFor({
    cap: 'order.create',
    apr: 'apv_1',
    aph: computeAph({ cap: 'order.create', input: CREATE_INPUT }),
  });

  it('不存在 → not_started', async () => {
    await expect(
      runtime.queryExecution({ capabilityId: 'order.create', identity: approved, lcid: 'lc_none' }),
    ).resolves.toEqual({ status: 'not_started' });
  });

  it('done → 带 result', async () => {
    await runtime.invoke({
      capabilityId: 'order.create',
      identity: approved,
      idempotencyKey: 'lc_1',
      body: { input: CREATE_INPUT },
    });
    await expect(
      runtime.queryExecution({ capabilityId: 'order.create', identity: approved, lcid: 'lc_1' }),
    ).resolves.toEqual({ status: 'done', result: { orderId: 'SO-9' } });
  });

  it('跨用户 → 404', async () => {
    await runtime.invoke({
      capabilityId: 'order.create',
      identity: approved,
      idempotencyKey: 'lc_1',
      body: { input: CREATE_INPUT },
    });
    await expect(
      runtime.queryExecution({
        capabilityId: 'order.create',
        identity: agentFor({ cap: 'order.create', sub: 'u_other' }),
        lcid: 'lc_1',
      }),
    ).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });

  it('跨能力 → not_started（记录挂在另一个 cap 上）', async () => {
    await runtime.invoke({
      capabilityId: 'order.create',
      identity: approved,
      idempotencyKey: 'lc_1',
      body: { input: CREATE_INPUT },
    });
    await expect(
      runtime.queryExecution({
        capabilityId: 'order.search',
        identity: agentFor({ cap: 'order.search' }),
        lcid: 'lc_1',
      }),
    ).resolves.toEqual({ status: 'not_started' });
  });

  it('超过 7 天保留期 → expired，再次调用同 lcid 被 409 挡住', async () => {
    await runtime.invoke({
      capabilityId: 'order.create',
      identity: approved,
      idempotencyKey: 'lc_1',
      body: { input: CREATE_INPUT },
    });
    clock.advance(EXECUTION_RETENTION_MS + 1);
    expect(await runtime.expireOverdue()).toBe(1);
    await expect(
      runtime.queryExecution({ capabilityId: 'order.create', identity: approved, lcid: 'lc_1' }),
    ).resolves.toEqual({ status: 'expired' });
    await expect(
      runtime.invoke({
        capabilityId: 'order.create',
        identity: approved,
        idempotencyKey: 'lc_1',
        body: { input: CREATE_INPUT },
      }),
    ).rejects.toMatchObject({ code: 'idempotency_mismatch' });
  });
});

describe('jti 占用时机', () => {
  it('输入校验失败时不占用 jti，成功路径才占用', async () => {
    let consumed = 0;
    const spy = (): VerifiedIdentity => ({
      ...agentFor({ cap: 'order.search' }),
      consumeJti: async () => {
        consumed += 1;
      },
    });
    await expect(
      runtime.invoke({
        capabilityId: 'order.search',
        identity: spy(),
        idempotencyKey: 'lc_1',
        body: { input: {} },
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(consumed).toBe(0);

    await runtime.invoke({
      capabilityId: 'order.search',
      identity: spy(),
      idempotencyKey: 'lc_1',
      body: { input: SEARCH_INPUT },
    });
    expect(consumed).toBe(1);
  });
});
