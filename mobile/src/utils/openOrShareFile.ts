import { Platform } from 'react-native';
import * as Sharing from 'expo-sharing';

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
