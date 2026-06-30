/**
 * 系统级分享流程专用上传工具：把 expo-share-intent 拿到的本地 file:// path
 * 上传到服务端 /api/upload，返回 UploadedFile（与 useFileUpload 行为对齐）。
 *
 * 与 useFileUpload 保持互不耦合：那边管 picker/相机/系统图库的交互流程并维护 React state；
 * 这里只是 share-target 页面的纯函数 helper，调用方自己管 state。
 */

import { File } from 'expo-file-system';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import type { UploadedFile } from '@agent/shared';
import { authFetch } from '@agent/shared';
import type { ShareIntentFile } from 'expo-share-intent';

const HEIF_MIMES = new Set([
  'image/heif',
  'image/heic',
  'image/heif-sequence',
  'image/heic-sequence',
]);

const MAX_FILE_SIZE = 1024 * 1024 * 1024; // 1GB，与 useFileUpload 一致

export async function uploadSharedFile(file: ShareIntentFile): Promise<UploadedFile> {
  let uri = file.path;
  let name = file.fileName || `shared_${Date.now()}`;
  let mime = file.mimeType || 'application/octet-stream';

  // 大小预检
  try {
    const local = new File(uri);
    if (local.exists && local.size && local.size > MAX_FILE_SIZE) {
      throw new Error(`文件"${name}"超过 1GB 限制`);
    }
  } catch {
    // expo-file-system 偶尔抛 path 协议未识别错误（content://）；让上传环节自己再判
  }

  // HEIC/HEIF → JPEG（大模型不支持 HEIF）
  if (HEIF_MIMES.has(mime.toLowerCase())) {
    const converted = await manipulateAsync(uri, [], {
      format: SaveFormat.JPEG,
      compress: 0.8,
    });
    uri = converted.uri;
    mime = 'image/jpeg';
    name = name.replace(/\.heic$/i, '.jpg').replace(/\.heif$/i, '.jpg');
  }

  const formData = new FormData();
  formData.append('files', {
    uri,
    name,
    type: mime,
  } as unknown as Blob);

  const response = await authFetch('/api/upload', {
    method: 'POST',
    body: formData,
  });
  if (!response.ok) throw new Error(`上传失败: ${response.status}`);

  const data = (await response.json()) as {
    success: boolean;
    error?: string;
    files?: UploadedFile[];
  };
  if (!data.success || !data.files?.[0]) {
    throw new Error(data.error || '上传失败');
  }

  const uploaded = data.files[0];
  return {
    ...uploaded,
    previewUrl: uploaded.isImage ? uri : undefined,
  };
}
