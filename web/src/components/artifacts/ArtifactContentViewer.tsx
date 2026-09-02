import { useEffect, useRef, useState } from "react";
import { CircleAlert, Download, FileQuestion, Loader2 } from "lucide-react";
import { authFetch, type ArtifactReadGrant, type ArtifactViewPosition } from "@agent/shared";

import { Button } from "@/components/ui/button";

interface ArtifactContentViewerProps {
  grant: ArtifactReadGrant;
  position?: ArtifactViewPosition;
  onPositionChange?: (position: ArtifactViewPosition) => void;
  onAuthorizationFailure?: (status: number, reason?: string) => void;
  className?: string;
}

type ViewerState =
  | { status: "loading" }
  | { status: "url"; url: string }
  | { status: "text"; text: string }
  | { status: "error"; message: string };

export function ArtifactContentViewer({
  grant,
  position,
  onPositionChange,
  onAuthorizationFailure,
  className,
}: ArtifactContentViewerProps) {
  const descriptor = grant.descriptor;
  const [state, setState] = useState<ViewerState>({ status: "loading" });
  const scrollRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (descriptor.viewKind === "download-only") {
      setState({ status: "error", message: "此类型不能安全在线预览，请确认风险后下载。" });
      return;
    }
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setState({ status: "loading" });
    void authFetch(grant.readUrl, {
      signal: controller.signal,
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers: { "X-Artifact-Correlation-Id": descriptor.correlationId },
    }).then(async (response) => {
      if (!response.ok) {
        const reason = response.status === 423 ? "quarantine" : undefined;
        if ([401, 403, 404, 410, 423].includes(response.status)) onAuthorizationFailure?.(response.status, reason);
        throw new Error(`文件加载失败（HTTP ${response.status}）`);
      }
      if (descriptor.viewKind === "text") {
        const contentLength = Number(response.headers.get("content-length") || "0");
        if (contentLength > descriptor.size || contentLength > 2 * 1024 * 1024) throw new Error("文本预览大小校验失败");
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > 2 * 1024 * 1024 || bytes.includes(0)) throw new Error("文本预览大小或编码不安全");
        return { status: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) } as ViewerState;
      }
      const blob = await response.blob();
      objectUrl = URL.createObjectURL(blob);
      if (controller.signal.aborted) {
        URL.revokeObjectURL(objectUrl);
        objectUrl = null;
        throw new DOMException("Aborted", "AbortError");
      }
      return { status: "url", url: objectUrl } as ViewerState;
    }).then((next) => {
      if (!controller.signal.aborted) setState(next);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setState({ status: "error", message: error instanceof Error ? error.message : "文件加载失败" });
    });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [descriptor, grant.readUrl, onAuthorizationFailure]);

  useEffect(() => {
    if (state.status === "text" && scrollRef.current && position?.scrollTop !== undefined) {
      scrollRef.current.scrollTop = position.scrollTop;
    }
  }, [position?.scrollTop, state.status]);

  if (state.status === "loading") {
    return <div className={`flex h-full min-h-64 items-center justify-center ${className || ""}`}><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>;
  }
  if (state.status === "error") {
    return <div role="alert" className={`flex h-full min-h-64 flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground ${className || ""}`}><CircleAlert className="size-7" /><span className="text-sm">{state.message}</span></div>;
  }
  if (state.status === "text") {
    return <pre ref={scrollRef} onScroll={(event) => onPositionChange?.({ scrollTop: event.currentTarget.scrollTop })} className={`h-full overflow-auto whitespace-pre-wrap break-words bg-card p-5 font-mono text-xs leading-5 sm:p-8 ${className || ""}`}>{state.text}</pre>;
  }
  if (descriptor.viewKind === "pdf") {
    return <iframe title={descriptor.name} src={`${state.url}#page=${position?.page ?? 1}`} sandbox="" referrerPolicy="no-referrer" className={`h-full min-h-64 w-full border-0 ${className || ""}`} />;
  }
  if (descriptor.viewKind === "image") {
    return <div className={`flex h-full min-h-64 items-center justify-center overflow-auto bg-muted/20 p-4 ${className || ""}`}><img src={state.url} alt={descriptor.name} className="max-h-full max-w-full object-contain" /></div>;
  }
  if (descriptor.viewKind === "audio") {
    return <div className={`flex h-full min-h-64 items-center justify-center p-6 ${className || ""}`}><audio src={state.url} controls preload="metadata" className="w-full max-w-xl" onLoadedMetadata={(event) => { if (position?.mediaTime) event.currentTarget.currentTime = position.mediaTime; }} onTimeUpdate={(event) => onPositionChange?.({ mediaTime: event.currentTarget.currentTime })} /></div>;
  }
  if (descriptor.viewKind === "video") {
    return <div className={`flex h-full min-h-64 items-center justify-center bg-black p-2 ${className || ""}`}><video src={state.url} controls playsInline preload="metadata" className="max-h-full max-w-full" onLoadedMetadata={(event) => { if (position?.mediaTime) event.currentTarget.currentTime = position.mediaTime; }} onTimeUpdate={(event) => onPositionChange?.({ mediaTime: event.currentTarget.currentTime })} /></div>;
  }
  return <div className={`flex h-full min-h-64 flex-col items-center justify-center gap-3 p-6 text-center ${className || ""}`}><FileQuestion className="size-8 text-muted-foreground" /><p className="text-sm text-muted-foreground">此文件只能下载查看</p><Button asChild variant="outline"><a href={grant.readUrl} download={descriptor.name} referrerPolicy="no-referrer"><Download className="mr-2 size-4" />下载</a></Button></div>;
}
