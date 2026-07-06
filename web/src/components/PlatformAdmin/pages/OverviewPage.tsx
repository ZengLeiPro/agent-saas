import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { AttentionQueue, MetricCard } from "@/components/PlatformAdmin/common";
import { buildPlatformAdminUrl, pushPlatformAdminUrl, type PlatformAdminSection } from "@/lib/urlSync";
import { cn } from "@/lib/utils";

import { platformAdminApi } from "../api";
import { attentionSeverity, formatNumber, formatRate, formatTime, formatYuan } from "../format";
import type { OverviewAttentionEntityRef, OverviewSnapshot } from "../types";

function navigate(section: PlatformAdminSection, search?: Record<string, string | number | boolean | null | undefined>) {
  pushPlatformAdminUrl({ section, search });
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function navigateRef(ref: OverviewAttentionEntityRef | undefined) {
  if (!ref) return;
  const section = ref.kind === "run"
    ? "runs"
    : ref.kind === "session"
      ? "sessions"
      : ref.kind === "sandbox"
        ? "sandboxes"
        : ref.kind === "user"
          ? "users"
          : "tenants";
  pushPlatformAdminUrl({ section, entityId: ref.id });
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function OverviewPage() {
  const [snapshot, setSnapshot] = useState<OverviewSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (mode: "initial" | "refresh" = "refresh") => {
    if (mode === "initial") setLoading(true);
    else setRefreshing(true);
    try {
      const data = await platformAdminApi.overviewSnapshot();
      setSnapshot(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load("initial");
    const timer = window.setInterval(() => void load("refresh"), 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const attentionItems = useMemo(() => (snapshot?.attention ?? []).map((item, index) => ({
    id: `${item.kind}:${item.entityRef?.id ?? index}`,
    title: item.title,
    description: `${item.kind}${item.occurredAt ? ` · ${formatTime(item.occurredAt)}` : ""}`,
    severity: attentionSeverity(item.severity),
    actionLabel: item.entityRef ? "查看" : undefined,
    onAction: item.entityRef ? () => navigateRef(item.entityRef) : undefined,
  })), [snapshot?.attention]);

  if (loading && !snapshot) {
    return (
      <div className="flex h-64 items-center justify-center rounded-lg border bg-card text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        加载平台总览...
      </div>
    );
  }

  const health = snapshot?.health;
  const dispatch = health?.dispatch as { dropped?: number; errors?: number; total?: number } | null | undefined;
  const projectionFailed = Number(health?.sessionMetaProjection?.failed ?? 0);

  return (
    <div className="w-full space-y-5">
      <SettingsPanelHeader
        title="平台总览"
        description="运行健康、容器池、成本和异常队列。"
        actions={
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={refreshing}>
            <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", refreshing && "animate-spin")} />
            刷新
          </Button>
        }
      />

      {error && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          加载失败：{error}
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          title="活跃 Run"
          value={formatNumber(health?.activeRuns.total)}
          description="pending / running / waiting"
          tone={(health?.activeRuns.total ?? 0) > 0 ? "warn" : "good"}
          onClick={() => navigate("runs", { status: "active" })}
        />
        <MetricCard
          title="容器 R / P"
          value={`${formatNumber(health?.sandboxes.running)} / ${formatNumber(health?.sandboxes.paused)}`}
          description={`${formatNumber(health?.sandboxes.total)} total · ${formatNumber(health?.sandboxes.broken)} broken`}
          tone={(health?.sandboxes.broken ?? 0) > 0 ? "bad" : "default"}
          onClick={() => navigate("sandboxes")}
        />
        <MetricCard
          title="今日成本"
          value={formatYuan(health?.todayCostYuan)}
          description="billing usage events"
          onClick={() => navigate("efficiency")}
        />
        <MetricCard
          title="今日 Run"
          value={formatNumber(health?.todayRuns)}
          description={`24h 完成率 ${formatRate(health?.completionRate24h)}`}
          onClick={() => navigate("runs", { hours: 24 })}
        />
        <MetricCard
          title="近 1 小时故障"
          value={formatNumber(health?.handFailures1h)}
          description="hand_failure events"
          tone={(health?.handFailures1h ?? 0) > 0 ? "bad" : "good"}
          onClick={() => navigate("audit", { event: "hand_failure" })}
        />
        <MetricCard
          title="工具路由异常"
          value={formatNumber(health?.toolRouting24h?.failedCount)}
          description={`${formatNumber(health?.toolRouting24h?.total)} calls / 24h`}
          tone={(health?.toolRouting24h?.failedCount ?? 0) > 0 ? "warn" : "good"}
          onClick={() => navigate("efficiency")}
        />
        <MetricCard
          title="Dispatch 错误"
          value={formatNumber(dispatch?.errors ?? dispatch?.dropped ?? 0)}
          description="当前进程指标快照"
          tone={(dispatch?.errors ?? dispatch?.dropped ?? 0) > 0 ? "warn" : "good"}
        />
        <MetricCard
          title="投影失败"
          value={formatNumber(projectionFailed)}
          description="session meta projection"
          tone={projectionFailed > 0 ? "bad" : "good"}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <AttentionQueue items={attentionItems} />
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <AlertTriangle className="h-4 w-4" />
              Snapshot
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">生成时间</span>
              <span className="tabular-nums">{formatTime(snapshot?.generatedAt)}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">活跃状态</span>
              <a className="text-primary hover:underline" href={buildPlatformAdminUrl({ section: "runs", search: { status: "active" } })}>
                {formatNumber(health?.activeRuns.total)} runs
              </a>
            </div>
            <div className="rounded-md bg-muted/40 p-3 font-mono text-xs text-muted-foreground">
              {JSON.stringify(health?.activeRuns.byStatus ?? {}, null, 2)}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
