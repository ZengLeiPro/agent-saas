import { createHash, randomUUID } from 'crypto';
import { constants } from 'fs';
import { copyFile, lstat, mkdir, open, readdir, realpath, stat, writeFile } from 'fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'path';

import { createCanvas, loadImage } from '@napi-rs/canvas';

import type { InboundMessage, UploadedFileInfo } from '../types/index.js';
import type {
  ModelAttachmentRef,
  ModelImageMimeType,
  ModelUserContent,
  ModelUserContentPart,
  ModelVisionAnalysis,
} from './types.js';

const MAX_ATTACHMENTS_PER_TURN = 10;
const MAX_IMAGE_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_TOTAL_BYTES = 40 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_IMAGE_SIDE = 2_048;
const MAX_MODEL_IMAGE_BYTES = 5 * 1024 * 1024;
const NORMALIZATION_VERSION = 'v1';
const RETAIN_IMAGE_TURNS = 3;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ImageDimensions = { width: number; height: number };

export interface ResolveAttachmentOptions {
  cwd: string;
  channel: InboundMessage['channel'];
}

export async function resolveInboundAttachments(
  attachments: readonly UploadedFileInfo[] | undefined,
  options: ResolveAttachmentOptions,
): Promise<ModelAttachmentRef[]> {
  if (!attachments?.length) return [];
  if (attachments.length > MAX_ATTACHMENTS_PER_TURN) {
    throw new Error(`UPLOAD_REJECTED: 单条消息最多 ${MAX_ATTACHMENTS_PER_TURN} 个附件`);
  }

  const uploadsRoot = resolve(options.cwd, 'uploads');
  await mkdir(uploadsRoot, { recursive: true, mode: 0o700 });
  const canonicalCwd = await realpath(options.cwd);
  const canonicalUploadsRoot = await realpath(uploadsRoot);
  const resolved: ModelAttachmentRef[] = [];
  let totalImageBytes = 0;

  for (const inbound of attachments) {
    const attachmentId = normalizeAttachmentId(inbound.attachmentId);
    let sourcePath = await resolveInboundSourcePath(inbound, {
      ...options,
      uploadsRoot: canonicalUploadsRoot,
    });
    if (!isPathInside(canonicalUploadsRoot, sourcePath)) {
      const stagedName = `${attachmentId}_${safeDisplayName(inbound.originalName || basename(sourcePath))}`;
      const stagedPath = resolve(canonicalUploadsRoot, stagedName);
      await copyFile(sourcePath, stagedPath);
      sourcePath = stagedPath;
    }
    const claimedImage = inbound.isImage || String(inbound.mimeType || '').startsWith('image/');
    const source = await readRegularFileNoFollow(sourcePath, MAX_IMAGE_SOURCE_BYTES);
    if (claimedImage && source.size > MAX_IMAGE_SOURCE_BYTES) {
      throw new Error('UPLOAD_REJECTED: 图片大小超过平台限制（单图 20MB、单条消息合计 40MB）');
    }
    const sourceBytes = source.bytes;
    const detectedMime = sourceBytes ? detectImageMime(sourceBytes) : undefined;
    if (claimedImage && !detectedMime) {
      throw new Error(`UPLOAD_REJECTED: ${safeDisplayName(inbound.originalName)} 不是有效的受支持图片`);
    }

    const originalName = safeDisplayName(inbound.originalName || basename(sourcePath));
    if (!detectedMime) {
      resolved.push({
        attachmentId,
        originalName,
        relativePath: workspaceRelativePath(canonicalCwd, sourcePath),
        sizeBytes: source.size,
        mimeType: safeNonImageMime(inbound.mimeType),
        isImage: false,
      });
      continue;
    }

    totalImageBytes += source.size;
    if (source.size > MAX_IMAGE_SOURCE_BYTES || totalImageBytes > MAX_IMAGE_TOTAL_BYTES) {
      throw new Error('UPLOAD_REJECTED: 图片大小超过平台限制（单图 20MB、单条消息合计 40MB）');
    }
    if (!sourceBytes) throw new Error('UPLOAD_REJECTED: 图片读取失败');

    const normalized = await normalizeImage(sourceBytes, detectedMime, options.cwd);
    resolved.push({
      attachmentId,
      originalName,
      relativePath: workspaceRelativePath(canonicalCwd, sourcePath),
      sizeBytes: source.size,
      mimeType: detectedMime,
      isImage: true,
      sha256: normalized.sha256,
      width: normalized.width,
      height: normalized.height,
      modelRelativePath: normalized.relativePath,
      modelMimeType: normalized.mimeType,
      modelSizeBytes: normalized.sizeBytes,
    });
  }

  return resolved;
}

