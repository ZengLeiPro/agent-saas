import { describe, expect, it } from 'vitest';

import { DIRECTORY_RATE_LIMIT, DirectoryRateLimiter } from './rateLimit.js';

const T0 = Date.parse('2026-09-06T10:00:00.000Z');

describe('目录端点限速（§3.6 每租户每分钟 ≤ 60）', () => {
  it('默认上限与消费端 DIRECTORY_RATE_LIMIT 同值：60 次 / 60 秒', () => {
    expect(DIRECTORY_RATE_LIMIT).toEqual({ max: 60, windowMs: 60_000 });
    const limiter = new DirectoryRateLimiter();
    for (let index = 0; index < 60; index += 1) {
      expect(limiter.take('t_demo', T0 + index).allowed).toBe(true);
    }
    const denied = limiter.take('t_demo', T0 + 60);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('滑动窗口：最老的一次滑出窗口后立刻放行一次，而不是等整分钟翻篇', () => {
    const limiter = new DirectoryRateLimiter({ max: 3, windowMs: 60_000 });
    expect(limiter.take('t', T0).allowed).toBe(true);
    expect(limiter.take('t', T0 + 10_000).allowed).toBe(true);
    expect(limiter.take('t', T0 + 20_000).allowed).toBe(true);
    expect(limiter.take('t', T0 + 30_000).allowed).toBe(false);
    // 判据是 at > now - windowMs：T0 那一次在 T0+60_000 恰好滑出窗口，立刻腾出一格。
    expect(limiter.take('t', T0 + 60_000).allowed).toBe(true);
    // 腾出的那一格已被上一行占用，窗口内重新是 3 次 → 再来一次仍然拒。
    expect(limiter.take('t', T0 + 60_001).allowed).toBe(false);
    // 下一次放行要等 T0+10_000 那一条也滑出。
    expect(limiter.take('t', T0 + 70_000).allowed).toBe(true);
  });

  it('被拒的请求不计入窗口——持续打满的客户端不会把自己永久锁死', () => {
    const limiter = new DirectoryRateLimiter({ max: 2, windowMs: 1_000 });
    limiter.take('t', T0);
    limiter.take('t', T0 + 100);
    for (let index = 0; index < 50; index += 1) {
      expect(limiter.take('t', T0 + 200 + index).allowed).toBe(false);
    }
    // 首次那一条滑出后马上恢复，说明被拒的 50 次没有续窗口。
    expect(limiter.take('t', T0 + 1_001).allowed).toBe(true);
  });

  it('按租户隔离：一个组织打满不影响另一个组织', () => {
    const limiter = new DirectoryRateLimiter({ max: 1, windowMs: 60_000 });
    expect(limiter.take('t_a', T0).allowed).toBe(true);
    expect(limiter.take('t_a', T0 + 1).allowed).toBe(false);
    expect(limiter.take('t_b', T0 + 1).allowed).toBe(true);
  });

  it('retryAfterSeconds 指向最老一次滑出的时刻，且至少 1 秒', () => {
    const limiter = new DirectoryRateLimiter({ max: 1, windowMs: 60_000 });
    limiter.take('t', T0);
    expect(limiter.take('t', T0 + 1_000).retryAfterSeconds).toBe(59);
    expect(limiter.take('t', T0 + 59_999).retryAfterSeconds).toBe(1);
  });

  it('桶数超过阈值后过期条目会被回收，长跑进程不会无界增长', () => {
    const limiter = new DirectoryRateLimiter({ max: 1, windowMs: 1_000 });
    for (let index = 0; index < 600; index += 1) limiter.take(`t-${String(index)}`, T0);
    // 全部过期后再打一个新键，触发 GC；老键被清掉后重新可用。
    limiter.take('t-fresh', T0 + 10_000);
    const internal = limiter as unknown as { hits: Map<string, number[]> };
    expect(internal.hits.size).toBeLessThan(600);
    expect(limiter.take('t-0', T0 + 10_000).allowed).toBe(true);
  });
});
