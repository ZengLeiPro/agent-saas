import { useEffect, useState } from "react";
import { CircleAlert, Download, FileBox, Loader2 } from "lucide-react";

import { ArtifactContentViewer } from "@/components/artifacts/ArtifactContentViewer";
import { Button } from "@/components/ui/button";
import { formatFileSize } from "@/components/types";
import { fetchPublicArtifactShare, type PublicArtifactShareResponse } from "@/lib/artifactShareApi";

interface PublicArtifactPageProps {
  token: string;
}

type PageState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; data: PublicArtifactShareResponse };

export function PublicArtifactPage({ token }: PublicArtifactPageProps) {
  const [state, setState] = useState<PageState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void fetchPublicArtifactShare(token)
      .then((data) => { if (!cancelled) setState({ status: "success", data }); })
      .catch((err: unknown) => { if (!cancelled) setState({ status: "error", message: err instanceof Error ? err.message : "分享内容加载失败" }); });
    return () => { cancelled = true; };
  }, [token]);

  if (state.status === "loading") {
    return <div className="flex min-h-[100dvh] items-center justify-center bg-background"><Loader2 className="size-8 animate-spin text-muted-foreground" /></div>;
  }
  if (state.status === "error") {
    return (
      <main className="flex min-h-[100dvh] items-center justify-center bg-muted/20 px-6">
        <div role="alert" className="max-w-md rounded-xl border bg-card p-8 text-center shadow-sm">
          <CircleAlert className="mx-auto size-10 text-destructive" />
          <h1 className="mt-4 text-lg font-semibold">无法打开 Artifact</h1>
          <p className="mt-2 text-sm text-muted-foreground">{state.message}</p>
        </div>
      </main>
    );
  }

  const { share, artifact, contentUrl } = state.data;
  const allowDownload = share.allowDownload !== false;
  const metadata = [
    artifact.mimeType || "未知类型",
    typeof artifact.sizeBytes === "number" ? formatFileSize(artifact.sizeBytes) : "大小未知",
    share.expiresAt ? `有效期至 ${new Date(share.expiresAt).toLocaleString()}` : "长期有效",
  ];

  return (
    <main className="flex h-[100dvh] min-h-0 flex-col bg-background">
      <header className="shrink-0 border-b bg-card" style={{ paddingTop: "var(--sat)" }}>
        <div className="mx-auto flex min-h-16 max-w-screen-2xl items-center gap-3 px-3 py-2 sm:px-6">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><FileBox className="size-5" /></div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold sm:text-base" title={artifact.fileName}>{artifact.fileName}</h1>
            <p className="truncate text-xs text-muted-foreground">{metadata.join(" · ")}</p>
          </div>
          {allowDownload ? (
            <Button variant="outline" size="sm" className="shrink-0 px-2 sm:px-3" asChild>
              <a href={contentUrl} download={artifact.fileName}><Download className="size-4" /><span className="hidden sm:inline">下载</span></a>
            </Button>
          ) : null}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">
        <ArtifactContentViewer contentUrl={contentUrl} fileName={artifact.fileName} mimeType={artifact.mimeType} allowDownload={allowDownload} className="h-full" />
      </div>
      <footer className="shrink-0 border-t bg-card px-4 py-2 text-center text-[11px] text-muted-foreground">公开只读 Artifact · 请谨慎处理分享内容</footer>
    </main>
  );
}
