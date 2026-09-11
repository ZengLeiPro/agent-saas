import type { ProviderQuotaPlanInfo, ProviderQuotaWindow } from '@agent/shared';
import { singleAttemptEgressFetch } from '../runtime/egressRequestPolicy.js';
import {
  GrokCredentialError,
  type GrokCredentialManager,
} from '../runtime/responses/grokCredentialManager.js';
import {
  GROK_BILLING_ENDPOINT,
  GrokProtocolError,
  isRecord,
  readGrokJson,
  subscriptionHeaders,
} from '../runtime/responses/grokProtocol.js';
export type GrokQuotaCredentialSource = Pick<
  GrokCredentialManager,
  'getConfiguration' | 'getCredentialRefs' | 'getCredentialsForCredential' | 'getStatuses'
>;
export interface GrokNormalizedQuota {
  plan?: ProviderQuotaPlanInfo;
  windows: ProviderQuotaWindow[];
  limitReached: boolean;
  extra: {
    protocol: 'xai_subscription_billing_v1';
    quotaKnown: boolean;
    prepaidBalance?: { amount: number; unit: 'USD'; source: 'xai_subscription_billing_v1' };
  };
}
/** Billing metadata is independent of model token usage and platform charge estimates. */
export function normalizeGrokBilling(raw: unknown): GrokNormalizedQuota {
  if (!isRecord(raw) || !isRecord(raw.config))
    throw new GrokProtocolError('invalid_billing_response');
  const config = raw.config;
  const currentPeriod = isRecord(config.currentPeriod ?? config.current_period)
    ? (config.currentPeriod ?? config.current_period)
    : undefined;
  const period = currentPeriod as Record<string, unknown> | undefined;
  const used = integerValue(config.used);
  const limit = integerValue(config.monthlyLimit ?? config.monthly_limit);
  const explicitValue = Object.hasOwn(config, 'creditUsagePercent')
    ? config.creditUsagePercent
    : config.credit_usage_percent;
  const explicitPercent = percent(explicitValue);
  // An explicitly malformed value is not repaired by a speculative zero or fallback percentage.
  const usedPercent =
    explicitValue === undefined
      ? used !== undefined && limit !== undefined && limit > 0
        ? percent((used / limit) * 100)
        : undefined
      : explicitPercent;
  const periodType = safeLabel(period?.type);
  const label = periodType?.endsWith('WEEKLY')
    ? '订阅周用量'
    : periodType?.endsWith('MONTHLY')
      ? '订阅月用量'
      : '订阅用量（周期未提供）';
  const resetAt = isoTime(period?.end ?? config.billingPeriodEnd ?? config.billing_period_end);
  const windows: ProviderQuotaWindow[] =
    usedPercent === undefined
      ? []
      : [
          {
            id: 'subscription',
            label,
            usedPercent,
            limitReached: usedPercent >= 100,
            ...(resetAt ? { resetAt } : {}),
          },
        ];
  const planType = safeLabel(raw.subscription_tier ?? raw.subscriptionTier);
  const prepaid = config.prepaidBalance ?? config.prepaid_balance;
  const prepaidCents = integerValue(prepaid);
  const currency = isRecord(prepaid) ? (prepaid.currency ?? prepaid.unit) : undefined;
  // Versioned upstream adapter contract: prepaidBalance.val is USD cents. Do not apply this
  // scale to used/limit credits, and reject an explicit conflicting unit.
  const prepaidBalance =
    prepaidCents !== undefined &&
    (currency === undefined || currency === 'USD' || currency === 'USD_CENTS')
      ? {
          amount: prepaidCents / 100,
          unit: 'USD' as const,
          source: 'xai_subscription_billing_v1' as const,
        }
      : undefined;
  return {
    ...(planType ? { plan: { type: planType } } : {}),
    windows,
    limitReached: usedPercent !== undefined && usedPercent >= 100,
    extra: {
      protocol: 'xai_subscription_billing_v1',
      quotaKnown: usedPercent !== undefined,
      ...(prepaidBalance ? { prepaidBalance } : {}),
    },
  };
}
export async function fetchGrokBilling(
  manager: GrokQuotaCredentialSource,
  ref: string,
  fetchImpl: typeof fetch,
): Promise<GrokNormalizedQuota> {
  const send = async (accessToken: string): Promise<Response> => {
    if (!manager.getConfiguration().enabled || !manager.getCredentialRefs().includes(ref))
      throw new GrokProtocolError('subscription_disabled_or_removed');
    return singleAttemptEgressFetch(fetchImpl)(GROK_BILLING_ENDPOINT, {
      headers: subscriptionHeaders(accessToken),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  };
  try {
    let token = await manager.getCredentialsForCredential(ref);
    let response = await send(token.accessToken);
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      token = await manager.getCredentialsForCredential(ref, true, token.generation);
      response = await send(token.accessToken);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new GrokProtocolError('billing_unavailable', response.status);
    }
    return normalizeGrokBilling(await readGrokJson(response));
  } catch (error) {
    if (error instanceof GrokProtocolError || error instanceof GrokCredentialError) throw error;
    throw new GrokProtocolError('billing_request_failed');
  }
}
function integerValue(value: unknown): number | undefined {
  if (!isRecord(value) || value.val === undefined || value.val === null) return undefined;
  const raw = value.val;
  const result =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && /^\d{1,16}$/.test(raw)
        ? Number(raw)
        : undefined;
  return result !== undefined && Number.isSafeInteger(result) && result >= 0 ? result : undefined;
}
function percent(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10_000
    ? value
    : undefined;
}
function safeLabel(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 128 &&
    !/[\u0000-\u001f\u007f]/.test(value)
    ? value.trim()
    : undefined;
}
function isoTime(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}