export function buildModelUserContent(
  text: string,
  attachments: readonly ModelAttachmentRef[] | undefined,
  visionAnalysis?: ModelVisionAnalysis,
): ModelUserContent {
  const images = (attachments ?? []).filter((item) => item.isImage && item.modelRelativePath && item.modelMimeType);
  if (images.length === 0) return text;

  const parts: ModelUserContentPart[] = [];
  if (images.length === 1) {
    parts.push(toImagePart(images[0]));
  } else {
    for (let index = 0; index < images.length; index++) {
      const image = images[index];
      parts.push({ type: 'text', text: `[附件图片 ${index + 1}：${image.originalName}]` });
      parts.push(toImagePart(image));
    }
  }
  if (visionAnalysis) {
    parts.push({
      type: 'vision_summary',
      model: visionAnalysis.model,
      attachmentIds: visionAnalysis.attachmentIds,
      text: visionAnalysis.content,
    });
  }
  parts.push({ type: 'text', text });
  return parts;
}

export function pruneHistoricalImageContent(
  events: readonly { type: string; attachments?: ModelAttachmentRef[] }[],
): Set<number> {
  const imageTurnIndices = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === 'user_message' && event.attachments?.some((item) => item.isImage))
    .map(({ index }) => index);
  return new Set(imageTurnIndices.slice(0, Math.max(0, imageTurnIndices.length - RETAIN_IMAGE_TURNS)));
}

export function buildPrunedHistoricalUserContent(
  text: string,
  attachments: readonly ModelAttachmentRef[] | undefined,
): string {
  const ids = (attachments ?? []).filter((item) => item.isImage).map((item) => item.attachmentId);
  if (ids.length === 0) return text;
  return `${text}\n\n[历史图片已从活跃视觉上下文移除；附件引用仍保留：${ids.join(', ')}。如任务必须重新查看，请让用户重新附图。]`;
}

export async function readModelImageDataUrl(
  cwd: string,
  part: Extract<ModelUserContentPart, { type: 'image_attachment' }>,
): Promise<string> {
  const absolutePath = await resolveTrustedWorkspaceFile(cwd, part.relativePath);
  const file = (await readRegularFileNoFollow(absolutePath)).bytes!;
  if (file.byteLength !== part.sizeBytes) {
    throw new Error(`ATTACHMENT_MISSING: 规范化图片字节数发生变化 attachmentId=${part.attachmentId}`);
  }
  const detected = detectImageMime(file);
  if (detected !== part.mimeType) {
    throw new Error(`PROVIDER_IMAGE_REJECTED: 图片 MIME 校验失败 attachmentId=${part.attachmentId}`);
  }
  return `data:${part.mimeType};base64,${file.toString('base64')}`;
}

export function modelSupportsImage(inputModalities: readonly string[] | undefined): boolean {
  return inputModalities?.includes('image') === true;
}

export function toTextOnlyContent(content: ModelUserContent): string {
  if (typeof content === 'string') return content;
  const summaries = content.filter((part): part is Extract<ModelUserContentPart, { type: 'vision_summary' }> => (
    part.type === 'vision_summary'
  ));
  const textParts = content
    .filter((part): part is Extract<ModelUserContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text);
  const imageIds = content
    .filter((part): part is Extract<ModelUserContentPart, { type: 'image_attachment' }> => part.type === 'image_attachment')
    .map((part) => part.attachmentId);
  if (summaries.length > 0) {
    const summaryText = summaries.map((summary) => (
      `[以下内容由辅助视觉模型 ${summary.model} 根据附件 ${summary.attachmentIds.join(', ')} 生成，可能有信息损失]\n${summary.text}`
    )).join('\n\n');
    return [...textParts, summaryText].filter(Boolean).join('\n\n');
  }
  if (imageIds.length > 0) {
    return [...textParts, `[图片内容已省略：当前模型不支持 image input；附件引用=${imageIds.join(', ')}]`]
      .filter(Boolean)
      .join('\n\n');
  }
  return textParts.join('\n\n');
}

