import { describe, expect, it } from 'vitest';

import { GovernanceShadowProjectionScheduler } from '../governance/migrations/shadowProjectionScheduler.js';

describe('Governance M1 shadow projection scheduler', () => {
  it('同类变更合并执行；投影运行中再次变更会补跑，不丢最后状态', async () => {
    let runs = 0;
    let releaseFirst: (() => void) | undefined;
    const firstRun = new Promise<void>(resolve => { releaseFirst = resolve; });
    const scheduler = new GovernanceShadowProjectionScheduler({
      membership: async () => {
        runs += 1;
        if (runs === 1) await firstRun;
      },
      entitlement: async () => undefined,
      assignment: async () => undefined,
    }, () => undefined);

    scheduler.schedule('membership');
    await Promise.resolve();
    scheduler.schedule('membership');
    scheduler.schedule('membership');
    releaseFirst?.();
    await scheduler.flush('membership');

    expect(runs).toBe(2);
  });

  it('投影失败不抛到旧权威写路径，下一次变更可重试', async () => {
    let attempts = 0;
    const errors: string[] = [];
    const scheduler = new GovernanceShadowProjectionScheduler({
      membership: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('pg unavailable');
      },
      entitlement: async () => undefined,
      assignment: async () => undefined,
    }, (name, error) => errors.push(`${name}:${String(error)}`));

    scheduler.schedule('membership');
    await scheduler.flush('membership');
    scheduler.schedule('membership');
    await scheduler.flush('membership');

    expect(attempts).toBe(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('membership:Error: pg unavailable');
  });
});
