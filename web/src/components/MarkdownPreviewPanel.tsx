import { publicSessionShareFileUrl } from "@/lib/sessionShareApi";
import { useState, useEffect, useMemo, lazy, Suspense } from "react";
import { ChevronLeft, Loader2, CircleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { authFetch } from "@/lib/authFetch";
import { extractTextFromChildren, getCellMinWidthPx } from "@/lib/tableCellWidth";
import { resolveImageSrc } from "@agent/shared";

/** 判断是否为外部 URL 或 data URI */
function isExternalSrc(src: string): boolean {
  return /^(https?:|data:|blob:)/i.test(src);
}

const VIDEO_EXT_RE = /\.(mp4|mov|webm|m4v|avi)$/i;

/** 预览面板内的图片：支持 owner 解析 + lightbox */
function PreviewImage({ src, alt, owner, referrer }: { src: string; alt?: string; owner?: string; referrer?: string }) {
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState(false);

  useEffect(() => {
    let cancelled = false;
    resolveImageSrc(src, owner, referrer)
      .then(url => { if (!cancelled) setResolvedSrc(url); })
      .catch(() => { if (!cancelled) setResolvedSrc(src); });
    return () => { cancelled = true; };
  }, [src, owner, referrer]);

  if (!resolvedSrc) {
    return <span className="inline-block h-40 w-60 animate-pulse rounded-lg bg-muted" />;
  }

  return (
    <>
      <img
        src={resolvedSrc}
        alt={alt}
        className="max-h-80 max-w-full cursor-pointer rounded-lg border border-border shadow-sm transition-shadow hover:shadow-md"
        onClick={() => setLightbox(true)}
      />
      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setLightbox(false)}
        >
          <button
            onClick={() => setLightbox(false)}
            className="absolute right-4 top-4 rounded-full bg-black/50 p-2 text-white hover:bg-black/70"
          >
            <X className="size-5" />
          </button>
          <img
            src={resolvedSrc}
            alt={alt}
            className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}

/** 预览面板内的视频：支持 owner 解析 */
function PreviewVideo({ src, owner, referrer }: { src: string; owner?: string; referrer?: string }) {
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    resolveImageSrc(src, owner, referrer)
      .then(url => { if (!cancelled) setResolvedSrc(url); })
      .catch(() => { if (!cancelled) setResolvedSrc(src); });
    return () => { cancelled = true; };
  }, [src, owner, referrer]);

  if (!resolvedSrc) {
    return <span className="inline-block h-40 w-60 animate-pulse rounded-lg bg-muted" />;
  }

  return (
    <video
      src={resolvedSrc}
      controls
      playsInline
      preload="metadata"
      className="max-h-80 max-w-full rounded-lg border border-border shadow-sm"
    />
  );
}

const markdownPromise = import("react-markdown");
const remarkGfmPromise = import("remark-gfm");
const remarkMathPromise = import("remark-math");
const rehypeKatexPromise = import("rehype-katex");
import "katex/dist/katex.min.css";

