import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw, TriangleAlert } from 'lucide-react';
import type {
  ProviderQuotaHistoryPoint,
  ProviderQuotaHistoryResponse,
  ProviderQuotaOverviewResponse,
  ProviderQuotaSnapshot,
  ProviderQuotaWindow,
} from '@agent/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SettingsPanelHeader } from '@/components/SettingsCenter/SettingsPanelHeader';
import { AdminErrorAlert, EmptyState } from '@/components/PlatformAdmin/common';
import { EntityIcons } from '@/lib/icons';
import { cn } from '@/lib/utils';

import { platformAdminApi } from '../api';
import { formatTime } from '../format';

const SOURCE_LABEL: Record<ProviderQuotaSnapshot['sourceKind'], string> = {
  codex_subscription: 'Codex 订阅',
  volcengine_ark_plan: '火山 Agent Plan',
};

const WARNING_PERCENT = 85;
const HISTORY_HOURS = 24;

type Tone = 'ok' | 'warning' | 'critical';

/** ≥85% 提醒、撞限或 ≥100% 告警；状态色只做强调，文字标签保证不靠颜色单独传达。 */
export function windowTone(
  window: Pick<ProviderQuotaWindow, 'usedPercent' | 'limitReached'>,
): Tone {
  if (window.limitReached || window.usedPercent >= 100) return 'critical';
  if (window.usedPercent >= WARNING_PERCENT) return 'warning';
  return 'ok';
}

/** 距离重置的人读描述；已过期或缺失返回 null。 */
export function formatResetIn(resetAt: string | undefined, now = Date.now()): string | null {
  if (!resetAt) return null;
  const target = new Date(resetAt).getTime();
  if (!Number.isFinite(target)) return null;
  const diffMin = Math.round((target - now) / 60_000);
  if (diffMin <= 0) return '即将重置';
  if (diffMin < 60) return `${diffMin} 分钟后重置`;
  const hours = Math.floor(diffMin / 60);
  if (hours < 48) return `${hours} 小时${diffMin % 60 ? ` ${diffMin % 60} 分` : ''}后重置`;
  return `${Math.round(hours / 24)} 天后重置`;
}

function formatAmount(value: number | undefined, unit: string | undefined): string | null {
  if (value === undefined || unit === '%' || !unit) return null;
  const text =
    value >= 1000 ? Math.round(value).toLocaleString('zh-CN') : value.toFixed(value >= 100 ? 0 : 1);
  return `${text} ${unit}`;
}

/** 每个账号窗口在 24h 前最早一条成功快照里的已用百分比。 */
export function baselineUsedPercent(
  points: ProviderQuotaHistoryPoint[],
  accountKey: string,
  windowId: string,
): number | null {
  for (const point of points) {
    if (point.accountKey !== accountKey || !point.ok) continue;
    const window = point.windows.find((item) => item.id === windowId);
    if (window) return window.usedPercent;
  }
  return null;
}

