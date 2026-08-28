import { useState } from "react";
import { UploadedFile, formatFileSize } from './types';
import { ChevronLeft, ChevronRight, Loader2, X } from "lucide-react";
import { getFileTypeVisual } from "@agent/shared";
import { CATEGORY_ICON } from "@/lib/fileCategoryIcons";
import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

interface FileUploadProps {
  uploadedFiles: UploadedFile[];
  uploading?: boolean;
  uploadError?: string | null;
  onRemoveFile: (index: number) => void;
  onDismissError?: () => void;
  resolveFileUrl?: (file: UploadedFile, download: boolean) => Promise<string>;
}

export function FileUpload({
  uploadedFiles,
  uploading,
  uploadError,
  onRemoveFile,
  onDismissError,
  resolveFileUrl,
}: FileUploadProps) {
  const [previewedImageIndex, setPreviewedImageIndex] = useState<number | null>(null);
  const [resolvedPreview, setResolvedPreview] = useState<{ src: string; alt: string } | null>(null);
  const previewableImages = uploadedFiles.filter((file) => file.isImage && file.previewUrl);
  const previewedImage = previewedImageIndex === null ? null : previewableImages[previewedImageIndex];
  const displayedPreview = resolvedPreview ?? (previewedImage?.previewUrl
    ? { src: previewedImage.previewUrl, alt: previewedImage.originalName }
    : null);
  const canSwitchPreview = !resolvedPreview && previewableImages.length > 1;

  const openResolvedFile = async (file: UploadedFile) => {
    if (!resolveFileUrl) return;
    const src = await resolveFileUrl(file, !file.isImage);
    if (file.isImage) {
      setResolvedPreview({ src, alt: file.originalName });
      return;
    }
    const anchor = document.createElement("a");
    anchor.href = src;
    anchor.download = file.originalName;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  };

  if (uploadedFiles.length === 0 && !uploading && !uploadError) {
    return null;
  }

  return (
    <>
      <div>
        <div className="content-container flex flex-wrap gap-2 py-2">
          {uploadedFiles.map((file, index) => {
            const TypeIcon = CATEGORY_ICON[getFileTypeVisual(file.originalName).category];
            const imageIndex = previewableImages.indexOf(file);
            const hasLocalPreview = imageIndex >= 0;
            const canOpen = hasLocalPreview || Boolean(resolveFileUrl);
            const action = file.isImage ? "预览图片" : "下载";
            const fileSummary = (
              <>
                {file.previewUrl ? (
                  <img src={file.previewUrl} alt="" className="size-7 rounded object-cover" />
                ) : (
                  <TypeIcon className="size-4 text-muted-foreground" />
                )}
                <span className={cn("max-w-[14rem] truncate")} title={file.originalName}>
                  {file.originalName}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatFileSize(file.size)}
                </span>
              </>
            );
            return (
            <div
              key={index}
              className="flex max-w-full items-center gap-2 rounded-md border bg-card px-2 py-1.5 text-sm"
            >
              {canOpen ? (
                <button
                  type="button"
                  className="flex min-w-0 items-center gap-2 rounded-sm text-left outline-none transition-opacity hover:opacity-75 focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => {
                    if (hasLocalPreview) setPreviewedImageIndex(imageIndex);
                    else void openResolvedFile(file);
                  }}
                  title={`${action}：${file.originalName}`}
                  aria-label={`${action}：${file.originalName}`}
                >
                  {fileSummary}
                </button>
              ) : fileSummary}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={() => onRemoveFile(index)}
                title="Remove"
                aria-label="Remove file"
              >
                <X className="size-4" />
              </Button>
            </div>
            );
          })}
          {uploading && (
            <div
              className="flex items-center gap-2 rounded-md border bg-card px-2 py-1.5 text-sm text-muted-foreground"
              aria-live="polite"
            >
              <Loader2 className="size-4 animate-spin" />
              <span>上传中...</span>
            </div>
          )}
          {uploadError && (
            <div
              className="flex max-w-full items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-sm text-destructive"
              role="alert"
            >
              <span className="max-w-[20rem] truncate" title={uploadError}>
                {uploadError}
              </span>
              {onDismissError && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 text-destructive hover:text-destructive"
                  onClick={onDismissError}
                  title="Dismiss"
                  aria-label="Dismiss error"
                >
                  <X className="size-4" />
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      <Dialog
        open={!!displayedPreview}
        onOpenChange={(open) => {
          if (!open) {
            setPreviewedImageIndex(null);
            setResolvedPreview(null);
          }
        }}
      >
        <DialogContent className="max-w-[calc(100vw-2rem)] border-none bg-transparent p-0 shadow-none sm:max-w-4xl">
          <DialogTitle className="sr-only">图片预览</DialogTitle>
          <DialogDescription className="sr-only">查看已添加的图片附件</DialogDescription>
          {displayedPreview && (
            <div className="relative flex max-h-[calc(100vh-4rem)] flex-col items-center gap-3 p-4">
              <img
                src={displayedPreview.src}
                alt={displayedPreview.alt}
                className="max-h-[calc(100vh-8rem)] max-w-full rounded-md object-contain shadow-2xl"
              />
              <span className="max-w-full truncate text-sm text-white">{displayedPreview.alt}</span>
              {canSwitchPreview && (
                <>
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon"
                    className="absolute left-4 top-1/2 -translate-y-1/2"
                    onClick={() => setPreviewedImageIndex((current) => current === 0 ? previewableImages.length - 1 : (current ?? 0) - 1)}
                    aria-label="上一张图片"
                  >
                    <ChevronLeft className="size-5" />
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon"
                    className="absolute right-4 top-1/2 -translate-y-1/2"
                    onClick={() => setPreviewedImageIndex((current) => current === previewableImages.length - 1 ? 0 : (current ?? 0) + 1)}
                    aria-label="下一张图片"
                  >
                    <ChevronRight className="size-5" />
                  </Button>
                </>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
