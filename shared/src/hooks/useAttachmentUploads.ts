import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { normalizeChatSubmissionAttachments } from '../lib/chatSubmission';
import type { UploadedFile } from '../types/message';

/**
 * 附件上传状态机（Web `useFileUpload` 与 mobile `useFileUpload` 的共同内核）。
 *
 * 内核只管平台无关的部分：
 * - 已上传附件列表、`uploading`、`uploadError` 三个状态；
 * - 「代」（generation）栅栏：身份切换 / 离线或锁定 / clear / consume / 卸载时把在途上传作废，
 *   晚到的响应与错误一律丢弃；
 * - 多个在途上传的 AbortController 登记与 `uploading` 汇总；
 * - 服务端返回的附件统一经 `normalizeChatSubmissionAttachments` 校验并补 `attachmentId`。
 *
 * 平台侧只剩：怎么选文件（File / picker URI）、怎么发请求、以及文件离开状态时的
 * 平台清理（Web 释放 previewUrl，mobile 让 picker adapter fence）。
 */

export interface AttachmentUploadBoundary {
  /** 平台当前是否允许上传：Web=在线；mobile=未锁定且未离线。 */
  ready: boolean;
  /** `租户:用户:代` 身份键；变化即视为换人，作废全部在途上传。 */
  identityKey: string;
}

export interface AttachmentUploadsOptions {
  boundary?: AttachmentUploadBoundary;
  /** 边界从 ready 变为不可用时，对进行中上传给出的提示。 */
  unavailableMessage: string;
  /** 身份切换时对进行中上传给出的提示；缺省与两端既有文案一致。 */
  identityChangedMessage?: string;
  /** 文件离开状态（移除 / 替换 / 清空 / 卸载）时的平台清理；consume 不触发（调用方仍要用）。 */
  onDiscardFiles?: (files: readonly UploadedFile[]) => void;
  /** 每次栅栏（身份切换 / 不可用 / clear / consume / 卸载）时的平台清理。 */
  onFence?: () => void;
}

/** 一次在途上传的句柄：发请求用 `signal`，写回状态前用 `isCurrent()` 判断是否已被作废。 */
export interface AttachmentUploadSlot {
  signal: AbortSignal;
  isCurrent(): boolean;
  /** 上传结束（无论成败）必须调用，否则 `uploading` 不会回落。 */
  finish(): void;
}

export interface AttachmentUploadsCore {
  uploadedFiles: UploadedFile[];
  /** 与 `uploadedFiles` 同步的 ref，供不想订阅渲染的调用方读取。 */
  uploadedFilesRef: MutableRefObject<UploadedFile[]>;
  uploading: boolean;
  uploadError: string | null;
  setUploadError: (message: string | null) => void;
  dismissUploadError: () => void;
  reportUploadError: (message: string) => void;
  /** 边界不可用时返回该用的提示，可用时返回 null。 */
  boundaryBlockReason: () => string | null;
  beginUpload: () => AttachmentUploadSlot;
  /** 追加已通过校验的附件（调用方先用 `slot.isCurrent()` 守住）。 */
  appendFiles: (files: readonly UploadedFile[]) => void;
  removeFile: (index: number) => void;
  replaceFiles: (files: UploadedFile[]) => void;
  clearFiles: () => void;
  consumeFiles: () => UploadedFile[];
}

const DEFAULT_IDENTITY_CHANGED_MESSAGE = '身份已切换，请重新选择文件';

/**
 * 校验服务端返回的附件并补上 `attachmentId`；不合法时抛出带用户可读文案的 Error。
 * `decorate` 让平台补自己的展示字段（Web 的 previewUrl）。
 */
export function acceptUploadedFiles(
  files: readonly UploadedFile[],
  decorate?: (file: UploadedFile, index: number) => UploadedFile,
): UploadedFile[] {
  const validation = normalizeChatSubmissionAttachments(files);
  if (!validation.ok) throw new Error(validation.issue.message);
  return files.map((file, index) => {
    const accepted = { ...file, attachmentId: validation.value[index].attachmentId };
    return decorate ? decorate(accepted, index) : accepted;
  });
}

