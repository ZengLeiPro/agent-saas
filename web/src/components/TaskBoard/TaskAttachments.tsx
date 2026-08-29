import { useRef, useState } from "react";
import type { TaskBoardAttachment, TaskBoardUploadAttachment } from "@agent/shared";
import { Download, Eye, Paperclip } from "lucide-react";
import { getFileTypeVisual, resolveImageSrc, resolveTaskAttachmentSrc } from "@agent/shared";
import { FileUpload } from "@/components/FileUpload";
import { ImageLightbox } from "@/components/ImageLightbox";
import { Button } from "@/components/ui/button";
import type { FileUploadState } from "@/hooks/useFileUpload";
import { CATEGORY_ICON } from "@/lib/fileCategoryIcons";
import { cn } from "@/lib/utils";

export function toTaskBoardAttachments(files: readonly TaskBoardAttachment[]): TaskBoardUploadAttachment[] {
  return files.flatMap(({ attachmentId, originalName, relativePath, size, mimeType, isImage }) => (
    attachmentId ? [{ attachmentId, originalName, relativePath, size, mimeType, isImage }] : []
  ));
}

interface TaskAttachmentFieldProps {
  upload: FileUploadState;
  taskId?: string;
  disabled?: boolean;
  className?: string;
  hideHint?: boolean;
  onFilesChanged?: () => void;
}

export function TaskAttachmentField({ upload, taskId, disabled, className, hideHint = false, onFilesChanged }: TaskAttachmentFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className={cn("space-y-1", className)}>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          if (event.target.files?.length) onFilesChanged?.();
          void upload.handleFileSelect(event);
        }}
        disabled={disabled || upload.uploading}
        aria-label="选择附件"
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => inputRef.current?.click()}
        disabled={disabled || upload.uploading}
      >
        <Paperclip />
        添加附件
      </Button>
      {!hideHint ? <span className="ml-2 text-xs text-muted-foreground">可多选，也可直接粘贴图片、视频或文件</span> : null}
      <FileUpload
        uploadedFiles={upload.uploadedFiles}
        uploading={upload.uploading}
        uploadError={upload.uploadError}
        onRemoveFile={(index) => {
          upload.removeFile(index);
          onFilesChanged?.();
        }}
        onDismissError={upload.dismissUploadError}
        resolveFileUrl={taskId ? (file, download) => {
          const taskScoped = file.attachmentId
            && file.relativePath.startsWith(`taskboard/attachments/${taskId}/`);
          return taskScoped
            ? resolveTaskAttachmentSrc(taskId, file.attachmentId!, download)
            : resolveImageSrc(file.relativePath);
        } : undefined}
      />
    </div>
  );
}

export function TaskAttachmentList({
  attachments,
  taskId,
}: {
  attachments: readonly TaskBoardAttachment[];
  taskId?: string;
}) {
  const [preview, setPreview] = useState<{ src: string; alt: string } | null>(null);

  if (attachments.length === 0) return null;

  const resolveAttachmentSrc = async (attachment: TaskBoardAttachment, download: boolean) => {
    const isTaskScoped = taskId && attachment.attachmentId
      && attachment.relativePath.startsWith(`taskboard/attachments/${taskId}/`);
    return isTaskScoped
      ? resolveTaskAttachmentSrc(taskId, attachment.attachmentId!, download)
      : resolveImageSrc(attachment.relativePath);
  };

  const open = async (attachment: TaskBoardAttachment) => {
    if (attachment.isImage) {
      setPreview({
        src: await resolveAttachmentSrc(attachment, false),
        alt: attachment.originalName,
      });
      return;
    }

    const anchor = document.createElement("a");
    anchor.href = await resolveAttachmentSrc(attachment, true);
    anchor.download = attachment.originalName;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  };

  return (
    <>
      <div className="mt-2 flex flex-wrap gap-2">
        {attachments.map((attachment) => {
          const TypeIcon = CATEGORY_ICON[getFileTypeVisual(attachment.originalName).category];
          const action = attachment.isImage ? "预览图片" : "下载";
          return (
            <Button
              key={`${attachment.attachmentId ?? attachment.relativePath}:${attachment.originalName}`}
              type="button"
              variant="outline"
              size="sm"
              className="h-auto max-w-full justify-start gap-2 py-1.5"
              onClick={() => void open(attachment)}
              title={`${action}：${attachment.originalName}`}
              aria-label={`${action}：${attachment.originalName}`}
            >
              <TypeIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="max-w-56 truncate">{attachment.originalName}</span>
              {attachment.isImage ? (
                <Eye className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <Download className="size-3.5 shrink-0 text-muted-foreground" />
              )}
            </Button>
          );
        })}
      </div>
      {preview ? (
        <ImageLightbox src={preview.src} alt={preview.alt} onClose={() => setPreview(null)} />
      ) : null}
    </>
  );
}
