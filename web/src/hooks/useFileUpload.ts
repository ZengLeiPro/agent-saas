import { useState, useRef, useCallback, useEffect } from "react";
import type { ChangeEvent, ClipboardEvent, DragEvent } from "react";
import type { UploadedFile } from "@/components/types";
import { authFetch } from "@/lib/authFetch";
import { MAX_UPLOAD_FILE_SIZE } from "@/lib/constants";

function revokeFilePreviews(files: UploadedFile[]): void {
  files.forEach((file) => {
    if (file.previewUrl) {
      URL.revokeObjectURL(file.previewUrl);
    }
  });
}

function findOversizedFiles(files: File[]): File[] {
  return files.filter((file) => file.size > MAX_UPLOAD_FILE_SIZE);
}

function formatOversizedMessage(oversized: File[]): string {
  const names = oversized.map((file) => file.name).join("、");
  return `以下文件超过 1GB 限制：${names}`;
}

export interface FileUploadState {
  uploadedFiles: UploadedFile[];
  uploading: boolean;
  uploadError: string | null;
  dismissUploadError: () => void;
  isDragging: boolean;
  removeFile: (index: number) => void;
  handleFileSelect: (event: ChangeEvent<HTMLInputElement>) => Promise<void>;
  handleDragOver: (event: DragEvent) => void;
  handleDragLeave: (event: DragEvent) => void;
  handleDrop: (event: DragEvent) => Promise<void>;
  handlePaste: (event: ClipboardEvent) => Promise<void>;
  clearFiles: () => void;
  consumeFiles: () => UploadedFile[];
  setIsDragging: (v: boolean) => void;
}

export function useFileUpload(
  /** current active tab -- drag/drop only works on "chat" tab */
  activeTab: string,
): FileUploadState {
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const dismissUploadError = useCallback(() => {
    setUploadError(null);
  }, []);

  const uploadedFilesRef = useRef<UploadedFile[]>([]);

  // Keep ref in sync for cleanup
  useEffect(() => {
    uploadedFilesRef.current = uploadedFiles;
  }, [uploadedFiles]);

  // Cleanup previews on unmount
  useEffect(() => {
    return () => {
      revokeFilePreviews(uploadedFilesRef.current);
    };
  }, []);

  const uploadFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) {
      return;
    }

    setUploading(true);
    setUploadError(null);

    try {
      const formData = new FormData();
      files.forEach((file) => {
        formData.append("files", file);
      });

      const response = await authFetch("/api/upload", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`Upload failed: ${response.status}`);
      }

      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || "Upload failed");
      }

      const uploadedWithPreviews = data.files.map((file: UploadedFile, index: number) => {
        const sourceFile = files[index];
        if (file.isImage && sourceFile) {
          return {
            ...file,
            previewUrl: URL.createObjectURL(sourceFile),
          };
        }
        return file;
      });

      setUploadedFiles((previous) => [...previous, ...uploadedWithPreviews]);
      console.log("Files uploaded:", data.files);
    } catch (error) {
      console.error("Upload error:", error);
      setUploadError(
        "上传失败：" + (error instanceof Error ? error.message : "未知错误"),
      );
    } finally {
      setUploading(false);
    }
  }, []);

  const handleFileSelect = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const fileList = event.target.files;
    if (!fileList || fileList.length === 0) {
      return;
    }

    const files = Array.from(fileList);
    const oversized = findOversizedFiles(files);
    if (oversized.length > 0) {
      setUploadError(formatOversizedMessage(oversized));
      event.target.value = "";
      return;
    }

    await uploadFiles(files);
    event.target.value = "";
  }, [uploadFiles]);

  const handlePaste = useCallback(async (event: ClipboardEvent) => {
    const items = event.clipboardData?.items;
    if (!items) return;

    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }

    if (files.length === 0) return;

    event.preventDefault();

    const oversized = findOversizedFiles(files);
    if (oversized.length > 0) {
      setUploadError(formatOversizedMessage(oversized));
      return;
    }

    await uploadFiles(files);
  }, [uploadFiles]);

  const removeFile = useCallback((index: number) => {
    setUploadedFiles((previous) => {
      const next = [...previous];
      const target = next[index];
      if (target?.previewUrl) {
        URL.revokeObjectURL(target.previewUrl);
      }
      next.splice(index, 1);
      return next;
    });
  }, []);

  // 仅外部文件拖入才触发文件上传 UI；内部 element 拖拽（如分组重排）不应被拦截
  const isExternalFileDrag = (event: DragEvent): boolean => {
    const types = event.dataTransfer?.types;
    if (!types) return false;
    // DataTransferItemList 不是真数组，需要遍历
    for (let i = 0; i < types.length; i++) {
      if (types[i] === 'Files') return true;
    }
    return false;
  };

  const handleDragOver = useCallback((event: DragEvent) => {
    if (activeTab !== "chat") {
      return;
    }
    if (!isExternalFileDrag(event)) return;
    event.preventDefault();
    setIsDragging(true);
  }, [activeTab]);

  const handleDragLeave = useCallback((event: DragEvent) => {
    if (activeTab !== "chat") {
      return;
    }
    if (!isExternalFileDrag(event)) return;
    event.preventDefault();
    if (event.currentTarget === event.target) {
      setIsDragging(false);
    }
  }, [activeTab]);

  const handleDrop = useCallback(async (event: DragEvent) => {
    if (activeTab !== "chat") {
      return;
    }
    if (!isExternalFileDrag(event)) return;

    event.preventDefault();
    setIsDragging(false);

    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) {
      return;
    }

    const oversized = findOversizedFiles(files);
    if (oversized.length > 0) {
      setUploadError(formatOversizedMessage(oversized));
      return;
    }

    await uploadFiles(files);
  }, [activeTab, uploadFiles]);

  const clearFiles = useCallback(() => {
    setUploadedFiles((previous) => {
      revokeFilePreviews(previous);
      return [];
    });
  }, []);

  const consumeFiles = useCallback((): UploadedFile[] => {
    const current = uploadedFilesRef.current;
    setUploadedFiles([]);
    // Note: we do NOT revoke previews here since caller may still need them briefly
    // The caller is responsible for revoking after use
    return current;
  }, []);

  return {
    uploadedFiles,
    uploading,
    uploadError,
    dismissUploadError,
    isDragging,
    removeFile,
    handleFileSelect,
    handlePaste,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    clearFiles,
    setIsDragging,
    consumeFiles,
  };
}
