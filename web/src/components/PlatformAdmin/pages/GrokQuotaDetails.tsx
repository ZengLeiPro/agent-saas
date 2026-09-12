import type { ProviderQuotaSnapshot } from '@agent/shared';
export function GrokQuotaDetails({ snapshot }: { snapshot: ProviderQuotaSnapshot }) {
  const prepaid = snapshot.extra?.prepaidBalance as
    { amount?: unknown; unit?: unknown; source?: unknown } | undefined;
  const validAmount =
    prepaid?.unit === 'USD' &&
    prepaid.source === 'xai_subscription_billing_v1' &&
    typeof prepaid.amount === 'number' &&
    Number.isFinite(prepaid.amount) &&
    prepaid.amount >= 0;
  return (
    <div className="space-y-1 text-xs text-muted-foreground" data-testid="grok-quota-scope">
      <p>
        Grok 订阅账号额度，不是 API Key 余额、模型 token
        用量或平台收费。未提供的上限和重置周期保持未知。
      </p>
      {validAmount && (
        <p>
          预付余额：
          {Number(prepaid!.amount).toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}{' '}
          USD（与套餐额度分开）
        </p>
      )}
      {snapshot.credential?.availability === 'quota_cooldown' && (
        <p>
          账号处于额度冷却，优先级调度暂时跳过；冷却到期：
          {snapshot.credential.cooldownUntil
            ? new Date(snapshot.credential.cooldownUntil).toLocaleString()
            : '未知'}
          。
        </p>
      )}
    </div>
  );
}
