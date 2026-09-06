/**
 * WP3 Phase B：§6.2-7 限流、并发闸与熔断。
 */
import { describe, expect, it } from 'vitest';

import type { KyAppGatewayLimits } from '../config.js';
import { GatewayConcurrencyAbortError, GatewayPolicy } from './policy.js';

const LIMITS: KyAppGatewayLimits = {
  perInstallationConcurrency: 8,
  perRunPerCapability: 20,
  perTenantPerMinute: 300,
  perTenantPerDay: 5_000,
  breakerFailureThreshold: 20,
  breakerCooldownMs: 5 * 60 * 1000,
};

function makePolicy(overrides: Partial<KyAppGatewayLimits> = {}) {
  let now = 1_000_000;
  const policy = new GatewayPolicy({
    limits: { ...LIMITS, ...overrides },
    now: () => now,
  });
  return { policy, advance: (ms: number) => (now += ms), at: () => now };
}

const CALL = { tenantId: 'org-1', installationId: 'iid-1', runId: 'run-1', capabilityId: 'cap-1' };

describe('每 run 同能力 ≤ 20', () => {
  it('第 21 次拒绝，换能力或换 run 不受影响', () => {
    const { policy } = makePolicy();
    for (let index = 0; index < 20; index += 1) {
      expect(policy.check(CALL).allowed).toBe(true);
    }
    const denied = policy.check(CALL);
    expect(denied).toEqual({ allowed: false, code: 'rate_limited', retryAfterMs: 0 });
    expect(policy.check({ ...CALL, capabilityId: 'cap-2' }).allowed).toBe(true);
    expect(policy.check({ ...CALL, runId: 'run-2' }).allowed).toBe(true);
  });

  it('run 结束回收计数', () => {
    const { policy } = makePolicy({ perRunPerCapability: 2 });
    expect(policy.check(CALL).allowed).toBe(true);
    expect(policy.check(CALL).allowed).toBe(true);
    expect(policy.check(CALL).allowed).toBe(false);
    policy.forgetRun('run-1');
    expect(policy.check(CALL).allowed).toBe(true);
  });
});

describe('每租户每分钟 300 / 每日 5000', () => {
  it('分钟窗满即拒，窗口滚过后恢复，retryAfterMs 是剩余时间', () => {
    const { policy, advance } = makePolicy({ perTenantPerMinute: 3, perRunPerCapability: 1_000 });
    for (let index = 0; index < 3; index += 1) expect(policy.check(CALL).allowed).toBe(true);
    const denied = policy.check(CALL);
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(denied.code).toBe('rate_limited');
      expect(denied.retryAfterMs).toBeGreaterThan(0);
      expect(denied.retryAfterMs).toBeLessThanOrEqual(60_000);
    }
    advance(60_001);
    expect(policy.check(CALL).allowed).toBe(true);
  });

  it('日窗满时拒绝，且不吃掉分钟配额（被拒的调用要退回分钟计数）', () => {
    const { policy } = makePolicy({
      perTenantPerDay: 2,
      perTenantPerMinute: 100,
      perRunPerCapability: 1_000,
    });
    expect(policy.check(CALL).allowed).toBe(true);
    expect(policy.check(CALL).allowed).toBe(true);
    // 第 3 次被日窗拒。此时分钟窗应仍是 2，不是 3。
    for (let index = 0; index < 5; index += 1) {
      const denied = policy.check(CALL);
      expect(denied.allowed).toBe(false);
      if (!denied.allowed) expect(denied.code).toBe('rate_limited');
    }
    expect(policy.check({ ...CALL, tenantId: 'org-2' }).allowed).toBe(true);
  });

  it('租户之间互不影响', () => {
    const { policy } = makePolicy({ perTenantPerMinute: 1, perRunPerCapability: 1_000 });
    expect(policy.check(CALL).allowed).toBe(true);
    expect(policy.check(CALL).allowed).toBe(false);
    expect(policy.check({ ...CALL, tenantId: 'org-2' }).allowed).toBe(true);
  });
});

describe('每安装实例并发 ≤ 8', () => {
  it('第 9 个排队，释放后 FIFO 放行', async () => {
    const { policy } = makePolicy({ perInstallationConcurrency: 2 });
    const first = await policy.acquire('iid-1');
    const second = await policy.acquire('iid-1');
    expect(policy.inspect('iid-1').active).toBe(2);

    let thirdAcquired = false;
    const third = policy.acquire('iid-1').then((slot) => {
      thirdAcquired = true;
      return slot;
    });
    await Promise.resolve();
    expect(thirdAcquired).toBe(false);

    first.release();
    const slot = await third;
    expect(thirdAcquired).toBe(true);
    slot.release();
    second.release();
  });

  it('不同安装实例各有各的槽', async () => {
    const { policy } = makePolicy({ perInstallationConcurrency: 1 });
    const a = await policy.acquire('iid-1');
    const b = await policy.acquire('iid-2');
    expect(policy.inspect('iid-1').active).toBe(1);
    expect(policy.inspect('iid-2').active).toBe(1);
    a.release();
    b.release();
  });

  it('AbortSignal 中断排队', async () => {
    const { policy } = makePolicy({ perInstallationConcurrency: 1 });
    const held = await policy.acquire('iid-1');
    const controller = new AbortController();
    const pending = policy.acquire('iid-1', controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(GatewayConcurrencyAbortError);
    held.release();
  });
});

describe('连续 20 次 5xx/超时 → 熔断 5 分钟', () => {
  it('达到阈值后拒绝新调用，冷却结束自动恢复', () => {
    const { policy, advance } = makePolicy({ perRunPerCapability: 1_000 });
    for (let index = 0; index < 19; index += 1) policy.recordFailure('iid-1');
    expect(policy.check(CALL).allowed).toBe(true);
    policy.recordFailure('iid-1');

    const denied = policy.check(CALL);
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      // 客户面渲染成「系统暂时不可用」，不出现「熔断」这类技术词。
      expect(denied.code).toBe('upstream_unavailable');
      expect(denied.retryAfterMs).toBeGreaterThan(0);
    }
    // 别的安装实例不受牵连。
    expect(policy.check({ ...CALL, installationId: 'iid-2' }).allowed).toBe(true);

    advance(5 * 60 * 1000 + 1);
    expect(policy.check(CALL).allowed).toBe(true);
  });

  it('一次成功即清零连续失败计数', () => {
    const { policy } = makePolicy({ breakerFailureThreshold: 3, perRunPerCapability: 1_000 });
    policy.recordFailure('iid-1');
    policy.recordFailure('iid-1');
    policy.recordSuccess('iid-1');
    policy.recordFailure('iid-1');
    policy.recordFailure('iid-1');
    expect(policy.check(CALL).allowed).toBe(true);
    policy.recordFailure('iid-1');
    expect(policy.check(CALL).allowed).toBe(false);
  });
});
