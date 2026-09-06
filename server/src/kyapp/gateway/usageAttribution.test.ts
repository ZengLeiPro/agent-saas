/**
 * WP3 §6.4：usage-events 的 installationId / capabilityId 归因。
 * **不单独扣积分** —— 这两个字段只做归因与看板。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  readAppCapabilityUsage,
  recordAppCapabilityUsage,
  resetAppCapabilityUsageForTest,
  forgetAppCapabilityUsage,
} from '../../runtime/appCapabilityUsageAttribution.js';

describe('定制项目能力用量归因', () => {
  beforeEach(() => resetAppCapabilityUsageForTest());

  it('按 (installationId, capabilityId) 聚合调用次数', () => {
    recordAppCapabilityUsage('run-1', { installationId: 'iid-1', capabilityId: 'order.search' });
    recordAppCapabilityUsage('run-1', { installationId: 'iid-1', capabilityId: 'order.search' });
    recordAppCapabilityUsage('run-1', { installationId: 'iid-2', capabilityId: 'order.create' });
    expect(readAppCapabilityUsage('run-1')).toEqual([
      { installationId: 'iid-1', capabilityId: 'order.search', calls: 2 },
      { installationId: 'iid-2', capabilityId: 'order.create', calls: 1 },
    ]);
  });

  it('run 之间互不串；未知 run 返回空数组', () => {
    recordAppCapabilityUsage('run-1', { installationId: 'iid-1', capabilityId: 'a' });
    expect(readAppCapabilityUsage('run-2')).toEqual([]);
    expect(readAppCapabilityUsage(undefined)).toEqual([]);
  });

  it('读出的顺序稳定（同一 run 每次读到同一序列）', () => {
    recordAppCapabilityUsage('run-1', { installationId: 'b', capabilityId: 'z' });
    recordAppCapabilityUsage('run-1', { installationId: 'a', capabilityId: 'y' });
    recordAppCapabilityUsage('run-1', { installationId: 'a', capabilityId: 'x' });
    expect(
      readAppCapabilityUsage('run-1').map((item) => `${item.installationId}/${item.capabilityId}`),
    ).toEqual(['a/x', 'a/y', 'b/z']);
  });

  it('runId 缺失时静默跳过，不抛错', () => {
    expect(() =>
      recordAppCapabilityUsage(undefined, { installationId: 'iid-1', capabilityId: 'a' }),
    ).not.toThrow();
  });

  it('run 终态回收', () => {
    recordAppCapabilityUsage('run-1', { installationId: 'iid-1', capabilityId: 'a' });
    forgetAppCapabilityUsage('run-1');
    expect(readAppCapabilityUsage('run-1')).toEqual([]);
  });
});
