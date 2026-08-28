import { performance } from 'node:perf_hooks';

import { describe, expect, it } from 'vitest';

import { redactDwsError, redactDwsProfilePaths } from './authFlow.js';

describe('DWS sensitive output redaction', () => {
  it('redacts config and key paths while preserving surrounding labels', () => {
    expect(
      redactDwsProfilePaths(
        [
          'config=/workspace/user/.dws/config/profiles.json',
          'key=/workspace/user/.DWS/KEYS/access-token',
        ].join(' '),
      ),
    ).toBe(['config=[DWS_PROFILE_PATH_REDACTED]', 'key=[DWS_PROFILE_PATH_REDACTED]'].join(' '));

    expect(
      redactDwsError(
        new Error('failed at /workspace/user/.dws/config/profiles.json token=secret-value'),
      ),
    ).toBe('failed at [DWS_PROFILE_PATH_REDACTED] token=[REDACTED]');
  });

  it('handles slash-rich DWS message content in linear time', () => {
    const content = `${'/cid0NsYmHfcREL'.repeat(22)} missing-profile-path`;
    const durations = Array.from({ length: 3 }, () => {
      const startedAt = performance.now();
      expect(redactDwsProfilePaths(content)).toBe(content);
      return performance.now() - startedAt;
    });

    expect(Math.min(...durations)).toBeLessThan(20);
  });
});