const LazyMarkdownRenderer = lazy(async () => {
  const [{ default: Markdown }, { default: remarkGfm }, { default: remarkMath }, { default: rehypeKatex }] = await Promise.all([
    markdownPromise,
    remarkGfmPromise,
    remarkMathPromise,
    rehypeKatexPromise,
  ]);
  return {
    default: ({ content, owner, referrer }: { content: string; owner?: string; referrer?: string }) => {
      const mdComponents = useMemo<import("react-markdown").Components>(() => ({
        a: ({ children, href, ...props }) => (
          <a href={href} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>
        ),
        table: ({ children, ...props }) => (
          <div className="overflow-x-auto">
            <table {...props}>{children}</table>
          </div>
        ),
        // td/th 注入 min-width = ⌈文本宽度 / 4⌉，保证自然换行不超过 4 行
        td: ({ children, style, ...props }) => (
          <td style={{ minWidth: `${getCellMinWidthPx(extractTextFromChildren(children))}px`, ...style }} {...props}>{children}</td>
        ),
        th: ({ children, style, ...props }) => (
          <th style={{ minWidth: `${getCellMinWidthPx(extractTextFromChildren(children))}px`, ...style }} {...props}>{children}</th>
        ),
        img: ({ src, alt, ...props }) => {
          if (!src || isExternalSrc(src)) {
            if (src && VIDEO_EXT_RE.test(src)) {
              return <video src={src} controls playsInline preload="metadata" className="max-h-80 max-w-full rounded-lg border border-border shadow-sm" />;
            }
            return <img src={src} alt={alt} {...props} />;
          }
          if (VIDEO_EXT_RE.test(src)) {
            return <PreviewVideo src={src} owner={owner} referrer={referrer} />;
          }
          return <PreviewImage src={src} alt={alt ?? ''} owner={owner} referrer={referrer} />;
        },
      }), [owner, referrer]);
      return <Markdown remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: false }]]} rehypePlugins={[rehypeKatex]} components={mdComponents}>{content}</Markdown>;
    },
  };
});

interface MarkdownPreviewPanelProps {
  filePath: string;
  /** 文件所属用户（admin 查看其他用户会话时需要） */
  owner?: string;
  /** 只读分享 token；提供时通过 /api/share/sessions/:token/file 读取快照内容。 */
  shareToken?: string;
  onBack: () => void;
  /** 隐藏内置 header（移动端由外层 Layout 统一渲染） */
  hideHeader?: boolean;
}

export function MarkdownPreviewPanel({ filePath, owner, shareToken, onBack, hideHeader }: MarkdownPreviewPanelProps) {
  const [state, setState] = useState<
    { status: "loading" } | { status: "error"; message: string } | { status: "success"; content: string; filename: string }
  >({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

    // 分享页无登录态，直接 fetch 公开 share file 接口拿原始文本；主站点走
    // /api/file/read（JSON 响应带 filename 兜底文件名解析）+ 鉴权 token。
    const request = shareToken
      ? fetch(publicSessionShareFileUrl(shareToken, filePath))
        .then(async (res) => {
          if (!res.ok) {
            const bodyText = await res.text().catch(() => '');
            throw new Error(bodyText ? bodyText.slice(0, 200) : `HTTP ${res.status}`);
          }
          const content = await res.text();
          const filename = filePath.split('/').pop() || filePath;
          return { content, filename };
        })
      : authFetch(`/api/file/read?path=${encodeURIComponent(filePath)}${owner ? `&owner=${encodeURIComponent(owner)}` : ''}`)
        .then(async (res) => {
          if (!res.ok) {
            const body = await res.json().catch(() => ({ error: "Unknown error" }));
            throw new Error(body.error || `HTTP ${res.status}`);
          }
          return res.json() as Promise<{ content: string; filename: string }>;
        });

    request
      .then((data) => {
        if (!cancelled) {
          setState({ status: "success", content: data.content, filename: data.filename });
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setState({ status: "error", message: (err as Error).message });
        }
      });

    return () => { cancelled = true; };
  }, [filePath, owner, shareToken]);

  const filename = state.status === "success" ? state.filename : filePath.split("/").pop() || filePath;
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

      <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden bg-card px-6 py-6 lg:px-10">
        <div className="mx-auto max-w-[72ch]">
          {state.status === "loading" && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          )}
          {state.status === "error" && (
            <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
              <CircleAlert className="size-6" />
              <span className="text-sm">{state.message}</span>
            </div>
          )}
          {state.status === "success" && (
            <div className="prose-chat text-sm">
              <Suspense
                fallback={<div className="whitespace-pre-wrap break-words">{state.content}</div>}
              >
                <LazyMarkdownRenderer content={state.content} owner={owner} referrer={filePath} />
              </Suspense>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
