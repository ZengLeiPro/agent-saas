import { useEffect, useRef, useState } from 'react';
import { CircleAlert, ChevronLeft, ChevronRight, Loader2, Minus, Plus } from 'lucide-react';
import * as pdfjs from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { getPlatform, resolveKbFileSrc, TOKEN_KEY } from '@agent/shared';
import { Button } from '@/components/ui/button';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export const PDF_RANGE_CHUNK_SIZE = 64 * 1024;

export function createPdfJsDocumentOptions(url: string, token: string | null) {
  return {
    url,
    httpHeaders: token ? { Authorization: `Bearer ${token}` } : undefined,
    disableStream: true,
    disableAutoFetch: true,
    rangeChunkSize: PDF_RANGE_CHUNK_SIZE,
    withCredentials: false,
  } as const;
}

interface PdfJsReaderProps {
  filePath: string;
  initialPage: number;
  onBackToPreview: () => void;
}

export function PdfJsReader({ filePath, initialPage, onBackToPreview }: PdfJsReaderProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [document, setDocument] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(initialPage);
  const [pageInput, setPageInput] = useState(String(initialPage));
  const [zoom, setZoom] = useState(1);
  const [loading, setLoading] = useState(true);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: pdfjs.PDFDocumentLoadingTask | null = null;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const [url, token] = await Promise.all([
          resolveKbFileSrc(filePath),
          getPlatform().secureStorage.getItem(TOKEN_KEY),
        ]);
        if (cancelled) return;
        loadingTask = pdfjs.getDocument(createPdfJsDocumentOptions(url, token));
        const loaded = await loadingTask.promise;
        if (cancelled) {
          await loaded.destroy();
          return;
        }
        const target = Math.min(Math.max(1, initialPage), loaded.numPages);
        setDocument(loaded);
        setPage(target);
        setPageInput(String(target));
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : '完整目录加载失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      void loadingTask?.destroy();
    };
  }, [filePath, initialPage]);

  useEffect(() => {
    if (!document || !canvasRef.current) return;
    let cancelled = false;
    let renderTask: pdfjs.RenderTask | null = null;
    setRendering(true);
    setError(null);
    void document.getPage(page).then((pdfPage) => {
      if (cancelled || !canvasRef.current) return;
      const viewport = pdfPage.getViewport({ scale: zoom * Math.min(2, window.devicePixelRatio || 1) });
      const canvas = canvasRef.current;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('浏览器无法创建 PDF 画布');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      canvas.style.width = `${Math.ceil(viewport.width / Math.min(2, window.devicePixelRatio || 1))}px`;
      canvas.style.height = 'auto';
      renderTask = pdfPage.render({ canvasContext: context, viewport });
      return renderTask.promise.finally(() => pdfPage.cleanup());
    }).catch((caught) => {
      if (!cancelled && !(caught instanceof Error && caught.name === 'RenderingCancelledException')) {
        setError(caught instanceof Error ? caught.message : '页面渲染失败');
      }
    }).finally(() => {
      if (!cancelled) setRendering(false);
    });
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [document, page, zoom]);

  const goToPage = (target: number) => {
    if (!document || !Number.isInteger(target) || target < 1 || target > document.numPages) {
      setPageInput(String(page));
      return;
    }
    setPage(target);
    setPageInput(String(target));
  };

  if (loading) return <Centered><Loader2 className="size-6 animate-spin text-muted-foreground" /></Centered>;
  if (!document || error) {
    return <Centered><CircleAlert className="size-6" /><span className="text-sm">{error ?? '完整目录加载失败'}</span></Centered>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b bg-background px-2 py-2">
        <Button variant="ghost" size="sm" onClick={onBackToPreview}>返回引用页</Button>
        <Button variant="ghost" size="icon" className="size-8" disabled={page <= 1} onClick={() => goToPage(page - 1)} aria-label="上一页">
          <ChevronLeft className="size-4" />
        </Button>
        <input
          aria-label="完整目录页码"
          autoComplete="off"
          className="h-8 w-14 rounded-md border bg-background px-1 text-center text-sm tabular-nums"
          inputMode="numeric"
          value={pageInput}
          onChange={(event) => setPageInput(event.target.value)}
          onBlur={() => goToPage(Number(pageInput))}
          onKeyDown={(event) => { if (event.key === 'Enter') goToPage(Number(pageInput)); }}
        />
        <span className="text-xs text-muted-foreground">/ {document.numPages} 页</span>
        <Button variant="ghost" size="icon" className="size-8" disabled={page >= document.numPages} onClick={() => goToPage(page + 1)} aria-label="下一页">
          <ChevronRight className="size-4" />
        </Button>
        <span className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="icon" className="size-8" disabled={zoom <= 0.5} onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))} aria-label="缩小">
            <Minus className="size-4" />
          </Button>
          <span className="w-12 text-center text-xs tabular-nums">{Math.round(zoom * 100)}%</span>
          <Button variant="ghost" size="icon" className="size-8" disabled={zoom >= 2.5} onClick={() => setZoom((value) => Math.min(2.5, value + 0.25))} aria-label="放大">
            <Plus className="size-4" />
          </Button>
        </span>
      </div>
      <div className="relative min-h-0 flex-1 overflow-auto bg-neutral-200 p-4 dark:bg-neutral-900">
        {rendering && <Loader2 className="absolute right-4 top-4 z-10 size-5 animate-spin text-muted-foreground" />}
        <canvas ref={canvasRef} className="mx-auto block max-w-none bg-white shadow-lg" />
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">{children}</div>;
}
