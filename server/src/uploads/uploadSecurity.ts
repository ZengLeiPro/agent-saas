import { open } from 'node:fs/promises';
import { extname } from 'node:path';

import { validateAttachmentSelection } from '../../../shared/src/lib/attachmentUpload.js';
import { inspectZipArchive, ZipInspectionError, type ZipInspectionResult } from './archiveInspection.js';

export type UploadRejectionCode =
  | 'UPLOAD_COUNT_EXCEEDED'
  | 'UPLOAD_SIZE_EXCEEDED'
  | 'UPLOAD_FILENAME_DANGEROUS'
  | 'UPLOAD_MIME_BLOCKED'
  | 'UPLOAD_MIME_MISMATCH'
  | 'UPLOAD_EXECUTABLE_CONTENT'
  | 'UPLOAD_ARCHIVE_INVALID'
  | 'UPLOAD_ARCHIVE_UNSAFE'
  | 'UPLOAD_ARCHIVE_LIMIT_EXCEEDED';

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
  'application/csv', 'application/json', 'text/json',
]);
const EXECUTABLE_DECLARATIONS = new Set([
  'application/x-msdownload', 'application/vnd.microsoft.portable-executable', 'application/x-dosexec',
  'application/x-elf', 'application/x-mach-binary', 'application/java-archive',
]);
const MIME_ALIASES: Readonly<Record<string, readonly string[]>> = {
  'application/gzip': ['application/x-gzip'],
  'audio/wav': ['audio/x-wav'],
  'audio/mpeg': ['audio/mp3'],
  'audio/mp4': ['audio/x-m4a'],
};

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
  if (buffer.subarray(0, 4).toString('ascii') === 'OggS') return 'audio/ogg';
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('ascii').toLowerCase();
    if (brand.includes('m4a')) return 'audio/mp4';
    return brand.includes('qt') ? 'video/quicktime' : 'video/mp4';
  }
  if (starts(buffer, [0x4d, 0x5a])) return 'application/vnd.microsoft.portable-executable';
  if (starts(buffer, [0x7f, 0x45, 0x4c, 0x46])) return 'application/x-elf';
  if (
    starts(buffer, [0xfe, 0xed, 0xfa, 0xce]) || starts(buffer, [0xce, 0xfa, 0xed, 0xfe])
    || starts(buffer, [0xfe, 0xed, 0xfa, 0xcf]) || starts(buffer, [0xcf, 0xfa, 0xed, 0xfe])
  ) return 'application/x-mach-binary';
  const sample = buffer.toString('utf8');
  const normalized = sample.replace(/^\ufeff/, '').trimStart().toLowerCase();
  if (/^<(?:!doctype\s+html|html\b)/.test(normalized)) return 'text/html';
  if (/^<svg\b/.test(normalized)) return 'image/svg+xml';
  if (!sample.includes('\ufffd') && !/[\0\x01-\x08\x0b\x0c\x0e-\x1f]/.test(sample)) return 'text/plain';
  return 'application/octet-stream';
}

function containsActiveContent(buffer: Buffer, extension: string, declared: string, detected: string): boolean {
  const text = buffer.toString('utf8').replace(/^\ufeff/, '').trimStart().slice(0, 8192).toLowerCase();
  if (detected === 'application/vnd.microsoft.portable-executable' || detected === 'application/x-elf' || detected === 'application/x-mach-binary') return true;
  if (['html', 'htm', 'xhtml', 'svg', 'svgz', 'js', 'mjs', 'cjs', 'jsx'].includes(extension)) return true;
  if (/(?:html|svg\+xml|javascript|ecmascript|x-msdownload)/i.test(declared)) return true;
  if (/^#!\s*\//.test(text)) return true;
  if (detected === 'application/pdf' && /\/(?:javascript|js|launch|openaction)\b/i.test(text)) return true;
  return /^<(?:!doctype\s+html|html\b|svg\b|script\b)/.test(text)
    || /<script\b|javascript\s*:|<iframe\b|<object\b|<embed\b/.test(text);
}

function mappedCode(code: string): UploadRejectionCode {
  switch (code) {
    case 'count_exceeded': return 'UPLOAD_COUNT_EXCEEDED';
    case 'size_exceeded': return 'UPLOAD_SIZE_EXCEEDED';
    case 'dangerous_filename': return 'UPLOAD_FILENAME_DANGEROUS';
    default: return 'UPLOAD_MIME_MISMATCH';
  }
}

function contentMatches(declared: string, detected: string, extension: string): boolean {
  if (detected === declared) return true;
  if (declared === 'application/octet-stream') return true;
  if (detected === 'application/zip' && ZIP_DECLARATIONS.has(declared)) return true;
  if (detected === 'text/plain' && (declared.startsWith('text/') || TEXT_DECLARATIONS.has(declared))) return true;
  if (detected === 'text/plain' && ['html', 'htm', 'xhtml'].includes(extension)) return declared === 'text/html' || declared === 'application/xhtml+xml';
  if (detected === 'application/vnd.microsoft.portable-executable' && EXECUTABLE_DECLARATIONS.has(declared)) return true;
  if (MIME_ALIASES[detected]?.includes(declared)) return true;
  if (detected === 'application/octet-stream' && declared === 'application/octet-stream'
    && ['doc', 'xls', 'ppt'].includes(extension)) return true;
  return false;
}

function archivePolicyError(error: ZipInspectionError): UploadPolicyError {
  if (error.failure === 'invalid') return new UploadPolicyError('UPLOAD_ARCHIVE_INVALID', error.message);
  if (error.failure === 'limit_exceeded') return new UploadPolicyError('UPLOAD_ARCHIVE_LIMIT_EXCEEDED', error.message, 413);
  return new UploadPolicyError('UPLOAD_ARCHIVE_UNSAFE', error.message);
}

export interface UploadedFileInspection {
  mimeType: string;
  isImage: boolean;
  detectedMimeType: string;
  contentMismatch: boolean;
  activeContent: boolean;
  archive?: ZipInspectionResult;
}

export async function inspectUploadedFile(file: {
  path: string;
  originalName: string;
  size: number;
  mimetype: string;
}): Promise<UploadedFileInspection> {
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

  const declared = (file.mimetype || 'application/octet-stream').toLowerCase();
  const extension = extname(file.originalName).slice(1).toLowerCase();
  const detectedByMagic = detectUploadContentType(buffer);
  const detected = detectedByMagic === 'text/plain'
    && ['html', 'htm', 'xhtml'].includes(extension)
    && (declared === 'text/html' || declared === 'application/xhtml+xml' || declared === 'application/octet-stream')
    ? 'text/html'
    : detectedByMagic;
  const activeContent = containsActiveContent(buffer, extension, declared, detected);
  let archive: ZipInspectionResult | undefined;
  if (detected === 'application/zip') {
    try {
      archive = await inspectZipArchive(file.path);
    } catch (error) {
      if (error instanceof ZipInspectionError) throw archivePolicyError(error);
      throw error;
    }
  }
  const contentMismatch = !contentMatches(declared, detected, extension);
  const preventInlinePreview = activeContent && detected !== 'text/html' && detected !== 'image/svg+xml';
  const mimeType = contentMismatch || preventInlinePreview
    ? 'application/octet-stream'
    : declared === 'application/octet-stream' ? detected : declared;
  return {
    mimeType,
    isImage: SAFE_RASTER.has(detected) && !contentMismatch && !activeContent,
    detectedMimeType: detected,
    contentMismatch,
    activeContent,
    ...(archive ? { archive } : {}),
  };
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
