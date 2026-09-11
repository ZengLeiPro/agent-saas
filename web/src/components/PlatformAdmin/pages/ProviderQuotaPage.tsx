import { GrokQuotaDetails } from './GrokQuotaDetails';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronRight, GripVertical, Loader2, RefreshCw, TriangleAlert } from 'lucide-react';
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
import { ProviderQuotaPlanBadge } from './ProviderQuotaPlanBadge';
import {
  moveQuotaAccount,
  orderQuotaAccounts,
  readQuotaAccountOrder,
  writeQuotaAccountOrder,
} from './providerQuotaOrder';
import { formatTime } from '../format';

const SOURCE_LABEL: Record<ProviderQuotaSnapshot['sourceKind'], string> = {
  codex_subscription: 'Codex 订阅',
  grok_subscription: 'Grok 订阅',
  volcengine_ark_plan: '火山 Agent Plan',
  claude_subscription: 'Claude 订阅',
  zhipu_coding_plan: '智谱 Coding Plan',
};

/** 推送型来源：平台没有可取数的管控面，由采集端主动上报，不提供单账号刷新。 */
const PUSH_ONLY_SOURCES = new Set<ProviderQuotaSnapshot['sourceKind']>(['claude_subscription']);

const WARNING_PERCENT = 70;
const HISTORY_HOURS = 24;
const VOLCENGINE_WINDOW_ORDER: Record<string, number> = { monthly: 0, five_hour: 1 };

type Tone = 'ok' | 'warning' | 'critical';

/** ≥70% 提醒、撞限或 ≥100% 告警；状态色只做强调，文字标签保证不靠颜色单独传达。 */
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

function isMainCodexWindow(window: ProviderQuotaWindow): boolean {
  return window.id === 'primary' || window.id === 'secondary';
}

function isMainClaudeWindow(window: ProviderQuotaWindow): boolean {
  return window.id === 'seven_day';
}

function isMainSubscriptionWindow(
  sourceKind: ProviderQuotaSnapshot['sourceKind'] | undefined,
  window: ProviderQuotaWindow,
): boolean {
  if (sourceKind === 'codex_subscription') return isMainCodexWindow(window);
  if (sourceKind === 'claude_subscription') return isMainClaudeWindow(window);
  return true;
}

/**
 * 卡级总状态：先看能不能采到、凭据能不能用，再看额度。
 * 调度器冷却不参与本页状态展示，不影响后端实际调度行为。
 */
