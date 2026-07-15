import { useState, useEffect } from "react";
import { ChevronLeft, Loader2, CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { authFetch } from "@/lib/authFetch";
import { publicSessionShareFileUrl } from "@/lib/sessionShareApi";

const HTML_SANDBOX_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' blob:",
  "style-src 'unsafe-inline' data:",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "navigate-to 'none'",
].join("; ");

interface HtmlPreviewPanelProps {
  filePath: string;
  owner?: string;
  shareToken?: string;
  onBack: () => void;
  hideHeader?: boolean;
}

function htmlDownloadUrl(filePath: string, owner?: string) {
  const ownerParam = owner ? `&owner=${encodeURIComponent(owner)}` : "";
  return `/api/file/download?path=${encodeURIComponent(filePath)}${ownerParam}`;
}

function injectSandboxCsp(html: string) {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${HTML_SANDBOX_CSP}">`;
  const headMatch = html.match(/<head(\s[^>]*)?>/i);
  if (!headMatch) return `${meta}${html}`;

  const index = html.indexOf(headMatch[0]) + headMatch[0].length;
  return `${html.slice(0, index)}${meta}${html.slice(index)}`;
}

export function HtmlPreviewPanel({ filePath, owner, shareToken, onBack, hideHeader }: HtmlPreviewPanelProps) {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "success"; html: string; filename: string }
  >({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

    const request = shareToken
      ? fetch(publicSessionShareFileUrl(shareToken, filePath))
      : authFetch(htmlDownloadUrl(filePath, owner));

    request
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: "Unknown error" }));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        return res.text();
      })
      .then((html) => {
        if (cancelled) return;
        const filename = filePath.split("/").pop() || filePath;
        setState({ status: "success", html: injectSandboxCsp(html), filename });
      })
      .catch((err) => {
        if (!cancelled) {
          setState({ status: "error", message: (err as Error).message });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [filePath, owner, shareToken]);

  const filename =
    state.status === "success" ? state.filename : filePath.split("/").pop() || filePath;
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
          </div>
        </header>
      )}

      <div className="min-w-0 flex-1 overflow-hidden">
        {state.status === "loading" && (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        )}
        {state.status === "error" && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <CircleAlert className="size-6" />
            <span className="text-sm">{state.message}</span>
          </div>
        )}
        {state.status === "success" && (
          <iframe
            srcDoc={state.html}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            className="h-full w-full border-0"
            title={filename}
          />
        )}
      </div>
    </>
  );
}
