import type { ProviderQuotaSnapshot } from '@agent/shared';
export function GrokQuotaDetails({ snapshot }: { snapshot: ProviderQuotaSnapshot }) {
  return (
    <div className="space-y-1 text-xs text-muted-foreground" data-testid="grok-quota-scope">
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
