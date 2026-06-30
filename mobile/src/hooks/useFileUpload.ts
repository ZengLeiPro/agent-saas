import { useState, useCallback, useRef } from 'react';
import { Alert } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { File } from 'expo-file-system';
import type { UploadedFile } from '@agent/shared';
import { authFetch } from '@agent/shared';

const HEIF_MIMES = new Set(['image/heif', 'image/heic', 'image/heif-sequence', 'image/heic-sequence']);

const MAX_FILE_SIZE = 1024 * 1024 * 1024; // 1GB

export interface FileUploadState {
  uploadedFiles: UploadedFile[];
  uploading: boolean;
  uploadError: string | null;
  dismissUploadError: () => void;
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

export function useFileUpload(): FileUploadState {
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const filesRef = useRef<UploadedFile[]>([]);
  filesRef.current = uploadedFiles;

  const dismissUploadError = useCallback(() => {
    setUploadError(null);
  }, []);

  const uploadFileFromUri = useCallback(async (uri: string, name: string, mimeType: string) => {
    setUploading(true);
    setUploadError(null);
    try {
      const file = new File(uri);
      if (file.exists && file.size && file.size > MAX_FILE_SIZE) {
        throw new Error(`文件"${name}"超过 1GB 限制`);
      }

      const formData = new FormData();
      formData.append('files', {
        uri,
        name,
        type: mimeType || 'application/octet-stream',
      } as unknown as Blob);

      const response = await authFetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) throw new Error(`上传失败: ${response.status}`);
      const data = await response.json() as { success: boolean; error?: string; files?: UploadedFile[] };
      if (!data.success || !data.files?.[0]) throw new Error(data.error || '上传失败');

      const uploaded: UploadedFile = {
        ...data.files[0],
        previewUrl: data.files[0].isImage ? uri : undefined,
      };

      setUploadedFiles(prev => [...prev, uploaded]);
    } catch (error) {
      console.error('Upload error:', error);
      setUploadError(
        '上传失败：' + (error instanceof Error ? error.message : '未知错误'),
      );
    } finally {
      setUploading(false);
    }
  }, []);

  const pickFile = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        multiple: true,
        copyToCacheDirectory: true,
      });

      if (result.canceled || !result.assets?.length) return;

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
      console.error('Document picker error:', error);
      const message = error instanceof Error ? error.message : '系统文件选择器打开失败';
      setUploadError(`选择文件失败：${message}`);
      Alert.alert('选择文件失败', message);
    }
  }, [uploadFileFromUri]);

  const pickImage = useCallback(async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images', 'videos'],
        allowsMultipleSelection: true,
        quality: 0.8,
      });

      if (result.canceled || !result.assets?.length) return;

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
      console.error('Image picker error:', error);
    }
  }, [uploadFileFromUri]);

  const takePhoto = useCallback(async () => {
    try {
      const { status } = await ImagePicker.getCameraPermissionsAsync();
      if (status !== 'granted') {
        const { status: newStatus } = await ImagePicker.requestCameraPermissionsAsync();
        if (newStatus !== 'granted') return;
      }

      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        quality: 0.8,
      });

      if (result.canceled || !result.assets?.length) return;

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
      console.error('Camera error:', error);
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
    setUploadedFiles([]);
  }, []);

  const consumeFiles = useCallback((): UploadedFile[] => {
    const current = filesRef.current;
    setUploadedFiles([]);
    return current;
  }, []);

  const addUploadedFiles = useCallback((files: UploadedFile[]) => {
    if (!files.length) return;
    setUploadedFiles(prev => [...prev, ...files]);
  }, []);

  return {
    uploadedFiles,
    uploading,
    uploadError,
    dismissUploadError,
    pickFile,
    pickImage,
    takePhoto,
    removeFile,
    clearFiles,
    consumeFiles,
    addUploadedFiles,
  };
}
