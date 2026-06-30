import fs from 'fs';
import path from 'path';
import type { DingtalkCredentials } from '../../../../integrations/dingtalk/mediaApi.js';
import { dingtalkLogger } from '../../../../utils/logger.js';
import {
  appendStatusMessages,
  MediaTarget,
  sendVideoProactive,
  toLocalPath,
  type VideoMetadata,
  uploadMediaToDingTalk,
} from './common.js';
import { parseVideoMarkerMatches } from './markerParser.js';

async function extractVideoMetadata(filePath: string): Promise<VideoMetadata | null> {
  try {
    const ffmpeg = (await import('fluent-ffmpeg')).default;
    const ffmpegPath = (await import('@ffmpeg-installer/ffmpeg')).path;
    ffmpeg.setFfmpegPath(ffmpegPath);

    return new Promise((resolve) => {
      ffmpeg.ffprobe(filePath, (err: any, metadata: any) => {
        if (err) {
          dingtalkLogger.error(`[Media][video] ffprobe 失败: ${err.message}`);
          resolve(null);
          return;
        }
        const videoStream = metadata.streams?.find((s: any) => s.codec_type === 'video');
        resolve({
          duration: Math.floor(metadata.format?.duration || 0),
          width: videoStream?.width || 0,
          height: videoStream?.height || 0,
        });
      });
    });
  } catch (err: any) {
    dingtalkLogger.error(`[Media][video] ffmpeg 模块加载失败: ${err.message}`);
    return null;
  }
}

async function extractVideoThumbnail(
  videoPath: string,
  outputPath: string,
): Promise<string | null> {
  try {
    const ffmpeg = (await import('fluent-ffmpeg')).default;
    const ffmpegPath = (await import('@ffmpeg-installer/ffmpeg')).path;
    ffmpeg.setFfmpegPath(ffmpegPath);

    return new Promise((resolve) => {
      ffmpeg(videoPath)
        .screenshots({
          count: 1,
          folder: path.dirname(outputPath),
          filename: path.basename(outputPath),
          timemarks: ['1'],
          size: '?x360',
        })
        .on('end', () => resolve(outputPath))
        .on('error', (err: any) => {
          dingtalkLogger.error(`[Media][video] 封面截取失败: ${err.message}`);
          resolve(null);
        });
    });
  } catch {
    return null;
  }
}

export async function processVideoMarkers(
  content: string,
  credentials: DingtalkCredentials,
  sessionWebhook?: string,
  target?: MediaTarget,
): Promise<string> {
  const matches = parseVideoMarkerMatches(content);
  if (matches.length === 0) return content;

  let result = content;
  const statusMessages: string[] = [];

  for (const match of matches) {
    try {
      const videoInfo = JSON.parse(match.payload) as { path: string };
      const absPath = toLocalPath(videoInfo.path);

      if (!fs.existsSync(absPath)) {
        statusMessages.push(`视频文件不存在: ${path.basename(absPath)}`);
        result = result.replace(match.fullMatch, '');
        continue;
      }

      const metadata = await extractVideoMetadata(absPath);
      if (!metadata) {
        statusMessages.push(`视频处理失败: ${path.basename(absPath)}（无法读取视频信息）`);
        result = result.replace(match.fullMatch, '');
        continue;
      }

      const thumbnailPath = path.join(path.dirname(absPath), `thumb_${Date.now()}.jpg`);
      const thumbnail = await extractVideoThumbnail(absPath, thumbnailPath);

      const videoMediaId = await uploadMediaToDingTalk(absPath, 'video', credentials);
      if (!videoMediaId) {
        statusMessages.push(`视频上传失败: ${path.basename(absPath)}（文件可能超过 20MB）`);
        result = result.replace(match.fullMatch, '');
        continue;
      }

      let picMediaId: string | null = null;
      if (thumbnail) {
        picMediaId = await uploadMediaToDingTalk(thumbnail, 'image', credentials);
        try {
          fs.unlinkSync(thumbnail);
        } catch (e: any) {
          dingtalkLogger.warn(`[Media][video] 封面临时文件删除失败: ${e.message}`);
        }
      }

      if (target) {
        await sendVideoProactive(credentials, target, videoMediaId, picMediaId, metadata);
      }

      statusMessages.push(`视频已发送: ${path.basename(absPath)}`);
      result = result.replace(match.fullMatch, '');
    } catch (err: any) {
      dingtalkLogger.error(`[Media][video] 处理失败: ${err.message}`);
      result = result.replace(match.fullMatch, '');
    }
  }

  return appendStatusMessages(result, statusMessages);
}
