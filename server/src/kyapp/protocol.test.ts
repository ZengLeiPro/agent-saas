import { describe, expect, it } from 'vitest';

import { kyAppRuntimePaths } from './protocol.js';

describe('业务系统运行接口选择', () => {
  it('新版实例的所有运行调用都使用新版接口且不回退旧接口', () => {
    const paths = kyAppRuntimePaths('v2_asymmetric');
    const selected = [
      paths.live,
      paths.ready,
      paths.manifest,
      paths.attest('instance/1', 'nonce/1'),
      paths.me,
      paths.events,
      paths.capability('order/search'),
      paths.execution('order/search', 'call/1'),
    ];

    expect(selected.every((path) => path.startsWith('/ky/v2/'))).toBe(true);
    expect(selected.some((path) => path.includes('/ky/v1/'))).toBe(false);
    expect(paths.attest('instance/1', 'nonce/1')).toContain('iid=instance%2F1');
  });

  it('明确登记的存量实例仍按自身协议调用', () => {
    const paths = kyAppRuntimePaths('v1_symmetric');

    expect(paths.ready).toBe('/ky/v1/health/ready');
    expect(paths.me).toBe('/ky/v1/me');
  });
});
