import type { ProviderQuotaCredentialState, ProviderQuotaSnapshot } from '@agent/shared';
import { GrokCredentialError } from '../runtime/responses/grokCredentialManager.js';
import { GrokProtocolError } from '../runtime/responses/grokProtocol.js';
import { fetchGrokBilling, type GrokQuotaCredentialSource } from './grokSubscriptionQuota.js';

const AUTH_FAILURE_CODES = new Set(['refresh_outcome_unknown', 'invalid_grant', 'invalid_token']);

/** 刷新结果未知或授权已失效：停打 billing，避免每 5 分钟写失败快照。 */
export function grokBillingCollectBlocked(
  status?: Pick<ProviderQuotaCredentialState, 'availability' | 'lastFailureCode'>,
): boolean {
  return (
    status?.availability === 'auth_unavailable' ||
    (typeof status?.lastFailureCode === 'string' && AUTH_FAILURE_CODES.has(status.lastFailureCode))
  );
}

export function sanitizeGrokTransportDetail(error: unknown): string | undefined {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : undefined;
  if (!raw?.trim()) return undefined;
  const stripped = [...raw]
    .map((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : char;
    })
    .join('')
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/giu, '$1=[redacted]')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!stripped) return undefined;
  return stripped.length > 160 ? `${stripped.slice(0, 157)}...` : stripped;
}

export function formatGrokQuotaCollectError(error: unknown): string {
  if (error instanceof GrokProtocolError || error instanceof GrokCredentialError) {
    const detail = sanitizeGrokTransportDetail(error.cause ?? undefined);
    return detail && detail !== error.message ? `Grok ${error.code}：${detail}` : `Grok ${error.code}`;
  }
  const detail = sanitizeGrokTransportDetail(error);
  return detail ? `Grok 额度采集未完成：${detail}` : 'Grok 额度采集未完成';
}

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
    const base = {
      accountKey,
      // Do not use a masked email as an identity key: unrelated accounts may have the same mask.
      expiryIdentity: status?.accountBindingHash
        ? `grok-account:${status.accountBindingHash}`
        : undefined,
    };
    if (grokBillingCollectBlocked(status)) {
      return { ...base, skipCollect: 'auth_unavailable' as const };
    }
    return {
      ...base,
      collect: async (): Promise<ProviderQuotaSnapshot> => {
        const snapshotBase = {
          sourceKind: 'grok_subscription' as const,
          accountKey,
          accountLabel:
            status?.email ??
            `Grok 账号 ${index + 1}${status?.accountIdHint ? `（${status.accountIdHint}）` : ''}`,
          collectedAt: now().toISOString(),
          ...(status ? { credential: credentialState(status) } : {}),
        };
        try {
          return { ...snapshotBase, ...(await fetchGrokBilling(manager, ref, fetchImpl)), ok: true };
        } catch (error) {
          return {
            ...snapshotBase,
            windows: [],
            limitReached: false,
            ok: false,
            error: formatGrokQuotaCollectError(error),
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
