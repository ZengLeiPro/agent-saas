import fs from 'fs';
import path from 'path';
import type { DingtalkCredentials } from '../../../../integrations/dingtalk/mediaApi.js';
import { dingtalkLogger } from '../../../../utils/logger.js';
import {
  appendStatusMessages,
  getAudioDurationMs,
  MediaTarget,
  sendAudioProactive,
  toLocalPath,
  uploadMediaToDingTalk,
} from './common.js';
import { parseAudioMarkerMatches } from './markerParser.js';

export async function processAudioMarkers(
  content: string,
  credentials: DingtalkCredentials,
  sessionWebhook?: string,
  target?: MediaTarget,
): Promise<string> {
  const matches = parseAudioMarkerMatches(content);
  if (matches.length === 0) return content;

  let result = content;
  const statusMessages: string[] = [];

  for (const match of matches) {
    try {
      const audioInfo = JSON.parse(match.payload) as { path: string };
      const absPath = toLocalPath(audioInfo.path);

      if (!fs.existsSync(absPath)) {
        statusMessages.push(`音频文件不存在: ${path.basename(absPath)}`);
        result = result.replace(match.fullMatch, '');
        continue;
      }

      const mediaId = await uploadMediaToDingTalk(absPath, 'voice', credentials);
      if (!mediaId) {
        statusMessages.push(`音频上传失败: ${path.basename(absPath)}`);
        result = result.replace(match.fullMatch, '');
        continue;
      }

      if (target) {
        const durationMs = await getAudioDurationMs(absPath);
        await sendAudioProactive(credentials, target, mediaId, durationMs);
      }

      statusMessages.push(`音频已发送: ${path.basename(absPath)}`);
      result = result.replace(match.fullMatch, '');
    } catch (err: any) {
      dingtalkLogger.error(`[Media][audio] 处理失败: ${err.message}`);
      result = result.replace(match.fullMatch, '');
    }
  }

  return appendStatusMessages(result, statusMessages);
}
