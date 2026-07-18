import { Database, Info } from 'lucide-react';
import { cn } from '@/lib/utils';

/** 数据面不可用（file backend 未装配 PG）：503 → 隐藏功能换提示 */
export function QaUnavailableHint() {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-12 text-muted-foreground">
      <Database className="size-6" />
      <div className="text-sm">对话质检需要 PG 数据面支持，当前部署未启用。</div>
    </div>
  );
}

/** 特定视图端点未部署（B4 · 申诉表尚未建）：404/503 → 视图内提示，不阻断其他视图 */
export function QaFeatureNotDeployedHint({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-10 text-muted-foreground">
      <Info className="size-5" />
      <div className="text-sm">{title}</div>
      {hint && <div className="text-xs">{hint}</div>}
    </div>
  );
}

export function formatQaTime(iso: string | null): string {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return iso;
  }
}

/** 数值卡片（KPI）：门禁看板顶部拒答率/申诉率/fail_open 率 */
export function QaKpiCard({
  label,
  value,
  hint,
  intent = 'default',
}: {
  label: string;
  value: string;
  hint?: string;
  intent?: 'default' | 'warning' | 'success' | 'danger';
}) {
  const tone: Record<typeof intent, string> = {
    default: 'text-foreground',
    warning: 'text-warning',
    success: 'text-success',
    danger: 'text-destructive',
  };
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn('mt-1 text-2xl font-semibold tabular-nums', tone[intent])}>{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

/** 水平柱条（拒答 top / model 分布均复用） */
export function QaHorizontalBar({
  label,
  count,
  total,
  color = 'bg-indigo-400/80 dark:bg-indigo-500/70',
  suffix,
}: {
  label: string;
  count: number;
  total: number;
  color?: string;
  /** 右侧文字（默认「count / total」，可传 e.g. 「count · 30%」） */
  suffix?: string;
}) {
  const ratio = total > 0 ? Math.max(0.02, count / total) : 0;
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-xs">
        <div className="min-w-0 flex-1 truncate text-foreground" title={label}>{label}</div>
        <div className="shrink-0 tabular-nums text-muted-foreground">
          {suffix ?? `${count} / ${total}`}
        </div>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-sm bg-muted">
        <div
          className={cn('h-full rounded-sm transition-all', color)}
          style={{ width: `${Math.min(100, ratio * 100)}%` }}
          aria-label={`${label} 占 ${pct}%`}
        />
      </div>
    </div>
  );
}

/** 简易日趋势柱图（视图 3 latency trend 附带）——复用 TenantAnalytics/charts MiniBarTrend 逻辑 */
export function QaMiniBarTrend({
  points,
  height = 96,
  emptyText = '区间内暂无数据',
}: {
  points: Array<{ date: string; value: number }>;
  height?: number;
  emptyText?: string;
}) {
  if (points.length === 0) {
    return (
      <div className="flex items-center justify-center text-xs text-muted-foreground" style={{ height }}>
        {emptyText}
      </div>
    );
  }
  const max = Math.max(...points.map((point) => point.value), 1);
  const first = points[0]?.date ?? '';
  const last = points[points.length - 1]?.date ?? '';
  return (
    <div>
      <div className="flex items-end gap-[2px]" style={{ height }}>
        {points.map((point) => {
          const ratio = Math.max(0, point.value) / max;
          return (
            <div
              key={point.date}
              className="group relative flex h-full flex-1 items-end rounded-sm hover:bg-muted/50"
              title={`${point.date} · ${point.value}`}
            >
              <div
                className="w-full rounded-sm bg-indigo-400/70 transition-colors group-hover:opacity-80 dark:bg-indigo-500/60"
                style={{ height: point.value > 0 ? `${Math.max(ratio * 100, 2)}%` : '1px' }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground tabular-nums">
        <span>{first}</span>
        {points.length > 2 && <span>{last}</span>}
      </div>
    </div>
  );
}

/** 门禁模式判定 badge——统一 shadow / enforce 视觉，避免 4 视图各自实现 */
export function QaVerdictBadge({ verdict }: { verdict: string }) {
  const isShadow = verdict.endsWith('_shadow');
  const isOffTopic = verdict.startsWith('off_topic');
  const label = isOffTopic ? '范围外拒绝' : '放行打标';
  const shadowSuffix = isShadow ? ' · shadow' : '';
  const cls = isOffTopic
    ? 'border-0 bg-destructive/15 text-destructive'
    : 'border-0 bg-warning/15 text-warning';
  return (
    <span className={cn('inline-flex items-center rounded-md px-1.5 py-0.5 text-xs', cls)}>
      {label}{shadowSuffix}
    </span>
  );
}

export function formatLatencyMs(value: number | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
  return `${Math.round(value)} ms`;
}

export function formatPercent(ratio: number, digits = 1): string {
  if (!Number.isFinite(ratio)) return '-';
  return `${(ratio * 100).toFixed(digits)}%`;
}
