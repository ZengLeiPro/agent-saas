import fs from 'fs';
import path from 'path';
import { uploadMediaWithCredentials, type DingtalkCredentials } from '../../../../integrations/dingtalk/mediaApi.js';
import { sendRawRobotMessage } from '../../../../integrations/dingtalk/proactiveMessageApi.js';
import { dingtalkLogger } from '../../../../utils/logger.js';
import {
  AUDIO_EXTENSIONS,
  DEFAULT_MAX_FILE_SIZE,
} from '../../../../integrations/dingtalk/constants.js';

export interface FileInfo {
  path: string;
  fileName: string;
  fileType: string;
}

export interface VideoMetadata {
  duration: number;
  width: number;
  height: number;
}

export type MediaTarget =
  | { type: 'user'; userId: string }
  | { type: 'group'; openConversationId: string };

export function toLocalPath(raw: string): string {
  let p = raw;
  if (p.startsWith('file:///')) p = p.slice(7);
  else if (p.startsWith('file://')) p = p.slice(7);
  else if (p.startsWith('MEDIA:')) p = p.slice(6);
  else if (p.startsWith('attachment:///')) p = p.slice(14);
  else if (p.startsWith('attachment://')) p = p.slice(13);
  try {
    p = decodeURIComponent(p);
  } catch {
    // 解码失败保持原样
  }
  p = p.replace(/\\ /g, ' ');

  const resolved = path.resolve(p);
  if (resolved !== path.normalize(p) || p.includes('..')) {
    dingtalkLogger.warn(`[Media] 拒绝可疑路径: ${raw}`);
    return '';
  }

  try {
    const realPath = fs.realpathSync(p);
    if (realPath !== resolved) {
      dingtalkLogger.warn(`[Media] 拒绝符号链接路径: ${raw} -> ${realPath}`);
      return '';
    }
  } catch {
    // 文件不存在时跳过检查（后续会在 fs.existsSync 中处理）
  }

  return p;
}

export function isAudioFile(ext: string): boolean {
  return AUDIO_EXTENSIONS.includes(ext.toLowerCase());
}

export async function uploadMediaToDingTalk(
  filePath: string,
  mediaType: 'image' | 'file' | 'video' | 'voice',
  credentials: DingtalkCredentials,
  maxSize: number = DEFAULT_MAX_FILE_SIZE,
): Promise<string | null> {
  try {
    const absPath = toLocalPath(filePath);

    if (!fs.existsSync(absPath)) {
      dingtalkLogger.warn(`[Media][${mediaType}] 文件不存在: ${absPath}`);
      return null;
    }

    const stats = fs.statSync(absPath);
    if (stats.size > maxSize) {
      const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
      dingtalkLogger.warn(`[Media][${mediaType}] 文件过大: ${fileSizeMB}MB`);
      return null;
    }

    const mediaId = await uploadMediaWithCredentials(absPath, mediaType, credentials);
    return mediaId;
  } catch (err: any) {
    dingtalkLogger.error(`[Media][${mediaType}] 上传失败: ${err.message}`);
    return null;
  }
}

export function appendStatusMessages(result: string, statusMessages: string[]): string {
  if (statusMessages.length === 0) {
    return result;
  }

  let merged = result.trim();
  if (merged) {
    merged += '\n\n';
  }
  merged += statusMessages.join('\n');
  return merged;
}

export async function sendProactiveMediaMessage(
  msgKey: string,
  credentials: DingtalkCredentials,
  target: MediaTarget,
  msgParam: Record<string, any>,
): Promise<void> {
  const proactiveTarget = target.type === 'group'
    ? { type: 'group' as const, openConversationId: target.openConversationId }
    : { type: 'user' as const, userId: target.userId };
  const sendResult = await sendRawRobotMessage(
    credentials,
    proactiveTarget,
    { msgKey, msgParam },
  );
  if (!sendResult.ok) {
    dingtalkLogger.error(`[Media] 主动发送失败 (${msgKey}): ${sendResult.error}`);
  }
}

export async function sendVideoProactive(
  credentials: DingtalkCredentials,
  target: MediaTarget,
  videoMediaId: string,
  picMediaId: string | null,
  metadata: VideoMetadata,
): Promise<void> {
  const msgParam: any = {
    duration: metadata.duration.toString(),
    videoMediaId,
    videoType: 'mp4',
  };
  if (picMediaId) msgParam.picMediaId = picMediaId;

  await sendProactiveMediaMessage('sampleVideo', credentials, target, msgParam);
}

export async function getAudioDurationMs(filePath: string): Promise<number> {
  try {
    const ffmpeg = (await import('fluent-ffmpeg')).default;
    const ffmpegPath = (await import('@ffmpeg-installer/ffmpeg')).path;
    ffmpeg.setFfmpegPath(ffmpegPath);

    return new Promise((resolve) => {
      ffmpeg.ffprobe(filePath, (err: any, metadata: any) => {
        if (err || !metadata?.format?.duration) {
          resolve(60000);
          return;
        }
        resolve(Math.floor(metadata.format.duration * 1000));
      });
    });
  } catch {
    return 60000;
  }
}

export async function sendAudioProactive(
  credentials: DingtalkCredentials,
  target: MediaTarget,
  mediaId: string,
  durationMs: number = 60000,
): Promise<void> {
  await sendProactiveMediaMessage('sampleAudio', credentials, target, {
    mediaId,
    duration: String(durationMs),
  });
}

export async function sendFileProactive(
  credentials: DingtalkCredentials,
  target: MediaTarget,
  fileInfo: FileInfo,
  mediaId: string,
): Promise<void> {
  await sendProactiveMediaMessage('sampleFile', credentials, target, {
    mediaId,
    fileName: fileInfo.fileName,
    fileType: fileInfo.fileType,
  });
}
