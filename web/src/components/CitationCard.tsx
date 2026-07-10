import { useState } from 'react';
import { BookOpen, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useFilePreview } from '@/contexts/FilePreviewContext';
import { buildKbPreviewPath, resolveKbFileSrc } from '@agent/shared';

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif)$/i;
const PDF_EXT_RE = /\.pdf$/i;

/**
 * 引用溯源卡（[CITE] 标记渲染产物，2026-07 唯恩批次）
 *
 * 行为矩阵：
 * - shareToken 存在（只读分享页）或 filePreview 缺失 → 禁用徽标（tooltip 引导登录）
 * - pdf → kb:// 伪协议穿透 FilePreviewContext，右侧面板打开并定位页码
 * - 图片 → 组件内 lightbox（仿 FileDownloadCard）
 * - 其他类型 → 新标签打开带 token 的 KB 文件 URL 兜底
 */
export function CitationCard({ doc, page, label }: { doc: string; page?: number; label: string }) {
  const filePreview = useFilePreview();
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const disabled = !filePreview || !!filePreview.shareToken;

  const handleClick = () => {
    if (disabled) return;
    if (PDF_EXT_RE.test(doc)) {
      filePreview.openPreview(buildKbPreviewPath(doc, page), undefined, { mode: 'side' });
      return;
    }
    if (IMAGE_EXT_RE.test(doc)) {
      void resolveKbFileSrc(doc)
        .then(setLightboxSrc)
        .catch(() => { /* 打开失败静默 */ });
      return;
    }
    void resolveKbFileSrc(doc)
      .then((url) => window.open(url, '_blank', 'noopener,noreferrer'))
      .catch(() => { /* 打开失败静默 */ });
  };

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled}
        title={disabled ? '引用文档需登录查看' : `打开 ${doc}${page ? ` 第 ${page} 页` : ''}`}
        aria-label={`引用：${label}`}
        className={cn(
          'inline-flex max-w-full items-center gap-1.5 rounded-lg border bg-muted/60 px-2.5 py-1 text-xs font-medium text-foreground transition-colors',
          disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-border',
        )}
      >
        <BookOpen className="h-3.5 w-3.5 shrink-0 text-brand-600" />
        <span className="truncate">{label}</span>
        {page ? (
          <span className="shrink-0 rounded bg-brand-50 px-1 py-0.5 text-[10px] font-semibold tabular-nums text-brand-600 dark:bg-brand-900/35 dark:text-brand-300">
            p.{page}
          </span>
        ) : null}
      </button>
      {lightboxSrc && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setLightboxSrc(null)}
        >
          <button
            type="button"
            onClick={() => setLightboxSrc(null)}
            className="absolute right-4 top-4 rounded-full bg-black/50 p-2 text-white hover:bg-black/70"
            title="关闭"
            aria-label="关闭预览"
          >
            <X className="h-5 w-5" />
          </button>
          <img
            src={lightboxSrc}
            alt={label}
            className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}
