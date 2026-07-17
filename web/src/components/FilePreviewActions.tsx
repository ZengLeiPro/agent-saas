import { useEffect, useState } from "react";
import { Download, Loader2, Printer } from "lucide-react";
import { getPreviewFileType, resolveImageSrc } from "@agent/shared";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { publicSessionShareFileUrl } from "@/lib/sessionShareApi";

const FILE_PREVIEW_PRINT_EVENT = "agent-saas:file-preview-print";
export const FILE_PREVIEW_PRINT_MESSAGE = "agent-saas:file-preview-print-message";
export const FILE_PREVIEW_PRINT_DONE_MESSAGE = "agent-saas:file-preview-print-done";

interface FilePreviewPrintDetail {
  filePath: string;
}

interface FilePreviewActionsProps {
  filePath: string;
  owner?: string;
  shareToken?: string;
  className?: string;
}

function triggerBrowserDownload(url: string, fileName: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
}

async function resolveWorkspaceFileUrl(filePath: string, owner?: string): Promise<string> {
  return resolveImageSrc(filePath, owner);
}

function withForcedDownload(url: string): string {
  const resolved = new URL(url, window.location.href);
  resolved.searchParams.set("download", "1");
  return resolved.toString();
}

function dispatchPrint(filePath: string): void {
  window.dispatchEvent(new CustomEvent<FilePreviewPrintDetail>(FILE_PREVIEW_PRINT_EVENT, {
    detail: { filePath },
  }));
}

/** 让具体预览器处理打印：HTML 交给 sandbox iframe，文本类只打印内容区。 */
export function useFilePreviewPrint(filePath: string, print: () => void): void {
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<FilePreviewPrintDetail>).detail;
      if (detail?.filePath === filePath) print();
    };
    window.addEventListener(FILE_PREVIEW_PRINT_EVENT, listener);
    return () => window.removeEventListener(FILE_PREVIEW_PRINT_EVENT, listener);
  }, [filePath, print]);
}

/** 通过打印媒体样式只保留当前 Markdown/文本/代码内容区。 */
export function printFilePreviewElement(element: HTMLElement | null): void {
  if (!element) return;
  element.setAttribute("data-file-preview-print-root", "true");
  document.body.classList.add("file-preview-printing");
  try {
    window.print();
  } finally {
    document.body.classList.remove("file-preview-printing");
    element.removeAttribute("data-file-preview-print-root");
  }
}

export function FilePreviewActions({
  filePath,
  owner,
  shareToken,
  className,
}: FilePreviewActionsProps) {
  const [downloading, setDownloading] = useState(false);
  const [openingPrintView, setOpeningPrintView] = useState(false);
  const fileName = filePath.split("/").pop() || filePath;
  const previewType = getPreviewFileType(filePath);
  const printable = previewType !== null && previewType !== "video";

  const fileUrl = () => shareToken
    ? Promise.resolve(publicSessionShareFileUrl(shareToken, filePath))
    : resolveWorkspaceFileUrl(filePath, owner);

  const handleDownload = async () => {
    setDownloading(true);
    try {
      triggerBrowserDownload(withForcedDownload(await fileUrl()), fileName);
    } catch (error) {
      console.error("File download failed:", error);
    } finally {
      setDownloading(false);
    }
  };

  const handlePrint = () => {
    if (previewType !== "pdf") {
      dispatchPrint(filePath);
      return;
    }

    // 生产前端与 API 分域，父页面无法跨域调用原生 PDF viewer 的 print()。
    // 在用户点击时同步打开窗口规避 popup blocker，再异步导航到 PDF 打印视图。
    const printWindow = window.open("", "_blank");
    if (printWindow) {
      printWindow.opener = null;
      printWindow.document.title = "正在打开打印视图";
      printWindow.document.body.textContent = "正在打开 PDF 打印视图…";
    }
    setOpeningPrintView(true);
    void fileUrl()
      .then((url) => {
        if (printWindow) printWindow.location.replace(url);
        else window.open(url, "_blank", "noopener,noreferrer");
      })
      .catch((error) => {
        console.error("Open PDF print view failed:", error);
        printWindow?.close();
      })
      .finally(() => setOpeningPrintView(false));
  };

  return (
    <div className={cn("flex shrink-0 items-center gap-1", className)}>
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        onClick={() => void handleDownload()}
        disabled={downloading}
        title="下载文件"
        aria-label="下载文件"
      >
        {downloading ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
      </Button>
      {printable ? (
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={handlePrint}
          disabled={openingPrintView}
          title={previewType === "pdf" ? "打开 PDF 打印视图" : "打印文件"}
          aria-label="打印文件"
        >
          {openingPrintView ? <Loader2 className="size-4 animate-spin" /> : <Printer className="size-4" />}
        </Button>
      ) : null}
    </div>
  );
}
