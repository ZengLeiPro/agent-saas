import { ATTACHMENT_ID_PATTERN } from './chatSubmission';
import { assertNoLocalAttachmentReference } from './attachmentUpload';

/** M50-01 applies a stricter envelope than the general 2 GiB/20-file upload picker. */
export const INCOMING_SHARE_MAX_ITEMS = 5;
export const INCOMING_SHARE_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
export const INCOMING_SHARE_STAGING_SAFETY_BYTES = 8 * 1024 * 1024;
export const INCOMING_SHARE_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

export type IncomingShareStatus =
  | 'received'
  | 'validating'
  | 'staging'
  | 'uploading'
  | 'uploaded'
  | 'failed'
  | 'expired';

export type IncomingShareKind = 'text' | 'image' | 'pdf';
export type IncomingShareErrorCode =
  | 'share_count_exceeded'
  | 'share_total_size_exceeded'
  | 'share_empty_file'
  | 'share_type_unsupported'
  | 'share_mime_mismatch'
  | 'share_active_content'
  | 'share_low_disk'
  | 'share_source_revoked'
  | 'share_source_missing'
  | 'share_offline'
  | 'share_upload_failed'
  | 'share_owner_changed'
  | 'share_cancelled'
  | 'share_expired'
  | 'share_attachment_invalid';

export interface IncomingShareError {
  code: IncomingShareErrorCode;
  retryable: boolean;
  requiresRepick: boolean;
  message: string;
}

/** Durable path-free metadata. Local content URI/sandbox URI is platform-vault state only. */
export interface AttachmentDraft {
  draftId: string;
  intentId: string;
  requestId: string;
  kind: Exclude<IncomingShareKind, 'text'>;
  name: string;
  size: number;
  mimeType: string;
  status: IncomingShareStatus;
  createdAt: string;
  expiresAt: string;
  attachmentId?: string;
  error?: IncomingShareError;
}

export interface IncomingShare {
  intentId: string;
  status: IncomingShareStatus;
  text: string;
  attachments: AttachmentDraft[];
  createdAt: string;
  expiresAt: string;
  error?: IncomingShareError;
}

export interface IncomingShareSelection {
  name: string;
  size: number;
  mimeType: string;
}

export type AttachmentDraftEvent =
  | { type: 'validate' }
  | { type: 'validation_passed' }
  | { type: 'staged' }
  | { type: 'upload_started' }
  | { type: 'uploaded'; attachmentId: string }
  | { type: 'failed'; error: IncomingShareError }
  | { type: 'retry' }
  | { type: 'expire' };

const EXTENSION_MIMES: Readonly<Record<string, readonly string[]>> = {
  png: ['image/png'],
  jpg: ['image/jpeg'],
  jpeg: ['image/jpeg'],
  gif: ['image/gif'],
  webp: ['image/webp'],
  pdf: ['application/pdf'],
};
const ACTIVE_OR_DOUBLE_EXTENSION = /\.(?:exe|com|bat|cmd|msi|apk|app|sh|ps1|js|mjs|cjs|html?|svg|xml|xhtml)(?:\.|$)/iu;

export function incomingShareKind(mimeType: string): IncomingShareKind | null {
  const mime = mimeType.trim().toLowerCase();
  if (mime === 'text/plain') return 'text';
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/gif' || mime === 'image/webp') return 'image';
  return null;
}

export function validateIncomingShareSelection(
  files: readonly IncomingShareSelection[],
  text = '',
): { ok: true; totalBytes: number } | { ok: false; error: IncomingShareError; index?: number } {
  if (files.length > INCOMING_SHARE_MAX_ITEMS) {
    return { ok: false, error: shareError('share_count_exceeded', false, true, `系统分享最多 ${INCOMING_SHARE_MAX_ITEMS} 项`) };
  }
  const totalBytes = files.reduce((sum, file) => sum + Math.max(0, file.size), 0);
  if (totalBytes > INCOMING_SHARE_MAX_TOTAL_BYTES) {
    return { ok: false, error: shareError('share_total_size_exceeded', false, true, '系统分享总大小不能超过 20 MB') };
  }
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (!Number.isSafeInteger(file.size) || file.size <= 0) {
      return { ok: false, index, error: shareError('share_empty_file', false, true, `文件为空或大小无效：${file.name}`) };
    }
    const kind = incomingShareKind(file.mimeType);
    if (!kind || kind === 'text') {
      return { ok: false, index, error: shareError('share_type_unsupported', false, true, `仅支持图片、PDF 与纯文本分享：${file.name}`) };
    }
    const lowerName = file.name.trim().toLowerCase();
    if (!lowerName || /[\\/\0]/u.test(lowerName) || ACTIVE_OR_DOUBLE_EXTENSION.test(lowerName)) {
      return { ok: false, index, error: shareError('share_active_content', false, true, `文件名不安全：${file.name}`) };
    }
    const extension = lowerName.includes('.') ? lowerName.slice(lowerName.lastIndexOf('.') + 1) : '';
    if (!EXTENSION_MIMES[extension]?.includes(file.mimeType.toLowerCase())) {
      return { ok: false, index, error: shareError('share_mime_mismatch', false, true, `文件类型与扩展名不一致：${file.name}`) };
    }
  }
  if (!text.trim() && files.length === 0) {
    return { ok: false, error: shareError('share_type_unsupported', false, false, '分享内容为空') };
  }
  return { ok: true, totalBytes };
}

