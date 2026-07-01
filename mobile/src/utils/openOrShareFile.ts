import { Platform } from 'react-native';
import * as Sharing from 'expo-sharing';
import { File, Paths } from 'expo-file-system';

/**
 * Try viewDocument (QLPreviewController on iOS) first;
 * if it fails (unsupported file type like .apk), fall back to system share sheet.
 */
export async function openOrShareFile(uri: string): Promise<void> {
  try {
    const { viewDocument } = await import('@react-native-documents/viewer');
    await viewDocument({ uri });
  } catch {
    // QLPreviewController doesn't support this file type — use share sheet
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(uri, {
        UTI: Platform.OS === 'ios' ? 'public.data' : undefined,
      });
    } else {
      throw new Error('当前设备不支持预览或分享此文件类型');
    }
  }
}

/**
 * 从远程 URL（如 artifact 签名 URL）拉到应用 cache 目录后走 openOrShareFile。
 * 避免 iOS QLPreviewController 直接吃 http URL 的兼容性问题,同时保留
 * 「预览失败自动 fallback 分享」的语义。fileName 用于本地落盘名（保留扩展名
 * 让预览器识别文件类型）。
 */
export async function openOrShareUrl(url: string, fileName: string): Promise<void> {
  const safeName = fileName.replace(/[^\w.\-]/g, '_') || 'artifact.bin';
  const target = new File(Paths.cache, `${Date.now()}-${safeName}`);
  const downloaded = await File.downloadFileAsync(url, target);
  await openOrShareFile(downloaded.uri);
}
