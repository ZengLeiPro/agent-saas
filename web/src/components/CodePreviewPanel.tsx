import { useState, useEffect, lazy, Suspense, useCallback, useRef } from "react";
import { ChevronLeft, Loader2, CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { authFetch } from "@/lib/authFetch";
import { FilePreviewActions, printFilePreviewElement, useFilePreviewPrint } from "@/components/FilePreviewActions";
import "./CodePreviewPanel.css";

/** 扩展名 → highlight.js 语言名（未命中则自动检测） */
const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", go: "go", rs: "rust", java: "java",
  c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp",
  rb: "ruby", php: "php", swift: "swift", kt: "kotlin",
  sh: "bash", bash: "bash", zsh: "bash",
  json: "json", jsonc: "json",
  yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini", conf: "ini", env: "ini",
  xml: "xml", html: "xml", htm: "xml",
  css: "css", scss: "scss", less: "less", sql: "sql",
  txt: "plaintext", log: "plaintext", csv: "plaintext",
};

function extOf(fileName: string): string {
  const i = fileName.lastIndexOf(".");
  return i >= 0 ? fileName.slice(i + 1).toLowerCase() : "";
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
}

/** JSON 自动美化（解析失败保持原文）；其它类型原样返回 */
function normalizeContent(content: string, ext: string): string {
  if (ext === "json" || ext === "jsonc") {
    try {
      return JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      return content;
    }
  }
  return content;
}

// 超大内容跳过高亮，避免主线程卡顿（仍可滚动查看原文）
const MAX_HIGHLIGHT_CHARS = 200_000;

const hljsPromise = import("highlight.js/lib/common");

const LazyHighlighter = lazy(async () => {
  const { default: hljs } = await hljsPromise;
  return {
    default: ({ content, lang }: { content: string; lang: string }) => {
      let html: string;
      try {
        html = lang !== "plaintext" && hljs.getLanguage(lang)
          ? hljs.highlight(content, { language: lang }).value
          : escapeHtml(content);
      } catch {
        html = escapeHtml(content);
      }
      return (
        <pre className="hljs-pre">
          <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
        </pre>
      );
    },
  };
});

interface CodePreviewPanelProps {
  filePath: string;
  /** 文件所属用户（admin 查看其他用户会话时需要） */
  owner?: string;
  onBack: () => void;
  /** 隐藏内置 header（移动端由外层 Layout 统一渲染） */
  hideHeader?: boolean;
}

export function CodePreviewPanel({ filePath, owner, onBack, hideHeader }: CodePreviewPanelProps) {
  const printRootRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<
    { status: "loading" } | { status: "error"; message: string } | { status: "success"; content: string; filename: string }
  >({ status: "loading" });
  const printPreview = useCallback(() => printFilePreviewElement(printRootRef.current), []);
  useFilePreviewPrint(filePath, printPreview);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

    const ownerParam = owner ? `&owner=${encodeURIComponent(owner)}` : '';
    authFetch(`/api/file/read?path=${encodeURIComponent(filePath)}${ownerParam}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: "Unknown error" }));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((data: { content: string; filename: string }) => {
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
  }, [filePath, owner]);

  const filename = state.status === "success" ? state.filename : filePath.split("/").pop() || filePath;
  const dirPath = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
  const ext = extOf(filename);
  const lang = EXT_TO_LANG[ext] ?? "plaintext";

  const display = state.status === "success" ? normalizeContent(state.content, ext) : "";
  const skipHighlight = display.length > MAX_HIGHLIGHT_CHARS;

  return (
    <>
      {!hideHeader && (
        <header className="shrink-0 border-b bg-background" style={{ paddingTop: "var(--sat)" }}>
          <div className="flex h-12 items-center gap-2 px-2">
            <Button variant="ghost" size="icon" className="size-9 shrink-0" onClick={onBack}>
              <ChevronLeft className="size-5" />
            </Button>
            <FilePreviewActions filePath={filePath} owner={owner} />
            <span className="min-w-0 truncate text-sm font-medium">{filename}</span>
            {dirPath && (
              <span className="min-w-0 shrink truncate text-xs text-muted-foreground">{dirPath}</span>
            )}
          </div>
        </header>
      )}

      <div ref={printRootRef} className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden bg-card px-4 py-4 lg:px-6">
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
          skipHighlight ? (
            <pre className="hljs-pre"><code className="hljs">{display}</code></pre>
          ) : (
            <Suspense fallback={<pre className="hljs-pre"><code className="hljs">{display}</code></pre>}>
              <LazyHighlighter content={display} lang={lang} />
            </Suspense>
          )
        )}
      </div>
    </>
  );
}
