/** PG harness 的就绪判据（C-fix-01）：宿主机 TCP 真实探测，不看容器内 pg_isready。 */
import { describe, expect, it } from 'vitest';

import { freePort } from './ports.js';
import { looksLikeTestDatabase, usePgUrl, waitForPostgresReady } from './pg.js';

describe('waitForPostgresReady', () => {
  it('连不上时按超时报错，错误里带探测次数与最后一次原因', async () => {
    const port = await freePort();
    const url = `postgresql://kyapp:kyapp@127.0.0.1:${String(port)}/kyapp_doctor`;
    const lines: string[] = [];
    await expect(
      waitForPostgresReady(url, { timeoutMs: 800, log: (line) => lines.push(line) }),
    ).rejects.toThrow(/没有就绪（探测 \d+ 次）/u);
    // 没就绪时不该打印「数据库就绪」。
    expect(lines.join('\n')).not.toContain('数据库就绪');
  });
});

describe('usePgUrl', () => {
  it('外部 URL 也带就绪信号，且 ready() 记忆化（同一个 Promise）', async () => {
    const handle = usePgUrl('postgresql://u:p@127.0.0.1:65432/kyapp_test', { timeoutMs: 200 });
    expect(handle.kind).toBe('url');
    const first = handle.ready();
    const second = handle.ready();
    expect(first).toBe(second);
    // 探测必然失败，这里只验证记忆化，等它结束并吞掉这条 rejection。
    await expect(first).rejects.toThrow('没有就绪');
  });
});

describe('looksLikeTestDatabase', () => {
  it('库名含 test/doctor/ci/tmp 才算测试库', () => {
    expect(looksLikeTestDatabase('postgresql://u:p@127.0.0.1:5433/kyapp_doctor')).toBe(true);
    expect(looksLikeTestDatabase('postgresql://u:p@127.0.0.1:5433/erp_test')).toBe(true);
    expect(looksLikeTestDatabase('postgresql://u:p@127.0.0.1:5433/erp_prod')).toBe(false);
    expect(looksLikeTestDatabase('not a url')).toBe(false);
  });
});
