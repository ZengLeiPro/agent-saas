import { describe, expect, it } from 'vitest';
import { allowedFrameAncestors } from './ch09Headers.js';

describe('doctor 环境 Shell 校验', () => {
  it('Staging 只接受实际 Shell，拒绝生产、通配符和本地附加来源', () => {
    const shell = 'https://staging-agent.kaiyan.net';
    expect(allowedFrameAncestors([shell], 'staging')).toBe(true);
    for (const extra of [
      '*',
      'https://agent.kaiyan.net',
      'http://localhost:8787',
      'https://evil.example',
    ]) {
      expect(allowedFrameAncestors([shell, extra], 'staging')).toBe(false);
      expect(allowedFrameAncestors([extra], 'staging')).toBe(false);
    }
  });
  it('Production 仍然只接受生产 Shell', () => {
    expect(allowedFrameAncestors(['https://agent.kaiyan.net'], 'prod')).toBe(true);
    expect(allowedFrameAncestors(['https://staging-agent.kaiyan.net'], 'prod')).toBe(false);
  });
  it('仅 local/test 允许附加本地 mock 壳', () => {
    expect(
      allowedFrameAncestors(['https://agent.kaiyan.net', 'http://127.0.0.1:8787'], 'test'),
    ).toBe(true);
    expect(
      allowedFrameAncestors(['https://agent.kaiyan.net', 'https://evil.example'], 'test'),
    ).toBe(false);
  });
});
