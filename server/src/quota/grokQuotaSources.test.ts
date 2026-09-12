import { describe, expect, it, vi } from 'vitest';

import { GrokProtocolError } from '../runtime/responses/grokProtocol.js';
import {
  formatGrokQuotaCollectError,
  grokBillingCollectBlocked,
  grokQuotaSources,
  sanitizeGrokTransportDetail,
} from './grokQuotaSources.js';
import type { GrokQuotaCredentialSource } from './grokSubscriptionQuota.js';

function manager(statuses: Array<Record<string, unknown>>): GrokQuotaCredentialSource {
  const refs = statuses.map((status) => String(status.id));
  return {
    getConfiguration: () => ({ enabled: true, credentialRefs: refs }),
    getCredentialRefs: () => refs,
    getCredentialsForCredential: vi.fn(),
    getStatuses: async () => statuses,
  } as unknown as GrokQuotaCredentialSource;
}

describe('grokQuotaSources', () => {
  it('blocks collection when auth is unavailable or refresh outcome is unknown', () => {
    expect(grokBillingCollectBlocked({ availability: 'auth_unavailable' })).toBe(true);
    expect(grokBillingCollectBlocked({ lastFailureCode: 'refresh_outcome_unknown' })).toBe(true);
    expect(grokBillingCollectBlocked({ lastFailureCode: 'invalid_grant' })).toBe(true);
    expect(grokBillingCollectBlocked({ availability: 'available' })).toBe(false);
    expect(grokBillingCollectBlocked({ availability: 'quota_cooldown' })).toBe(false);
  });

  it('keeps the transport cause in the snapshot error and redacts secrets', () => {
    const failed = new GrokProtocolError('billing_request_failed', undefined, true, {
      cause: new TypeError('fetch failed Bearer sk-secret token=abc'),
    });
    expect(formatGrokQuotaCollectError(failed)).toBe(
      'Grok billing_request_failed：fetch failed Bearer [redacted] token=[redacted]',
    );
    expect(sanitizeGrokTransportDetail(new Error('Bearer abc.def'))).toBe('Bearer [redacted]');
  });

  it('omits collect for blocked accounts so the scheduler does not hit billing', async () => {
    const fetchImpl = vi.fn();
    const sources = await grokQuotaSources(
      manager([
        {
          id: 'dead',
          availability: 'auth_unavailable',
          lastFailureCode: 'refresh_outcome_unknown',
        },
        { id: 'live', availability: 'available', email: 'live@x.ai' },
      ]),
      fetchImpl as unknown as typeof fetch,
      () => new Date('2026-09-13T00:00:00Z'),
    );
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({
      accountKey: 'grok:dead',
      skipCollect: 'auth_unavailable',
    });
    expect('collect' in sources[0]!).toBe(false);
    expect('collect' in sources[1]!).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
