import { useState, useRef, useCallback, useEffect } from "react";
import type { ChangeEvent, ClipboardEvent, DragEvent } from "react";
import type { UploadedFile } from "@/components/types";
import { authFetch } from "@/lib/authFetch";
import { MAX_UPLOAD_FILES_PER_REQUEST } from "@/lib/constants";
import { validateWebUploadedFiles } from "@/lib/chatSubmissionAdapter";
import { validateAttachmentSelection } from "@agent/shared";

function revokeFilePreviews(files: UploadedFile[]): void {
  files.forEach((file) => {
    if (file.previewUrl) {
      URL.revokeObjectURL(file.previewUrl);
    }
  });
}

function validateFileBatch(files: File[]): string | null {
  const result = validateAttachmentSelection(files.map((file) => ({
    name: file.name,
    size: file.size,
    mimeType: file.type || 'application/octet-stream',
  })));
  return result.ok ? null : result.issue.message;
}

function createUploadRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? '00000000-0000-4000-8000-' + Date.now().toString().padStart(12, '0').slice(-12);
}

export interface FileUploadState {
  uploadedFiles: UploadedFile[];
  uploading: boolean;
  uploadError: string | null;
  dismissUploadError: () => void;
  reportUploadError: (message: string) => void;
  isDragging: boolean;
  replaceFiles: (files: UploadedFile[]) => void;
  removeFile: (index: number) => void;
  handleFileSelect: (event: ChangeEvent<HTMLInputElement>) => Promise<void>;
  handleAssetSelect: (paths: string[]) => Promise<void>;
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
  getSessionId?: () => string | null,
  boundary?: { online: boolean; identityKey: string },
): FileUploadState {
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const generationRef = useRef(0);
  const nextUploadIdRef = useRef(0);
  const activeUploadsRef = useRef(new Map<number, number>());
  const abortControllersRef = useRef(new Map<number, AbortController>());
  const boundaryRef = useRef(boundary);

  const refreshUploading = useCallback(() => {
    const currentGeneration = generationRef.current;
    setUploading([...activeUploadsRef.current.values()].some((generation) => generation === currentGeneration));
  }, []);

  const dismissUploadError = useCallback(() => {
    setUploadError(null);
  }, []);

  const reportUploadError = useCallback((message: string) => {
    setUploadError(message);
  }, []);

  const replaceFiles = useCallback((files: UploadedFile[]) => {
    generationRef.current += 1;
    for (const controller of abortControllersRef.current.values()) controller.abort();
    abortControllersRef.current.clear();
    activeUploadsRef.current.clear();
    setUploadedFiles((previous) => {
      revokeFilePreviews(previous);
      return files;
    });
    setUploading(false);
    setUploadError(null);
    setIsDragging(false);
  }, []);

  const uploadedFilesRef = useRef<UploadedFile[]>([]);

  // Keep ref in sync for cleanup
  useEffect(() => {
    uploadedFilesRef.current = uploadedFiles;
  }, [uploadedFiles]);

  // Cleanup previews on unmount
  useEffect(() => {
    return () => {
      generationRef.current += 1;
      for (const controller of abortControllersRef.current.values()) controller.abort();
      abortControllersRef.current.clear();
      activeUploadsRef.current.clear();
      revokeFilePreviews(uploadedFilesRef.current);
    };
  }, []);

  useEffect(() => {
    const previous = boundaryRef.current;
    boundaryRef.current = boundary;
    const identityChanged = !!previous && !!boundary && previous.identityKey !== boundary.identityKey;
    const fenced = identityChanged || boundary?.online === false;
    if (!fenced) return;
    const hadActive = activeUploadsRef.current.size > 0;
    generationRef.current += 1;
    for (const controller of abortControllersRef.current.values()) controller.abort();
    abortControllersRef.current.clear();
    activeUploadsRef.current.clear();
    setUploading(false);
    if (hadActive) setUploadError(identityChanged ? '身份已切换，请重新选择文件' : '网络已断开，请重新选择文件');
  }, [boundary?.identityKey, boundary?.online]);

  const uploadFiles = useCallback(async (files: File[]) => {
    if (boundaryRef.current?.online === false) {
      setUploadError('当前离线，无法上传');
      return;
    }
    if (files.length === 0) {
      return;
    }
    const validationError = validateFileBatch(files);
    if (validationError) {
      setUploadError(validationError);
      return;
    }

    const generation = generationRef.current;
    const uploadId = ++nextUploadIdRef.current;
    const controller = new AbortController();
    activeUploadsRef.current.set(uploadId, generation);
    abortControllersRef.current.set(uploadId, controller);
    refreshUploading();
    setUploadError(null);

    try {
      const formData = new FormData();
      files.forEach((file) => {
        formData.append("files", file);
      });

      const sessionId = getSessionId?.()?.trim();
      const uploadUrl = sessionId ? `/api/upload?sessionId=${encodeURIComponent(sessionId)}` : "/api/upload";
      const requestId = createUploadRequestId();
      const response = await authFetch(uploadUrl, {
        method: "POST",
        headers: { "X-Upload-Request-Id": requestId },
        signal: controller.signal,
        body: formData,
      });

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(errorBody.error || `Upload failed: ${response.status}`);
      }

      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || "Upload failed");
      }
      if (generation !== generationRef.current) return;
      const validation = validateWebUploadedFiles(data.files as UploadedFile[]);
      if (!validation.ok) throw new Error(validation.issue.message);

      const uploadedWithPreviews = data.files.map((file: UploadedFile, index: number) => {
        const sourceFile = files[index];
        if (file.isImage && sourceFile) {
          return {
            ...file,
            attachmentId: validation.value[index].attachmentId,
            previewUrl: URL.createObjectURL(sourceFile),
          };
        }
        return { ...file, attachmentId: validation.value[index].attachmentId };
      });

      setUploadedFiles((previous) => [...previous, ...uploadedWithPreviews]);
    } catch (error) {
      if (generation === generationRef.current) {
        setUploadError(
          "上传失败：" + (error instanceof Error ? error.message : "未知错误"),
        );
      }
    } finally {
      activeUploadsRef.current.delete(uploadId);
      abortControllersRef.current.delete(uploadId);
      refreshUploading();
    }
  }, [getSessionId, refreshUploading]);

  const handleFileSelect = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const fileList = event.target.files;
    if (!fileList || fileList.length === 0) {
      return;
    }

    const files = Array.from(fileList);
    const validationError = validateFileBatch(files);
    if (validationError) {
      setUploadError(validationError);
      event.target.value = "";
      return;
    }

    await uploadFiles(files);
    event.target.value = "";
  }, [uploadFiles]);

  const handleAssetSelect = useCallback(async (paths: string[]) => {
    if (boundaryRef.current?.online === false) {
      const message = '当前离线，无法上传';
      setUploadError(message);
      throw new Error(message);
    }
    if (paths.length === 0) return;
    if (paths.length > MAX_UPLOAD_FILES_PER_REQUEST) {
      const message = `单次最多上传 ${MAX_UPLOAD_FILES_PER_REQUEST} 个文件`;
      setUploadError(message);
      throw new Error(message);
    }

    const generation = generationRef.current;
    const uploadId = ++nextUploadIdRef.current;
    const controller = new AbortController();
    activeUploadsRef.current.set(uploadId, generation);
    abortControllersRef.current.set(uploadId, controller);
    refreshUploading();
    setUploadError(null);

    try {
      const sessionId = getSessionId?.()?.trim();
      const uploadUrl = sessionId ? `/api/upload/assets?sessionId=${encodeURIComponent(sessionId)}` : "/api/upload/assets";
      const response = await authFetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ paths }),
      });
      const data = await response.json().catch(() => ({})) as {
        success?: boolean;
        error?: string;
        files?: UploadedFile[];
      };
      if (!response.ok || !data.success || !data.files) {
        throw new Error(data.error || `Upload failed: ${response.status}`);
      }
      if (generation !== generationRef.current) return;
      const validation = validateWebUploadedFiles(data.files);
      if (!validation.ok) throw new Error(validation.issue.message);
      setUploadedFiles((previous) => [...previous, ...data.files!.map((file, index) => ({
        ...file,
        attachmentId: validation.value[index].attachmentId,
      }))]);
    } catch (error) {
      if (generation === generationRef.current) {
        setUploadError(`添加资料失败：${error instanceof Error ? error.message : "未知错误"}`);
      }
      throw error;
    } finally {
      activeUploadsRef.current.delete(uploadId);
      abortControllersRef.current.delete(uploadId);
      refreshUploading();
    }
  }, [getSessionId, refreshUploading]);

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

    const validationError = validateFileBatch(files);
    if (validationError) {
      setUploadError(validationError);
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

    const validationError = validateFileBatch(files);
    if (validationError) {
      setUploadError(validationError);
      return;
    }

    await uploadFiles(files);
  }, [activeTab, uploadFiles]);

  const clearFiles = useCallback(() => {
    generationRef.current += 1;
    for (const controller of abortControllersRef.current.values()) controller.abort();
    abortControllersRef.current.clear();
    activeUploadsRef.current.clear();
    setUploading(false);
    setUploadError(null);
    setUploadedFiles((previous) => {
      revokeFilePreviews(previous);
      return [];
    });
  }, []);

  const consumeFiles = useCallback((): UploadedFile[] => {
    generationRef.current += 1;
    for (const controller of abortControllersRef.current.values()) controller.abort();
    abortControllersRef.current.clear();
    activeUploadsRef.current.clear();
    setUploading(false);
    setUploadError(null);
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
    reportUploadError,
    isDragging,
    replaceFiles,
    removeFile,
    handleFileSelect,
    handleAssetSelect,
    handlePaste,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    clearFiles,
    setIsDragging,
    consumeFiles,
  };
}
