import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { CircleAlert, Download, FileQuestion, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { resolveArtifactContentUrl } from "@/lib/artifactShareApi";
import { injectSandboxCsp } from "@/lib/htmlSandbox";

const ReactMarkdown = lazy(() => import("react-markdown"));
const remarkGfm = () => import("remark-gfm").then((module) => module.default);

export const ARTIFACT_TEXT_MAX_BYTES = 2 * 1024 * 1024;
export const ARTIFACT_HTML_MAX_BYTES = 50 * 1024 * 1024;

export type ArtifactPreviewKind =
  | "html"
  | "markdown"
  | "pdf"
  | "image"
  | "audio"
  | "video"
  | "text"
  | "download";

// HTML 预览在 sandbox 中渲染，大小由 ARTIFACT_HTML_MAX_BYTES 控制。
const HTML_MIME = new Set(["text/html", "application/xhtml+xml"]);
const MARKDOWN_MIME = new Set(["text/markdown", "text/x-markdown"]);
const TEXT_MIME = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-javascript",
  "application/yaml",
  "application/x-yaml",
]);

export function selectArtifactPreviewKind(fileName: string, mimeType?: string): ArtifactPreviewKind {
  const mime = mimeType?.split(";", 1)[0]?.trim().toLowerCase() || "";
  const extension = fileName.toLowerCase().match(/\.([^.]+)$/)?.[1] || "";
  if (HTML_MIME.has(mime) || ["html", "htm", "xhtml"].includes(extension)) return "html";
  // SVG 是可执行/可引用外部资源的 XML 活动内容，不能作为同 origin blob 图片预览。
  if (mime === "image/svg+xml" || extension === "svg") return "download";
  if (MARKDOWN_MIME.has(mime) || ["md", "markdown", "mdown", "mkd"].includes(extension)) return "markdown";
  if (mime === "application/pdf" || extension === "pdf") return "pdf";
  if (mime.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif"].includes(extension)) return "image";
  if (mime.startsWith("audio/") || ["mp3", "wav", "ogg", "m4a", "aac", "flac"].includes(extension)) return "audio";
  if (mime.startsWith("video/") || ["mp4", "webm", "mov", "m4v", "ogv"].includes(extension)) return "video";
  if (mime.startsWith("text/") || TEXT_MIME.has(mime) || ["txt", "log", "csv", "tsv", "json", "xml", "yaml", "yml", "js", "ts", "tsx", "jsx", "css", "sql", "sh", "patch", "diff"].includes(extension)) return "text";
  return "download";
}

interface ArtifactContentViewerProps {
  contentUrl: string;
  fileName: string;
  mimeType?: string;
  allowDownload?: boolean;
  className?: string;
}

type ViewerState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "text"; text: string }
  | { status: "url"; url: string };

async function blobLooksLikeSvg(blob: Blob): Promise<boolean> {
  const prefix = await blob.slice(0, 4096).text();
  return /<svg(?:\s|>)/i.test(prefix.replace(/^\uFEFF/, ""));
}

async function readLimitedText(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    throw new Error(`文件过大，文本预览上限为 ${Math.round(limit / 1024 / 1024)} MB`);
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > limit) {
    throw new Error(`文件过大，文本预览上限为 ${Math.round(limit / 1024 / 1024)} MB`);
  }
  return new TextDecoder().decode(bytes);
}

function DownloadFallback({ contentUrl, fileName, allowDownload }: Pick<ArtifactContentViewerProps, "contentUrl" | "fileName" | "allowDownload">) {
  return (
    <div className="flex h-full min-h-64 flex-col items-center justify-center gap-3 px-6 text-center">
      <FileQuestion className="size-10 text-muted-foreground" strokeWidth={1.5} />
      <div>
        <div className="text-sm font-medium">该文件类型暂不支持在线预览</div>
        <div className="mt-1 text-xs text-muted-foreground">请下载后使用本地应用打开</div>
      </div>
      {allowDownload !== false ? (
        <Button asChild>
          <a href={contentUrl} download={fileName}>
            <Download className="size-4" /> 下载文件
          </a>
        </Button>
      ) : (
        <div className="text-xs text-muted-foreground">分享者未开放下载</div>
      )}
    </div>
  );
}

