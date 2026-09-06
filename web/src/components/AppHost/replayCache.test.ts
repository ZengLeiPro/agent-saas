/**
 * §5.3：重复 `(type,id)` 重放缓存的同一应答，副作用只执行一次。
 * 这条是总控点名「写测试钉死」的项。
 */
import { describe, expect, it } from 'vitest';

import { ReplayCache, replayKey } from './replayCache';

describe('ReplayCache', () => {
  it('重复 (type,id) 只跑一次副作用，应答完全相同', async () => {
    const cache = new ReplayCache<string>();
    let effects = 0;
    const run = async () => {
      effects += 1;
      return `token-${effects}`;
    };
    const key = replayKey('token.request', 'req-1');
    const first = await cache.runOnce(key, run);
    const second = await cache.runOnce(key, run);
    const third = await cache.runOnce(key, run);
    expect(effects).toBe(1);
    expect([second, third]).toEqual([first, first]);
    expect(cache.replayCount).toBe(2);
  });

  it('在途重复也挂同一个 Promise，不另起副作用', async () => {
    const cache = new ReplayCache<number>();
    let effects = 0;
    let release: (value: number) => void = () => {};
    const run = () => {
      effects += 1;
      return new Promise<number>((resolve) => {
        release = resolve;
      });
    };
    const key = replayKey('link.open', 'l-1');
    const a = cache.runOnce(key, run);
    const b = cache.runOnce(key, run);
    expect(effects).toBe(1);
    release(42);
    expect(await Promise.all([a, b])).toEqual([42, 42]);
  });

  it('键是 (type,id) 二元组：同 id 不同 type 各跑各的', async () => {
    const cache = new ReplayCache<string>();
    let effects = 0;
    const run = async () => `r${(effects += 1)}`;
    await cache.runOnce(replayKey('token.request', 'x'), run);
    await cache.runOnce(replayKey('link.open', 'x'), run);
    expect(effects).toBe(2);
    expect(cache.size).toBe(2);
  });

  it('副作用失败的条目会被剔除，子端重发还有一次机会', async () => {
    const cache = new ReplayCache<string>();
    let attempts = 0;
    const key = replayKey('token.request', 'req-2');
    await expect(
      cache.runOnce(key, async () => {
        attempts += 1;
        throw new Error('网络抖动');
      }),
    ).rejects.toThrow('网络抖动');
    expect(cache.has(key)).toBe(false);
    const value = await cache.runOnce(key, async () => {
      attempts += 1;
      return 'ok';
    });
    expect([attempts, value]).toEqual([2, 'ok']);
  });

  it('条目数有上限，子端刷 id 打不爆壳的内存', async () => {
    const cache = new ReplayCache<number>({ maxEntries: 3 });
    for (let index = 0; index < 10; index += 1) {
      await cache.runOnce(replayKey('link.open', String(index)), async () => index);
    }
    expect(cache.size).toBe(3);
    // FIFO：最老的先走
    expect(cache.has(replayKey('link.open', '0'))).toBe(false);
    expect(cache.has(replayKey('link.open', '9'))).toBe(true);
  });

  it('clear 同时清空计数', async () => {
    const cache = new ReplayCache<number>();
    await cache.runOnce(replayKey('ready', 'a'), async () => 1);
    await cache.runOnce(replayKey('ready', 'a'), async () => 2);
    cache.clear();
    expect([cache.size, cache.replayCount]).toEqual([0, 0]);
  });
});
