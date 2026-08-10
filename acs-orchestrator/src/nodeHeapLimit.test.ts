import { describe, expect, it } from 'vitest';

import { nodeHeapLimitMb } from './sandboxManager.js';

/**
 * NODE_OPTIONS 堆上限推导（2026-08-10）。
 * 背景：Agent 惯用 `--max-old-space-size=4096`，在 2GiB 容器上直接触发
 * cgroup oom_kill（生产实测单 pod 累计 10 次）。默认值必须低于容器 limit。
 */
describe('nodeHeapLimitMb', () => {
  it('2Gi 容器给出低于 2048 的堆上限（旧的 4096 正是 OOM 根因）', () => {
    const heap = nodeHeapLimitMb('2Gi');
    expect(heap).toBe(1536);
    expect(heap!).toBeLessThan(2048);
  });

  it('A 方案的 4Gi 规格给出 3072', () => {
    expect(nodeHeapLimitMb('4Gi')).toBe(3072);
  });

  it('支持 Mi / G / M 单位与裸数字（按 Mi 解释）', () => {
    expect(nodeHeapLimitMb('4096Mi')).toBe(3072);
    expect(nodeHeapLimitMb('4096')).toBe(3072);
    expect(nodeHeapLimitMb('2G')).toBe(Math.floor((2_000_000_000 / 1048576) * 0.75));
  });

  it('未配置或无法解析时返回 undefined（不注入，保持既有行为）', () => {
    expect(nodeHeapLimitMb(undefined)).toBeUndefined();
    expect(nodeHeapLimitMb('')).toBeUndefined();
    expect(nodeHeapLimitMb('abc')).toBeUndefined();
    expect(nodeHeapLimitMb('-1Gi')).toBeUndefined();
  });

  it('过小的容器不注入，避免把堆压到不可用', () => {
    expect(nodeHeapLimitMb('256Mi')).toBeUndefined();
  });
});
