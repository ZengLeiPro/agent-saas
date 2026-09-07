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
import { ProviderPlanExpiryEditor } from './ProviderPlanExpiryEditor';
import { formatTime } from '../format';

const SOURCE_LABEL: Record<ProviderQuotaSnapshot['sourceKind'], string> = {
  codex_subscription: 'Codex 订阅',
  volcengine_ark_plan: '火山 Agent Plan',
  claude_subscription: 'Claude 订阅',
};

/** 推送型来源：平台没有可取数的管控面，由采集端主动上报，不提供单账号刷新。 */
const PUSH_ONLY_SOURCES = new Set<ProviderQuotaSnapshot['sourceKind']>(['claude_subscription']);

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

export interface AccountStatus {
  tone: Tone;
  label: string;
}

/**
 * 卡级总状态：先看能不能采到、凭据能不能用，再看额度。
 * 「冷却中」= 我们自己的调度器此刻在绕开这个账号，与供应商侧撞限分开显示。
 */
export function accountStatus(
  snapshot: Pick<ProviderQuotaSnapshot, 'ok' | 'limitReached' | 'windows' | 'credential'> & { sourceKind?: ProviderQuotaSnapshot['sourceKind'] },
): AccountStatus {
  if (!snapshot.ok) return { tone: 'critical', label: '采集失败' };
  if (snapshot.credential?.availability === 'auth_unavailable') {
    return { tone: 'critical', label: '凭据不可用' };
  }
  const tones = snapshot.windows
    .filter((window) => snapshot.sourceKind !== 'codex_subscription' || isMainCodexWindow(window))
    .map(windowTone);
  if (snapshot.limitReached || tones.includes('critical')) return { tone: 'critical', label: '已耗尽' };
  if (snapshot.credential?.availability === 'quota_cooldown') return { tone: 'warning', label: '冷却中' };
  if (tones.includes('warning')) return { tone: 'warning', label: '接近上限' };
  return { tone: 'ok', label: '正常' };
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

/** 中文量级：37.7万 / 40.2万，比 378,006 更易读（与火山控制台口径一致）。 */
export function formatWan(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 1e8) return `${(value / 1e8).toFixed(2)}亿`;
  if (Math.abs(value) >= 1e4) return `${(value / 1e4).toFixed(Math.abs(value) >= 1e6 ? 0 : 1)}万`;
  if (Math.abs(value) >= 100) return Math.round(value).toLocaleString('zh-CN');
  return value.toFixed(value === Math.round(value) ? 0 : 1);
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

function isMainCodexWindow(window: ProviderQuotaWindow): boolean {
  return window.id === 'primary' || window.id === 'secondary';
}

const TONE_BADGE: Record<Tone, 'success' | 'warning' | 'danger'> = {
  ok: 'success',
  warning: 'warning',
  critical: 'danger',
};
const TONE_BAR: Record<Tone, string> = {
  ok: 'bg-primary',
  warning: 'bg-warning',
  critical: 'bg-danger',
};
const TONE_EDGE: Record<Tone, string> = {
  ok: 'border-l-success',
  warning: 'border-l-warning',
  critical: 'border-l-danger',
};

export function formatResetTime(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  const weekday = `周${'日一二三四五六'[date.getDay()]}`;
  return formatTime(value).replace(/(\d{2}\/\d{2})\s+/, `$1 ${weekday} `);
}

function WindowTile({ window, baseline }: { window: ProviderQuotaWindow; baseline: number | null }) {
  const tone = windowTone(window);
  const label = window.label.replace(/每周/g, '周用量');
  const fill = Math.min(100, Math.max(0, window.usedPercent));
  const hasAmount = window.used !== undefined && window.unit !== undefined && window.unit !== '%';
  const resetIn = formatResetIn(window.resetAt);
  const delta = baseline === null ? null : window.usedPercent - baseline;
  return (
    <div
      className="space-y-2 rounded-md border bg-muted/10 p-3"
      data-testid={`quota-window-${window.id}`}
    >
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="truncate">{label}</span>
        {tone !== 'ok' && (
          <Badge variant={TONE_BADGE[tone]} className="gap-1 px-1.5 py-0 text-[11px]">
            <TriangleAlert className="size-3" />
            {tone === 'critical' ? '已撞限' : '接近上限'}
          </Badge>
        )}
      </div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-2xl font-semibold tabular-nums leading-none text-foreground">
          {window.usedPercent.toFixed(1)}%
        </span>
        {resetIn && <span className="ml-auto text-right text-xs text-muted-foreground">{resetIn}（{formatResetTime(window.resetAt)}）</span>}
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={Math.round(window.usedPercent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${label} 已用`}
      >
        <div className={cn('h-full rounded-full', TONE_BAR[tone])} style={{ width: `${fill}%` }} />
      </div>
      <div className="space-y-0.5 text-xs text-muted-foreground">
        <div className="flex flex-wrap items-center justify-between gap-x-3">
          {hasAmount && <span>已用 {formatWan(window.used!)}{window.quota !== undefined ? ` / ${formatWan(window.quota)}` : ''} {window.unit}</span>}
          {delta !== null && Math.abs(delta) >= 0.05 && (
            <span>
              24h {delta > 0 ? '+' : ''}
              {delta.toFixed(1)}%
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: Tone }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div
        className={cn(
          'truncate text-xs text-foreground',
          tone === 'critical' && 'text-danger-ink',
          tone === 'warning' && 'text-warning-ink',
        )}
        title={value}
      >
        {value}
      </div>
    </div>
  );
}

function AccountCard({
  snapshot,
  history,
  refreshing,
  onRefresh,
  onExpirySaved,
}: {
  snapshot: ProviderQuotaSnapshot;
  history: ProviderQuotaHistoryPoint[];
  refreshing: boolean;
  onRefresh: (accountKey: string) => void;
  onExpirySaved: (overview: ProviderQuotaOverviewResponse) => void;
}) {
  const status = accountStatus(snapshot);
  const credential = snapshot.credential;
  const isCodex = snapshot.sourceKind === 'codex_subscription';
  const isPushOnly = PUSH_ONLY_SOURCES.has(snapshot.sourceKind);
  const mainWindows = snapshot.windows
    .filter((window) => !isCodex || isMainCodexWindow(window))
    .sort((a, b) => Number(b.windowSeconds === 604_800) - Number(a.windowSeconds === 604_800));
  const additionalWindows = isCodex
    ? snapshot.windows.filter((window) => !isMainCodexWindow(window))
    : [];
  const additionalLimited = additionalWindows.filter((window) => windowTone(window) === 'critical').length;
  const lastSuccessAt =
    typeof snapshot.extra?.lastSuccessAt === 'string' ? snapshot.extra.lastSuccessAt : null;
  const credits = snapshot.extra?.credits as
    { balance?: string | number; hasCredits?: boolean } | undefined;
  const subtitle = [
    SOURCE_LABEL[snapshot.sourceKind],
    snapshot.plan?.type === 'pro' ? 'Pro' : snapshot.plan?.type,
    snapshot.resetCredits && snapshot.resetCredits > 0 ? `重置券 ${snapshot.resetCredits}` : undefined,
    !isCodex && snapshot.plan?.autoRenew ? '自动续费' : undefined,
  ].filter(Boolean).join(' · ');
  const minuteTime = (value: string) => formatTime(value).replace(/:\d{2}$/, '');
  const facts: Array<{ label: string; value: string; tone?: Tone }> = [
    ...(credits ? [{ label: 'Credits', value: String(credits.balance ?? 0) }] : []),
  ];
  return (
    <Card
      className={cn('h-full border-l-[3px]', TONE_EDGE[status.tone])}
      data-testid={`quota-account-${snapshot.accountKey}`}
    >
      <CardHeader className="pb-3">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <CardTitle className="break-all text-base">{snapshot.accountLabel}</CardTitle>
              <Badge variant={TONE_BADGE[status.tone]} className="gap-1 px-1.5 py-0 text-[11px]">
                {status.tone !== 'ok' && <TriangleAlert className="size-3" />}
                {status.label}
              </Badge>
              {credential?.availability === 'quota_cooldown' && status.label !== '冷却中' && (
                <Badge variant="warning" className="px-1.5 py-0 text-2xs" title={credential.cooldownUntil ? `冷却至 ${formatTime(credential.cooldownUntil)}` : undefined}>冷却中</Badge>
              )}
              {credential?.availability === 'auth_unavailable' && status.label !== '凭据不可用' && (
                <Badge variant="danger" className="px-1.5 py-0 text-2xs" title={credential.lastFailureCode}>凭据不可用</Badge>
              )}
            {!isCodex && snapshot.plan?.status && snapshot.plan.status !== 'Running' && (
              <Badge variant="warning" className="px-1.5 py-0 text-2xs">{snapshot.plan.status}</Badge>
            )}
          </div>
          <span className={cn('col-start-1 row-start-3 text-xs tabular-nums text-muted-foreground sm:col-start-2 sm:row-start-1 sm:text-right', !snapshot.ok && 'text-danger-ink')}>
            {snapshot.ok ? '采集于' : '采集失败于'} {minuteTime(snapshot.collectedAt)}
          </span>
          {!isPushOnly && (
            <Button
              variant="ghost"
              size="sm"
              className="col-start-2 row-start-1 h-7 px-2 text-xs sm:col-start-3"
              aria-label={`刷新 ${snapshot.accountLabel}`}
              disabled={refreshing}
              onClick={() => onRefresh(snapshot.accountKey)}
            >
              <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />
            </Button>
          )}
          <span className="col-start-1 row-start-2 text-xs text-muted-foreground" title={isCodex && credential?.expiresAt ? `凭据到期 ${minuteTime(credential.expiresAt)}${credential.accessTokenExpired ? '（已过期）' : ''}` : undefined}>{subtitle}</span>
          <div className="col-start-1 row-start-4 text-xs tabular-nums text-muted-foreground sm:col-start-2 sm:row-start-2 sm:text-right">
            <ProviderPlanExpiryEditor snapshot={snapshot} onSaved={onExpirySaved} />
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
        {mainWindows.length > 0 && (
          <div className={cn('grid gap-3', mainWindows.length > 1 && 'sm:grid-cols-2')}>
            {mainWindows.map((window) => (
              <WindowTile
                key={window.id}
                window={window}
                baseline={baselineUsedPercent(history, snapshot.accountKey, window.id)}
              />
            ))}
          </div>
        )}
        {facts.length > 0 && <div className="grid grid-cols-2 gap-x-3 gap-y-2 border-t pt-3 sm:grid-cols-4">
          {facts.map((fact) => (
            <Fact key={fact.label} {...fact} />
          ))}
        </div>}
        {additionalWindows.length > 0 && (
          <details className="rounded-md border p-3">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              其他模型额度（{additionalWindows.length} 个窗口）
              {additionalLimited > 0 && <span className="ml-2 text-warning-ink">{additionalLimited} 个窗口已耗尽</span>}
            </summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {additionalWindows.map((window) => (
                <WindowTile key={window.id} window={window} baseline={baselineUsedPercent(history, snapshot.accountKey, window.id)} />
              ))}
            </div>
          </details>
        )}

      </CardContent>
    </Card>
  );
}

export function ProviderQuotaPage() {
  const [overview, setOverview] = useState<ProviderQuotaOverviewResponse | null>(null);
  const [history, setHistory] = useState<ProviderQuotaHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshingKey, setRefreshingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (mode: 'initial' | 'reload' | 'collect' = 'reload', accountKey?: string) => {
      if (mode === 'initial') setLoading(true);
      else setRefreshing(true);
      if (accountKey) setRefreshingKey(accountKey);
      try {
        const overviewPromise =
          mode === 'collect'
            ? platformAdminApi.refreshProviderQuota(accountKey)
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
        setRefreshingKey(null);
      }
    },
    [],
  );

  useEffect(() => {
    void load('initial');
  }, [load]);

  const points = useMemo(() => history?.points ?? [], [history?.points]);
  const collector = overview?.collector;
  const statusCounts = useMemo(() => {
    const counts = { collectionFailed: 0, exhausted: 0, credentialUnavailable: 0, warning: 0 };
    for (const item of overview?.items ?? []) {
      const status = accountStatus(item);
      if (status.label === '采集失败') counts.collectionFailed += 1;
      if (status.label === '已耗尽') counts.exhausted += 1;
      if (status.label === '凭据不可用') counts.credentialUnavailable += 1;
      if (status.tone === 'warning') counts.warning += 1;
    }
    return counts;
  }, [overview?.items]);

  const criticalCount = statusCounts.collectionFailed + statusCounts.exhausted + statusCounts.credentialUnavailable;

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
        description={
          <span>{collector?.enabled ? `每 ${Math.round(collector.intervalMs / 60_000)} 分钟自动采集。` : '本进程按需采集。'}页面不自动刷新，点击「立即采集」更新。</span>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {criticalCount > 0 && <Badge variant="danger" title={`采集失败 ${statusCounts.collectionFailed} · 额度耗尽 ${statusCounts.exhausted} · 凭据不可用 ${statusCounts.credentialUnavailable}`}>{criticalCount} 个异常</Badge>}
            {statusCounts.warning > 0 && <Badge variant="warning">{statusCounts.warning} 个需关注</Badge>}
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

      {overview && overview.items.length === 0 ? (
        <EmptyState
          icon={EntityIcons.credits}
          title="尚未配置任何套餐用量来源"
          description="在「平台配置 → 模型」里为火山 Agent Plan 分组填写管控面 AccessKey，或完成 Codex 订阅账号授权后，这里会自动出现对应账号。"
        />
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {overview?.items.map((snapshot) => (
            <AccountCard
              key={snapshot.accountKey}
              snapshot={snapshot}
              history={points}
              refreshing={refreshing && (refreshingKey === null || refreshingKey === snapshot.accountKey)}
              onExpirySaved={setOverview}
              onRefresh={(accountKey) => void load('collect', accountKey)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
