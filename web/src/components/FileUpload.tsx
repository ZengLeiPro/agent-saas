import { UploadedFile, formatFileSize } from './types';
import { FileText, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";

interface FileUploadProps {
  uploadedFiles: UploadedFile[];
  uploading?: boolean;
  uploadError?: string | null;
  onRemoveFile: (index: number) => void;
  onDismissError?: () => void;
}

export function FileUpload({
  uploadedFiles,
  uploading,
  uploadError,
  onRemoveFile,
  onDismissError,
}: FileUploadProps) {
  if (uploadedFiles.length === 0 && !uploading && !uploadError) {
    return null;
  }

  return (
    <div>
      <div className="content-container flex flex-wrap gap-2 py-2">
        {uploadedFiles.map((file, index) => (
          <div
            key={index}
            className="flex max-w-full items-center gap-2 rounded-md border bg-card px-2 py-1.5 text-sm"
          >
            {file.isImage && file.previewUrl ? (
              <img
                src={file.previewUrl}
                alt=""
                className="h-7 w-7 rounded object-cover"
              />
            ) : (
              <FileText className="h-4 w-4 text-muted-foreground" />
            )}
            <span className={cn("max-w-[14rem] truncate")} title={file.originalName}>
              {file.originalName}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {formatFileSize(file.size)}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => onRemoveFile(index)}
              title="Remove"
              aria-label="Remove file"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        ))}
        {uploading && (
          <div
            className="flex items-center gap-2 rounded-md border bg-card px-2 py-1.5 text-sm text-muted-foreground"
            aria-live="polite"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
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
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-destructive hover:text-destructive"
                onClick={onDismissError}
                title="Dismiss"
                aria-label="Dismiss error"
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

