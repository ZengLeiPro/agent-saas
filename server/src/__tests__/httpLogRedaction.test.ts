import { describe, expect, it } from 'vitest';
import { requestTargetForLog } from '../security/httpLogRedaction.js';

describe('HTTP log redaction', () => {
  it('never includes a legacy preview bearer or its query in logs', () => {
    const token = '1.sensitive-nonce.sensitive-token';
    expect(requestTargetForLog({
      path: `/preview/${token}/reports/attack.html`,
      originalUrl: `/preview/${token}/reports/attack.html?nonce=also-sensitive`,
    })).toBe('/preview/[REDACTED]');
  });

  it('preserves ordinary request targets', () => {
    expect(requestTargetForLog({ path: '/api/health', originalUrl: '/api/health?verbose=1' }))
      .toBe('/api/health?verbose=1');
  });
});
