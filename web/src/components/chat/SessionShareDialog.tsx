import { useEffect, useMemo, useState } from "react";
import { Check, Copy, ExternalLink, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  getSessionShare,
  revokeSessionShare,
  updateSessionShare,
  type SessionShareSummary,
} from "@/lib/sessionShareApi";
import type { ChatSessionIndexItem } from "@/types/sidebar";

interface SessionShareDialogProps {
  open: boolean;
  session: ChatSessionIndexItem | null;
  onOpenChange: (open: boolean) => void;
}

export function SessionShareDialog({ open, session, onOpenChange }: SessionShareDialogProps) {
  const [share, setShare] = useState<SessionShareSummary | null>(null);
  const [debugMode, setDebugMode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !session) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setCopied(false);
    setDebugMode(false);
    getSessionShare(session.id)
      .then((next) => {
        if (cancelled) return;
        setShare(next);
        if (next.enabled && typeof next.debugMode === "boolean") {
          setDebugMode(next.debugMode);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, session]);

  const fullUrl = useMemo(() => {
    if (!share?.url) return "";
    return `${window.location.origin}${share.url}`;
  }, [share?.url]);

  const handleSave = async () => {
    if (!session) return;
    setSaving(true);
    setError(null);
    try {
      const next = await updateSessionShare(session.id, { debugMode });
      setShare(next);
      setCopied(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleCopy = async () => {
    if (!fullUrl) return;
    await navigator.clipboard.writeText(fullUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const handleRevoke = async () => {
    if (!session) return;
    setRevoking(true);
    setError(null);
    try {
      const next = await revokeSessionShare(session.id);
      setShare(next);
      setCopied(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRevoking(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>分享会话</DialogTitle>
          <DialogDescription>
            生成当前会话的只读分享链接。分享页保留原消息页面和输入框，但无法发送消息。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-md border bg-muted/30 px-3 py-2">
            <div className="truncate text-sm font-medium">{session?.title || "当前会话"}</div>
          </div>

          <label className="flex items-center justify-between gap-4 rounded-md border px-3 py-2">
            <span>
              <span className="block text-sm font-medium">调试模式</span>
              <span className="block text-xs text-muted-foreground">
                开启后分享页会完整展示 thinking、工具调用与执行细节。
              </span>
            </span>
            <Switch checked={debugMode} onCheckedChange={setDebugMode} disabled={loading || saving} />
          </label>

          <div className="space-y-2">
            <div className="text-sm font-medium">分享链接</div>
            <div className="flex gap-2">
              <Input readOnly value={fullUrl || (loading ? "加载中..." : "尚未生成")} className="font-mono text-xs" />
              <Button
                type="button"
                variant="outline"
                size="icon"
                disabled={!fullUrl}
                onClick={() => void handleCopy()}
                title="复制链接"
              >
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                disabled={!fullUrl}
                onClick={() => fullUrl && window.open(fullUrl, "_blank", "noopener,noreferrer")}
                title="打开链接"
              >
                <ExternalLink className="size-4" />
              </Button>
            </div>
          </div>

          {error && <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <div>
            {share?.enabled && (
              <Button type="button" variant="ghost" disabled={revoking || saving} onClick={() => void handleRevoke()}>
                {revoking ? <Loader2 className="size-4 animate-spin" /> : null}
                撤销分享
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              关闭
            </Button>
            <Button type="button" disabled={loading || saving || !session} onClick={() => void handleSave()}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {share?.enabled ? "更新快照" : "生成链接"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
