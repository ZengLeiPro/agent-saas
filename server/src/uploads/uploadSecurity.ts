import { open } from 'node:fs/promises';
import { extname } from 'node:path';

import { validateAttachmentSelection } from '../../../shared/src/lib/attachmentUpload.js';

export type UploadRejectionCode =
  | 'UPLOAD_COUNT_EXCEEDED'
  | 'UPLOAD_SIZE_EXCEEDED'
  | 'UPLOAD_FILENAME_DANGEROUS'
  | 'UPLOAD_DOUBLE_EXTENSION'
  | 'UPLOAD_EXTENSION_BLOCKED'
  | 'UPLOAD_MIME_BLOCKED'
  | 'UPLOAD_MIME_MISMATCH'
  | 'UPLOAD_EXECUTABLE_CONTENT';

export class UploadPolicyError extends Error {
  constructor(
    readonly code: UploadRejectionCode,
    message: string,
    readonly statusCode = 422,
  ) {
    super(message);
    this.name = 'UploadPolicyError';
  }
}

const SAFE_RASTER = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const SAFE_INLINE_MEDIA = new Set([...SAFE_RASTER, 'audio/wav', 'audio/x-wav', 'audio/mpeg']);
const ZIP_DECLARATIONS = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);
const TEXT_DECLARATIONS = new Set([
  'text/plain', 'text/markdown', 'text/csv', 'application/csv', 'application/json', 'text/json',
]);

function starts(buffer: Buffer, bytes: readonly number[], offset = 0): boolean {
  return bytes.every((byte, index) => buffer[offset + index] === byte);
}

export function detectUploadContentType(buffer: Buffer): string {
  if (starts(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts(buffer, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (starts(buffer, [0x50, 0x4b, 0x03, 0x04]) || starts(buffer, [0x50, 0x4b, 0x05, 0x06]) || starts(buffer, [0x50, 0x4b, 0x07, 0x08])) return 'application/zip';
  if (starts(buffer, [0x1f, 0x8b])) return 'application/gzip';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WAVE') return 'audio/wav';
  if (buffer.subarray(0, 3).toString('ascii') === 'ID3' || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('ascii').toLowerCase();
    return brand.includes('qt') ? 'video/quicktime' : 'video/mp4';
  }
  const sample = buffer.toString('utf8');
  if (!sample.includes('\ufffd') && !/[\0\x01-\x08\x0b\x0c\x0e-\x1f]/.test(sample)) return 'text/plain';
  return 'application/octet-stream';
}

function containsExecutableMarkup(buffer: Buffer): boolean {
  const text = buffer.toString('utf8').replace(/^\ufeff/, '').trimStart().slice(0, 8192).toLowerCase();
  return /^<(?:!doctype\s+html|html\b|svg\b|script\b)/.test(text)
    || /<script\b|javascript\s*:|<iframe\b|<object\b|<embed\b/.test(text);
}

function mappedCode(code: string): UploadRejectionCode {
  switch (code) {
    case 'count_exceeded': return 'UPLOAD_COUNT_EXCEEDED';
    case 'size_exceeded': return 'UPLOAD_SIZE_EXCEEDED';
    case 'double_extension': return 'UPLOAD_DOUBLE_EXTENSION';
    case 'extension_blocked': return 'UPLOAD_EXTENSION_BLOCKED';
    case 'mime_blocked': return 'UPLOAD_MIME_BLOCKED';
    case 'dangerous_filename': return 'UPLOAD_FILENAME_DANGEROUS';
    default: return 'UPLOAD_MIME_MISMATCH';
  }
}

function contentMatches(declared: string, detected: string, extension: string): boolean {
  if (detected === declared) return true;
  if (declared === 'application/octet-stream') {
    const expectedByExtension: Record<string, readonly string[]> = {
      txt: ['text/plain'], md: ['text/plain'], csv: ['text/plain'], json: ['text/plain'],
      png: ['image/png'], jpg: ['image/jpeg'], jpeg: ['image/jpeg'], gif: ['image/gif'], webp: ['image/webp'],
      pdf: ['application/pdf'], zip: ['application/zip'], docx: ['application/zip'], xlsx: ['application/zip'], pptx: ['application/zip'],
      gz: ['application/gzip'], mp3: ['audio/mpeg'], wav: ['audio/wav'], mp4: ['video/mp4'], mov: ['video/quicktime'],
    };
    if (expectedByExtension[extension]?.includes(detected)) return true;
  }
  if (detected === 'application/zip' && ZIP_DECLARATIONS.has(declared)) return true;
  if (detected === 'text/plain' && TEXT_DECLARATIONS.has(declared)) return true;
  if (detected === 'application/octet-stream' && declared === 'application/octet-stream'
    && ['doc', 'xls', 'ppt'].includes(extension)) return true;
  return false;
}

export async function inspectUploadedFile(file: {
  path: string;
  originalName: string;
  size: number;
  mimetype: string;
}): Promise<{ mimeType: string; isImage: boolean }> {
  const validation = validateAttachmentSelection([{
    name: file.originalName,
    size: file.size,
    mimeType: file.mimetype || 'application/octet-stream',
  }]);
  if (!validation.ok) {
    const status = validation.issue.code === 'size_exceeded' ? 413 : 422;
    throw new UploadPolicyError(mappedCode(validation.issue.code), validation.issue.message, status);
  }

  const handle = await open(file.path, 'r');
  let buffer: Buffer;
  try {
    const size = Math.min(8192, Math.max(1, file.size));
    buffer = Buffer.alloc(size);
    const result = await handle.read(buffer, 0, size, 0);
    buffer = buffer.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }

  if (containsExecutableMarkup(buffer)) {
    throw new UploadPolicyError('UPLOAD_EXECUTABLE_CONTENT', '不允许上传可执行 HTML、SVG 或 JavaScript 内容');
  }
  const declared = (file.mimetype || 'application/octet-stream').toLowerCase();
  const detected = detectUploadContentType(buffer);
  const extension = extname(file.originalName).slice(1).toLowerCase();
  if (!contentMatches(declared, detected, extension)) {
    throw new UploadPolicyError('UPLOAD_MIME_MISMATCH', `文件真实类型与声明不一致：${file.originalName}`);
  }
  return { mimeType: declared === 'application/octet-stream' ? detected : declared, isImage: SAFE_RASTER.has(detected) };
}

export function attachmentResponseHeaders(input: { originalName: string; mimeType: string; inline: boolean }): Record<string, string> {
  const safeInline = input.inline && SAFE_INLINE_MEDIA.has(input.mimeType.toLowerCase());
  const ascii = input.originalName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\\r\n]/g, '_').slice(0, 150) || 'attachment';
  const encoded = encodeURIComponent(input.originalName).replace(/['()]/g, escape);
  return {
    'Content-Type': safeInline ? input.mimeType : 'application/octet-stream',
    'Content-Disposition': `${safeInline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`,
    'Content-Security-Policy': "default-src 'none'; sandbox; img-src 'self' data:; style-src 'none'; script-src 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
}
