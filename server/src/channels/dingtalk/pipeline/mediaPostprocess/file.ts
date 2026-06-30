import fs from 'fs';
import type { DingtalkCredentials } from '../../../../integrations/dingtalk/mediaApi.js';
import { dingtalkLogger } from '../../../../utils/logger.js';
import { DEFAULT_MAX_FILE_SIZE } from '../../../../integrations/dingtalk/constants.js';
import {
  appendStatusMessages,
  FileInfo,
  getAudioDurationMs,
  isAudioFile,
  MediaTarget,
  sendAudioProactive,
  sendFileProactive,
  toLocalPath,
  uploadMediaToDingTalk,
} from './common.js';
import { parseFileMarkerMatches } from './markerParser.js';

export async function processFileMarkers(
  content: string,
  credentials: DingtalkCredentials,
  sessionWebhook?: string,
  target?: MediaTarget,
  maxFileSize: number = DEFAULT_MAX_FILE_SIZE,
): Promise<string> {
  const matches = parseFileMarkerMatches(content);
  if (matches.length === 0) return content;

  let result = content;
  const statusMessages: string[] = [];

  for (const match of matches) {
    try {
      const fileInfo = JSON.parse(match.payload) as FileInfo;
      const absPath = toLocalPath(fileInfo.path);

      if (!fs.existsSync(absPath)) {
        statusMessages.push(`文件不存在: ${fileInfo.fileName}`);
        result = result.replace(match.fullMatch, '');
        continue;
      }

      const stats = fs.statSync(absPath);
      if (stats.size > maxFileSize) {
        const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(1);
        const limitMB = (maxFileSize / (1024 * 1024)).toFixed(0);
        statusMessages.push(`文件过大: ${fileInfo.fileName}（${fileSizeMB}MB，限制 ${limitMB}MB）`);
        result = result.replace(match.fullMatch, '');
        continue;
      }

      if (isAudioFile(fileInfo.fileType)) {
        const mediaId = await uploadMediaToDingTalk(absPath, 'voice', credentials);
        if (mediaId && target) {
          const durationMs = await getAudioDurationMs(absPath);
          await sendAudioProactive(credentials, target, mediaId, durationMs);
          statusMessages.push(`音频已发送: ${fileInfo.fileName}`);
        }
      } else {
        const mediaId = await uploadMediaToDingTalk(absPath, 'file', credentials);
        if (mediaId && target) {
          await sendFileProactive(credentials, target, fileInfo, mediaId);
          statusMessages.push(`文件已发送: ${fileInfo.fileName}`);
        }
      }

      result = result.replace(match.fullMatch, '');
    } catch (err: any) {
      dingtalkLogger.error(`[Media][file] 处理失败: ${err.message}`);
      result = result.replace(match.fullMatch, '');
    }
  }

  return appendStatusMessages(result, statusMessages);
}
