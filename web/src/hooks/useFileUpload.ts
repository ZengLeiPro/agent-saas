import { useState, useCallback } from "react";
import type { ChangeEvent, ClipboardEvent, DragEvent } from "react";
import type { UploadedFile } from "@/components/types";
import { authFetch } from "@/lib/authFetch";
import { MAX_UPLOAD_FILES_PER_REQUEST } from "@/lib/constants";
import { acceptUploadedFiles, useAttachmentUploads, validateAttachmentSelection } from "@agent/shared";

/**
 * Web 附件上传：状态机内核在 shared `useAttachmentUploads`（与 mobile 共用），
 * 这里只保留浏览器专有的部分——File 对象、图片 previewUrl、拖拽 / 粘贴 / 资料库选取。
 */

function revokeFilePreviews(files: readonly UploadedFile[]): void {
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
  const core = useAttachmentUploads({
    boundary: boundary ? { ready: boundary.online, identityKey: boundary.identityKey } : undefined,
    unavailableMessage: '网络已断开，请重新选择文件',
    onDiscardFiles: revokeFilePreviews,
  });
  const { beginUpload, appendFiles, setUploadError, boundaryBlockReason, replaceFiles: replaceCoreFiles } = core;
  const [isDragging, setIsDragging] = useState(false);

  const replaceFiles = useCallback((files: UploadedFile[]) => {
    replaceCoreFiles(files);
    setIsDragging(false);
  }, [replaceCoreFiles]);

  const uploadFiles = useCallback(async (files: File[]) => {
    if (boundaryBlockReason()) {
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

    const slot = beginUpload();
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
        signal: slot.signal,
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
      if (!slot.isCurrent()) return;
      appendFiles(acceptUploadedFiles(data.files as UploadedFile[], (file, index) => {
        const sourceFile = files[index];
        return file.isImage && sourceFile ? { ...file, previewUrl: URL.createObjectURL(sourceFile) } : file;
      }));
    } catch (error) {
      if (slot.isCurrent()) {
        setUploadError(
          "上传失败：" + (error instanceof Error ? error.message : "未知错误"),
        );
      }
    } finally {
      slot.finish();
    }
  }, [appendFiles, beginUpload, boundaryBlockReason, getSessionId, setUploadError]);

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
  }, [setUploadError, uploadFiles]);

  const handleAssetSelect = useCallback(async (paths: string[]) => {
    if (boundaryBlockReason()) {
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

    const slot = beginUpload();
    try {
      const sessionId = getSessionId?.()?.trim();
      const uploadUrl = sessionId ? `/api/upload/assets?sessionId=${encodeURIComponent(sessionId)}` : "/api/upload/assets";
      const response = await authFetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: slot.signal,
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
      if (!slot.isCurrent()) return;
      appendFiles(acceptUploadedFiles(data.files));
    } catch (error) {
      if (slot.isCurrent()) {
        setUploadError(`添加资料失败：${error instanceof Error ? error.message : "未知错误"}`);
      }
      throw error;
    } finally {
      slot.finish();
    }
  }, [appendFiles, beginUpload, boundaryBlockReason, getSessionId, setUploadError]);

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
  }, [setUploadError, uploadFiles]);

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
  }, [activeTab, setUploadError, uploadFiles]);

  return {
    uploadedFiles: core.uploadedFiles,
    uploading: core.uploading,
    uploadError: core.uploadError,
    dismissUploadError: core.dismissUploadError,
    reportUploadError: core.reportUploadError,
    isDragging,
    replaceFiles,
    removeFile: core.removeFile,
    handleFileSelect,
    handleAssetSelect,
    handlePaste,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    clearFiles: core.clearFiles,
    setIsDragging,
    consumeFiles: core.consumeFiles,
  };
}
