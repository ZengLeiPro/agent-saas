import { Database, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { EmptyState, MetricCard, type MetricTone } from "@/components/PlatformAdmin/common";

import { formatBytes, formatDuration, formatNumber, formatTime } from "../format";
import type { EventStoreRetentionStatus, EventStoreStatusResponse } from "../types";

const STATUS_TEXT: Record<EventStoreRetentionStatus, string> = {
  never_run: "从未运行",
  scheduled: "已调度",
  running: "运行中",
  dry_run_succeeded: "预演成功",
  execute_succeeded: "执行成功",
  blocked: "已阻断",
  failed: "失败",
  stale: "已过期",
  unavailable: "不可用",
};

const CATEGORY_TEXT: Record<string, string> = {
  "tool-delta": "工具增量",
  "assistant-stream": "助手流事件",
  "tool-stream-summary": "工具流摘要",
  "model-diagnostics": "模型诊断",
  "model-request-finished": "模型请求完成",
  "hand-events": "Hand 事件",
};

function normalizedStatus(data: EventStoreStatusResponse): EventStoreRetentionStatus {
  return Object.prototype.hasOwnProperty.call(STATUS_TEXT, data.retention.status)
    ? data.retention.status
    : "unavailable";
}

function hasCompleteCapacityValues(capacity: {
  totalBytes: number | null;
  tableBytes: number | null;
  indexBytes: number | null;
}): boolean {
  const values = [capacity.totalBytes, capacity.tableBytes, capacity.indexBytes];
  return values.every((value) => value !== null && Number.isFinite(value) && value >= 0)
    && capacity.totalBytes! >= capacity.tableBytes! + capacity.indexBytes!;
}

function hasCompleteCapacity(data: EventStoreStatusResponse): boolean {
  return data.capacity.available && isValidTimestamp(data.capacity.sampledAt)
    && hasCompleteCapacityValues(data.capacity);
}

function isValidTimestamp(value: string | null): value is string {
  return value !== null && Number.isFinite(Date.parse(value));
}

function hasPlausibleRunTimestamps(data: EventStoreStatusResponse): boolean {
  const generatedMs = Date.parse(data.generatedAt);
  if (!Number.isFinite(generatedMs)) return false;
  return [
    data.retention.lastStartedAt,
    data.retention.lastCompletedAt,
    data.retention.lastSuccessAt,
  ].every((value) => value === null || (
    isValidTimestamp(value) && Date.parse(value) <= generatedMs + 5 * 60_000
  ));
}

function isValidCapacitySample(sample: EventStoreStatusResponse["capacity"]["series"][number]): boolean {
  return isValidTimestamp(sample.sampledAt) && hasCompleteCapacityValues(sample);
}

function hasConsistentRetentionWatermarks(
  watermarks: EventStoreStatusResponse["retention"]["watermarks"],
): boolean {
  const values = [
    watermarks.legal,
    watermarks.billing,
    watermarks.effective,
    watermarks.maxGlobalSequence,
    watermarks.lag,
  ];
  if (values.some((value) => value === null || !/^\d+$/.test(value))) return false;
  const legal = BigInt(watermarks.legal!);
  const billing = BigInt(watermarks.billing!);
  const effective = BigInt(watermarks.effective!);
  const maxGlobalSequence = BigInt(watermarks.maxGlobalSequence!);
  const lag = BigInt(watermarks.lag!);
  return effective === (legal < billing ? legal : billing)
    && maxGlobalSequence >= billing
    && lag === maxGlobalSequence - effective;
}

function hasSufficientCapacityTrend(data: EventStoreStatusResponse): boolean {
  return data.capacity.series.filter(isValidCapacitySample).length >= 2;
}

function hasTrustworthyRetention(data: EventStoreStatusResponse): boolean {
  const { retention } = data;
  const status = normalizedStatus(data);
  if (status === "scheduled") {
    return hasPlausibleRunTimestamps(data)
      && retention.enabled && isValidTimestamp(retention.nextScheduledAt)
      && retention.lastStartedAt === null && retention.lastCompletedAt === null
      && retention.durationMs === null && retention.errorCategory === null
      && typeof retention.watermarks.legal === "string" && /^\d+$/.test(retention.watermarks.legal)
      && retention.watermarks.billing === null && retention.watermarks.effective === null
      && retention.watermarks.maxGlobalSequence === null && retention.watermarks.lag === null
      && Object.keys(retention.categories).length === 0;
  }
  if (status !== "dry_run_succeeded" && status !== "execute_succeeded") return true;
  const categories = Object.values(retention.categories);
  const validCategories = categories.length === Object.keys(CATEGORY_TEXT).length
    && Object.keys(CATEGORY_TEXT).every((name) => retention.categories[name] !== undefined)
    && categories.every((category) => (
      category.eligible !== null && Number.isSafeInteger(category.eligible) && category.eligible >= 0
      && category.deleted !== null && Number.isSafeInteger(category.deleted) && category.deleted >= 0
      && category.deleted <= category.eligible
    ));
  const dryRunDeletedNothing = status !== "dry_run_succeeded"
    || categories.every((category) => category.deleted === 0);
  return hasPlausibleRunTimestamps(data)
    && isValidTimestamp(retention.lastStartedAt)
    && isValidTimestamp(retention.lastCompletedAt)
    && isValidTimestamp(retention.lastSuccessAt)
    && Date.parse(retention.lastCompletedAt) >= Date.parse(retention.lastStartedAt)
    && Date.parse(retention.lastSuccessAt) >= Date.parse(retention.lastStartedAt)
    && retention.durationMs !== null && Number.isFinite(retention.durationMs) && retention.durationMs >= 0
    && retention.errorCategory === null && hasConsistentRetentionWatermarks(retention.watermarks)
    && validCategories && dryRunDeletedNothing
    && (!retention.enabled || isValidTimestamp(retention.nextScheduledAt))
    && (status === "dry_run_succeeded") === (retention.mode === "dry-run");
}

function statusTone(data: EventStoreStatusResponse, refreshFailed: boolean): MetricTone {

  const status = normalizedStatus(data);
  if (status === "blocked" || status === "failed") return "bad";
  if (!data.available || status === "unavailable"
    || !hasCompleteCapacity(data) || !hasTrustworthyRetention(data)) return "default";
  if (
    refreshFailed || !data.retention.enabled || data.retention.stale || data.capacity.stale
    || !hasSufficientCapacityTrend(data)
    || status === "stale" || status === "scheduled" || status === "running" || status === "never_run"
  ) return "warn";
  return "good";
}

function badgeVariant(tone: MetricTone): "success" | "warning" | "danger" | "muted" {
  if (tone === "good") return "success";
  if (tone === "warn") return "warning";
  if (tone === "bad") return "danger";
  return "muted";
}

function healthText(data: EventStoreStatusResponse, refreshFailed: boolean): string {
  const status = normalizedStatus(data);
  if (status === "blocked") return "已阻断";
  if (status === "failed") return "失败";
  if (!data.available || status === "unavailable"
    || !hasCompleteCapacity(data) || !hasTrustworthyRetention(data)) return "不可用";
  if (!data.retention.enabled) return "未启用";
  if (refreshFailed || data.retention.stale || data.capacity.stale || status === "stale") return "已过期";
  if (!hasSufficientCapacityTrend(data)
    || status === "scheduled" || status === "running" || status === "never_run") return "需关注";
  return "健康";
}

function formatDelta(first: number | null, last: number | null): string {
  if (first == null || last == null || !Number.isFinite(first) || !Number.isFinite(last)) return "不可用";
  const delta = last - first;
  return `${delta >= 0 ? "+" : "−"}${formatBytes(Math.abs(delta))}`;
}

export function EventStoreSection({ data, refreshFailed = false }: { data: EventStoreStatusResponse | null; refreshFailed?: boolean }) {
  if (!data) {
    return (
      <section className="rounded-lg border bg-card" aria-labelledby="event-store-title">
        <div className="border-b px-4 py-3">
          <h2 id="event-store-title" className="text-sm font-semibold">EventStore</h2>
        </div>
        <EmptyState icon={Database} title="EventStore 状态不可用" description="状态接口尚未返回可验证数据，当前不能判断为健康。" compact />
      </section>
    );
  }

  const tone = statusTone(data, refreshFailed);
  const status = normalizedStatus(data);
  const retentionStale = data.retention.stale || data.retention.status === "stale";
  const capacityAvailable = hasCompleteCapacity(data);
  const capacityStale = data.capacity.stale;
  const trendInsufficient = capacityAvailable && !hasSufficientCapacityTrend(data);
  const categories = Object.entries(data.retention.categories);
  const samples = data.capacity.series
    .filter(isValidCapacitySample)
    .sort((a, b) => Date.parse(a.sampledAt) - Date.parse(b.sampledAt));
  const firstSample = samples[0];
  const lastSample = samples.at(-1);
  const trend = samples.length < 2
    ? "暂无（样本不足）"
    : `总量 ${formatBytes(firstSample?.totalBytes)} → ${formatBytes(lastSample?.totalBytes)}（${formatDelta(firstSample?.totalBytes ?? null, lastSample?.totalBytes ?? null)}）`;

  return (
    <section className="min-w-0 space-y-4 rounded-lg border bg-card p-4" aria-labelledby="event-store-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 id="event-store-title" className="text-sm font-semibold">EventStore</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">事件保留水位与 runtime_events 容量（最近 24 小时）</p>
        </div>
        <Badge variant={badgeVariant(tone)}>{healthText(data, refreshFailed)}</Badge>
      </div>

      {(refreshFailed || retentionStale || capacityStale || trendInsufficient) && (
        <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-subtle px-3 py-2 text-xs text-warning-ink">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          {refreshFailed
            ? "EventStore 刷新失败；当前显示最近一次可信数据，可能已过期。"
            : retentionStale || capacityStale
              ? <>EventStore {retentionStale && capacityStale ? "保留状态和容量采样" : retentionStale ? "保留状态" : "容量采样"}已过期；当前显示最近一次可信数据。</>
              : "EventStore 容量趋势有效样本不足 2 条，暂不判定为健康。"}
        </div>
      )}

      <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard title="总体健康" value={healthText(data, refreshFailed)} tone={tone} description={data.available ? (data.retention.enabled ? "保留任务已启用" : "保留任务未启用") : "状态源不可用"} />
        <MetricCard title="运行模式" value={data.available ? data.retention.mode : "—"} description={data.available ? "只读状态" : "不可用"} valueClassName="break-all font-mono text-xl" />
        <MetricCard
          title="最近结果"
          value={data.available ? STATUS_TEXT[status] : "不可用"}
          tone={tone}
          description={`完成 ${formatTime(data.retention.lastCompletedAt)} · 成功 ${formatTime(data.retention.lastSuccessAt)}`}
        />
        <MetricCard title="最近耗时" value={formatDuration(data.retention.durationMs)} description={`开始 ${formatTime(data.retention.lastStartedAt)}`} />
      </div>

      <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <MetricCard title="Billing watermark" value={data.available ? (data.retention.watermarks.billing ?? "—") : "—"} valueClassName="break-all font-mono text-lg" description="计费保留水位" />
        <MetricCard title="Effective watermark" value={data.available ? (data.retention.watermarks.effective ?? "—") : "—"} valueClassName="break-all font-mono text-lg" description="实际生效水位" />
        <MetricCard title="Watermark lag" value={data.available ? (data.retention.watermarks.lag ?? "—") : "—"} valueClassName="break-all font-mono text-lg" description="未知不会按 0 展示" />
      </div>

      <div>
        <h3 className="mb-2 text-xs font-medium text-muted-foreground">保留分类摘要</h3>
        {categories.length === 0 ? (
          <EmptyState title="暂无分类摘要" description="eligible / deleted 尚不可用。" compact />
        ) : (
          <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {categories.map(([key, category]) => (
              <MetricCard
                key={key}
                title={CATEGORY_TEXT[key] ?? key}
                value={formatNumber(category.eligible)}
                description={`eligible · deleted ${formatNumber(category.deleted)}`}
                valueClassName="break-all font-mono"
              />
            ))}
          </div>
        )}
      </div>

      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-medium text-muted-foreground">runtime_events 容量</h3>
          <span className="max-w-full break-all font-mono text-xs text-muted-foreground">{data.capacity.tableName ?? "表名不可用"}</span>
        </div>
        {!capacityAvailable ? (
          <EmptyState icon={Database} title="容量不可用" description="容量字段显示为「—」，不代表 0 B。" compact />
        ) : (
          <>
            <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <MetricCard title="Table" value={formatBytes(data.capacity.tableBytes)} valueClassName="break-all font-mono" />
              <MetricCard title="Index" value={formatBytes(data.capacity.indexBytes)} valueClassName="break-all font-mono" />
              <MetricCard title="Total" value={formatBytes(data.capacity.totalBytes)} valueClassName="break-all font-mono" />
            </div>
            <div className="mt-3 min-w-0 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              <div>采样：{formatTime(data.capacity.sampledAt)}</div>
              <div className="mt-1 break-words font-mono">趋势：{trend}</div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
