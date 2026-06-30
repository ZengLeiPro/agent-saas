import { useState, useEffect } from "react";
import { ChevronLeft, Loader2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { authFetch } from "@/lib/authFetch";

interface HtmlPreviewPanelProps {
  filePath: string;
  owner?: string;
  onBack: () => void;
  hideHeader?: boolean;
}

export function HtmlPreviewPanel({ filePath, owner, onBack, hideHeader }: HtmlPreviewPanelProps) {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "success"; previewUrl: string; filename: string }
  >({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

    authFetch("/api/file/preview-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(owner ? { owner } : {}),
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: "Unknown error" }));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((data: { token: string }) => {
        if (cancelled) return;
        const encodedPath = filePath.split('/').map(s => encodeURIComponent(s)).join('/');
        const previewUrl = `/preview/${data.token}/${encodedPath}`;
        const filename = filePath.split("/").pop() || filePath;
        setState({ status: "success", previewUrl, filename });
      })
      .catch((err) => {
        if (!cancelled) {
          setState({ status: "error", message: (err as Error).message });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [filePath, owner]);

  const filename =
    state.status === "success" ? state.filename : filePath.split("/").pop() || filePath;
  const dirPath = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";

  return (
    <>
      {!hideHeader && (
        <header className="shrink-0 border-b bg-background" style={{ paddingTop: "var(--sat)" }}>
          <div className="flex h-12 items-center gap-2 px-2">
            <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={onBack}>
              <ChevronLeft className="!h-5 !w-5" />
            </Button>
            <span className="min-w-0 truncate text-sm font-medium">{filename}</span>
            {dirPath && (
              <span className="min-w-0 shrink truncate text-xs text-muted-foreground">{dirPath}</span>
            )}
          </div>
        </header>
      )}

      <div className="min-w-0 flex-1 overflow-hidden">
        {state.status === "loading" && (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}
        {state.status === "error" && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <AlertCircle className="h-6 w-6" />
            <span className="text-sm">{state.message}</span>
          </div>
        )}
        {state.status === "success" && (
          <iframe
            src={state.previewUrl}
            sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            className="h-full w-full border-0"
            title={filename}
          />
        )}
      </div>
    </>
  );
}
