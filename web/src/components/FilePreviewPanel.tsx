import { PanelRightOpen, FileQuestion } from "lucide-react";
import { getPreviewFileType, isKbPath, parseKbPath } from "@agent/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { MarkdownPreviewPanel } from "@/components/MarkdownPreviewPanel";
import { HtmlPreviewPanel } from "@/components/HtmlPreviewPanel";
import { CodePreviewPanel } from "@/components/CodePreviewPanel";
import { PdfPreviewPanel } from "@/components/PdfPreviewPanel";
import { VideoPreviewPanel } from "@/components/VideoPreviewPanel";
import { FilePreviewActions } from "@/components/FilePreviewActions";

interface FilePreviewPanelProps {
  filePath: string;
  owner?: string;
  shareToken?: string;
  onBack: () => void;
  hideHeader?: boolean;
}

export function FilePreviewPanel({ filePath, owner, shareToken, onBack, hideHeader }: FilePreviewPanelProps) {
  // kb:// 伪协议（引用溯源卡）：pdf 走 PdfPreviewPanel kb 分支（带 #page=N 定位）；
  // 其余类型引用卡内部已自行处理（lightbox/新标签），此处仅兜底提示。
  if (isKbPath(filePath)) {
    const kb = parseKbPath(filePath);
    if (kb && getPreviewFileType(kb.doc) === "pdf") {
      return <PdfPreviewPanel filePath={kb.doc} kbSource page={kb.page} onBack={onBack} hideHeader={hideHeader} />;
    }
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
        <FileQuestion className="size-6" />
        <span className="text-sm">该引用类型不支持内嵌预览</span>
      </div>
    );
  }
  const previewType = getPreviewFileType(filePath);
  if (previewType === "html") return <HtmlPreviewPanel filePath={filePath} owner={owner} shareToken={shareToken} onBack={onBack} hideHeader={hideHeader} />;
  if (previewType === "pdf") return <PdfPreviewPanel filePath={filePath} owner={owner} shareToken={shareToken} onBack={onBack} hideHeader={hideHeader} />;
  if (previewType === "video") return <VideoPreviewPanel filePath={filePath} owner={owner} onBack={onBack} hideHeader={hideHeader} />;
  if (previewType === "code") return <CodePreviewPanel filePath={filePath} owner={owner} onBack={onBack} hideHeader={hideHeader} />;
  return <MarkdownPreviewPanel filePath={filePath} owner={owner} shareToken={shareToken} onBack={onBack} hideHeader={hideHeader} />;
}

interface FilePreviewDialogProps {
  open: boolean;
  filePath: string | null;
  owner?: string;
  shareToken?: string;
  onClose: () => void;
  onDock?: () => void;
}

export function FilePreviewDialog({ open, filePath, owner, shareToken, onClose, onDock }: FilePreviewDialogProps) {
  const filename = filePath?.split("/").pop() || filePath || "";
  const dirPath = filePath?.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <DialogContent className="flex h-[min(900px,calc(100vh-64px))] w-[min(1180px,calc(100vw-48px))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:rounded-xl">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-background px-4 pr-16">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-sm font-medium leading-5">
              {filename}
            </DialogTitle>
            {dirPath ? (
              <div className="truncate text-xs text-muted-foreground">
                {dirPath}
              </div>
            ) : null}
          </div>
          {filePath ? (
            <FilePreviewActions
              filePath={filePath}
              owner={owner}
              shareToken={shareToken}
            />
          ) : null}
          {onDock ? (
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={onDock}
              title="在右侧预览栏打开"
            >
              <PanelRightOpen className="size-4" />
              右侧打开
            </Button>
          ) : null}
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {filePath ? (
            <FilePreviewPanel
              filePath={filePath}
              owner={owner}
              shareToken={shareToken}
              onBack={onClose}
              hideHeader
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
