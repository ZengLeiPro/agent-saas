import { useCallback, useEffect, useState } from "react";
import { Loader2, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { MetricCard } from "@/components/PlatformAdmin/common";
import { cn } from "@/lib/utils";

import { platformAdminApi } from "./api";
import { formatNumber, formatTime } from "./format";
import type { AlertingStatus } from "./types";

export function SystemSettingsPanel() {
  const [status, setStatus] = useState<AlertingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

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

  useEffect(() => {
    void load();
  }, [load]);

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

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col">
      <SettingsPanelHeader
        title="系统配置"
        description="平台运行参数、集成、备份、存储和健康检查。"
        actions={
          <Button variant="outline" size="sm" onClick={() => void sendTest()} disabled={sending || !status?.webhookConfigured}>
            {sending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-1.5 h-3.5 w-3.5" />}
            发送测试告警
          </Button>
        }
      />
      <div className="min-h-0 flex-1 space-y-4 overflow-auto">
        {message && (
          <div className={cn(
            "rounded-md px-3 py-2 text-sm",
            message.includes("已发送") ? "bg-emerald-500/10 text-emerald-700" : "bg-destructive/10 text-destructive",
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
          <CardContent className="space-y-3 p-5 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">钉钉 Webhook</span>
              {/* FIX-5a: server 侧只回「已配置 + 域名」，不再回显 access_token 任何字符 */}
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
    </div>
  );
}