export function accountStatus(
  snapshot: Pick<ProviderQuotaSnapshot, 'ok' | 'limitReached' | 'windows' | 'credential'> & { sourceKind?: ProviderQuotaSnapshot['sourceKind'] },
): AccountStatus {
  if (!snapshot.ok) return { tone: 'critical', label: '采集失败' };
  if (snapshot.credential?.availability === 'auth_unavailable') {
    return { tone: 'critical', label: '凭据不可用' };
  }
  if (snapshot.sourceKind === 'grok_subscription' && snapshot.windows.length === 0) return { tone: 'warning', label: '额度未知' };
  const tones = snapshot.windows
    .filter((window) => isMainSubscriptionWindow(snapshot.sourceKind, window))
    .map(windowTone);
  if (snapshot.limitReached || tones.includes('critical')) return { tone: 'critical', label: '已耗尽' };
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
  if (diffMin < 60) return `${diffMin} 分钟`;
  const hours = Math.floor(diffMin / 60);
  if (hours < 48) return `${hours} 小时${diffMin % 60 ? ` ${diffMin % 60} 分` : ''}`;
  return `${Math.round(hours / 24)} 天`;
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

export function formatResetTime(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  const weekday = `周${'日一二三四五六'[date.getDay()]}`;
  return formatTime(value).replace(/(\d{2}\/\d{2})\s+/, `$1 ${weekday} `);
}

function WindowTile({ window }: { window: ProviderQuotaWindow }) {
  const tone = windowTone(window);
  const label = window.label.replace(/每周/g, '周用量');
  const fill = Math.min(100, Math.max(0, window.usedPercent));
  const hasAmount = window.used !== undefined && window.unit !== undefined && window.unit !== '%';
  const resetIn = formatResetIn(window.resetAt);
  return (
    <div
      className="space-y-2 rounded-md border bg-muted/10 p-3"
      data-testid={`quota-window-${window.id}`}
    >
      <div className="text-xs text-muted-foreground">
        <span className="truncate">{label}</span>
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
      {hasAmount && (
        <div className="text-xs text-muted-foreground">
          已用 {formatWan(window.used!)}{window.quota !== undefined ? ` / ${formatWan(window.quota)}` : ''} {window.unit}
        </div>
      )}
    </div>
  );
}

function AccountCard({
  snapshot,
  refreshing,
  onRefresh,
  onExpirySaved,
  dragHandle,
}: {
  snapshot: ProviderQuotaSnapshot;
  refreshing: boolean;
  onRefresh: (accountKey: string) => void;
  onExpirySaved: (overview: ProviderQuotaOverviewResponse) => void;
  dragHandle: ReactNode;
}) {
  const status = accountStatus(snapshot);
  const credential = snapshot.credential;
  const isCodex = snapshot.sourceKind === 'codex_subscription';
  const isClaude = snapshot.sourceKind === 'claude_subscription';
  const isZhipu = snapshot.sourceKind === 'zhipu_coding_plan';
  const isPushOnly = PUSH_ONLY_SOURCES.has(snapshot.sourceKind);
  const mainWindows = snapshot.windows
    .filter((window) => isMainSubscriptionWindow(snapshot.sourceKind, window))
    .sort((a, b) => snapshot.sourceKind === 'volcengine_ark_plan'
      ? (VOLCENGINE_WINDOW_ORDER[a.id] ?? 2) - (VOLCENGINE_WINDOW_ORDER[b.id] ?? 2)
      : Number(b.windowSeconds === 604_800) - Number(a.windowSeconds === 604_800));
  const additionalWindows = isCodex || isClaude
    ? snapshot.windows.filter((window) => !isMainSubscriptionWindow(snapshot.sourceKind, window))
    : [];
  const additionalLimited = additionalWindows.filter((window) => windowTone(window) === 'critical').length;
  const lastSuccessAt =
    typeof snapshot.extra?.lastSuccessAt === 'string' ? snapshot.extra.lastSuccessAt : null;
  const credits = snapshot.extra?.credits as
    { balance?: string | number; hasCredits?: boolean } | undefined;
  const creditBalance = Number(credits?.balance ?? 0);
  const showCredits = Number.isFinite(creditBalance) && creditBalance !== 0;
  const subtitle = [
    SOURCE_LABEL[snapshot.sourceKind],
    snapshot.plan?.type === 'pro' ? 'Pro' : snapshot.plan?.type,
    snapshot.resetCredits && snapshot.resetCredits > 0 ? `重置券 ${snapshot.resetCredits}` : undefined,
    !isCodex && snapshot.plan?.autoRenew ? '自动续费' : undefined,
  ].filter(Boolean).join(' · ');
  const minuteTime = (value: string) => formatTime(value).replace(/:\d{2}$/, '');
  return (
    <Card
      className={cn(
        'h-full border-brand-100 bg-gradient-to-b from-brand-50/80 via-white via-55% to-white ring-1 ring-brand-100',
        'shadow-[inset_0_1px_0_#fff,0_1px_2px_rgba(0,0,0,0.03)]',
        'dark:border-brand-800 dark:from-brand-900/30 dark:via-card dark:to-card dark:ring-brand-800 dark:shadow-none',
      )}
      data-testid={`quota-account-${snapshot.accountKey}`}
    >
      <CardHeader className="pb-3">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {dragHandle}
            <CardTitle className="break-all text-base">{snapshot.accountLabel}</CardTitle>
            <Badge variant={TONE_BADGE[status.tone]} className="gap-1 px-1.5 py-0 text-[11px]">
              {status.tone !== 'ok' && <TriangleAlert className="size-3" />}
              {status.label}
            </Badge>
            {credential?.availability === 'auth_unavailable' && status.label !== '凭据不可用' && (
              <Badge variant="danger" className="px-1.5 py-0 text-2xs" title={credential.lastFailureCode}>凭据不可用</Badge>
            )}
            {!isCodex && snapshot.plan?.status && snapshot.plan.status !== 'Running' && (
              <Badge variant="warning" className="px-1.5 py-0 text-2xs">{snapshot.plan.status}</Badge>
            )}
          </div>
          <div className="col-start-2 row-start-1 flex items-center justify-end gap-3">
            <span className={cn('whitespace-nowrap text-xs font-normal tabular-nums text-muted-foreground', !snapshot.ok && 'text-danger-ink')}>
              采集 {minuteTime(snapshot.collectedAt)}
            </span>
            {!isPushOnly ? (
              <Button
                variant="ghost"
                size="sm"
                className="size-7 shrink-0 p-0 text-xs"
                aria-label={`刷新 ${snapshot.accountLabel}`}
                disabled={refreshing}
                onClick={() => onRefresh(snapshot.accountKey)}
              >
                <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />
              </Button>
            ) : (
              <span className="size-7 shrink-0" aria-hidden="true" />
            )}
          </div>
          <div className="col-start-1 row-start-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs" title={isCodex && credential?.expiresAt ? `凭据到期 ${minuteTime(credential.expiresAt)}${credential.accessTokenExpired ? '（已过期）' : ''}` : undefined}>
            <ProviderQuotaPlanBadge sourceKind={snapshot.sourceKind} planType={snapshot.plan?.type}>{subtitle}</ProviderQuotaPlanBadge>
            {showCredits && <span className="whitespace-nowrap tabular-nums text-muted-foreground">Credits {credits!.balance}</span>}
          </div>
          <div className="col-start-2 row-start-2 justify-self-end text-right">
            <ProviderPlanExpiryEditor snapshot={snapshot} onSaved={onExpirySaved} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {snapshot.sourceKind === 'grok_subscription' && <GrokQuotaDetails snapshot={snapshot} />} 
        {isZhipu && (
          <p className="text-xs text-muted-foreground" data-testid="zhipu-quota-scope">
            个人套餐 · 账号共享额度，不是单 Key 用量。同账号多个 Key 的卡片可能重复，不能相加。
            未返回的周期、上限或重置时间不做推算。
          </p>
        )}
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
              <WindowTile key={window.id} window={window} />
            ))}
          </div>
        )}
        {additionalWindows.length > 0 && (
          <details className="group/other">
            <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-1 gap-y-1 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
              <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform group-open/other:rotate-90" aria-hidden="true" />
              <span>其他（{additionalWindows.length} 个窗口）</span>
              {additionalLimited > 0 && <span className="ml-2 text-warning-ink">{additionalLimited} 个窗口已耗尽</span>}
            </summary>
            <div className={cn('mt-3 grid gap-3', mainWindows.length > 1 && 'sm:grid-cols-2')}>
              {additionalWindows.map((window) => (
                <WindowTile key={window.id} window={window} />
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
  const [, setHistory] = useState<ProviderQuotaHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshingKey, setRefreshingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accountOrder, setAccountOrder] = useState(readQuotaAccountOrder);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [dropTargetKey, setDropTargetKey] = useState<string | null>(null);
  const [sortAnnouncement, setSortAnnouncement] = useState('');

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

  const orderedItems = useMemo(
    () => orderQuotaAccounts(overview?.items ?? [], accountOrder),
    [overview?.items, accountOrder],
  );

  const moveAccount = (accountKey: string, targetKey: string) => {
    const next = moveQuotaAccount(orderedItems.map((item) => item.accountKey), accountKey, targetKey);
    if (!next) return;
    setAccountOrder(next);
    const saved = writeQuotaAccountOrder(next);
    const label = orderedItems.find((item) => item.accountKey === accountKey)?.accountLabel ?? accountKey;
    setSortAnnouncement(`已将 ${label} 移至第 ${next.indexOf(accountKey) + 1} 位，共 ${next.length} 张卡片。${saved ? '顺序已保存。' : '浏览器存储不可用，仅在本次页面内保留顺序。'}`);
  };

  const stopDragging = () => {
    setDraggingKey(null);
    setDropTargetKey(null);
  };

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

      <p id="quota-order-instructions" className="sr-only">拖动卡片标题旁的六点手柄调整顺序；也可聚焦手柄后按上下方向键前移或后移。顺序保存在当前浏览器。</p>
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">{sortAnnouncement}</p>
      {error && <AdminErrorAlert error={error} />}

      {overview && overview.items.length === 0 ? (
        <EmptyState
          icon={EntityIcons.credits}
          title="尚未配置任何套餐用量来源"
          description="在「平台配置 → 模型」里配置智谱分组的 API Key 和官方 Base URL（也可显式选择智谱 Coding Plan），为火山 Agent Plan 填写管控面 AccessKey，或完成 Codex 订阅授权。首次采集后会出现对应卡片，也可点击「立即采集」。"
        />
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {orderedItems.map((snapshot, index) => (
            <div
              key={snapshot.accountKey}
              data-quota-sortable={snapshot.accountKey}
              className={cn(
                'group relative min-w-0 rounded-lg transition-[box-shadow,opacity]',
                draggingKey === snapshot.accountKey && 'opacity-50',
                dropTargetKey === snapshot.accountKey && 'ring-2 ring-primary/50 ring-offset-2 ring-offset-background',
              )}
              onDragOver={(event) => {
                if (!draggingKey) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setDropTargetKey(draggingKey === snapshot.accountKey ? null : snapshot.accountKey);
              }}
              onDragLeave={(event) => {
                const next = event.relatedTarget;
                if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
                  setDropTargetKey((key) => key === snapshot.accountKey ? null : key);
                }
              }}
              onDrop={(event) => {
                if (!draggingKey) return;
                event.preventDefault();
                moveAccount(draggingKey, snapshot.accountKey);
                stopDragging();
              }}
            >
              <AccountCard
                snapshot={snapshot}
                refreshing={refreshing && (refreshingKey === null || refreshingKey === snapshot.accountKey)}
                onExpirySaved={setOverview}
                onRefresh={(accountKey) => void load('collect', accountKey)}
                dragHandle={
                  <button
                    type="button"
                    draggable={orderedItems.length > 1}
                    disabled={orderedItems.length < 2}
                    aria-label={`拖动排序 ${snapshot.accountLabel}`}
                    aria-describedby="quota-order-instructions"
                    aria-keyshortcuts="ArrowUp ArrowDown"
                    title="拖动调整顺序；也可聚焦后按上下方向键"
                    className="-ml-1 flex size-7 shrink-0 cursor-grab items-center justify-center rounded-md text-muted-foreground/40 outline-none transition-colors group-hover:text-muted-foreground hover:bg-background/80 hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing disabled:cursor-default disabled:opacity-25"
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData('text/plain', snapshot.accountKey);
                      const card = event.currentTarget.closest<HTMLElement>('[data-quota-sortable]');
                      if (card) {
                        const rect = card.getBoundingClientRect();
                        event.dataTransfer.setDragImage(card, event.clientX - rect.left, event.clientY - rect.top);
                      }
                      setDraggingKey(snapshot.accountKey);
                    }}
                    onDragEnd={stopDragging}
                    onKeyDown={(event) => {
                      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                      event.preventDefault();
                      const target = orderedItems[index + (event.key === 'ArrowUp' ? -1 : 1)];
                      if (target) moveAccount(snapshot.accountKey, target.accountKey);
                    }}
                  >
                    <GripVertical className="h-4 w-4" aria-hidden="true" />
                  </button>
                }
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
