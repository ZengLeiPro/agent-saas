import { useEffect, useMemo, useState } from "react";
import { Check, Copy, ExternalLink, Loader2, Share2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  createArtifactShare,
  getArtifactShare,
  publicArtifactPageUrl,
  revokeArtifactShare,
  type ArtifactShareSummary,
} from "@/lib/artifactShareApi";

const DEFAULT_SHARE_DAYS = 7;

interface ArtifactShareDialogProps {
  open: boolean;
  artifactId: string;
  fileName: string;
  onOpenChange: (open: boolean) => void;
}

export function ArtifactShareDialog({ open, artifactId, fileName, onOpenChange }: ArtifactShareDialogProps) {
  const [share, setShare] = useState<ArtifactShareSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [allowDownload, setAllowDownload] = useState(true);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [defaultExpiresAt, setDefaultExpiresAt] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setShare(null);
    setConfirmed(false);
    setCopied(false);
    setError(null);
    setAllowDownload(true);
    setDefaultExpiresAt(new Date(Date.now() + DEFAULT_SHARE_DAYS * 24 * 60 * 60 * 1000).toISOString());
    void getArtifactShare(artifactId)
      .then((value) => {
        if (cancelled) return;
        setShare(value);
        if (typeof value.allowDownload === "boolean") setAllowDownload(value.allowDownload);
        if (value.enabled && value.expiresAt) setDefaultExpiresAt(value.expiresAt);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "读取分享设置失败");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [artifactId, open]);

  const fullUrl = useMemo(() => share?.enabled ? publicArtifactPageUrl(share) : null, [share]);

  const handleCreate = async () => {
    if (!confirmed) return;
    setSaving(true);
    setError(null);
    try {
      const next = await createArtifactShare(artifactId, {
        confirmPublicArtifact: true,
        expiresAt: defaultExpiresAt,
        allowDownload,
      });
      setShare(next);
      setCopied(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "生成分享链接失败");
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
    setRevoking(true);
    setError(null);
    try {
      const next = await revokeArtifactShare(artifactId);
      setShare(next);
      setCopied(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "撤销分享失败");
    } finally {
      setRevoking(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-24px)] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Share2 className="size-5" /> 分享 Artifact</DialogTitle>
          <DialogDescription>生成无需登录即可访问的只读链接。任何获得链接的人都能查看文件内容，请勿分享敏感信息。</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="truncate rounded-md border bg-muted/30 px-3 py-2 text-sm font-medium" title={fileName}>{fileName}</div>
          <div className="space-y-2">
            <div className="text-sm font-medium">分享链接</div>
            <div className="flex gap-2">
              <Input readOnly value={fullUrl || (loading ? "加载中..." : "尚未生成")} className="min-w-0 font-mono text-xs" aria-label="Artifact 分享链接" />
              <Button type="button" variant="outline" size="icon" disabled={!fullUrl} onClick={() => void handleCopy()} title="复制链接" aria-label="复制链接">
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              </Button>
              <Button type="button" variant="outline" size="icon" disabled={!fullUrl} onClick={() => fullUrl && window.open(fullUrl, "_blank", "noopener,noreferrer")} title="打开链接" aria-label="打开链接">
                <ExternalLink className="size-4" />
              </Button>
            </div>
          </div>

          <div className="space-y-3 rounded-md border p-3 text-sm">
            <label className="flex items-start gap-2">
              <Checkbox checked={confirmed} onCheckedChange={(checked) => setConfirmed(checked === true)} aria-label="确认公开 Artifact" />
              <span>我确认将此 Artifact 公开给任何获得链接的人，并已检查其中不含密码、密钥、客户隐私等敏感内容。</span>
            </label>
            <label className="flex items-center gap-2">
              <Checkbox checked={allowDownload} onCheckedChange={(checked) => setAllowDownload(checked === true)} aria-label="允许下载" />
              <span>显示原文件下载按钮（关闭后仍无法阻止访问者保存已加载的内容）</span>
            </label>
            <p className="text-xs text-muted-foreground">新链接默认 {DEFAULT_SHARE_DAYS} 天后失效；可随时撤销。</p>
          </div>

          {share?.enabled && share.expiresAt ? <div className="text-xs text-muted-foreground">当前链接有效期至 {new Date(share.expiresAt).toLocaleString()}</div> : null}
          {error ? <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div> : null}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <div>
            {share?.enabled ? (
              <Button type="button" variant="ghost" disabled={revoking || saving} onClick={() => void handleRevoke()}>
                {revoking ? <Loader2 className="size-4 animate-spin" /> : null} 撤销分享
              </Button>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
            <Button type="button" disabled={loading || saving || !confirmed} onClick={() => void handleCreate()}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {share?.enabled ? "更新链接" : "生成链接"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
