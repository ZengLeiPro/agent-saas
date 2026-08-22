import { useEffect, useState } from "react";
import { Download, Loader2, Share2 } from "lucide-react";

import { ArtifactContentViewer } from "@/components/artifacts/ArtifactContentViewer";
import { ArtifactShareDialog } from "@/components/artifacts/ArtifactShareDialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { formatFileSize } from "@/components/types";
import { getArtifactContentUrl } from "@/lib/artifactShareApi";

interface ArtifactPreviewDialogProps {
  open: boolean;
  artifactId: string;
  fileName: string;
  fileSize?: number;
  mimeType?: string;
  onOpenChange: (open: boolean) => void;
}

export function ArtifactPreviewDialog({ open, artifactId, fileName, fileSize, mimeType, onOpenChange }: ArtifactPreviewDialogProps) {
  const [contentUrl, setContentUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setContentUrl(null);
    setError(null);
    void getArtifactContentUrl(artifactId)
      .then((url) => { if (!cancelled) setContentUrl(url); })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : "Artifact 加载失败"); });
    return () => { cancelled = true; };
  }, [artifactId, open]);

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
            {contentUrl ? (
              <Button variant="outline" size="sm" className="shrink-0 px-2 sm:px-3" asChild title="下载 Artifact">
                <a href={contentUrl} download={fileName}><Download className="size-4" /><span className="hidden sm:inline">下载</span></a>
              </Button>
            ) : null}
            <Button variant="outline" size="sm" className="shrink-0 px-2 sm:px-3" onClick={() => setShareOpen(true)}>
              <Share2 className="size-4" /><span className="hidden sm:inline">分享</span>
            </Button>
          </header>
          <div className="min-h-0 flex-1 overflow-hidden">
            {!contentUrl && !error ? <div className="flex h-full items-center justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div> : null}
            {error ? <div role="alert" className="flex h-full items-center justify-center px-6 text-center text-sm text-destructive">{error}</div> : null}
            {contentUrl ? <ArtifactContentViewer contentUrl={contentUrl} fileName={fileName} mimeType={mimeType} className="h-full" /> : null}
          </div>
        </DialogContent>
      </Dialog>
      <ArtifactShareDialog open={shareOpen} artifactId={artifactId} fileName={fileName} onOpenChange={setShareOpen} />
    </>
  );
}
