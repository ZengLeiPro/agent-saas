import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Trash2 } from "lucide-react";
import { formatFileSize } from "@agent/shared";

import { Button } from "@/components/ui/button";
import { authFetch } from "@/lib/authFetch";
import { SettingsPanelHeader } from "./SettingsPanelHeader";

interface AttachmentUsage {
  totalBytes: number;
  totalFiles: number;
  stagedBytes: number;
  stagedFiles: number;
  referencedBytes: number;
  referencedFiles: number;
  legacyBytes: number;
  legacyFiles: number;
  partialBytes: number;
  partialFiles: number;
  stagedRetentionHours: number;
  measuredAt: string;
}

interface UsageResponse {
  success: boolean;
  usage?: AttachmentUsage;
  error?: string;
}

function UsageCard({ label, bytes, files, hint }: { label: string; bytes: number; files: number; hint: string }) {
  return (
    <div className="rounded-xl border bg-background p-4">
      <div className="text-sm font-medium text-muted-foreground">{label}</div>
      <div className="mt-2 text-2xl font-semibold tracking-tight">{formatFileSize(bytes)}</div>
      <div className="mt-1 text-xs text-muted-foreground">{files} 个文件 · {hint}</div>
    </div>
  );
}

export function AttachmentStorageSection() {
  const [usage, setUsage] = useState<AttachmentUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [cleaning, setCleaning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await authFetch("/api/uploads/usage");
      const body = await response.json().catch(() => ({})) as UsageResponse;
      if (!response.ok || !body.success || !body.usage) {
        throw new Error(body.error || "读取附件用量失败");
      }
      setUsage(body.usage);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "读取附件用量失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const cleanup = useCallback(async () => {
    if (!usage?.stagedFiles) return;
    const confirmed = window.confirm(
      `将删除 ${usage.stagedFiles} 个尚未发送的附件（${formatFileSize(usage.stagedBytes)}）。已发送附件和历史文件不会删除，是否继续？`,
    );
    if (!confirmed) return;
    setCleaning(true);
    setError(null);
    setNotice(null);
    try {
      const response = await authFetch("/api/uploads/staged", { method: "DELETE" });
      const body = await response.json().catch(() => ({})) as {
        success?: boolean;
        error?: string;
        deletedFiles?: number;
        deletedBytes?: number;
      };
      if (!response.ok || !body.success) throw new Error(body.error || "清理未发送附件失败");
      setNotice(`已清理 ${body.deletedFiles ?? 0} 个文件，释放 ${formatFileSize(body.deletedBytes ?? 0)}`);
      await load();
    } catch (cleanupError) {
      setError(cleanupError instanceof Error ? cleanupError.message : "清理未发送附件失败");
    } finally {
      setCleaning(false);
    }
  }, [load, usage]);

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col">
      <SettingsPanelHeader
        title="附件存储"
        description="查看个人工作区附件用量；未发送附件超过 24 小时会自动清理，已发送附件不会自动删除。"
        actions={(
          <Button variant="outline" size="sm" onClick={() => { void load(); }} disabled={loading || cleaning}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            刷新
          </Button>
        )}
      />
      <div className="min-h-0 flex-1 overflow-auto">
        <section className="space-y-5 rounded-2xl border bg-card p-5 shadow-sm">
          {loading && !usage ? (
            <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />读取中...
            </div>
          ) : error && !usage ? (
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{error}</div>
          ) : usage ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <UsageCard label="附件总量" bytes={usage.totalBytes} files={usage.totalFiles} hint="当前工作区" />
                <UsageCard label="已发送" bytes={usage.referencedBytes} files={usage.referencedFiles} hint="不自动清理" />
                <UsageCard label="未发送" bytes={usage.stagedBytes} files={usage.stagedFiles} hint={`${usage.stagedRetentionHours} 小时后自动清理`} />
                <UsageCard label="其他/历史" bytes={usage.legacyBytes} files={usage.legacyFiles} hint="不参与自动清理" />
              </div>

              {usage.partialFiles > 0 && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-foreground">
                  当前另有 {usage.partialFiles} 个传输中或异常中断的临时文件，共 {formatFileSize(usage.partialBytes)}；超龄临时文件会自动清理。
                </div>
              )}

              <div className="flex flex-col gap-3 rounded-xl border bg-muted/20 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="text-sm font-medium">清理未发送附件</div>
                  <div className="mt-1 text-xs leading-5 text-muted-foreground">
                    只删除上传后尚未随消息发送的附件；已发送附件和升级前的历史文件不受影响。
                  </div>
                </div>
                <Button
                  variant="destructive"
                  onClick={() => { void cleanup(); }}
                  disabled={cleaning || usage.stagedFiles === 0}
                  className="shrink-0"
                >
                  {cleaning ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                  {usage.stagedFiles > 0 ? `清理 ${usage.stagedFiles} 个` : "无需清理"}
                </Button>
              </div>

              {notice && <div className="text-sm text-success">{notice}</div>}
              {error && <div className="text-sm text-destructive">{error}</div>}
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}