/** Lightweight client magic check; the server repeats the authoritative full upload inspection. */
export function validateIncomingShareMagic(mimeType: string, bytes: Uint8Array): boolean {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  switch (mimeType.toLowerCase()) {
    case 'image/png': return bytes.length >= 8 && [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a].every((v, i) => bytes[i] === v);
    case 'image/jpeg': return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/gif': return ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a';
    case 'image/webp': return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
    case 'application/pdf': return ascii(0, 5) === '%PDF-' && !/<(?:script|iframe|object|embed)\b/iu.test(ascii(0, Math.min(bytes.length, 8192)));
    default: return false;
  }
}

export function shareError(
  code: IncomingShareErrorCode,
  retryable: boolean,
  requiresRepick: boolean,
  message: string,
): IncomingShareError {
  return { code, retryable, requiresRepick, message };
}

export function createIncomingShare(input: {
  intentId: string;
  text?: string;
  attachments?: readonly Omit<AttachmentDraft, 'intentId' | 'status' | 'createdAt' | 'expiresAt'>[];
  now?: number;
}): IncomingShare {
  const now = input.now ?? Date.now();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + INCOMING_SHARE_DRAFT_TTL_MS).toISOString();
  const attachments = (input.attachments ?? []).map((draft) => ({
    ...draft,
    intentId: input.intentId,
    status: 'received' as const,
    createdAt,
    expiresAt,
  }));
  const result: IncomingShare = {
    intentId: input.intentId,
    status: 'received',
    text: input.text ?? '',
    attachments,
    createdAt,
    expiresAt,
  };
  assertIncomingSharePathFree(result);
  return result;
}

export function reduceAttachmentDraft(state: AttachmentDraft, event: AttachmentDraftEvent): AttachmentDraft {
  if (event.type === 'uploaded') {
    if (!ATTACHMENT_ID_PATTERN.test(event.attachmentId)) {
      return { ...state, status: 'failed', error: shareError('share_attachment_invalid', true, false, '服务端附件标识无效') };
    }
    return { ...state, status: 'uploaded', attachmentId: event.attachmentId, error: undefined };
  }
  switch (event.type) {
    case 'validate': return state.status === 'received' ? { ...state, status: 'validating', error: undefined } : state;
    case 'validation_passed': return state.status === 'validating' ? { ...state, status: 'staging' } : state;
    case 'staged': return state.status === 'staging' ? state : state;
    case 'upload_started': return state.status === 'staging' || state.status === 'failed' ? { ...state, status: 'uploading', error: undefined } : state;
    case 'failed': return state.status === 'uploaded' || state.status === 'expired' ? state : { ...state, status: 'failed', error: event.error };
    case 'retry': return state.status === 'failed' && state.error?.retryable ? { ...state, status: state.error.requiresRepick ? 'received' : 'staging', error: undefined } : state;
    case 'expire': return state.status === 'uploaded' ? state : { ...state, status: 'expired', error: shareError('share_expired', false, false, '分享草稿已过期') };
  }
}

export function projectIncomingShareStatus(attachments: readonly AttachmentDraft[], fallback: IncomingShareStatus = 'received'): IncomingShareStatus {
  if (!attachments.length) return fallback;
  if (attachments.every((item) => item.status === 'uploaded')) return 'uploaded';
  if (attachments.every((item) => item.status === 'expired')) return 'expired';
  if (attachments.some((item) => item.status === 'uploading')) return 'uploading';
  if (attachments.some((item) => item.status === 'staging')) return 'staging';
  if (attachments.some((item) => item.status === 'validating')) return 'validating';
  if (attachments.some((item) => item.status === 'failed')) return 'failed';
  return 'received';
}

export function assertIncomingSharePathFree(value: IncomingShare | AttachmentDraft | unknown): void {
  assertNoLocalAttachmentReference(value);
}

/** Submission/queue/replay projection deliberately contains no request, draft or local source fields. */
export function mergeIncomingShareText(existingComposer: string, incomingText: string): string {
  if (!incomingText.trim()) return existingComposer;
  if (!existingComposer.trim()) return incomingText;
  return `${existingComposer}\n${incomingText}`;
}

export function incomingShareUploadedAttachments(share: IncomingShare): Array<{
  attachmentId: string;
  display: { originalName: string; mimeType: string; size: number; isImage: boolean };
}> {
  const uploaded = share.attachments.map((draft) => {
    if (draft.status !== 'uploaded' || !draft.attachmentId || !ATTACHMENT_ID_PATTERN.test(draft.attachmentId)) {
      throw new Error('incoming_share_not_uploaded');
    }
    return {
      attachmentId: draft.attachmentId,
      display: { originalName: draft.name, mimeType: draft.mimeType, size: draft.size, isImage: draft.kind === 'image' },
    };
  });
  assertIncomingSharePathFree(uploaded);
  return uploaded;
}
