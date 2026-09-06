import { describe, expect, it } from 'vitest';

import { resolveKyAppConfig } from '../config.js';
import { assertBaseUrl } from './service.js';

describe('assertBaseUrl', () => {
  it('第一期生产只接受公司控制的应用子域', () => {
    const config = resolveKyAppConfig({ kyApp: { environment: 'prod' } });
    if (!config) throw new Error('测试配置缺失');
    expect(() => assertBaseUrl('https://demo.apps.kaiyancn.com', config)).not.toThrow();
    expect(() => assertBaseUrl('https://apps.kaiyancn.com', config)).toThrow(/\*/u);
    expect(() => assertBaseUrl('https://erp.customer.example', config)).toThrow(/kaiyancn/u);
  });

  it('本地测试仍可使用回环地址', () => {
    const config = resolveKyAppConfig({
      kyApp: {
        environment: 'local',
        publicIssuer: 'http://127.0.0.1:4001',
        allowInsecureOutbound: true,
      },
    });
    if (!config) throw new Error('测试配置缺失');
    expect(() => assertBaseUrl('http://127.0.0.1:4002', config)).not.toThrow();
  });
});