function WindowRow({ window, baseline }: { window: ProviderQuotaWindow; baseline: number | null }) {
  const tone = windowTone(window);
  const fill = Math.min(100, Math.max(0, window.usedPercent));
  const amount = formatAmount(window.used, window.unit);
  const quota = formatAmount(window.quota, window.unit);
  const resetIn = formatResetIn(window.resetAt);
  const delta = baseline === null ? null : window.usedPercent - baseline;
  return (
    <div className="space-y-1" data-testid={`quota-window-${window.id}`}>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="truncate text-foreground">{window.label}</span>
        <span className="flex shrink-0 items-center gap-1.5 tabular-nums text-foreground">
          {tone !== 'ok' && (
            <Badge
              variant={tone === 'critical' ? 'danger' : 'warning'}
              className="gap-1 px-1.5 py-0 text-[11px]"
            >
              <TriangleAlert className="size-3" />
              {tone === 'critical' ? '已撞限' : '接近上限'}
            </Badge>
          )}
          {window.usedPercent.toFixed(1)}%
        </span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={Math.round(window.usedPercent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={window.label}
      >
        <div
          className={cn(
            'h-full rounded-full',
            tone === 'critical' ? 'bg-danger' : tone === 'warning' ? 'bg-warning' : 'bg-primary',
          )}
          style={{ width: `${fill}%` }}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 text-xs text-muted-foreground">
        <span>
          {amount && quota ? `${amount} / ${quota}` : (amount ?? '')}
          {delta !== null && Math.abs(delta) >= 0.05
            ? `${amount ? ' · ' : ''}24h ${delta > 0 ? '+' : ''}${delta.toFixed(1)}%`
            : ''}
        </span>
        <span>{resetIn ? `${resetIn}（${formatTime(window.resetAt)}）` : ''}</span>
      </div>
    </div>
  );
}

function AccountCard({
  snapshot,
  history,
}: {
  snapshot: ProviderQuotaSnapshot;
  history: ProviderQuotaHistoryPoint[];
}) {
  const critical =
    snapshot.limitReached || snapshot.windows.some((window) => windowTone(window) === 'critical');
  const lastSuccessAt =
    typeof snapshot.extra?.lastSuccessAt === 'string' ? snapshot.extra.lastSuccessAt : null;
  const credits = snapshot.extra?.credits as
    { balance?: string | number; hasCredits?: boolean } | undefined;
  return (
    <Card
      className={cn('h-fit', critical && 'border-danger/50')}
      data-testid={`quota-account-${snapshot.accountKey}`}
    >
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="truncate text-base">{snapshot.accountLabel}</CardTitle>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <Badge variant="outline" className="px-1.5 py-0 text-[11px]">
                {SOURCE_LABEL[snapshot.sourceKind]}
              </Badge>
              {snapshot.plan?.type && <span>档位 {snapshot.plan.type}</span>}
              {snapshot.plan?.status && <span>· {snapshot.plan.status}</span>}
              {snapshot.plan?.endTime && (
                <span>
                  · 到期 {formatTime(snapshot.plan.endTime)}
                  {snapshot.plan.autoRenew ? '（自动续费）' : ''}
                </span>
              )}
              {credits && <span>· Credits {credits.balance ?? 0}</span>}
            </div>
          </div>
          <div className="shrink-0 text-right text-xs text-muted-foreground">
            {snapshot.ok ? (
              `采集于 ${formatTime(snapshot.collectedAt)}`
            ) : (
              <span className="inline-flex items-center gap-1 text-danger-ink">
                <TriangleAlert className="size-3.5" />
                采集失败 {formatTime(snapshot.collectedAt)}
              </span>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {!snapshot.ok && (
          <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger-ink">
            {snapshot.error ?? '未知错误'}
            {lastSuccessAt && snapshot.windows.length > 0
              ? `。下方为 ${formatTime(lastSuccessAt)} 的最后一次成功数据。`
              : ''}
          </div>
        )}
        {snapshot.windows.length === 0 && snapshot.ok && (
          <p className="text-xs text-muted-foreground">供应商未返回额度窗口。</p>
        )}
        {snapshot.windows.map((window) => (
          <WindowRow
            key={window.id}
            window={window}
            baseline={baselineUsedPercent(history, snapshot.accountKey, window.id)}
          />
        ))}
      </CardContent>
    </Card>
  );
}

export function ProviderQuotaPage() {
  const [overview, setOverview] = useState<ProviderQuotaOverviewResponse | null>(null);
  const [history, setHistory] = useState<ProviderQuotaHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (mode: 'initial' | 'reload' | 'collect' = 'reload') => {
    if (mode === 'initial') setLoading(true);
    else setRefreshing(true);
    try {
      const overviewPromise =
        mode === 'collect'
          ? platformAdminApi.refreshProviderQuota()
          : platformAdminApi.providerQuota();
      const [overviewResult, historyResult] = await Promise.allSettled([
        overviewPromise,
        platformAdminApi.providerQuotaHistory(HISTORY_HOURS),
      ]);
      if (overviewResult.status === 'fulfilled') setOverview(overviewResult.value);
      if (historyResult.status === 'fulfilled') setHistory(historyResult.value);
      const failures = [overviewResult, historyResult]
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) =>
          result.reason instanceof Error ? result.reason.message : String(result.reason),
        );
      setError(failures.length > 0 ? failures.join(' · ') : null);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load('initial');
  }, [load]);

  const points = useMemo(() => history?.points ?? [], [history?.points]);
  const collector = overview?.collector;
  const limitReachedCount =
    overview?.items.filter(
      (item) =>
        item.limitReached || item.windows.some((window) => windowTone(window) === 'critical'),
    ).length ?? 0;

  if (loading && !overview) {
    return (
      <div className="flex h-64 items-center justify-center rounded-lg border bg-card text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        正在加载套餐额度…
      </div>
    );
  }

  return (
    <div className="w-full space-y-5">
      <SettingsPanelHeader
        title="套餐额度"
        description="各模型套餐账号的实时用量、重置时间与撞限状态。数据来源随模型配置：Codex 订阅按已授权账号采集，火山 Agent Plan 在模型分组里配置管控面凭据。"
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void load('collect')}
              disabled={refreshing}
            >
              <RefreshCw className={cn('mr-1.5 size-3.5', refreshing && 'animate-spin')} />
              立即采集
            </Button>
          </div>
        }
      />

      {error && <AdminErrorAlert error={error} />}

      {collector && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>
            采集器：
            {collector.enabled
              ? `每 ${Math.round(collector.intervalMs / 60_000)} 分钟自动采集`
              : '本进程仅按需刷新'}
          </span>
          <span>
            上次采集：{collector.lastRunAt ? formatTime(collector.lastRunAt) : '尚未运行'}
          </span>
          {limitReachedCount > 0 && (
            <span className="inline-flex items-center gap-1 text-danger-ink">
              <TriangleAlert className="size-3.5" />
              {limitReachedCount} 个账号已撞限
            </span>
          )}
          {collector.lastError && (
            <span className="text-warning-ink">最近错误：{collector.lastError}</span>
          )}
        </div>
      )}

      {overview && overview.items.length === 0 ? (
        <EmptyState
          icon={EntityIcons.credits}
          title="尚未配置任何套餐用量来源"
          description="在「平台配置 → 模型」里为火山 Agent Plan 分组填写管控面 AccessKey，或完成 Codex 订阅账号授权后，这里会自动出现对应账号。"
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {overview?.items.map((snapshot) => (
            <AccountCard key={snapshot.accountKey} snapshot={snapshot} history={points} />
          ))}
        </div>
      )}
    </div>
  );
}
