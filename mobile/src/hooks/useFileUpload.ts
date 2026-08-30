import { useState, useCallback, useEffect, useRef } from 'react';
import { Alert } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import {
  launchCameraForUserAction,
  launchPhotoLibraryForUserAction,
} from '../platform/jitMediaPermissions';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { File } from 'expo-file-system';
import type { UploadedFile } from '@agent/shared';
import { authFetch, MAX_UPLOAD_FILE_SIZE, MAX_UPLOAD_FILES_PER_REQUEST, validateAttachmentSelection } from '@agent/shared';
import { validateMobileUploadedFiles } from '../lib/chatSubmissionAdapter';
import { AttachmentPickerAdapter } from '../platform/attachmentPickerAdapter';

const HEIF_MIMES = new Set(['image/heif', 'image/heic', 'image/heif-sequence', 'image/heic-sequence']);


function createUploadRequestId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (!crypto?.randomUUID) throw new Error('设备安全随机数能力不可用');
  return crypto.randomUUID();
}

export interface FileUploadState {
  uploadedFiles: UploadedFile[];
  uploading: boolean;
  uploadError: string | null;
  dismissUploadError: () => void;
  reportUploadError: (message: string) => void;
  pickFile: () => Promise<void>;
  pickImage: () => Promise<void>;
  takePhoto: () => Promise<void>;
  removeFile: (index: number) => void;
  clearFiles: () => void;
  consumeFiles: () => UploadedFile[];
  /**
   * 注入已上传成功的 UploadedFile（不走本地 picker，例如系统级分享流程）。
   * share-target 页面已经把文件 POST 到 /api/upload 拿到结果，这里只负责把结果
   * 灌到当前会话的输入框附件区，让发送时能一并 attachments 走 WS。
   */
  addUploadedFiles: (files: UploadedFile[]) => void;
}

