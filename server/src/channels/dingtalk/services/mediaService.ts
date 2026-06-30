import fs from 'fs';
import os from 'os';
import path from 'path';
import type { DingtalkRobotConfig, UploadedFileInfo } from '../../../types/index.js';
import type { DingtalkMessageContext } from '../types.js';
import { downloadMedia, type DingtalkCredentials } from '../../../integrations/dingtalk/mediaApi.js';
import { dingtalkLogger } from '../../../utils/logger.js';

const INBOUND_IMAGE_FILE_PREFIX = 'dingtalk_inbound_';

const SUPPORTED_INBOUND_TYPES = ['picture', 'file', 'audio'];

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];

// 同步读取仅 4 字节文件头，开销极小，无需改为异步
function detectImageMimeType(filePath: string): string {
  const head = Buffer.alloc(4);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, head, 0, 4, 0);
  } finally {
    fs.closeSync(fd);
  }

  if (head[0] === 0x89 && head[1] === 0x50) return 'image/png';
  if (head[0] === 0x47 && head[1] === 0x49) return 'image/gif';
  if (head[0] === 0x52 && head[1] === 0x49) return 'image/webp';
  return 'image/jpeg';
}

function createTempImagePath(): string {
  return path.join(
    os.tmpdir(),
    `${INBOUND_IMAGE_FILE_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`,
  );
}

function guessMimeType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase().slice(1);
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain',
    csv: 'text/csv',
    json: 'application/json',
    zip: 'application/zip',
    rar: 'application/x-rar-compressed',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    amr: 'audio/amr',
    mp4: 'video/mp4',
  };
  return map[ext] || 'application/octet-stream';
}

function sanitizeFileName(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, '_');
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

export class DingtalkMediaService {
  private readonly dingtalkUploadsDir?: string;

  constructor(options?: { uploadsDir?: string }) {
    if (options?.uploadsDir) {
      this.dingtalkUploadsDir = path.join(options.uploadsDir, 'dingtalk');
      if (!fs.existsSync(this.dingtalkUploadsDir)) {
        fs.mkdirSync(this.dingtalkUploadsDir, { recursive: true });
      }
    }
  }

  resolveRobotCredentials(
    robotConfig?: Pick<DingtalkRobotConfig, 'appKey' | 'appSecret'>,
  ): DingtalkCredentials | undefined {
    if (!robotConfig?.appKey || !robotConfig?.appSecret) {
      return undefined;
    }
    return { appKey: robotConfig.appKey, appSecret: robotConfig.appSecret };
  }

  async downloadInboundAttachments(
    ctx: Pick<DingtalkMessageContext, 'downloadCode' | 'msgtype' | 'fileName' | 'fileType'>,
    robotConfig?: Pick<DingtalkRobotConfig, 'appKey' | 'appSecret'>,
  ): Promise<UploadedFileInfo[]> {
    const credentials = this.resolveRobotCredentials(robotConfig);
    if (!credentials || !ctx.downloadCode || !SUPPORTED_INBOUND_TYPES.includes(ctx.msgtype || '')) {
      return [];
    }

    try {
      if (ctx.msgtype === 'picture') {
        return await this.downloadPicture(ctx.downloadCode, credentials);
      }

      if (ctx.msgtype === 'file') {
        return await this.downloadFile(ctx.downloadCode, credentials, ctx.fileName, ctx.fileType);
      }

      if (ctx.msgtype === 'audio') {
        return await this.downloadAudio(ctx.downloadCode, credentials);
      }

      return [];
    } catch (err: any) {
      dingtalkLogger.error(`[Media] 入站媒体下载失败 (${ctx.msgtype}): ${err.message}`);
      return [];
    }
  }

  private async downloadPicture(downloadCode: string, credentials: DingtalkCredentials): Promise<UploadedFileInfo[]> {
    const destPath = createTempImagePath();
    const ok = await downloadMedia(downloadCode, credentials, destPath);
    if (!ok || !fs.existsSync(destPath)) {
      return [];
    }

    const stat = fs.statSync(destPath);
    const mimeType = detectImageMimeType(destPath);
    const attachment: UploadedFileInfo = {
      originalName: `dingtalk_image.${mimeType.split('/')[1]}`,
      savedPath: destPath,
      relativePath: destPath,
      size: stat.size,
      mimeType,
      isImage: true,
    };

    dingtalkLogger.info(`[Media] 入站图片已下载: ${destPath} (${(stat.size / 1024).toFixed(1)} KB, ${mimeType})`);
    return [attachment];
  }

  private async downloadFile(
    downloadCode: string,
    credentials: DingtalkCredentials,
    fileName?: string,
    fileType?: string,
  ): Promise<UploadedFileInfo[]> {
    if (!this.dingtalkUploadsDir) {
      dingtalkLogger.warn('[Media] uploadsDir 未配置，无法保存文件');
      return [];
    }

    const safeName = sanitizeFileName(fileName || `file_${randomSuffix()}.${fileType || 'bin'}`);
    const destPath = path.join(this.dingtalkUploadsDir, `${Date.now()}_${safeName}`);
    const ok = await downloadMedia(downloadCode, credentials, destPath);
    if (!ok || !fs.existsSync(destPath)) {
      return [];
    }

    const stat = fs.statSync(destPath);
    const mimeType = guessMimeType(safeName);
    const ext = path.extname(safeName).toLowerCase().slice(1);
    const isImage = IMAGE_EXTENSIONS.includes(ext);

    const attachment: UploadedFileInfo = {
      originalName: fileName || safeName,
      savedPath: destPath,
      relativePath: destPath,
      size: stat.size,
      mimeType,
      isImage,
    };

    dingtalkLogger.info(`[Media] 入站文件已下载: ${destPath} (${(stat.size / 1024).toFixed(1)} KB, ${mimeType})`);
    return [attachment];
  }

  private async downloadAudio(downloadCode: string, credentials: DingtalkCredentials): Promise<UploadedFileInfo[]> {
    if (!this.dingtalkUploadsDir) {
      dingtalkLogger.warn('[Media] uploadsDir 未配置，无法保存语音');
      return [];
    }

    const destPath = path.join(this.dingtalkUploadsDir, `voice_${Date.now()}_${randomSuffix()}.amr`);
    const ok = await downloadMedia(downloadCode, credentials, destPath);
    if (!ok || !fs.existsSync(destPath)) {
      return [];
    }

    const stat = fs.statSync(destPath);
    const attachment: UploadedFileInfo = {
      originalName: `voice_${Date.now()}.amr`,
      savedPath: destPath,
      relativePath: destPath,
      size: stat.size,
      mimeType: 'audio/amr',
      isImage: false,
    };

    dingtalkLogger.info(`[Media] 入站语音已下载: ${destPath} (${(stat.size / 1024).toFixed(1)} KB)`);
    return [attachment];
  }
}

export type { DingtalkCredentials };
