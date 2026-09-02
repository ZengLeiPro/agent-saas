import { basename, isAbsolute, resolve } from 'node:path';
import type { TaskBoardAttachment, TaskBoardUploadAttachment } from '../../../shared/src/types/taskboard.js';
import type { UploadedFileInfo } from '../types/index.js';
import { openTrustedFile, readTrustedFile, relativeToTrustedRoot, UnsafeFilePathError } from '../security/trustedFile.js';
import { validateAttachmentStatePath } from './assetReference.js';
import type { AttachmentState, AttachmentUnavailableCode, UploadReference } from './manager.js';

export const ATTACHMENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class AttachmentUnavailableError extends Error {
  constructor(readonly code: AttachmentUnavailableCode, message: string) {
    super(message);
    this.name = 'AttachmentUnavailableError';
  }
}

export function isSafeTaskScopeSegment(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export function taskAttachmentFilename(attachment: TaskBoardUploadAttachment): string {
  const sourceName = basename(attachment.originalName) || basename(attachment.relativePath) || 'attachment';
  const safeName = sourceName.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'attachment';
  return `${attachment.attachmentId}-${safeName}`;
}

export function trustedRelative(root: string, relativePath: string): string {
  if (!relativePath || isAbsolute(relativePath) || relativePath.includes('\0') || relativePath.includes('\\')) {
    throw new UnsafeFilePathError('Invalid trusted relative path');
  }
  return relativeToTrustedRoot(root, resolve(root, relativePath));
}

export function validateTaskAttachmentPath(
  taskId: string,
  attachment: Pick<TaskBoardAttachment, 'attachmentId' | 'relativePath'>,
): string {
  if (!attachment.attachmentId || !ATTACHMENT_ID_RE.test(attachment.attachmentId)) {
    throw new Error('Invalid task attachment id');
  }
  if (!isSafeTaskScopeSegment(taskId)) throw new Error('Invalid task attachment scope');
  const normalized = attachment.relativePath.split('\\').join('/');
  const prefix = `taskboard/attachments/${taskId}/`;
  const leaf = normalized.slice(prefix.length);
  if (!normalized.startsWith(prefix) || !leaf || leaf.includes('/')
    || !leaf.startsWith(`${attachment.attachmentId}-`)) {
    throw new Error('Task attachment is not in its task scope');
  }
  return normalized;
}

function isSupportedImage(mimeType: string): boolean {
  return mimeType === 'image/png'
    || mimeType === 'image/jpeg'
    || mimeType === 'image/gif'
    || mimeType === 'image/webp';
}

function validateState(userCwd: string, attachmentId: string, state: AttachmentState): void {
  if (state.attachmentId !== attachmentId || basename(state.filename) !== state.filename) {
    throw new Error(`Invalid attachment state: ${attachmentId}`);
  }
  validateAttachmentStatePath(userCwd, state);
}

export async function resolveAttachmentReferences(
  userCwd: string,
  attachmentIds: readonly string[],
  refs: Pick<UploadReference, 'sessionId'>,
  now: () => number,
  stagedRetentionMs: number,
): Promise<UploadedFileInfo[]> {
  const resolved: UploadedFileInfo[] = [];
  for (const attachmentId of attachmentIds) {
    if (!ATTACHMENT_ID_RE.test(attachmentId)) throw new Error('Invalid attachment id');
    let state: AttachmentState;
    try {
      state = JSON.parse(await readTrustedFile(userCwd, `uploads/.state/${attachmentId}.json`, 'utf8') as string) as AttachmentState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        const tombstone = JSON.parse(await readTrustedFile(userCwd, `uploads/.tombstones/${attachmentId}.json`, 'utf8') as string) as { code?: AttachmentUnavailableCode };
        if (tombstone.code === 'ATTACHMENT_EXPIRED' || tombstone.code === 'ATTACHMENT_DELETED') {
          throw new AttachmentUnavailableError(tombstone.code, `${tombstone.code}: ${attachmentId}`);
        }
      } catch (tombstoneError) {
        if (tombstoneError instanceof AttachmentUnavailableError) throw tombstoneError;
        if ((tombstoneError as NodeJS.ErrnoException).code !== 'ENOENT') throw tombstoneError;
      }
      throw new AttachmentUnavailableError('ATTACHMENT_NOT_FOUND', `Attachment not found: ${attachmentId}`);
    }
    validateState(userCwd, attachmentId, state);
    if (state.status === 'staged' && now() - Date.parse(state.createdAt) >= stagedRetentionMs) {
      throw new AttachmentUnavailableError('ATTACHMENT_EXPIRED', `Attachment expired: ${attachmentId}`);
    }
    if (refs.sessionId && !state.sessionIds?.includes(refs.sessionId)) {
      throw new Error(`Attachment does not belong to session: ${attachmentId}`);
    }
    let opened;
    try {
      opened = await openTrustedFile(userCwd, state.relativePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new AttachmentUnavailableError('ATTACHMENT_DELETED', `Attachment content deleted: ${attachmentId}`);
      }
      throw error;
    }
    await opened.handle.close();
    resolved.push({
      attachmentId,
      originalName: state.originalName,
      relativePath: state.relativePath,
      size: state.size,
      mimeType: state.mimeType,
      isImage: isSupportedImage(state.mimeType),
    });
  }
  return resolved;
}

export async function resolveLegacyAttachmentReferences(
  userCwd: string,
  attachments: readonly UploadedFileInfo[],
  states: readonly AttachmentState[],
): Promise<UploadedFileInfo[]> {
  const byId = new Map(states.map((state) => [state.attachmentId, state]));
  const byRelativePath = new Map(states.map((state) => [state.relativePath, state]));
  const resolved: UploadedFileInfo[] = [];
  for (const attachment of attachments) {
    const providedId = typeof attachment.attachmentId === 'string' ? attachment.attachmentId.trim() : '';
    let state: AttachmentState | undefined;
    if (providedId) {
      if (!ATTACHMENT_ID_RE.test(providedId)) throw new Error('Invalid attachment id');
      state = byId.get(providedId);
    } else if (typeof attachment.relativePath === 'string' && attachment.relativePath) {
      state = byRelativePath.get(attachment.relativePath);
    }
    if (!state) throw new Error('Attachment not found');
    validateState(userCwd, state.attachmentId, state);
    const opened = await openTrustedFile(userCwd, state.relativePath);
    await opened.handle.close();
    resolved.push({
      attachmentId: state.attachmentId,
      originalName: state.originalName,
      relativePath: state.relativePath,
      size: state.size,
      mimeType: state.mimeType,
      isImage: isSupportedImage(state.mimeType),
    });
  }
  return resolved;
}
