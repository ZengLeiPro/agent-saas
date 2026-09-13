import type { ProviderQuotaSnapshot } from '@agent/shared';
/**
 * 只有真的有话要说时才占位：无冷却信息时返回 null，
 * 否则空节点仍会吃掉 CardContent 的 space-y-3 间距，让 Grok 卡比其他卡多一行行距。
 */
export function GrokQuotaDetails({ snapshot }: { snapshot: ProviderQuotaSnapshot }) {
  const credential = snapshot.credential;
  if (credential?.availability !== 'quota_cooldown') return null;
  return (
    <div className="space-y-1 text-xs text-muted-foreground" data-testid="grok-quota-scope">
      <p>
        账号处于额度冷却，优先级调度暂时跳过；冷却到期：
        {credential.cooldownUntil
          ? new Date(credential.cooldownUntil).toLocaleString()
          : '未知'}
        。
      </p>
    </div>
  );
}