async function resolveInboundSourcePath(
  inbound: UploadedFileInfo,
  options: ResolveAttachmentOptions & { uploadsRoot: string },
): Promise<string> {
  if (options.channel === 'web') {
    if (inbound.attachmentId && UUID_PATTERN.test(inbound.attachmentId)) {
      const matches = (await readdir(options.uploadsRoot))
        .filter((name) => name.startsWith(`${inbound.attachmentId}_`));
      if (matches.length !== 1) {
        throw new Error('ATTACHMENT_FORBIDDEN: 附件标识无效或不属于当前工作区');
      }
      return await resolveTrustedWorkspaceFile(options.cwd, `uploads/${matches[0]}`);
    }
    return await resolveTrustedWorkspaceFile(options.cwd, inbound.relativePath);
  }

  if (options.channel === 'dingtalk' && inbound.savedPath && isAbsolute(inbound.savedPath)) {
    const canonical = await realpath(inbound.savedPath);
    const fileStat = await stat(canonical);
    if (!fileStat.isFile()) throw new Error('UPLOAD_REJECTED: 钉钉附件不是普通文件');
    return canonical;
  }
  return await resolveTrustedWorkspaceFile(options.cwd, inbound.relativePath);
}

async function resolveTrustedWorkspaceFile(cwd: string, relativePath: string): Promise<string> {
  if (!relativePath || isAbsolute(relativePath) || relativePath.includes('\0') || relativePath.includes('\\')) {
    throw new Error('ATTACHMENT_FORBIDDEN: 附件路径格式非法');
  }
  const uploadsPath = resolve(cwd, 'uploads');
  const candidate = resolve(cwd, relativePath);
  if (!isPathInside(uploadsPath, candidate)) {
    throw new Error('ATTACHMENT_FORBIDDEN: 附件不在当前用户 uploads 目录');
  }
  const fileInfo = await lstat(candidate);
  if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) {
    throw new Error('ATTACHMENT_FORBIDDEN: 附件不是普通文件');
  }
  const uploadsRoot = await realpath(uploadsPath);
  const canonical = await realpath(candidate);
  if (!isPathInside(uploadsRoot, canonical)) {
    throw new Error('ATTACHMENT_FORBIDDEN: 附件真实路径越出当前用户 uploads 目录');
  }
  return canonical;
}

async function normalizeImage(
  source: Buffer,
  sourceMime: ModelImageMimeType,
  cwd: string,
): Promise<{
  relativePath: string;
  mimeType: ModelImageMimeType;
  sizeBytes: number;
  sha256: string;
  width: number;
  height: number;
}> {
  const sourceSha = createHash('sha256').update(source).digest('hex');
  const headerDimensions = readImageDimensions(source, sourceMime);
  if (!headerDimensions || headerDimensions.width <= 0 || headerDimensions.height <= 0) {
    throw new Error('UPLOAD_REJECTED: 无法在解码前验证图片尺寸');
  }
  if (headerDimensions.width * headerDimensions.height > MAX_IMAGE_PIXELS) {
    throw new Error(`UPLOAD_REJECTED: 图片像素超过 ${MAX_IMAGE_PIXELS.toLocaleString()} 上限`);
  }

  let decoded: Awaited<ReturnType<typeof loadImage>>;
  try {
    decoded = await loadImage(source);
  } catch {
    throw new Error('UPLOAD_REJECTED: 图片无法完整解码或文件已损坏');
  }
  const width = decoded.width;
  const height = decoded.height;
  if (!width || !height || width * height > MAX_IMAGE_PIXELS) {
    throw new Error(`UPLOAD_REJECTED: 图片尺寸非法或像素超过 ${MAX_IMAGE_PIXELS.toLocaleString()} 上限`);
  }

  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(width, height));
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  const canvas = createCanvas(targetWidth, targetHeight);
  const context = canvas.getContext('2d');
  const preferJpeg = sourceMime === 'image/jpeg';
  if (preferJpeg) {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, targetWidth, targetHeight);
  }
  context.drawImage(decoded, 0, 0, targetWidth, targetHeight);

  let mimeType: ModelImageMimeType = preferJpeg ? 'image/jpeg' : 'image/png';
  let encoded = preferJpeg
    ? canvas.toBuffer('image/jpeg', 0.88)
    : canvas.toBuffer('image/png');
  if (encoded.byteLength > MAX_MODEL_IMAGE_BYTES) {
    const jpegCanvas = createCanvas(targetWidth, targetHeight);
    const jpegContext = jpegCanvas.getContext('2d');
    jpegContext.fillStyle = '#ffffff';
    jpegContext.fillRect(0, 0, targetWidth, targetHeight);
    jpegContext.drawImage(decoded, 0, 0, targetWidth, targetHeight);
    mimeType = 'image/jpeg';
    for (const quality of [0.85, 0.7, 0.55]) {
      encoded = jpegCanvas.toBuffer('image/jpeg', quality);
      if (encoded.byteLength <= MAX_MODEL_IMAGE_BYTES) break;
    }
  }
  if (encoded.byteLength > MAX_MODEL_IMAGE_BYTES) {
    throw new Error('UPLOAD_REJECTED: 图片规范化后仍超过模型 5MB 上限');
  }

  const extension = mimeType === 'image/jpeg' ? 'jpg' : 'png';
  const relativePath = `uploads/.model-images/${sourceSha}-${NORMALIZATION_VERSION}.${extension}`;
  const absolutePath = resolve(cwd, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 });
  try {
    await writeFile(absolutePath, encoded, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }

  return {
    relativePath,
    mimeType,
    sizeBytes: encoded.byteLength,
    sha256: sourceSha,
    width: targetWidth,
    height: targetHeight,
  };
}

