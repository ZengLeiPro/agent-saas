import { describe, expect, it } from 'vitest';

import {
  formatVolcengineDate,
  signVolcengineOpenApiRequest,
} from './volcengineOpenApiSignature.js';

describe('signVolcengineOpenApiRequest', () => {
  it('X-Date 使用火山要求的紧凑 UTC 格式', () => {
    expect(formatVolcengineDate(new Date('2026-09-05T06:12:00.123Z'))).toBe('20260905T061200Z');
  });

  it('与已对拍真实接口的参考实现产出一致签名', () => {
    // 向量来自 Python 参考实现（同一实现对真实 GetAFPUsage 返回 200）。
    const signed = signVolcengineOpenApiRequest({
      accessKeyId: 'AKTESTACCESSKEYID',
      secretAccessKey: 'TESTSECRETACCESSKEY',
      region: 'cn-beijing',
      service: 'ark',
      host: 'ark.cn-beijing.volcengineapi.com',
      action: 'GetAFPUsage',
      version: '2024-01-01',
      body: '{}',
      date: new Date('2026-09-05T06:12:00Z'),
    });
    expect(signed.url).toBe(
      'https://ark.cn-beijing.volcengineapi.com/?Action=GetAFPUsage&Version=2024-01-01',
    );
    expect(signed.headers['X-Date']).toBe('20260905T061200Z');
    expect(signed.headers['X-Content-Sha256']).toBe(
      '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    );
    expect(signed.headers.Authorization).toBe(
      'HMAC-SHA256 Credential=AKTESTACCESSKEYID/20260905/cn-beijing/ark/request, ' +
        'SignedHeaders=content-type;host;x-content-sha256;x-date, ' +
        'Signature=0a6075487b349797a7c1af8a1e524c66333360f68a5aaa39a29d0740e95eec58',
    );
    expect(signed.body).toBe('{}');
  });

  it('body 变化时 payload hash 与签名同时变化', () => {
    const base = {
      accessKeyId: 'a',
      secretAccessKey: 'b',
      region: 'cn-beijing',
      service: 'ark',
      host: 'h',
      action: 'GetPersonalPlan',
      version: '2024-01-01',
      date: new Date('2026-09-05T06:12:00Z'),
    };
    const one = signVolcengineOpenApiRequest({ ...base, body: '{"Plan":"AgentPlan"}' });
    const two = signVolcengineOpenApiRequest({ ...base, body: '{"Plan":"CodingPlan"}' });
    expect(one.headers['X-Content-Sha256']).not.toBe(two.headers['X-Content-Sha256']);
    expect(one.headers.Authorization).not.toBe(two.headers.Authorization);
  });
});
