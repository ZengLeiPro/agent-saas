import { describe, expect, it, vi } from 'vitest';
import {
  fetchGrokBilling,
  normalizeGrokBilling,
  type GrokQuotaCredentialSource,
} from '../quota/grokSubscriptionQuota.js';
import { GROK_BILLING_ENDPOINT, GROK_OAUTH_ISSUER } from '../runtime/responses/grokProtocol.js';
import { isProxyRequiredEgressRequest } from '../runtime/egressRequestPolicy.js';
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
describe('Grok billing v1 contract (T34)', () => {
  it('maps camelCase weekly usage and USD-cent prepaid balance without mixing units', () => {
    const result = normalizeGrokBilling({
      subscriptionTier: 'SuperGrok',
      config: {
        creditUsagePercent: 32.5,
        currentPeriod: { type: 'QUOTA_WEEKLY', end: '2026-10-01T00:00:00Z' },
        prepaidBalance: { val: '12345' },
      },
    });
    expect(result.windows).toEqual([
      {
        id: 'subscription',
        label: '订阅周用量',
        usedPercent: 32.5,
        limitReached: false,
        resetAt: '2026-10-01T00:00:00.000Z',
      },
    ]);
    expect(result.extra.prepaidBalance).toMatchObject({ amount: 123.45, unit: 'USD' });
    expect(result.windows[0].used).toBeUndefined();
  });
  it('supports snake_case and exact explicit zero without inventing a month', () => {
    const result = normalizeGrokBilling({
      subscription_tier: 'unknown-new-plan',
      config: { credit_usage_percent: 0, billing_period_end: '2026-10-01T00:00:00Z' },
    });
    expect(result.windows[0]).toMatchObject({ usedPercent: 0, label: '订阅用量（周期未提供）' });
    expect(result.extra.prepaidBalance).toBeUndefined();
  });
  it('derives a ratio only when both legacy numbers are present and valid', () => {
    expect(
      normalizeGrokBilling({ config: { used: { val: 25 }, monthly_limit: { val: 100 } } })
        .windows[0].usedPercent,
    ).toBe(25);
    for (const config of [
      {},
      { used: { val: 0 } },
      { monthlyLimit: { val: 100 } },
      { used: {}, monthlyLimit: { val: 100 } },
    ]) {
      expect(normalizeGrokBilling({ config })).toMatchObject({
        windows: [],
        extra: { quotaKnown: false },
      });
    }
  });
  it.each([null, -1, Infinity, NaN, '0', 1e100])(
    'does not repair malformed explicit percentages: %s',
    (value) => {
      expect(
        normalizeGrokBilling({
          config: { creditUsagePercent: value, used: { val: 0 }, monthlyLimit: { val: 100 } },
        }).windows,
      ).toEqual([]);
    },
  );
  it.each([
    undefined,
    null,
    {},
    { val: '-1' },
    { val: '9007199254740992' },
    { val: 1.5 },
    { val: 100, currency: 'credits' },
  ])('does not invent or mis-scale prepaid balances: %j', (value) => {
    expect(
      normalizeGrokBilling({ config: { prepaidBalance: value } }).extra.prepaidBalance,
    ).toBeUndefined();
  });
  it('rejects malformed response roots and omits unsafe labels', () => {
    expect(() => normalizeGrokBilling({})).toThrow('invalid_billing_response');
    expect(
      normalizeGrokBilling({ config: {}, subscriptionTier: 'bad\nlabel' }).plan,
    ).toBeUndefined();
  });
  it('uses one shared manager refresh on 401, never an API-key endpoint', async () => {
    const token = {
      accessToken: 'fixture-access',
      refreshToken: 'fixture-refresh',
      accountId: 'fixture-account',
      clientId: 'fixture-client',
      issuer: GROK_OAUTH_ISSUER,
      expiresAt: '2099-01-01T00:00:00.000Z',
      generation: 1,
    };
    const getCredentialsForCredential = vi
      .fn()
      .mockResolvedValueOnce(token)
      .mockResolvedValueOnce({ ...token, accessToken: 'fixture-new', generation: 2 });
    const manager = {
      getConfiguration: () => ({ enabled: true }),
      getCredentialRefs: () => ['a'],
      getCredentialsForCredential,
      getStatuses: async () => [],
    } as unknown as GrokQuotaCredentialSource;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(json({ config: { credit_usage_percent: 20 } }));
    expect((await fetchGrokBilling(manager, 'a', fetcher)).windows[0].usedPercent).toBe(20);
    expect(getCredentialsForCredential).toHaveBeenNthCalledWith(2, 'a', true, 1);
    expect(fetcher.mock.calls.every(([url]) => url === GROK_BILLING_ENDPOINT)).toBe(true);
    expect(fetcher.mock.calls.every(([, init]) => isProxyRequiredEgressRequest(init))).toBe(true);
    expect(fetcher.mock.calls[1][1].headers.Authorization).toBe('Bearer fixture-new');
  });
});
