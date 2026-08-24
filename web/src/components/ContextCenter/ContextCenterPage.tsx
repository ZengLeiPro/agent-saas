import {
  Activity,
  BookOpenCheck,
  Database,
  History,
  Loader2,
  Radio,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";

import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import type {
  BackfillCoverage,
  ConsumerStatus,
  ContextCenterApiPort,
  ContextConsumer,
  ContextScope,
  ContextSource,
  SourceSyncStatus,
} from "./types";
import { useContextCenter } from "./useContextCenter";

const SOURCE_STATUS: Record<SourceSyncStatus, { label: string; variant: "success" | "info" | "warning" | "muted" }> = {
  healthy: { label: "同步正常", variant: "success" },
  syncing: { label: "同步中", variant: "info" },
  attention: { label: "需要关注", variant: "warning" },
  paused: { label: "已暂停", variant: "muted" },
};

const CONSUMER_STATUS: Record<ConsumerStatus, { label: string; variant: "success" | "warning" | "danger" | "muted" }> = {
  current: { label: "已追平", variant: "success" },
  lagging: { label: "有延迟", variant: "warning" },
  blocked: { label: "已阻塞", variant: "danger" },
  offline: { label: "离线", variant: "muted" },
};

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

function formatLag(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "未上报";
  const normalized = Math.max(0, Math.floor(seconds));
  if (normalized < 60) return `${normalized} 秒`;
  const minutes = Math.floor(normalized / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours} 小时` : `${hours} 小时 ${remainingMinutes} 分钟`;
}

function formatCoverage(coverage: BackfillCoverage): { primary: string; secondary: string } {
  if (coverage.kind === "items") {
    return {
      primary: `${coverage.coveredItems.toLocaleString("zh-CN")} / ${coverage.totalItems.toLocaleString("zh-CN")} 条`,
      secondary: "已覆盖 / 可回填总量",
    };
  }
  if (!coverage.coveredFrom && !coverage.coveredThrough) {
    return { primary: "尚未形成覆盖区间", secondary: "来源未提供可回填总量" };
  }
  return {
    primary: `${formatDateTime(coverage.coveredFrom)} — ${formatDateTime(coverage.coveredThrough)}`,
    secondary: "已覆盖时间 · 来源未提供总量",
  };
}

function ScopePanel({ kind, scope }: { kind: "history" | "realtime"; scope: ContextScope }) {
  const historical = kind === "history";
  const Icon = historical ? History : Radio;
  return (
    <section className="rounded-lg border bg-muted/20 p-3" aria-label={historical ? "历史学习范围" : "实时监听范围"}>
      <div className="flex items-center justify-between gap-2">
        <h4 className="flex items-center gap-1.5 text-sm font-medium">
          <Icon className="size-4 text-muted-foreground" />
          {historical ? "历史学习范围" : "实时监听范围"}
        </h4>
        <Badge variant={scope.enabled ? "success" : "muted"}>{scope.enabled ? "已启用" : "未启用"}</Badge>
      </div>
      <p className="mt-2 text-sm text-foreground">{scope.summary}</p>
      {(scope.from || scope.through) && (
        <p className="mt-1 text-xs text-muted-foreground">
          时间：{formatDateTime(scope.from ?? null)} — {scope.through ? formatDateTime(scope.through) : "持续监听"}
        </p>
      )}
      {scope.includes && scope.includes.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {scope.includes.map((item) => <Badge key={item} variant="outline">{item}</Badge>)}
        </div>
      )}
    </section>
  );
}

function OutcomeSummary({ source }: { source: ContextSource }) {
  const outcomes = [
    { label: "截断", value: source.ingestOutcomes.truncated },
    { label: "拒绝", value: source.ingestOutcomes.refused },
    { label: "不可读", value: source.ingestOutcomes.unreadable },
    { label: "重试中", value: source.ingestOutcomes.retrying },
  ];
  const hasIssue = outcomes.some((outcome) => outcome.value > 0);
  return (
    <div>
      <div className="text-xs text-muted-foreground">内容处理结果</div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {hasIssue
          ? outcomes.map((outcome) => (
              <Badge key={outcome.label} variant={outcome.value > 0 ? "warning" : "muted"}>
                {outcome.label} {outcome.value.toLocaleString("zh-CN")}
              </Badge>
            ))
          : <Badge variant="success">无截断、拒绝、不可读或重试</Badge>}
      </div>
      {source.ingestOutcomes.nextRetryAt && <div className="mt-1 text-xs text-muted-foreground">下次重试：{formatDateTime(source.ingestOutcomes.nextRetryAt)}</div>}
    </div>
  );
}

function SourceCard({ source }: { source: ContextSource }) {
  const status = SOURCE_STATUS[source.status];
  const coverage = formatCoverage(source.backfillCoverage);
  return (
    <article className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">{source.name}</h3>
            <Badge variant={status.variant}>{status.label}</Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{source.system} · Collection：{source.collection}</p>
        </div>
      </div>

      <div className="mt-4 grid gap-4 border-y py-4 sm:grid-cols-2 xl:grid-cols-4">
        <div>
          <div className="text-xs text-muted-foreground">最后同步</div>
          <div className="mt-1 text-sm font-medium tabular-nums">{formatDateTime(source.lastSyncedAt)}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Backfill coverage</div>
          <div className="mt-1 text-sm font-medium tabular-nums">{coverage.primary}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">{coverage.secondary}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Watermark lag</div>
          <div className="mt-1 text-sm font-medium tabular-nums">{formatLag(source.watermarkLagSeconds)}</div>
        </div>
        <OutcomeSummary source={source} />
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <ScopePanel kind="history" scope={source.historicalLearningScope} />
        <ScopePanel kind="realtime" scope={source.realtimeListeningScope} />
      </div>
    </article>
  );
}

function ConsumerRow({ consumer }: { consumer: ContextConsumer }) {
  const status = CONSUMER_STATUS[consumer.status];
  return (
    <div className="grid gap-2 border-b px-4 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center sm:gap-6">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{consumer.name}</span>
          <span className="text-xs text-muted-foreground">{consumer.kind}</span>
        </div>
        {consumer.detail && <p className="mt-1 text-xs text-muted-foreground">{consumer.detail}</p>}
      </div>
      <div className="text-xs text-muted-foreground sm:text-right">
        <div>Watermark：<span className="text-foreground tabular-nums">{formatDateTime(consumer.watermarkAt)}</span></div>
        <div className="mt-0.5">延迟：<span className="text-foreground tabular-nums">{formatLag(consumer.lagSeconds)}</span></div>
      </div>
      <Badge variant={status.variant} className="w-fit">{status.label}</Badge>
    </div>
  );
}

export function ContextCenterPage({ api }: { api: ContextCenterApiPort }) {
  const state = useContextCenter(api);

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto w-full max-w-7xl p-4 sm:p-6">
        <SettingsPanelHeader
          title="Context Center"
          description="查看组织上下文来源、回填与实时水位、消费端状态，并追溯回答所用证据。"
          actions={(
            <Button variant="outline" size="sm" disabled={state.loading} onClick={() => void state.reload()}>
              {state.loading ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 size-3.5" />}
              刷新
            </Button>
          )}
        />

        {state.loading && !state.snapshot && (
          <div className="flex min-h-72 items-center justify-center gap-2 rounded-xl border bg-card text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />正在加载 Context Center
          </div>
        )}

        {!state.loading && state.error && !state.snapshot && (
          <div className="flex min-h-72 flex-col items-center justify-center gap-3 rounded-xl border border-danger/30 bg-danger/5 p-6 text-center">
            <TriangleAlert className="size-8 text-danger-ink" />
            <div>
              <p className="text-sm font-medium text-danger-ink">Context Center 暂不可用</p>
              <p className="mt-1 text-xs text-muted-foreground">{state.error}</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => void state.reload()}>重试</Button>
          </div>
        )}

        {state.snapshot && (
          <div className="space-y-4">
            {state.error && (
              <div className="flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning-ink">
                <TriangleAlert className="size-4" />刷新失败，继续展示上次成功数据：{state.error}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5"><Database className="size-3.5" />{state.snapshot.sources.length} 个来源 / Collection</span>
              <span className="tabular-nums">数据更新时间：{formatDateTime(state.snapshot.generatedAt)}</span>
            </div>

            <Card density="compact">
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><BookOpenCheck className="size-4" />来源与 Collection</CardTitle>
              </CardHeader>
              <CardContent>
                {state.snapshot.sources.length === 0 ? (
                  <div className="rounded-xl border border-dashed p-8 text-center">
                    <Database className="mx-auto size-8 text-muted-foreground" />
                    <p className="mt-3 text-sm font-medium">尚未接入上下文来源</p>
                    <p className="mt-1 text-xs text-muted-foreground">后端接线后，来源与同步状态会显示在这里。</p>
                  </div>
                ) : (
                  <div className="space-y-3" aria-label="来源与 Collection 列表">
                    {state.snapshot.sources.map((source) => (
                      <SourceCard key={`${source.sourceId}:${source.collectionId}`} source={source} />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card density="compact">
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Activity className="size-4" />Consumer 状态</CardTitle>
              </CardHeader>
              <CardContent>
                {state.snapshot.consumers.length === 0 ? (
                  <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">尚未上报 Consumer 状态</p>
                ) : (
                  <div className="overflow-hidden rounded-lg border">
                    {state.snapshot.consumers.map((consumer) => <ConsumerRow key={consumer.id} consumer={consumer} />)}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </div>

    </div>
  );
}
