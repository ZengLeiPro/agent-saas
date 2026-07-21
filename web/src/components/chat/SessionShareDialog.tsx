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
import { Checkbox } from "@/components/ui/checkbox";
import {
  getSessionShare,
  getSessionSharePreview,
  revokeSessionShare,
  updateSessionShare,
  type SessionShareSummary,
  type SessionSharePreview,
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
  const [preview, setPreview] = useState<SessionSharePreview | null>(null);
  const [confirmedPublicText, setConfirmedPublicText] = useState(false);
  const [selectedFilePaths, setSelectedFilePaths] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open || !session) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setCopied(false);
    setShare(null);
    setPreview(null);
    setConfirmedPublicText(false);
    setSelectedFilePaths(new Set());
    Promise.allSettled([getSessionShare(session.id), getSessionSharePreview(session.id)])
      .then(([shareResult, previewResult]) => {
        if (cancelled) return;
        if (shareResult.status === "fulfilled") setShare(shareResult.value);
        else setError(shareResult.reason instanceof Error ? shareResult.reason.message : String(shareResult.reason));
        if (previewResult.status === "fulfilled") setPreview(previewResult.value);
        else setError((current) => current
          ?? (previewResult.reason instanceof Error ? previewResult.reason.message : String(previewResult.reason)));
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
      const next = await updateSessionShare(session.id, {
        confirmPublicText: true,
        filePaths: [...selectedFilePaths],
        ...(preview?.defaultExpiresAt ? { expiresAt: preview.defaultExpiresAt } : {}),
      });
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
            生成当前会话的只读分享链接。公开页只保留对话正文和显式分享的成果文件。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-md border bg-muted/30 px-3 py-2">
            <div className="truncate text-sm font-medium">{session?.title || "当前会话"}</div>
          </div>

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

          <div className="space-y-3 rounded-md border p-3 text-sm">
            <label className="flex items-start gap-2">
              <Checkbox
                checked={confirmedPublicText}
                disabled={!preview}
                onCheckedChange={(checked) => setConfirmedPublicText(checked === true)}
              />
              <span>
                我确认公开当前会话的 {preview?.blockCount ?? 0} 条用户/助手正文；系统会阻断凭据、手机号、邮箱和身份证号。
              </span>
            </label>
            {(preview?.files.length ?? 0) > 0 ? (
              <div className="space-y-2">
                <div className="font-medium">选择要公开的成果文件（默认不公开）</div>
                {preview!.files.map((file) => (
                  <label key={file.relativePath} className="flex items-center gap-2">
                    <Checkbox
                      checked={selectedFilePaths.has(file.relativePath)}
                      onCheckedChange={(checked) => {
                        setSelectedFilePaths((current) => {
                          const next = new Set(current);
                          if (checked === true) next.add(file.relativePath);
                          else next.delete(file.relativePath);
                          return next;
                        });
                      }}
                    />
                    <span className="truncate" title={file.relativePath}>{file.fileName}</span>
                  </label>
                ))}
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">链接默认 7 天失效；文件会冻结为不可变快照，不再读取工作区同名文件。</p>
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
            <Button type="button" disabled={loading || saving || !session || !preview || !confirmedPublicText} onClick={() => void handleSave()}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {share?.enabled ? "更新快照" : "生成链接"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