export function useAttachmentUploads(options: AttachmentUploadsOptions): AttachmentUploadsCore {
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const uploadedFilesRef = useRef<UploadedFile[]>([]);
  uploadedFilesRef.current = uploadedFiles;

  const generationRef = useRef(0);
  const nextUploadIdRef = useRef(0);
  const activeUploadsRef = useRef(new Map<number, number>());
  const abortControllersRef = useRef(new Map<number, AbortController>());
  const boundaryRef = useRef(options.boundary);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const refreshUploading = useCallback(() => {
    const currentGeneration = generationRef.current;
    setUploading(
      [...activeUploadsRef.current.values()].some((generation) => generation === currentGeneration),
    );
  }, []);

  /** 作废全部在途上传并进入下一代；返回作废前是否有在途上传。 */
  const fence = useCallback((): boolean => {
    const hadActive = activeUploadsRef.current.size > 0;
    generationRef.current += 1;
    for (const controller of abortControllersRef.current.values()) controller.abort();
    abortControllersRef.current.clear();
    activeUploadsRef.current.clear();
    setUploading(false);
    optionsRef.current.onFence?.();
    return hadActive;
  }, []);

  // 卸载：作废在途上传并释放文件资源。
  useEffect(() => {
    return () => {
      fence();
      optionsRef.current.onDiscardFiles?.(uploadedFilesRef.current);
    };
  }, [fence]);

  // 边界只看两个原始值：身份键变了 = 换人；ready 变 false = 离线/锁定。
  boundaryRef.current = options.boundary;
  const identityKey = options.boundary?.identityKey;
  const ready = options.boundary?.ready;
  const lastBoundaryRef = useRef(options.boundary);
  useEffect(() => {
    const previous = lastBoundaryRef.current;
    const current = identityKey === undefined ? undefined : { identityKey, ready: ready !== false };
    lastBoundaryRef.current = current;
    const identityChanged = !!previous && !!current && previous.identityKey !== current.identityKey;
    const fenced = identityChanged || ready === false;
    if (!fenced) return;
    const hadActive = fence();
    if (hadActive) {
      setUploadError(
        identityChanged
          ? (optionsRef.current.identityChangedMessage ?? DEFAULT_IDENTITY_CHANGED_MESSAGE)
          : optionsRef.current.unavailableMessage,
      );
    }
  }, [identityKey, ready, fence]);

  const dismissUploadError = useCallback(() => {
    setUploadError(null);
  }, []);
  const reportUploadError = useCallback((message: string) => {
    setUploadError(message);
  }, []);

  const boundaryBlockReason = useCallback(
    (): string | null =>
      boundaryRef.current?.ready === false ? optionsRef.current.unavailableMessage : null,
    [],
  );

  const beginUpload = useCallback((): AttachmentUploadSlot => {
    const generation = generationRef.current;
    const uploadId = ++nextUploadIdRef.current;
    const controller = new AbortController();
    activeUploadsRef.current.set(uploadId, generation);
    abortControllersRef.current.set(uploadId, controller);
    refreshUploading();
    setUploadError(null);
    return {
      signal: controller.signal,
      isCurrent: () => generation === generationRef.current,
      finish: () => {
        activeUploadsRef.current.delete(uploadId);
        abortControllersRef.current.delete(uploadId);
        refreshUploading();
      },
    };
  }, [refreshUploading]);

  const appendFiles = useCallback((files: readonly UploadedFile[]) => {
    if (files.length === 0) return;
    setUploadedFiles((previous) => [...previous, ...files]);
  }, []);

  const removeFile = useCallback((index: number) => {
    setUploadedFiles((previous) => {
      const next = [...previous];
      const [target] = next.splice(index, 1);
      if (target) optionsRef.current.onDiscardFiles?.([target]);
      return next;
    });
  }, []);

  const replaceFiles = useCallback(
    (files: UploadedFile[]) => {
      fence();
      setUploadedFiles((previous) => {
        optionsRef.current.onDiscardFiles?.(previous);
        return files;
      });
      setUploadError(null);
    },
    [fence],
  );

  const clearFiles = useCallback(() => {
    fence();
    setUploadError(null);
    setUploadedFiles((previous) => {
      optionsRef.current.onDiscardFiles?.(previous);
      return [];
    });
  }, [fence]);

  const consumeFiles = useCallback((): UploadedFile[] => {
    fence();
    setUploadError(null);
    const current = uploadedFilesRef.current;
    // 不触发 onDiscardFiles：调用方（发送消息）短时间内仍要用这些文件。
    setUploadedFiles([]);
    return current;
  }, [fence]);

  return {
    uploadedFiles,
    uploadedFilesRef,
    uploading,
    uploadError,
    setUploadError,
    dismissUploadError,
    reportUploadError,
    boundaryBlockReason,
    beginUpload,
    appendFiles,
    removeFile,
    replaceFiles,
    clearFiles,
    consumeFiles,
  };
}
