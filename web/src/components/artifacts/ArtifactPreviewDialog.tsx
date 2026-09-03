import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { Download, Loader2, PanelRight, Share2, TriangleAlert } from "lucide-react";
import {
  artifactViewerError,
  createArtifactViewerState,
  reduceArtifactViewer,
  type ArtifactReadGrant,
  type ArtifactViewPosition,
} from "@agent/shared";

import { ArtifactContentViewer } from "@/components/artifacts/ArtifactContentViewer";
import { ArtifactShareDialog } from "@/components/artifacts/ArtifactShareDialog";
import { RightPanelFrame } from "@/components/RightPanelFrame";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@/contexts/AuthContext";
import { formatFileSize } from "@/components/types";
import { ArtifactReadError, getArtifactReadGrant } from "@/lib/artifactShareApi";

interface ArtifactPreviewProps {
  artifactId: string;
  fileName: string;
  fileSize?: number;
  mimeType?: string;
}
interface ArtifactPreviewDialogProps extends ArtifactPreviewProps { open: boolean; onOpenChange: (open: boolean) => void; onDock?: () => void; }
interface ArtifactPreviewPanelProps extends ArtifactPreviewProps { onClose: () => void; }

function useSafeArtifactGrant(artifactId: string, active: boolean) {
  const { identity } = useAuth();
  const ownerKey = identity ? `${identity.tenantId}:${identity.userId}:${identity.generation}` : "anonymous";
  const [state, dispatch] = useReducer(reduceArtifactViewer, undefined, createArtifactViewerState);

  useEffect(() => {
    if (active) dispatch({ type: "open", artifactId, ownerKey });
    else dispatch({ type: "close" });
  }, [active, artifactId, ownerKey]);

  useEffect(() => {
    dispatch({ type: "owner-switched", ownerKey });
  }, [ownerKey]);

  useEffect(() => {
    if (state.status !== "loading" && state.status !== "refreshing") return;
    let cancelled = false;
    void getArtifactReadGrant(artifactId).then((grant) => {
      if (!cancelled) dispatch({ type: "loaded", grant });
    }).catch((error: unknown) => {
      if (cancelled) return;
      const status = error instanceof ArtifactReadError ? error.status : 500;
      const reason = error instanceof ArtifactReadError ? error.reason : undefined;
      dispatch({ type: "failed", status, reason });
    });
    return () => { cancelled = true; };
  }, [artifactId, state.status]);

  useEffect(() => {
    if (state.status !== "ready" || !state.grant) return;
    const delay = Math.max(0, Date.parse(state.grant.descriptor.expiresAt) - Date.now() - 3_000);
    const timer = window.setTimeout(() => dispatch({ type: "expired" }), delay);
    return () => window.clearTimeout(timer);
  }, [state.grant, state.status]);

  const onAuthorizationFailure = useCallback((status: number, reason?: string) => {
    if (status === 401 && state.refreshCount === 0) dispatch({ type: "expired" });
    else dispatch({ type: "failed", status, reason });
  }, [state.refreshCount]);
  const onPositionChange = useCallback((position: ArtifactViewPosition) => dispatch({ type: "position", position }), []);
  return { state, onAuthorizationFailure, onPositionChange };
}

function ArtifactPreviewContent({ grant, loading, error, position, onAuthorizationFailure, onPositionChange, onClose }: {
  grant: ArtifactReadGrant | null;
  loading: boolean;
  error: ReturnType<typeof artifactViewerError> | null;
  position: ArtifactViewPosition;
  onAuthorizationFailure: (status: number, reason?: string) => void;
  onPositionChange: (position: ArtifactViewPosition) => void;
  onClose: () => void;
}) {
  if (loading) return <div className="flex h-full items-center justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>;
  if (error) return <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center"><TriangleAlert className="size-8 text-destructive" /><h3 className="font-medium">{error.title}</h3><p className="text-sm text-muted-foreground">{error.message}</p><Button onClick={() => { if (error.action === "sign-in") window.location.assign("/login"); else onClose(); }}>{error.actionLabel}</Button></div>;
  if (!grant) return null;
  return <ArtifactContentViewer grant={grant} position={position} onPositionChange={onPositionChange} onAuthorizationFailure={onAuthorizationFailure} className="h-full" />;
}

function useArtifactDownload(grant: ArtifactReadGrant | null) {
  const [downloading, setDownloading] = useState(false);
  const download = useCallback(async () => {
    if (!grant || downloading) return;
    const { descriptor } = grant;
    if (descriptor.requiresWarning) {
      const accepted = window.confirm(`此文件包含主动内容或未知格式，下载到本机后可能执行代码。\n\n类型：${descriptor.safeMime || "未知"}\n大小：${formatFileSize(descriptor.size)}\n来源：当前会话 Artifact\n\n下载后请仅使用可信应用打开。`);
      if (!accepted) return;
    }
    setDownloading(true);
    try {
      const downloadGrant = await getArtifactReadGrant(descriptor.artifactId, true);
      const anchor = document.createElement("a");
      anchor.href = downloadGrant.readUrl;
      anchor.download = descriptor.name;
      anchor.referrerPolicy = "no-referrer";
      anchor.rel = "noreferrer";
      anchor.click();
    } finally { setDownloading(false); }
  }, [downloading, grant]);
  return { download, downloading };
}

