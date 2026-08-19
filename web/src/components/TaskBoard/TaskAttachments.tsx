import { useRef } from "react";
import type { TaskBoardAttachment, TaskBoardUploadAttachment } from "@agent/shared";
import { Download, Paperclip } from "lucide-react";
import { getFileTypeVisual, resolveImageSrc, resolveTaskAttachmentSrc } from "@agent/shared";
import { FileUpload } from "@/components/FileUpload";
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
  disabled?: boolean;
  className?: string;
  onFilesChanged?: () => void;
}

export function TaskAttachmentField({ upload, disabled, className, onFilesChanged }: TaskAttachmentFieldProps) {
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
      <span className="ml-2 text-xs text-muted-foreground">可多选，也可直接粘贴图片、视频或文件</span>
      <FileUpload
        uploadedFiles={upload.uploadedFiles}
        uploading={upload.uploading}
        uploadError={upload.uploadError}
        onRemoveFile={(index) => {
          upload.removeFile(index);
          onFilesChanged?.();
        }}
        onDismissError={upload.dismissUploadError}
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
  if (attachments.length === 0) return null;

  const download = async (attachment: TaskBoardAttachment) => {
    const isTaskScoped = taskId && attachment.attachmentId
      && attachment.relativePath.startsWith(`taskboard/attachments/${taskId}/`);
    const url = isTaskScoped
      ? await resolveTaskAttachmentSrc(taskId, attachment.attachmentId!, true)
      : await resolveImageSrc(attachment.relativePath);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = attachment.originalName;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  };

  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {attachments.map((attachment) => {
        const TypeIcon = CATEGORY_ICON[getFileTypeVisual(attachment.originalName).category];
        return (
          <Button
            key={`${attachment.attachmentId ?? attachment.relativePath}:${attachment.originalName}`}
            type="button"
            variant="outline"
            size="sm"
            className="h-auto max-w-full justify-start gap-2 py-1.5"
            onClick={() => void download(attachment)}
            title={`下载 ${attachment.originalName}`}
          >
            <TypeIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="max-w-56 truncate">{attachment.originalName}</span>
            <Download className="size-3.5 shrink-0 text-muted-foreground" />
          </Button>
        );
      })}
    </div>
  );
}
