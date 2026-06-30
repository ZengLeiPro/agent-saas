/**
 * 图片格式归一化工具
 *
 * iOS 拍照默认输出 HEIC/HEIF，许多后端或对象存储上传链路
 * 不接受这些格式，必须转 JPEG 再上传。
 */

import { manipulateAsync, SaveFormat } from "expo-image-manipulator";

export const HEIF_MIMES = new Set([
  "image/heif",
  "image/heic",
  "image/heif-sequence",
  "image/heic-sequence",
]);

export interface NormalizedImage {
  uri: string;
  mime: string;
  name: string;
}

/**
 * 若文件是 HEIC/HEIF，转成 JPEG；否则原样返回。
 *
 * compress=0.8 与现有 useFileUpload.ts 保持一致；视频/非图片直接原样返回。
 */
export async function normalizeImageIfNeeded(
  uri: string,
  mime: string,
  name: string,
): Promise<NormalizedImage> {
  const lower = (mime || "").toLowerCase();
  if (!HEIF_MIMES.has(lower)) {
    return { uri, mime, name };
  }
  const converted = await manipulateAsync(uri, [], {
    format: SaveFormat.JPEG,
    compress: 0.8,
  });
  return {
    uri: converted.uri,
    mime: "image/jpeg",
    name: name.replace(/\.heic$/i, ".jpg").replace(/\.heif$/i, ".jpg"),
  };
}
