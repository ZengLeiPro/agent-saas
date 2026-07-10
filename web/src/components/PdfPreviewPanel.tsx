import { useState, useEffect } from "react";
import { ChevronLeft, Loader2, AlertCircle, ExternalLink, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { resolveImageSrc, resolveKbFileSrc } from "@agent/shared";
import { authFetch } from "@/lib/authFetch";

interface PdfPreviewPanelProps {
  filePath: string;
  owner?: string;
  /** 只读分享 token；提供时通过 /api/share/sessions/:token/file 拉取 PDF（无需登录）。 */
  shareToken?: string;
  /** 租户共享 KB 文档（引用溯源卡）：走 /api/kb/file + HEAD 预检 + #page 定位。 */
  kbSource?: boolean;
  /** 浏览器原生 viewer 页码定位（仅 kbSource；越界由浏览器自动 clamp）。 */
  page?: number;
  onBack: () => void;
  /** 隐藏内置 header（移动端由外层 Layout 统一渲染） */
  hideHeader?: boolean;
}

// iOS Safari 的 iframe 无法可靠内嵌 PDF（空白/不可滚动），降级为「新标签打开」
const IS_IOS = typeof navigator !== "undefined" && /iP(hone|ad|od)/.test(navigator.userAgent);

export function PdfPreviewPanel({ filePath, owner, shareToken, kbSource, page, onBack, hideHeader }: PdfPreviewPanelProps) {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "success"; url: string }
  >({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    if (kbSource) {
      // KB 文档：HEAD 预检（403=未开通/无权限，404=文档不存在）后再 iframe，
      // 避免浏览器原生 viewer 吞掉错误只显示空白。#page=N 交给原生 viewer 定位。
      (async () => {
        try {
          const head = await authFetch(`/api/kb/file?path=${encodeURIComponent(filePath)}`, { method: "HEAD" });
          if (cancelled) return;
          if (!head.ok) {
            setState({ status: "error", message: "文档不存在或知识库未开通" });
            return;
          }
          const url = await resolveKbFileSrc(filePath);
          if (cancelled) return;
          setState({ status: "success", url: page ? `${url}#page=${page}` : url });
        } catch (err) {
          if (!cancelled) setState({ status: "error", message: (err as Error).message });
        }
      })();
      return () => { cancelled = true; };
    }
    if (shareToken) {
      // 分享页公开接口本身按 path 直读快照文件，浏览器可直接 iframe 渲染 PDF。
      const url = `/api/share/sessions/${encodeURIComponent(shareToken)}/file?path=${encodeURIComponent(filePath)}`;
      setState({ status: "success", url });
      return () => { cancelled = true; };
    }
    // resolveImageSrc 返回带 token 的 /api/file/download URL，后端对 .pdf 走 inline，
    // 浏览器原生 PDF 阅读器在 iframe 内渲染；Range 支持保证大文件按页流式加载
    resolveImageSrc(filePath, owner)
      .then((url) => { if (!cancelled) setState({ status: "success", url }); })
      .catch((err) => { if (!cancelled) setState({ status: "error", message: (err as Error).message }); });
    return () => { cancelled = true; };
  }, [filePath, owner, shareToken, kbSource, page]);

  const filename = filePath.split("/").pop() || filePath;
  const dirPath = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
  const url = state.status === "success" ? state.url : null;

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
            {url && (
              <Button variant="ghost" size="icon" className="ml-auto h-9 w-9 shrink-0" title="在新标签页打开" asChild>
                <a href={url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="!h-4 !w-4" />
                </a>
              </Button>
            )}
          </div>
        </header>
      )}

      <div className="min-w-0 flex-1 overflow-hidden bg-muted/30">
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
        {state.status === "success" &&
          (IS_IOS ? (
            <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
              <FileText className="h-10 w-10 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">当前设备无法内嵌预览 PDF</span>
              <Button asChild>
                <a href={state.url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="mr-2 h-4 w-4" /> 在新标签页打开
                </a>
              </Button>
            </div>
          ) : (
            // key={url}：同文档不同页码时强制 iframe 重建（浏览器不对 fragment 变化重载 PDF）
            <iframe key={state.url} src={state.url} className="h-full w-full border-0" title={filename} />
          ))}
      </div>
    </>
  );
}
