import { extname, resolve } from 'node:path';

import { relativeToTrustedRoot } from '../security/trustedFile.js';

interface AttachmentStatePath {
  attachmentId: string;
  filename: string;
  relativePath: string;
  source?: 'upload' | 'asset';
}

export function mimeTypeForAsset(path: string): string {
  const extension = extname(path).toLowerCase();
  const types: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.json': 'application/json',
    '.csv': 'text/csv',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  return types[extension] ?? 'application/octet-stream';
}

export function validateAssetPath(userCwd: string, relativePath: string): string {
  if (!relativePath.startsWith('assets/') || relativePath.includes('\0') || relativePath.includes('\\')) {
    throw Object.assign(new Error('Invalid asset path'), { statusCode: 400 });
  }
  try {
    relativeToTrustedRoot(resolve(userCwd, 'assets'), resolve(userCwd, relativePath));
  } catch {
    throw Object.assign(new Error('Invalid asset path'), { statusCode: 400 });
  }
  return relativePath;
}

export function validateAttachmentStatePath(userCwd: string, state: AttachmentStatePath): string {
  if (state.source === 'asset') return validateAssetPath(userCwd, state.relativePath);
  if (state.relativePath !== `uploads/${state.filename}`) {
    throw new Error(`Invalid attachment state: ${state.attachmentId}`);
  }
  return state.relativePath;
}
