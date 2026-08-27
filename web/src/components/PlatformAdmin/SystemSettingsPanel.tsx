import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Save, Send, SlidersHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SETTINGS_CONTENT_WIDTH, SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { MetricCard } from "@/components/PlatformAdmin/common";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";

import { platformAdminApi } from "./api";
import { useConfirmDialog } from "./ConfirmDialog";
import { formatNumber, formatTime } from "./format";
import type { AlertingStatus, RuntimeSchedulerCapacity } from "./types";

function parseSchedulerLimit(value: string, max: number): number {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) throw new Error(`顶层任务并发必须是 1-${max} 的整数`);
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`顶层任务并发必须是 1-${max} 的整数`);
  }
  return parsed;
}

export function SystemSettingsPanel() {
  const { platformReadOnly } = useAuth();
  const { confirm, confirmDialog } = useConfirmDialog();
  const [status, setStatus] = useState<AlertingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [scheduler, setScheduler] = useState<RuntimeSchedulerCapacity | null>(null);
  const [schedulerLoading, setSchedulerLoading] = useState(true);
  const [schedulerSaving, setSchedulerSaving] = useState(false);
  const [schedulerMaxText, setSchedulerMaxText] = useState("");
  const [schedulerMessage, setSchedulerMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await platformAdminApi.alertingStatus());
      setMessage(null);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadScheduler = useCallback(async () => {
    setSchedulerLoading(true);
    try {
      const { runtimeScheduler } = await platformAdminApi.schedulerRuntimeConfig();
      setScheduler(runtimeScheduler);
      setSchedulerMaxText(String(runtimeScheduler.maxConcurrentRuns));
      setSchedulerMessage(null);
    } catch (err) {
      setSchedulerMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSchedulerLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    void loadScheduler();
  }, [load, loadScheduler]);

  const sendTest = useCallback(async () => {
    setSending(true);
    try {
      await platformAdminApi.sendTestAlert();
      setMessage("测试告警已发送");
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }, [load]);

  const saveScheduler = useCallback(async (maxConcurrentRuns: number) => {
    setSchedulerSaving(true);
    setSchedulerMessage(null);
    try {
      const { runtimeScheduler } = await platformAdminApi.updateSchedulerRuntimeConfig(maxConcurrentRuns);
      setScheduler(runtimeScheduler);
      setSchedulerMaxText(String(runtimeScheduler.maxConcurrentRuns));
      setSchedulerMessage(`顶层任务并发已调整为 ${runtimeScheduler.maxConcurrentRuns}`);
    } catch (err) {
      setSchedulerMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSchedulerSaving(false);
    }
  }, []);

  const confirmSchedulerSave = useCallback(() => {
    if (!scheduler) return;
    try {
      const maxConcurrentRuns = parseSchedulerLimit(schedulerMaxText, scheduler.maxConfigurableConcurrentRuns);
      confirm({
        title: "修改顶层任务并发？",
        description: "只影响后续调度，不会中断正在运行的任务。",
        details: [
          { label: "当前期望值", value: scheduler.maxConcurrentRuns },
          { label: "变更后", value: maxConcurrentRuns },
          { label: "当前有效上限", value: scheduler.effectiveMaxConcurrentRuns },
        ],
        confirmLabel: "保存并热生效",
        onConfirm: () => void saveScheduler(maxConcurrentRuns),
      });
    } catch (err) {
      setSchedulerMessage(err instanceof Error ? err.message : String(err));
    }
  }, [confirm, saveScheduler, scheduler, schedulerMaxText]);

  return (
    <div className={cn("flex h-full min-h-0 flex-col", SETTINGS_CONTENT_WIDTH)}>
      <SettingsPanelHeader
        title="系统配置"
        description="平台运行参数、集成、备份、存储和健康检查。"
        actions={
          <Button variant="outline" size="sm" onClick={() => void sendTest()} disabled={platformReadOnly || sending || !status?.webhookConfigured}>
            {sending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
            发送测试告警
          </Button>
        }
      />
      <div className="min-h-0 flex-1 space-y-4 overflow-auto">
        {message && (
          <div className={cn(
            "rounded-md px-3 py-2 text-sm",
            message.includes("已发送") ? "bg-success/10 text-success-ink" : "bg-destructive/10 text-destructive",
          )}>
            {message}
          </div>
        )}
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            title="告警状态"
            value={loading ? "加载中" : status?.configured ? "已启用" : "未启用"}
            description={status?.webhookConfigured ? "Webhook 已配置" : "Webhook 未配置"}
            tone={status?.configured ? "good" : "warn"}
          />
          <MetricCard
            title="最低级别"
            value={status?.minSeverity ?? "high"}
            description="低于该级别不推送"
          />
          <MetricCard
            title="最近推送"
            value={formatTime(status?.lastNotifiedAt)}
            description="去重状态表"
          />
          <MetricCard
            title="累计推送"
            value={formatNumber(status?.notifyCount)}
            description="当前告警状态"
          />
        </div>
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 pb-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base"><SlidersHorizontal className="size-4" />顶层任务调度并发</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">期望值保存在运行配置中并热生效；降低并发不会中断正在运行的任务。</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => void loadScheduler()} disabled={schedulerLoading || schedulerSaving}>
              {schedulerLoading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
              刷新
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            {schedulerMessage && (
              <div className={cn(
                "rounded-md px-3 py-2 text-sm",
                schedulerMessage.includes("已调整") ? "bg-success/10 text-success-ink" : "bg-destructive/10 text-destructive",
              )}>
                {schedulerMessage}
              </div>
            )}
            {schedulerLoading && !scheduler ? (
              <div className="flex h-24 items-center justify-center text-sm text-muted-foreground"><Loader2 className="mr-2 size-4 animate-spin" />加载调度配置...</div>
            ) : scheduler ? (
              <>
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  <MetricCard title="当前有效上限" value={scheduler.effectiveMaxConcurrentRuns} description={`期望 ${scheduler.maxConcurrentRuns}`} tone="good" />
                  <MetricCard title="本实例执行中" value={scheduler.inFlightRuns} description="前台与后台执行合计" />
                  <MetricCard title="后台执行中" value={scheduler.inFlightBackgroundRuns} description="后台任务占用" />
                  <MetricCard title="前台保留" value={scheduler.foregroundReservedRuns} description={scheduler.executionEnabled ? "调度已启用" : "调度已进入维护"} tone={scheduler.executionEnabled ? "good" : "warn"} />
                </div>
                <div className="flex flex-wrap items-end gap-3">
                  <div className="w-56 space-y-1.5">
                    <Label htmlFor="scheduler-max-concurrent-runs">期望并发</Label>
                    <Input
                      id="scheduler-max-concurrent-runs"
                      inputMode="numeric"
                      value={schedulerMaxText}
                      onChange={(event) => { setSchedulerMaxText(event.target.value); setSchedulerMessage(null); }}
                      disabled={!scheduler.editable || schedulerSaving || platformReadOnly}
                    />
                  </div>
                  <Button onClick={confirmSchedulerSave} disabled={!scheduler.editable || schedulerSaving || platformReadOnly || !schedulerMaxText}>
                    {schedulerSaving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                    保存并热生效
                  </Button>
                </div>
                <div className="text-xs leading-5 text-muted-foreground">
                  {scheduler.sessionLockMode === "dual"
                    ? "当前处于 dual 迁移阶段，有效并发固定不超过 4；切换到 lease 后开放修改。"
                    : `可配置范围 1-${scheduler.maxConfigurableConcurrentRuns}。`}
                  {scheduler.updatedBy ? ` 最近由 ${scheduler.updatedBy} 更新于 ${formatTime(scheduler.updatedAt)}。` : ""}
                </div>
              </>
            ) : null}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-3 p-5 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">钉钉 Webhook</span>
              <span className="max-w-[70%] truncate font-mono text-xs">
                {status?.webhookConfigured
                  ? (status.webhookMasked ? `已配置 · ${status.webhookMasked}` : "已配置")
                  : "未配置"}
              </span>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {["钉钉与外部集成配置", "存储、备份、恢复与数据保留", "系统版本、健康检查、队列和任务状态", "平台公告、维护窗口和运营参数"].map(point => (
                <div key={point} className="rounded-lg border bg-muted/20 p-3 text-sm text-muted-foreground">{point}</div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
      {confirmDialog}
    </div>
  );
}