export async function downloadArtifact(artifactId: string, fileName: string): Promise<void> {
  const grant = await getArtifactReadGrant(artifactId, true).catch((error: unknown) => {
    if (error instanceof ArtifactReadError) throw new Error(`下载地址获取失败（HTTP ${error.status}）`);
    throw error;
  });
  if (grant.descriptor.requiresWarning && !window.confirm("此文件下载到本机后可能执行代码。确认仍要下载吗？")) return;
  const anchor = document.createElement("a");
  anchor.href = grant.readUrl;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
}

function ArtifactPreviewActions({ grant, onShare }: { grant: ArtifactReadGrant | null; onShare: () => void }) {
  const { download, downloading } = useArtifactDownload(grant);
  return <><Button variant="outline" size="sm" disabled={!grant || downloading} onClick={() => void download()} aria-label={grant?.descriptor.requiresWarning ? "确认风险并下载 Artifact" : "下载 Artifact"}><Download className="size-4" /><span className="hidden sm:inline">下载</span></Button><Button variant="outline" size="sm" onClick={onShare}><Share2 className="size-4" /><span className="hidden sm:inline">分享</span></Button></>;
}

export function ArtifactPreviewDialog({ open, artifactId, fileName, fileSize, mimeType, onOpenChange, onDock }: ArtifactPreviewDialogProps) {
  const { state, onAuthorizationFailure, onPositionChange } = useSafeArtifactGrant(artifactId, open);
  const [shareOpen, setShareOpen] = useState(false);
  const descriptor = state.grant?.descriptor;
  const subtitle = useMemo(() => [descriptor?.safeMime || mimeType || "未知类型", formatFileSize(descriptor?.size ?? fileSize ?? 0)].filter(Boolean).join(" · "), [descriptor, fileSize, mimeType]);
  return <><Dialog open={open} onOpenChange={onOpenChange}><DialogContent onOpenAutoFocus={(event) => event.preventDefault()} className="flex h-[100dvh] w-screen max-w-none flex-col gap-0 overflow-hidden !border-0 p-0 !shadow-xl outline-none sm:h-[calc(100dvh-32px)] sm:w-[min(1180px,calc(100vw-48px))] sm:rounded-xl"><header className="flex min-h-14 shrink-0 items-center gap-2 border-b bg-background px-3 pr-14 sm:px-4 sm:pr-16"><div className="min-w-0 flex-1"><DialogTitle className="truncate text-sm font-medium">{descriptor?.name || fileName}</DialogTitle><DialogDescription className="sr-only">安全查看会话 Artifact；主动内容仅在隔离环境预览，下载需确认风险。</DialogDescription><div className="truncate text-xs text-muted-foreground">{subtitle}</div></div><ArtifactPreviewActions grant={state.grant} onShare={() => setShareOpen(true)} />{onDock ? <Button variant="outline" size="sm" onClick={onDock} aria-label="在右侧预览栏打开"><PanelRight className="size-4" /><span className="hidden sm:inline">右侧打开</span></Button> : null}</header><div className="min-h-0 flex-1 overflow-hidden"><ArtifactPreviewContent grant={state.grant} loading={state.status === "loading" || state.status === "refreshing"} error={state.error} position={state.position} onAuthorizationFailure={onAuthorizationFailure} onPositionChange={onPositionChange} onClose={() => onOpenChange(false)} /></div></DialogContent></Dialog><ArtifactShareDialog open={shareOpen} artifactId={artifactId} fileName={fileName} onOpenChange={setShareOpen} /></>;
}

export function ArtifactPreviewPanel({ artifactId, fileName, fileSize, mimeType, onClose }: ArtifactPreviewPanelProps) {
  const { state, onAuthorizationFailure, onPositionChange } = useSafeArtifactGrant(artifactId, true);
  const [shareOpen, setShareOpen] = useState(false);
  const descriptor = state.grant?.descriptor;
  const subtitle = [descriptor?.safeMime || mimeType || "未知类型", formatFileSize(descriptor?.size ?? fileSize ?? 0)].filter(Boolean).join(" · ");
  return <><RightPanelFrame title={descriptor?.name || fileName} subtitle={subtitle} onClose={onClose} closeLabel="关闭 Artifact 预览" actions={<ArtifactPreviewActions grant={state.grant} onShare={() => setShareOpen(true)} />}><ArtifactPreviewContent grant={state.grant} loading={state.status === "loading" || state.status === "refreshing"} error={state.error} position={state.position} onAuthorizationFailure={onAuthorizationFailure} onPositionChange={onPositionChange} onClose={onClose} /></RightPanelFrame><ArtifactShareDialog open={shareOpen} artifactId={artifactId} fileName={fileName} onOpenChange={setShareOpen} /></>;
}