function toImagePart(
  image: ModelAttachmentRef,
): Extract<ModelUserContentPart, { type: 'image_attachment' }> {
  return {
    type: 'image_attachment',
    attachmentId: image.attachmentId,
    displayName: image.originalName,
    relativePath: image.modelRelativePath!,
    mimeType: image.modelMimeType!,
    sizeBytes: image.modelSizeBytes!,
    width: image.width,
    height: image.height,
    detail: 'high',
  };
}

function detectImageMime(bytes: Buffer): ModelImageMimeType | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  const six = bytes.subarray(0, 6).toString('ascii');
  if (six === 'GIF87a' || six === 'GIF89a') return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return undefined;
}

function readImageDimensions(bytes: Buffer, mime: ModelImageMimeType): ImageDimensions | undefined {
  if (mime === 'image/png' && bytes.length >= 24) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (mime === 'image/gif' && bytes.length >= 10) {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (mime === 'image/jpeg') return readJpegDimensions(bytes);
  if (mime === 'image/webp') return readWebpDimensions(bytes);
  return undefined;
}

function readJpegDimensions(bytes: Buffer): ImageDimensions | undefined {
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const segmentLength = bytes.readUInt16BE(offset + 2);
    if (segmentLength < 2 || offset + 2 + segmentLength > bytes.length) return undefined;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
    }
    offset += 2 + segmentLength;
  }
  return undefined;
}

function readWebpDimensions(bytes: Buffer): ImageDimensions | undefined {
  if (bytes.length < 30) return undefined;
  const chunk = bytes.subarray(12, 16).toString('ascii');
  if (chunk === 'VP8X') {
    return {
      width: 1 + bytes.readUIntLE(24, 3),
      height: 1 + bytes.readUIntLE(27, 3),
    };
  }
  if (chunk === 'VP8 ' && bytes.length >= 30) {
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = bytes.readUInt32LE(21);
    return {
      width: 1 + (bits & 0x3fff),
      height: 1 + ((bits >> 14) & 0x3fff),
    };
  }
  return undefined;
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

async function readRegularFileNoFollow(
  path: string,
  readBytesUpTo = Number.POSITIVE_INFINITY,
): Promise<{ size: number; bytes?: Buffer }> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) {
      throw new Error('UPLOAD_REJECTED: 附件必须是普通文件，不能是目录或符号链接');
    }
    return {
      size: fileStat.size,
      ...(fileStat.size <= readBytesUpTo ? { bytes: await handle.readFile() } : {}),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error('UPLOAD_REJECTED: 附件不能是符号链接');
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function workspaceRelativePath(cwd: string, absolutePath: string): string {
  const rel = relative(cwd, absolutePath).split(sep).join('/');
  return isAbsolute(rel) || rel.startsWith('../') ? `uploads/external-${randomUUID()}` : rel;
}

function normalizeAttachmentId(value: string | undefined): string {
  return value && UUID_PATTERN.test(value) ? value : randomUUID();
}

function safeDisplayName(value: string): string {
  return basename(String(value || '附件')).replace(/[\u0000-\u001f\u007f]/g, '_').slice(0, 160) || '附件';
}

function safeNonImageMime(value: string): string {
  const normalized = String(value || '').trim().toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(normalized) ? normalized : 'application/octet-stream';
}