export function useFileUpload(boundary?: { available: boolean; identityKey: string }): FileUploadState {
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const filesRef = useRef<UploadedFile[]>([]);
  const pickerAdapterRef = useRef(new AttachmentPickerAdapter());
  const abortControllerRef = useRef<AbortController | null>(null);
  const boundaryRef = useRef(boundary);
  const generationRef = useRef(0);
  filesRef.current = uploadedFiles;

  useEffect(() => {
    const previous = boundaryRef.current;
    boundaryRef.current = boundary;
    const identityChanged = !!previous && !!boundary && previous.identityKey !== boundary.identityKey;
    if (!identityChanged && boundary?.available !== false) return;
    const hadUpload = !!abortControllerRef.current;
    generationRef.current += 1;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    pickerAdapterRef.current.fence();
    setUploading(false);
    if (hadUpload) setUploadError(identityChanged ? '身份已切换，请重新选择文件' : '应用已锁定或离线，请重新选择文件');
  }, [boundary?.available, boundary?.identityKey]);

  const dismissUploadError = useCallback(() => {
    setUploadError(null);
  }, []);

  const reportUploadError = useCallback((message: string) => {
    setUploadError(message);
  }, []);

  const uploadFileFromUri = useCallback(async (uri: string, name: string, mimeType: string) => {
    if (boundaryRef.current?.available === false) {
      setUploadError('应用已锁定或离线，无法上传');
      return;
    }
    setUploading(true);
    setUploadError(null);
    const generation = generationRef.current;
    let localIntentId = '';
    try {
      localIntentId = createUploadRequestId();
      pickerAdapterRef.current.select(localIntentId, { uri, name, mimeType });
      const source = pickerAdapterRef.current.read(localIntentId);
      const file = new File(source.uri);
      const size = file.exists && typeof file.size === 'number' ? file.size : 0;
      const selection = validateAttachmentSelection([{ name: source.name, size, mimeType: source.mimeType || 'application/octet-stream' }]);
      if (!selection.ok) throw new Error(selection.issue.message);

      const formData = new FormData();
      formData.append('files', {
        uri: source.uri,
        name: source.name,
        type: source.mimeType || 'application/octet-stream',
      } as unknown as Blob);

      const controller = new AbortController();
      abortControllerRef.current = controller;
      const response = await authFetch('/api/upload', {
        method: 'POST',
        headers: { 'X-Upload-Request-Id': createUploadRequestId() },
        signal: controller.signal,
        body: formData,
      });

      if (!response.ok) throw new Error(`上传失败: ${response.status}`);
      const data = await response.json() as { success: boolean; error?: string; files?: UploadedFile[] };
      if (!data.success || !data.files?.[0]) throw new Error(data.error || '上传失败');

      const validation = validateMobileUploadedFiles([data.files[0]]);
      if (!validation.ok) throw new Error(validation.issue.message);
      const uploaded: UploadedFile = {
        ...data.files[0],
        attachmentId: validation.value[0].attachmentId,
      };

      if (generation === generationRef.current) setUploadedFiles(prev => [...prev, uploaded]);
    } catch (error) {
      if (generation === generationRef.current) setUploadError(
        '上传失败：' + (error instanceof Error ? error.message : '未知错误'),
      );
    } finally {
      if (localIntentId) pickerAdapterRef.current.release(localIntentId);
      if (generation === generationRef.current) {
        abortControllerRef.current = null;
        setUploading(false);
      }
    }
  }, []);

  const pickFile = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        multiple: true,
        copyToCacheDirectory: true,
      });

      if (result.canceled || !result.assets?.length) return;
      if (result.assets.length > MAX_UPLOAD_FILES_PER_REQUEST) {
        throw new Error(`单次最多上传 ${MAX_UPLOAD_FILES_PER_REQUEST} 个文件`);
      }

      for (const asset of result.assets) {
        let { uri } = asset;
        let name = asset.name;
        let mime = asset.mimeType || 'application/octet-stream';

        // 文件选择器也可能选到 HEIC 图片
        if (HEIF_MIMES.has(mime.toLowerCase())) {
          const converted = await manipulateAsync(uri, [], {
            format: SaveFormat.JPEG,
            compress: 0.8,
          });
          uri = converted.uri;
          mime = 'image/jpeg';
          name = name.replace(/\.heic$/i, '.jpg').replace(/\.heif$/i, '.jpg');
        }

        await uploadFileFromUri(uri, name, mime);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '系统文件选择器打开失败';
      setUploadError(`选择文件失败：${message}`);
      Alert.alert('选择文件失败', message);
    }
  }, [uploadFileFromUri]);

  const pickImage = useCallback(async () => {
    try {
      const result = await launchPhotoLibraryForUserAction({
        mediaTypes: ['images', 'videos'],
        allowsMultipleSelection: true,
        quality: 0.8,
      });

      if (result.canceled || !result.assets?.length) return;
      if (result.assets.length > MAX_UPLOAD_FILES_PER_REQUEST) {
        throw new Error(`单次最多上传 ${MAX_UPLOAD_FILES_PER_REQUEST} 个文件`);
      }

      for (const asset of result.assets) {
        const isVideo = asset.type === 'video';
        const fallbackName = isVideo ? `video_${Date.now()}.mp4` : `image_${Date.now()}.jpg`;
        const fallbackMime = isVideo ? 'video/mp4' : 'image/jpeg';
        let uri = asset.uri;
        let name = asset.fileName || fallbackName;
        let mime = asset.mimeType || fallbackMime;

        // HEIF/HEIC → JPEG（大模型不支持 HEIF）
        if (!isVideo && HEIF_MIMES.has(mime.toLowerCase())) {
          const converted = await manipulateAsync(uri, [], {
            format: SaveFormat.JPEG,
            compress: 0.8,
          });
          uri = converted.uri;
          mime = 'image/jpeg';
          name = name.replace(/\.heic$/i, '.jpg').replace(/\.heif$/i, '.jpg');
        }

        await uploadFileFromUri(uri, name, mime);
      }
    } catch (error) {
    }
  }, [uploadFileFromUri]);

  const takePhoto = useCallback(async () => {
    try {
      const result = await launchCameraForUserAction({
        mediaTypes: ['images'],
        quality: 0.8,
      });

      if (!result || result.canceled || !result.assets?.length) return;

      const asset = result.assets[0];
      let uri = asset.uri;
      let name = asset.fileName || `photo_${Date.now()}.jpg`;
      let mime = asset.mimeType || 'image/jpeg';

      if (HEIF_MIMES.has(mime.toLowerCase())) {
        const converted = await manipulateAsync(uri, [], {
          format: SaveFormat.JPEG,
          compress: 0.8,
        });
        uri = converted.uri;
        mime = 'image/jpeg';
        name = name.replace(/\.heic$/i, '.jpg').replace(/\.heif$/i, '.jpg');
      }

      await uploadFileFromUri(uri, name, mime);
    } catch (error) {
    }
  }, [uploadFileFromUri]);

  const removeFile = useCallback((index: number) => {
    setUploadedFiles(prev => {
      const next = [...prev];
      next.splice(index, 1);
      return next;
    });
  }, []);

  const clearFiles = useCallback(() => {
    generationRef.current += 1;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    pickerAdapterRef.current.fence();
    setUploadedFiles([]);
  }, []);

  const consumeFiles = useCallback((): UploadedFile[] => {
    generationRef.current += 1;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    const current = filesRef.current;
    pickerAdapterRef.current.fence();
    setUploadedFiles([]);
    return current;
  }, []);

  const addUploadedFiles = useCallback((files: UploadedFile[]) => {
    if (!files.length) return;
    const validation = validateMobileUploadedFiles(files);
    if (!validation.ok) {
      setUploadError(`附件不可发送：${validation.issue.message}`);
      return;
    }
    setUploadedFiles(prev => [...prev, ...files.map((file, index) => ({
      ...file,
      attachmentId: validation.value[index].attachmentId,
    }))]);
  }, []);

  return {
    uploadedFiles,
    uploading,
    uploadError,
    dismissUploadError,
    reportUploadError,
    pickFile,
    pickImage,
    takePhoto,
    removeFile,
    clearFiles,
    consumeFiles,
    addUploadedFiles,
  };
}
