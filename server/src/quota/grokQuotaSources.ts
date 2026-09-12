import type { ProviderQuotaCredentialState, ProviderQuotaSnapshot } from '@agent/shared';
import { GrokCredentialError } from '../runtime/responses/grokCredentialManager.js';
import { GrokProtocolError } from '../runtime/responses/grokProtocol.js';
import { fetchGrokBilling, type GrokQuotaCredentialSource } from './grokSubscriptionQuota.js';
export async function grokQuotaSources(
  manager: GrokQuotaCredentialSource | undefined,
  fetchImpl: typeof fetch,
  now: () => Date,
) {
  if (!manager || !manager.getConfiguration().enabled) return [];
  const statuses = await manager.getStatuses();
  return manager.getCredentialRefs().map((ref, index) => {
    const status = statuses.find((entry) => entry.id === ref);
    const accountKey = `grok:${ref}`;
    return {
      accountKey,
      // Do not use a masked email as an identity key: unrelated accounts may have the same mask.
      expiryIdentity: status?.accountBindingHash
        ? `grok-account:${status.accountBindingHash}`
        : undefined,
      collect: async (): Promise<ProviderQuotaSnapshot> => {
        const base = {
          sourceKind: 'grok_subscription' as const,
          accountKey,
          accountLabel:
            status?.email ??
            `Grok 账号 ${index + 1}${status?.accountIdHint ? `（${status.accountIdHint}）` : ''}`,
          collectedAt: now().toISOString(),
          ...(status ? { credential: credentialState(status) } : {}),
        };
        try {
          return { ...base, ...(await fetchGrokBilling(manager, ref, fetchImpl)), ok: true };
        } catch (error) {
          return {
            ...base,
            windows: [],
            limitReached: false,
            ok: false,
            error:
              error instanceof GrokProtocolError || error instanceof GrokCredentialError
                ? `Grok ${error.code}`
                : 'Grok 额度采集未完成',
            extra: { protocol: 'xai_subscription_billing_v1', quotaKnown: false },
          };
        }
      },
    };
  });
}
export async function grokQuotaCredentialStates(
  manager?: GrokQuotaCredentialSource,
): Promise<Map<string, ProviderQuotaCredentialState>> {
  if (!manager || !manager.getConfiguration().enabled) return new Map();
  return new Map(
    (await manager.getStatuses())
      .filter((status) => status.id)
      .map((status) => [`grok:${status.id}`, credentialState(status)]),
  );
}
function credentialState(status: ProviderQuotaCredentialState): ProviderQuotaCredentialState {
  return {
    expiresAt: status.expiresAt,
    accessTokenExpired: status.accessTokenExpired,
    availability: status.availability,
    cooldownUntil: status.cooldownUntil,
    lastFailureCode: status.lastFailureCode,
  };
}
