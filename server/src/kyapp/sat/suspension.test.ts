import { describe, expect, it } from 'vitest';

import { KY_APP_SUSPENSION_WINDOW_MS, KyAppSuspensionRegistry } from './suspension.js';

describe('SAT 停签联动（规范 §3.1 残留风险）', () => {
  it('fence 与 generation 撤销触发 5 分钟停签，窗口过后自动解除', () => {
    let now = 1_000_000;
    const registry = new KyAppSuspensionRegistry({ now: () => now });
    registry.onAuthEpochAudit({ event: 'auth_epoch_fenced', userId: 'u_1' });
    registry.onAuthEpochAudit({ event: 'auth_generation_revoked', userId: 'u_2' });
    expect(registry.isSuspended('u_1')).toBe(true);
    expect(registry.isSuspended('u_2')).toBe(true);
    expect(registry.isSuspended('u_3')).toBe(false);

    now += KY_APP_SUSPENSION_WINDOW_MS - 1;
    expect(registry.isSuspended('u_1')).toBe(true);
    now += 1;
    expect(registry.isSuspended('u_1')).toBe(false);
    expect(registry.size).toBe(1);
    expect(registry.prune()).toBe(1);
    expect(registry.size).toBe(0);
  });

  it('登录与合法升级不触发停签，条目上限按最早写入淘汰', () => {
    const registry = new KyAppSuspensionRegistry({ maxEntries: 2 });
    registry.onAuthEpochAudit({ event: 'auth_epoch_issued', userId: 'u_1' });
    registry.onAuthEpochAudit({ event: 'legacy_token_upgraded', userId: 'u_1' });
    expect(registry.isSuspended('u_1')).toBe(false);

    registry.suspend('a');
    registry.suspend('b');
    registry.suspend('c');
    expect(registry.isSuspended('a')).toBe(false);
    expect(registry.isSuspended('b')).toBe(true);
    expect(registry.isSuspended('c')).toBe(true);
  });
});
