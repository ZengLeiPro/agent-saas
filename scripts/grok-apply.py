from pathlib import Path
import re
root=Path('server/src')
def put(path,text):
    p=root/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text.lstrip('\n'))
def edit(path,before,after):
    p=Path(path);s=p.read_text();assert before in s,(path,before);p.write_text(s.replace(before,after,1))
put('quota/grokSubscriptionQuota.ts', '''import type { ProviderQuotaPlanInfo, ProviderQuotaWindow } from '@agent/shared';
import { singleAttemptEgressFetch } from '../runtime/egressRequestPolicy.js';
import { GrokCredentialError, type GrokCredentialManager } from '../runtime/responses/grokCredentialManager.js';
import { GROK_BILLING_ENDPOINT, GrokProtocolError, isRecord, readGrokJson, subscriptionHeaders } from '../runtime/responses/grokProtocol.js';
export type GrokQuotaCredentialSource = Pick<GrokCredentialManager, 'getConfiguration' | 'getCredentialRefs' | 'getCredentialsForCredential' | 'getStatuses'>;
export interface GrokNormalizedQuota {
  plan?: ProviderQuotaPlanInfo; windows: ProviderQuotaWindow[]; limitReached: boolean;
  extra: { protocol: 'xai_subscription_billing_v1'; quotaKnown: boolean; prepaidBalance?: { amount: number; unit: 'USD'; source: 'xai_subscription_billing_v1' } };
}
/** Billing metadata is independent of model token usage and platform charge estimates. */
export function normalizeGrokBilling(raw: unknown): GrokNormalizedQuota {
  if (!isRecord(raw) || !isRecord(raw.config)) throw new GrokProtocolError('invalid_billing_response');
  const config = raw.config;
  const currentPeriod = isRecord(config.currentPeriod ?? config.current_period) ? config.currentPeriod ?? config.current_period : undefined;
  const period = currentPeriod as Record<string, unknown> | undefined;
  const used = integerValue(config.used);
  const limit = integerValue(config.monthlyLimit ?? config.monthly_limit);
  const explicitValue = config.creditUsagePercent ?? config.credit_usage_percent;
  const explicitPercent = percent(explicitValue);
  // An explicitly malformed value is not repaired by a speculative zero or fallback percentage.
  const usedPercent = explicitValue === undefined
    ? used !== undefined && limit !== undefined && limit > 0 ? percent(used / limit * 100) : undefined
    : explicitPercent;
  const periodType = safeLabel(period?.type);
  const label = periodType?.endsWith('WEEKLY') ? '订阅周用量'
    : periodType?.endsWith('MONTHLY') ? '订阅月用量' : '订阅用量（周期未提供）';
  const resetAt = isoTime(period?.end ?? config.billingPeriodEnd ?? config.billing_period_end);
  const windows: ProviderQuotaWindow[] = usedPercent === undefined ? [] : [{
    id: 'subscription', label, usedPercent, limitReached: usedPercent >= 100, ...(resetAt ? { resetAt } : {}),
  }];
  const planType = safeLabel(raw.subscription_tier ?? raw.subscriptionTier);
  const prepaid = config.prepaidBalance ?? config.prepaid_balance;
  const prepaidCents = integerValue(prepaid);
  const currency = isRecord(prepaid) ? prepaid.currency ?? prepaid.unit : undefined;
  // Versioned upstream adapter contract: prepaidBalance.val is USD cents. Do not apply this
  // scale to used/limit credits, and reject an explicit conflicting unit.
  const prepaidBalance = prepaidCents !== undefined && (currency === undefined || currency === 'USD' || currency === 'USD_CENTS')
    ? { amount: prepaidCents / 100, unit: 'USD' as const, source: 'xai_subscription_billing_v1' as const } : undefined;
  return { ...(planType ? { plan: { type: planType } } : {}), windows, limitReached: usedPercent !== undefined && usedPercent >= 100,
    extra: { protocol: 'xai_subscription_billing_v1', quotaKnown: usedPercent !== undefined, ...(prepaidBalance ? { prepaidBalance } : {}) } };
}
export async function fetchGrokBilling(manager: GrokQuotaCredentialSource, ref: string, fetchImpl: typeof fetch): Promise<GrokNormalizedQuota> {
  const send = async (accessToken: string): Promise<Response> => {
    if (!manager.getConfiguration().enabled || !manager.getCredentialRefs().includes(ref)) throw new GrokProtocolError('subscription_disabled_or_removed');
    return singleAttemptEgressFetch(fetchImpl)(GROK_BILLING_ENDPOINT, {
      headers: subscriptionHeaders(accessToken), redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
  };
  try {
    let token = await manager.getCredentialsForCredential(ref);
    let response = await send(token.accessToken);
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      token = await manager.getCredentialsForCredential(ref, true, token.generation); response = await send(token.accessToken);
    }
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new GrokProtocolError('billing_unavailable', response.status); }
    return normalizeGrokBilling(await readGrokJson(response));
  } catch (error) {
    if (error instanceof GrokProtocolError || error instanceof GrokCredentialError) throw error;
    throw new GrokProtocolError('billing_request_failed');
  }
}
function integerValue(value: unknown): number | undefined {
  if (!isRecord(value) || value.val === undefined || value.val === null) return undefined;
  const raw = value.val;
  const result = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\\d{1,16}$/.test(raw) ? Number(raw) : undefined;
  return result !== undefined && Number.isSafeInteger(result) && result >= 0 ? result : undefined;
}
function percent(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10_000 ? value : undefined;
}
function safeLabel(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128 && !/[\\u0000-\\u001f\\u007f]/.test(value) ? value.trim() : undefined;
}
function isoTime(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\\d{4}-\\d{2}-\\d{2}T/.test(value)) return undefined;
  const time = Date.parse(value); return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}
''')
put('quota/grokQuotaSources.ts', '''import type { ProviderQuotaCredentialState, ProviderQuotaSnapshot } from '@agent/shared';
import { GrokCredentialError } from '../runtime/responses/grokCredentialManager.js';
import { GrokProtocolError } from '../runtime/responses/grokProtocol.js';
import { fetchGrokBilling, type GrokQuotaCredentialSource } from './grokSubscriptionQuota.js';
export async function grokQuotaSources(manager: GrokQuotaCredentialSource | undefined, fetchImpl: typeof fetch, now: () => Date) {
  if (!manager || !manager.getConfiguration().enabled) return [];
  const statuses = await manager.getStatuses();
  return manager.getCredentialRefs().map((ref, index) => {
    const status = statuses.find((entry) => entry.id === ref);
    const accountKey = `grok:${ref}`;
    return { accountKey,
      // Do not use a masked email as an identity key: unrelated accounts may have the same mask.
      expiryIdentity: status?.accountBindingHash ? `grok-account:${status.accountBindingHash}` : undefined,
      collect: async (): Promise<ProviderQuotaSnapshot> => {
        const base = { sourceKind: 'grok_subscription' as const, accountKey,
          accountLabel: status?.email ?? `Grok 账号 ${index + 1}${status?.accountIdHint ? `（${status.accountIdHint}）` : ''}`,
          collectedAt: now().toISOString(), ...(status ? { credential: credentialState(status) } : {}) };
        try {
          return { ...base, ...await fetchGrokBilling(manager, ref, fetchImpl), ok: true };
        } catch (error) {
          return { ...base, windows: [], limitReached: false, ok: false,
            error: error instanceof GrokProtocolError || error instanceof GrokCredentialError ? `Grok ${error.code}` : 'Grok 额度采集未完成',
            extra: { protocol: 'xai_subscription_billing_v1', quotaKnown: false } };
        }
      },
    };
  });
}
export async function grokQuotaCredentialStates(manager?: GrokQuotaCredentialSource): Promise<Map<string, ProviderQuotaCredentialState>> {
  if (!manager || !manager.getConfiguration().enabled) return new Map();
  return new Map((await manager.getStatuses()).filter((status) => status.id).map((status) => [`grok:${status.id}`, credentialState(status)]));
}
function credentialState(status: ProviderQuotaCredentialState): ProviderQuotaCredentialState {
  return { expiresAt: status.expiresAt, accessTokenExpired: status.accessTokenExpired, availability: status.availability,
    cooldownUntil: status.cooldownUntil, lastFailureCode: status.lastFailureCode };
}
''')
p=root/'quota/providerQuotaService.ts';s=p.read_text();s="import { grokQuotaSources, grokQuotaCredentialStates } from './grokQuotaSources.js';\nimport type { GrokQuotaCredentialSource } from './grokSubscriptionQuota.js';\n"+s
s=s.replace('  codexCredentialManager?: CodexCredentialManagerLike;','  codexCredentialManager?: CodexCredentialManagerLike;\n  grokCredentialManager?: GrokQuotaCredentialSource;',1)
s=s.replace('    const liveCredentials = await this.codexCredentialStates();','    const liveCredentials = new Map([...await this.codexCredentialStates(), ...await grokQuotaCredentialStates(this.options.grokCredentialManager)]);\n    const sourceOrder = new Map(sources.map((source, index) => [source.accountKey, index]));',1)
needle='a.sourceKind.localeCompare(b.sourceKind) || a.accountLabel.localeCompare(b.accountLabel),';assert needle in s
s=s.replace(needle,"a.sourceKind.localeCompare(b.sourceKind) || (a.sourceKind === 'grok_subscription'\n            ? (sourceOrder.get(a.accountKey) ?? 0) - (sourceOrder.get(b.accountKey) ?? 0)\n            : a.accountLabel.localeCompare(b.accountLabel)),",1)
needle='    const [codex, claude] = await Promise.all([this.codexSources(), this.claudeSources()]);\n    return [...this.volcengineSources(), ...this.zhipuSources(), ...codex, ...claude];';assert needle in s
s=s.replace(needle,'    const [codex, grok, claude] = await Promise.all([this.codexSources(), grokQuotaSources(this.options.grokCredentialManager, this.fetchImpl, this.now), this.claudeSources()]);\n    return [...this.volcengineSources(), ...this.zhipuSources(), ...codex, ...grok, ...claude];',1);p.write_text(s)
p=root/'quota/providerQuotaRuntime.ts';s=p.read_text();s="import type { GrokCredentialManager } from '../runtime/responses/grokCredentialManager.js';\n"+s
s=s.replace('  codexCredentialManager: CodexCredentialManager;','  codexCredentialManager: CodexCredentialManager;\n  grokCredentialManager?: GrokCredentialManager;',1)
s=s.replace('    codexCredentialManager: options.codexCredentialManager,','    codexCredentialManager: options.codexCredentialManager,\n    grokCredentialManager: options.grokCredentialManager,',1);p.write_text(s)
p=root/'app/runtime.ts';s=p.read_text();a=s.index('await createProviderQuotaRuntime({');b=s.index('});',a);block=s[a:b];assert 'codexCredentialManager,' in block
s=s[:a]+block.replace('codexCredentialManager,','codexCredentialManager, grokCredentialManager,',1)+s[b:];p.write_text(s)
edit('shared/src/types/providerQuota.ts',"  | 'codex_subscription'","  | 'codex_subscription'\n  | 'grok_subscription'")
edit('web/src/components/PlatformAdmin/pages/ProviderQuotaPlanBadge.tsx',"  codex_subscription: { fallback: 'blue', plans: {} },","  codex_subscription: { fallback: 'blue', plans: {} },\n  grok_subscription: { fallback: 'teal', plans: {} },")
edit('web/src/components/PlatformAdmin/pages/providerQuotaOrder.ts',"  codex_subscription: 0,","  codex_subscription: 0,\n  grok_subscription: 0.5,")
p=Path('web/src/components/PlatformAdmin/pages/ProviderQuotaPage.tsx');s=p.read_text()
s="import { GrokQuotaDetails } from './GrokQuotaDetails';\n"+s
s=s.replace("  codex_subscription: 'Codex 订阅',","  codex_subscription: 'Codex 订阅',\n  grok_subscription: 'Grok 订阅',",1)
needle='  const tones = snapshot.windows';assert needle in s
s=s.replace(needle,"  if (snapshot.sourceKind === 'grok_subscription' && snapshot.windows.length === 0) return { tone: 'warning', label: '额度未知' };\n"+needle,1)
needle='      <CardContent className="space-y-3">';assert needle in s
s=s.replace(needle,needle+'\n        {snapshot.sourceKind === \'grok_subscription\' && <GrokQuotaDetails snapshot={snapshot} />} ',1)
p.write_text(s)
p=Path('web/src/components/PlatformAdmin/pages/GrokQuotaDetails.tsx');p.write_text('''import type { ProviderQuotaSnapshot } from '@agent/shared';
export function GrokQuotaDetails({ snapshot }: { snapshot: ProviderQuotaSnapshot }) {
  const prepaid = snapshot.extra?.prepaidBalance as { amount?: unknown; unit?: unknown; source?: unknown } | undefined;
  const validAmount = prepaid?.unit === 'USD' && prepaid.source === 'xai_subscription_billing_v1'
    && typeof prepaid.amount === 'number' && Number.isFinite(prepaid.amount) && prepaid.amount >= 0;
  return <div className="space-y-1 text-xs text-muted-foreground" data-testid="grok-quota-scope">
    <p>Grok 订阅账号额度，不是 API Key 余额、模型 token 用量或平台收费。未提供的上限和重置周期保持未知。</p>
    {validAmount && <p>预付余额：{Number(prepaid!.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD（与套餐额度分开）</p>}
    {snapshot.credential?.availability === 'quota_cooldown' && <p>账号处于额度冷却，优先级调度暂时跳过；冷却到期：{snapshot.credential.cooldownUntil ? new Date(snapshot.credential.cooldownUntil).toLocaleString() : '未知'}。</p>}
  </div>;
}
''')
# Basic quota/parser contracts run immediately in the isolated environment.
put('__tests__/grokSubscriptionQuota.test.ts', '''import { describe, expect, it, vi } from 'vitest';
import { fetchGrokBilling, normalizeGrokBilling, type GrokQuotaCredentialSource } from '../quota/grokSubscriptionQuota.js';
import { GROK_BILLING_ENDPOINT, GROK_OAUTH_ISSUER } from '../runtime/responses/grokProtocol.js';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
describe('Grok billing v1 contract (T34)', () => {
  it('maps camelCase weekly usage and USD-cent prepaid balance without mixing units', () => {
    const result = normalizeGrokBilling({ subscriptionTier: 'SuperGrok', config: { creditUsagePercent: 32.5,
      currentPeriod: { type: 'QUOTA_WEEKLY', end: '2026-10-01T00:00:00Z' }, prepaidBalance: { val: '12345' } } });
    expect(result.windows).toEqual([{ id: 'subscription', label: '订阅周用量', usedPercent: 32.5, limitReached: false, resetAt: '2026-10-01T00:00:00.000Z' }]);
    expect(result.extra.prepaidBalance).toMatchObject({ amount: 123.45, unit: 'USD' });
    expect(result.windows[0].used).toBeUndefined();
  });
  it('supports snake_case and exact explicit zero without inventing a month', () => {
    const result = normalizeGrokBilling({ subscription_tier: 'unknown-new-plan', config: { credit_usage_percent: 0, billing_period_end: '2026-10-01T00:00:00Z' } });
    expect(result.windows[0]).toMatchObject({ usedPercent: 0, label: '订阅用量（周期未提供）' });
    expect(result.extra.prepaidBalance).toBeUndefined();
  });
  it('derives a ratio only when both legacy numbers are present and valid', () => {
    expect(normalizeGrokBilling({ config: { used: { val: 25 }, monthly_limit: { val: 100 } } }).windows[0].usedPercent).toBe(25);
    for (const config of [{}, { used: { val: 0 } }, { monthlyLimit: { val: 100 } }, { used: {}, monthlyLimit: { val: 100 } }]) {
      expect(normalizeGrokBilling({ config })).toMatchObject({ windows: [], extra: { quotaKnown: false } });
    }
  });
  it.each([null, -1, Infinity, NaN, '0', 1e100])('does not repair malformed explicit percentages: %s', (value) => {
    expect(normalizeGrokBilling({ config: { creditUsagePercent: value, used: { val: 0 }, monthlyLimit: { val: 100 } } }).windows).toEqual([]);
  });
  it.each([undefined, null, {}, { val: '-1' }, { val: '9007199254740992' }, { val: 1.5 }, { val: 100, currency: 'credits' }])('does not invent or mis-scale prepaid balances: %j', (value) => {
    expect(normalizeGrokBilling({ config: { prepaidBalance: value } }).extra.prepaidBalance).toBeUndefined();
  });
  it('rejects malformed response roots and omits unsafe labels', () => {
    expect(() => normalizeGrokBilling({})).toThrow('invalid_billing_response');
    expect(normalizeGrokBilling({ config: {}, subscriptionTier: 'bad\\nlabel' }).plan).toBeUndefined();
  });
  it('uses one shared manager refresh on 401, never an API-key endpoint', async () => {
    const token = { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', accountId: 'fixture-account', clientId: 'fixture-client', issuer: GROK_OAUTH_ISSUER,
      expiresAt: '2099-01-01T00:00:00.000Z', generation: 1 };
    const getCredentialsForCredential = vi.fn().mockResolvedValueOnce(token).mockResolvedValueOnce({ ...token, accessToken: 'fixture-new', generation: 2 });
    const manager = { getConfiguration: () => ({ enabled: true }), getCredentialRefs: () => ['a'], getCredentialsForCredential, getStatuses: async () => [] } as unknown as GrokQuotaCredentialSource;
    const fetcher = vi.fn().mockResolvedValueOnce(json({}, 401)).mockResolvedValueOnce(json({ config: { credit_usage_percent: 20 } }));
    expect((await fetchGrokBilling(manager, 'a', fetcher)).windows[0].usedPercent).toBe(20);
    expect(getCredentialsForCredential).toHaveBeenNthCalledWith(2, 'a', true, 1);
    expect(fetcher.mock.calls.every(([url]) => url === GROK_BILLING_ENDPOINT)).toBe(true);
    expect(fetcher.mock.calls[1][1].headers.Authorization).toBe('Bearer fixture-new');
  });
});
''')
print('Applied versioned Grok quota parser, shared refresh collector, ordered snapshots, unknown-state UI and billing tests')
