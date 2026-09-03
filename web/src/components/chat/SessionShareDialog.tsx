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
    setShare(null);
    void getSessionShare(session.id)
      .then((nextShare) => {
        if (cancelled) return;
        setShare(nextShare);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
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
      const next = await updateSessionShare(session.id);
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
    try {
      await navigator.clipboard.writeText(fullUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("复制失败，请手动复制链接");
    }
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
      <DialogContent className="max-h-[calc(100dvh-24px)] w-[calc(100vw-24px)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>分享会话</DialogTitle>
          <DialogDescription>获得链接的人可以查看当前会话内容及其中的成果文件。</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="min-w-0 rounded-md border bg-muted/30 px-3 py-2">
            <div className="truncate text-sm font-medium" title={session?.title || "当前会话"}>
              {session?.title || "当前会话"}
            </div>
          </div>

          {share?.enabled && fullUrl ? (
            <div className="min-w-0 space-y-2">
              <div className="text-sm font-medium">分享链接</div>
              <div className="flex min-w-0 gap-2">
                <Input readOnly value={fullUrl} className="min-w-0 font-mono text-xs" aria-label="会话分享链接" />
                <Button type="button" variant="outline" size="icon" onClick={() => void handleCopy()} title="复制链接" aria-label="复制链接" className="shrink-0">
                  {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                </Button>
                <Button type="button" variant="outline" size="icon" onClick={() => fullUrl && window.open(fullUrl, "_blank", "noopener,noreferrer")} title="打开链接" aria-label="打开链接" className="shrink-0">
                  <ExternalLink className="size-4" />
                </Button>
              </div>
              {share.expiresAt ? <p className="text-xs text-muted-foreground">链接将在 {new Date(share.expiresAt).toLocaleString()} 失效</p> : null}
            </div>
          ) : null}

          {loading ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />正在读取分享状态...</div> : null}
          {error && <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
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
            <Button type="button" disabled={loading || saving || revoking || !session} onClick={() => void handleSave()}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {share?.enabled ? "更新分享" : "生成链接"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