export function ArtifactContentViewer({ contentUrl, fileName, mimeType, allowDownload = true, className }: ArtifactContentViewerProps) {
  const kind = useMemo(() => selectArtifactPreviewKind(fileName, mimeType), [fileName, mimeType]);
  const [state, setState] = useState<ViewerState>({ status: "loading" });
  const [markdownPlugins, setMarkdownPlugins] = useState<Awaited<ReturnType<typeof remarkGfm>>[] | null>(null);

  useEffect(() => {
    if (kind !== "markdown") return;
    let cancelled = false;
    void remarkGfm().then((plugin) => { if (!cancelled) setMarkdownPlugins([plugin]); });
    return () => { cancelled = true; };
  }, [kind]);

  useEffect(() => {
    if (kind === "download") {
      setState({ status: "url", url: contentUrl });
      return;
    }
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setState({ status: "loading" });

    void fetch(resolveArtifactContentUrl(contentUrl), { signal: controller.signal, referrerPolicy: "no-referrer" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`加载失败（HTTP ${response.status}）`);
        if (kind === "html" || kind === "markdown" || kind === "text") {
          const limit = kind === "html" ? ARTIFACT_HTML_MAX_BYTES : ARTIFACT_TEXT_MAX_BYTES;
          const text = await readLimitedText(response, limit);
          return { status: "text", text: kind === "html" ? injectSandboxCsp(text) : text } as ViewerState;
        }
        const blob = await response.blob();
        if (kind === "image" && await blobLooksLikeSvg(blob)) {
          throw new Error("检测到 SVG 活动内容；为避免脚本与外部资源风险，请下载后查看");
        }
        objectUrl = URL.createObjectURL(blob);
        // fetch/Blob 解析存在极短竞态：卸载触发 abort 后，已完成的响应仍可能落到这里。
        // 此时 effect cleanup 已经运行，必须立即撤销，不能遗留对象 URL。
        if (controller.signal.aborted) {
          URL.revokeObjectURL(objectUrl);
          objectUrl = null;
          throw new DOMException("Aborted", "AbortError");
        }
        return { status: "url", url: objectUrl } as ViewerState;
      })
      .then((next) => {
        if (!controller.signal.aborted) setState(next);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setState({ status: "error", message: error instanceof Error ? error.message : "文件加载失败" });
        }
      });

    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [contentUrl, kind]);

  if (kind === "download") {
    return <div className={className}><DownloadFallback contentUrl={contentUrl} fileName={fileName} allowDownload={allowDownload} /></div>;
  }

  if (state.status === "loading") {
    return <div className={`flex h-full min-h-64 items-center justify-center ${className || ""}`}><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>;
  }
  if (state.status === "error") {
    return (
      <div className={`flex h-full min-h-64 flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground ${className || ""}`} role="alert">
        <CircleAlert className="size-7" />
        <span className="text-sm">{state.message}</span>
      </div>
    );
  }
  if (kind === "html" && state.status === "text") {
    return <iframe title={fileName} srcDoc={state.text} sandbox="allow-scripts" referrerPolicy="no-referrer" className={`h-full min-h-64 w-full border-0 ${className || ""}`} />;
  }
  if (kind === "markdown" && state.status === "text") {
    return (
      <div className={`h-full overflow-auto bg-card px-5 py-6 sm:px-8 ${className || ""}`}>
        <Suspense fallback={<Loader2 className="mx-auto size-6 animate-spin text-muted-foreground" />}>
          {markdownPlugins ? (
            <div className="prose-chat mx-auto max-w-[76ch] text-sm">
              <ReactMarkdown
                remarkPlugins={markdownPlugins}
                components={{
                  img: ({ src, alt }) => {
                    const embedded = typeof src === "string" && (src.startsWith("data:image/") || src.startsWith("blob:"));
                    return embedded
                      ? <img src={src} alt={alt || ""} referrerPolicy="no-referrer" />
                      : <span className="text-muted-foreground">[外部图片已阻止{alt ? `：${alt}` : ""}]</span>;
                  },
                  a: ({ href, children }) => {
                    const external = typeof href === "string" && /^https?:\/\//i.test(href);
                    return <a href={href} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>{children}</a>;
                  },
                }}
              >
                {state.text}
              </ReactMarkdown>
            </div>
          ) : <Loader2 className="mx-auto size-6 animate-spin text-muted-foreground" />}
        </Suspense>
      </div>
    );
  }
  if (kind === "text" && state.status === "text") {
    return <pre className={`h-full overflow-auto whitespace-pre-wrap break-words bg-card p-5 font-mono text-xs leading-5 sm:p-8 ${className || ""}`}>{state.text}</pre>;
  }
  if (state.status !== "url") return null;
  if (kind === "pdf") return <iframe title={fileName} src={state.url} referrerPolicy="no-referrer" className={`h-full min-h-64 w-full border-0 ${className || ""}`} />;
  if (kind === "image") return <div className={`flex h-full min-h-64 items-center justify-center overflow-auto bg-muted/20 p-4 ${className || ""}`}><img src={state.url} alt={fileName} className="max-h-full max-w-full object-contain" /></div>;
  if (kind === "audio") return <div className={`flex h-full min-h-64 items-center justify-center p-6 ${className || ""}`}><audio src={state.url} controls preload="metadata" className="w-full max-w-xl" /></div>;
  if (kind === "video") return <div className={`flex h-full min-h-64 items-center justify-center bg-black p-2 ${className || ""}`}><video src={state.url} controls playsInline preload="metadata" className="max-h-full max-w-full" /></div>;
  return <DownloadFallback contentUrl={contentUrl} fileName={fileName} allowDownload={allowDownload} />;
}
