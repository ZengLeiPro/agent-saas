import { describe, expect, it } from 'vitest';

import { backoffDelayMs } from './store.js';

describe('出站事件退避（规范 §3.7：指数退避，24 小时窗口）', () => {
  it('从 1 秒起翻倍，上限 15 分钟，负数与超大 attempts 都被夹住', () => {
    expect(backoffDelayMs(0)).toBe(1000);
    expect(backoffDelayMs(1)).toBe(2000);
    expect(backoffDelayMs(4)).toBe(16_000);
    expect(backoffDelayMs(-3)).toBe(1000);
    expect(backoffDelayMs(9)).toBe(512_000);
    expect(backoffDelayMs(10)).toBe(15 * 60 * 1000);
    expect(backoffDelayMs(1000)).toBe(15 * 60 * 1000);
  });
});
