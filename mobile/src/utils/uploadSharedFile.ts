/**
 * 系统级分享流程专用上传工具：把 expo-share-intent 的内存选择结果
 * 上传到服务端 /api/upload，返回 UploadedFile（与 useFileUpload 行为对齐）。
 *
 * 与 useFileUpload 保持互不耦合：那边管 picker/相机/系统图库的交互流程并维护 React state；
 * 这里只是 share-target 页面的纯函数 helper，调用方自己管 state。
 */

import { File } from 'expo-file-system';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import type { UploadedFile } from '@agent/shared';
import { authFetch, validateAttachmentSelection } from '@agent/shared';
import type { ShareIntentFile } from 'expo-share-intent';
import { validateMobileUploadedFiles } from '../lib/chatSubmissionAdapter';

const HEIF_MIMES = new Set([
  'image/heif',
  'image/heic',
  'image/heif-sequence',
  'image/heic-sequence',
]);

export async function uploadSharedFile(file: ShareIntentFile): Promise<UploadedFile> {
  let uri = file.path;
  let name = file.fileName || `shared_${Date.now()}`;
  let mime = file.mimeType || 'application/octet-stream';

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

  const local = new File(uri);
  const size = local.exists && typeof local.size === 'number' ? local.size : 0;
  const selection = validateAttachmentSelection([{ name, size, mimeType: mime }]);
  if (!selection.ok) throw new Error(selection.issue.message);

  const formData = new FormData();
  formData.append('files', {
    uri,
    name,
    type: mime,
  } as unknown as Blob);

  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (!crypto?.randomUUID) throw new Error('设备安全随机数能力不可用');
  const response = await authFetch('/api/upload', {
    method: 'POST',
    headers: { 'X-Upload-Request-Id': crypto.randomUUID() },
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
  const validation = validateMobileUploadedFiles([uploaded]);
  if (!validation.ok) throw new Error(validation.issue.message);
  return {
    ...uploaded,
    attachmentId: validation.value[0].attachmentId,
  };
}
