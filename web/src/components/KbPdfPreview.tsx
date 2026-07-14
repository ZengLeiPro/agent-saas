import { lazy, Suspense, useEffect, useState } from 'react';
import { AlertCircle, ChevronLeft, ChevronRight, Download, Loader2, Minus, Plus } from 'lucide-react';
import {
  buildKbPreviewManifestUrl,
  buildKbPreviewPageUrl,
  type KbPreviewManifest,
  resolveKbFileSrc,
} from '@agent/shared';
import { Button } from '@/components/ui/button';
import { authFetch } from '@/lib/authFetch';

const PdfJsReader = lazy(() => import('./PdfJsReader').then((module) => ({ default: module.PdfJsReader })));

interface KbPdfPreviewProps {
  filePath: string;
  initialPage?: number;
}

export function KbPdfPreview({ filePath, initialPage = 1 }: KbPdfPreviewProps) {
  const [manifest, setManifest] = useState<KbPreviewManifest | null>(null);
  const [manifestLoading, setManifestLoading] = useState(true);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [page, setPage] = useState(initialPage);
  const [pageInput, setPageInput] = useState(String(initialPage));
  const [pageUrl, setPageUrl] = useState<string | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [readerOpen, setReaderOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setManifestLoading(true);
    setManifestError(null);
    void authFetch(buildKbPreviewManifestUrl(filePath)).then(async (response) => {
      if (!response.ok) throw new Error(response.status === 404 ? '该页预览暂未生成' : '文档不存在或知识库未开通');
      return response.json() as Promise<KbPreviewManifest>;
    }).then((nextManifest) => {
      if (cancelled) return;
      setManifest(nextManifest);
      if (initialPage > nextManifest.pageCount) {
        setPageError(`引用页码 ${initialPage} 超出文档范围（共 ${nextManifest.pageCount} 页）`);
      }
    }).catch((caught) => {
      if (!cancelled) setManifestError(caught instanceof Error ? caught.message : '该页预览暂未生成');
    }).finally(() => {
      if (!cancelled) setManifestLoading(false);
    });
    return () => { cancelled = true; };
  }, [filePath, initialPage]);

  useEffect(() => {
    if (!manifest || page < 1 || page > manifest.pageCount) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    setPageLoading(true);
    setPageError(null);
    void authFetch(buildKbPreviewPageUrl(filePath, page, manifest.sourceSha256)).then(async (response) => {
      if (!response.ok) throw new Error(response.status === 404 ? '该页预览暂未生成' : '页面预览加载失败');
      return response.blob();
    }).then((blob) => {
      if (cancelled) return;
      objectUrl = URL.createObjectURL(blob);
      setPageUrl(objectUrl);
    }).catch((caught) => {
      if (!cancelled) setPageError(caught instanceof Error ? caught.message : '页面预览加载失败');
    }).finally(() => {
      if (!cancelled) setPageLoading(false);
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [filePath, manifest, page]);

  const goToPage = (target: number) => {
    if (!manifest || !Number.isInteger(target) || target < 1 || target > manifest.pageCount) {
      setPageInput(String(page));
      return;
    }
    setPage(target);
    setPageInput(String(target));
  };

  const downloadOriginal = async () => {
    setDownloading(true);
    try {
      const response = await authFetch(await resolveKbFileSrc(filePath));
      if (!response.ok) throw new Error('原文件下载失败');
      const objectUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = filePath.split('/').pop() || '目录.pdf';
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    } catch (caught) {
      setPageError(caught instanceof Error ? caught.message : '原文件下载失败');
    } finally {
      setDownloading(false);
    }
  };

  if (readerOpen) {
    return (
      <Suspense fallback={<Centered><Loader2 className="h-6 w-6 animate-spin" /><span className="text-sm">正在打开完整目录…</span></Centered>}>
        <PdfJsReader filePath={filePath} initialPage={page} onBackToPreview={() => setReaderOpen(false)} />
      </Suspense>
    );
  }

  if (manifestLoading) return <Centered><Loader2 className="h-6 w-6 animate-spin" /></Centered>;
  if (manifestError || !manifest) {
    return (
      <Centered>
        <AlertCircle className="h-6 w-6" />
        <span className="text-sm">{manifestError ?? '该页预览暂未生成'}</span>
        <Button size="sm" onClick={() => setReaderOpen(true)}>使用完整目录阅读器</Button>
      </Centered>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b bg-background px-2 py-2">
        <Button variant="ghost" size="icon" className="h-8 w-8" disabled={page <= 1} onClick={() => goToPage(page - 1)} aria-label="上一页">
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <input
          aria-label="预览页码"
          autoComplete="off"
          className="h-8 w-14 rounded-md border bg-background px-1 text-center text-sm tabular-nums"
          inputMode="numeric"
          value={pageInput}
          onChange={(event) => setPageInput(event.target.value)}
          onBlur={() => goToPage(Number(pageInput))}
          onKeyDown={(event) => { if (event.key === 'Enter') goToPage(Number(pageInput)); }}
        />
        <span className="text-xs text-muted-foreground">/ {manifest.pageCount} 页</span>
        <Button variant="ghost" size="icon" className="h-8 w-8" disabled={page >= manifest.pageCount} onClick={() => goToPage(page + 1)} aria-label="下一页">
          <ChevronRight className="h-4 w-4" />
        </Button>
        <span className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-8 w-8" disabled={zoom <= 0.5} onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))} aria-label="缩小">
            <Minus className="h-4 w-4" />
          </Button>
          <span className="w-12 text-center text-xs tabular-nums">{Math.round(zoom * 100)}%</span>
          <Button variant="ghost" size="icon" className="h-8 w-8" disabled={zoom >= 2.5} onClick={() => setZoom((value) => Math.min(2.5, value + 0.25))} aria-label="放大">
            <Plus className="h-4 w-4" />
          </Button>
        </span>
        <Button variant="outline" size="sm" className="ml-auto" onClick={() => setReaderOpen(true)}>查看完整目录</Button>
        <Button variant="ghost" size="sm" disabled={downloading} onClick={() => void downloadOriginal()}>
          {downloading ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Download className="mr-1 h-4 w-4" />}下载原文件
        </Button>
      </div>
      <div className="relative min-h-0 flex-1 overflow-auto bg-neutral-200 p-4 dark:bg-neutral-900">
        {pageLoading && <Centered><Loader2 className="h-6 w-6 animate-spin" /></Centered>}
        {pageError && <Centered><AlertCircle className="h-6 w-6" /><span className="text-sm">{pageError}</span><Button size="sm" onClick={() => setReaderOpen(true)}>使用完整目录阅读器</Button></Centered>}
        {!pageLoading && !pageError && pageUrl && (
          <img
            src={pageUrl}
            alt={`${filePath.split('/').pop() || filePath} 第 ${page} 页`}
            className="mx-auto block h-auto bg-white shadow-lg"
            style={{ width: `${zoom * 100}%`, maxWidth: 'none' }}
          />
        )}
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">{children}</div>;
}
