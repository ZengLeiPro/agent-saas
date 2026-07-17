import { useState, useEffect } from "react";
import { ChevronLeft, Loader2, CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { resolveImageSrc } from "@agent/shared";
import { FilePreviewActions } from "@/components/FilePreviewActions";

interface VideoPreviewPanelProps {
  filePath: string;
  owner?: string;
  onBack: () => void;
  /** 隐藏内置 header（移动端由外层 Layout 统一渲染） */
  hideHeader?: boolean;
}

export function VideoPreviewPanel({ filePath, owner, onBack, hideHeader }: VideoPreviewPanelProps) {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "success"; url: string }
  >({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    // resolveImageSrc 生成带 token 的 /api/file/download URL；后端 Range 支持保证可拖动 seek
    resolveImageSrc(filePath, owner)
      .then((url) => { if (!cancelled) setState({ status: "success", url }); })
      .catch((err) => { if (!cancelled) setState({ status: "error", message: (err as Error).message }); });
    return () => { cancelled = true; };
  }, [filePath, owner]);

  const filename = filePath.split("/").pop() || filePath;
  const dirPath = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";

  return (
    <>
      {!hideHeader && (
        <header className="shrink-0 border-b bg-background" style={{ paddingTop: "var(--sat)" }}>
          <div className="flex h-12 items-center gap-2 px-2">
            <Button variant="ghost" size="icon" className="size-9 shrink-0" onClick={onBack}>
              <ChevronLeft className="size-5" />
            </Button>
            <span className="min-w-0 truncate text-sm font-medium">{filename}</span>
            {dirPath && (
              <span className="min-w-0 shrink truncate text-xs text-muted-foreground">{dirPath}</span>
            )}
            <FilePreviewActions filePath={filePath} owner={owner} className="ml-auto" />
          </div>
        </header>
      )}

      <div className="flex min-w-0 flex-1 items-center justify-center overflow-hidden bg-black p-2">
        {state.status === "loading" && (
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        )}
        {state.status === "error" && (
          <div className="flex flex-col items-center gap-2 text-muted-foreground">
            <CircleAlert className="size-6" />
            <span className="text-sm">{state.message}</span>
          </div>
        )}
        {state.status === "success" && (
          <video
            src={state.url}
            controls
            playsInline
            preload="metadata"
            className="max-h-full max-w-full rounded-lg"
          />
        )}
      </div>
    </>
  );
}
