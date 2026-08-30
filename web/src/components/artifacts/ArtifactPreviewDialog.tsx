import { useEffect, useState } from "react";
import { Download, Loader2, PanelRight, Share2 } from "lucide-react";

import { ArtifactContentViewer } from "@/components/artifacts/ArtifactContentViewer";
import { ArtifactShareDialog } from "@/components/artifacts/ArtifactShareDialog";
import { RightPanelFrame } from "@/components/RightPanelFrame";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { formatFileSize } from "@/components/types";
import { getArtifactContentUrl } from "@/lib/artifactShareApi";

interface ArtifactPreviewProps {
  artifactId: string;
  fileName: string;
  fileSize?: number;
  mimeType?: string;
}

interface ArtifactPreviewDialogProps extends ArtifactPreviewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDock?: () => void;
}

interface ArtifactPreviewPanelProps extends ArtifactPreviewProps {
  onClose: () => void;
}

function useArtifactContentUrl(artifactId: string, active: boolean) {
  const [contentUrl, setContentUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setContentUrl(null);
    setError(null);
    void getArtifactContentUrl(artifactId)
      .then((url) => { if (!cancelled) setContentUrl(url); })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : "Artifact 加载失败"); });
    return () => { cancelled = true; };
  }, [active, artifactId]);

  return { contentUrl, error };
}

function ArtifactPreviewContent({ contentUrl, error, fileName, mimeType }: {
  contentUrl: string | null;
  error: string | null;
  fileName: string;
  mimeType?: string;
}) {
  if (!contentUrl && !error) {
    return <div className="flex h-full items-center justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>;
  }
  if (error) {
    return <div role="alert" className="flex h-full items-center justify-center px-6 text-center text-sm text-destructive">{error}</div>;
  }
  return <ArtifactContentViewer contentUrl={contentUrl!} fileName={fileName} mimeType={mimeType} className="h-full" />;
}

function ArtifactPreviewActions({ contentUrl, fileName, onShare }: {
  contentUrl: string | null;
  fileName: string;
  onShare: () => void;
}) {
  return (
    <>
      {contentUrl ? (
        <Button variant="outline" size="sm" className="shrink-0 px-2 sm:px-3" asChild title="下载 Artifact">
          <a href={contentUrl} download={fileName}><Download className="size-4" /><span className="hidden sm:inline">下载</span></a>
        </Button>
      ) : null}
      <Button variant="outline" size="sm" className="shrink-0 px-2 sm:px-3" onClick={onShare}>
        <Share2 className="size-4" /><span className="hidden sm:inline">分享</span>
      </Button>
    </>
  );
}

export function ArtifactPreviewDialog({
  open,
  artifactId,
  fileName,
  fileSize,
  mimeType,
  onOpenChange,
  onDock,
}: ArtifactPreviewDialogProps) {
  const { contentUrl, error } = useArtifactContentUrl(artifactId, open);
  const [shareOpen, setShareOpen] = useState(false);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          onOpenAutoFocus={(event) => event.preventDefault()}
          className="flex h-[100dvh] w-screen max-w-none flex-col gap-0 overflow-hidden !border-0 p-0 !shadow-xl outline-none sm:h-[calc(100dvh-32px)] sm:w-[min(1180px,calc(100vw-48px))] sm:rounded-xl [&>button[aria-label='Close']]:right-2 [&>button[aria-label='Close']]:top-2 sm:[&>button[aria-label='Close']]:right-4 sm:[&>button[aria-label='Close']]:top-1.5"
        >
          <header className="flex min-h-14 shrink-0 items-center gap-2 border-b bg-background px-3 pr-14 sm:px-4 sm:pr-16" style={{ paddingTop: "var(--sat)" }}>
            <div className="min-w-0 flex-1">
              <DialogTitle className="truncate text-sm font-medium leading-5">{fileName}</DialogTitle>
              <div className="truncate text-xs text-muted-foreground">
                {[mimeType || "未知类型", fileSize ? formatFileSize(fileSize) : null].filter(Boolean).join(" · ")}
              </div>
            </div>
            <ArtifactPreviewActions contentUrl={contentUrl} fileName={fileName} onShare={() => setShareOpen(true)} />
            {onDock ? (
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={onDock}
                title="在右侧预览栏打开"
                aria-label="在右侧预览栏打开"
              >
                <PanelRight className="size-4" />
                <span className="hidden sm:inline">右侧打开</span>
              </Button>
            ) : null}
          </header>
          <div className="min-h-0 flex-1 overflow-hidden">
            <ArtifactPreviewContent contentUrl={contentUrl} error={error} fileName={fileName} mimeType={mimeType} />
          </div>
        </DialogContent>
      </Dialog>
      <ArtifactShareDialog open={shareOpen} artifactId={artifactId} fileName={fileName} onOpenChange={setShareOpen} />
    </>
  );
}

export function ArtifactPreviewPanel({ artifactId, fileName, fileSize, mimeType, onClose }: ArtifactPreviewPanelProps) {
  const { contentUrl, error } = useArtifactContentUrl(artifactId, true);
  const [shareOpen, setShareOpen] = useState(false);
  const subtitle = [mimeType || "未知类型", fileSize ? formatFileSize(fileSize) : null].filter(Boolean).join(" · ");

  return (
    <>
      <RightPanelFrame
        title={fileName}
        subtitle={subtitle}
        onClose={onClose}
        closeLabel="关闭 Artifact 预览"
        actions={<ArtifactPreviewActions contentUrl={contentUrl} fileName={fileName} onShare={() => setShareOpen(true)} />}
      >
        <ArtifactPreviewContent contentUrl={contentUrl} error={error} fileName={fileName} mimeType={mimeType} />
      </RightPanelFrame>
      <ArtifactShareDialog open={shareOpen} artifactId={artifactId} fileName={fileName} onOpenChange={setShareOpen} />
    </>
  );
}
