import { ATTACHMENT_ID_PATTERN } from './chatSubmission';
import { MAX_UPLOAD_FILE_SIZE, MAX_UPLOAD_FILES_PER_REQUEST } from './constants';

export type AttachmentUploadStatus =
  | 'selected'
  | 'validating'
  | 'uploading'
  | 'uploaded'
  | 'failed'
  | 'cancelled'
  | 'expired';

export type AttachmentUploadFenceReason = 'offline' | 'locked' | 'identity_boundary' | 'background_killed';

export interface AttachmentSelectionMetadata {
  name: string;
  size: number;
  mimeType: string;
}

/**
 * Durable/path-free projection. The picker File/URI is deliberately held by a platform adapter,
 * keyed by localIntentId, and can never be represented in this contract.
 */
export interface AttachmentUploadIntent extends AttachmentSelectionMetadata {
  localIntentId: string;
  uploadRequestId: string;
  attempt: number;
  status: AttachmentUploadStatus;
  progress: number;
  attachmentId?: string;
  errorCode?: string;
  retryOfRequestId?: string;
  requiresReselection?: boolean;
}

export type AttachmentUploadEvent =
  | { type: 'validate' }
  | { type: 'validation_passed' }
  | { type: 'validation_failed'; code: string }
  | { type: 'progress'; value: number }
  | { type: 'server_uploaded'; attachmentId: string }
  | { type: 'upload_failed'; code: string }
  | { type: 'cancel' }
  | { type: 'expire' }
  | { type: 'retry_same_request' }
  | { type: 'retry_new_request'; uploadRequestId: string }
  | { type: 'fence'; reason: AttachmentUploadFenceReason };

export interface AttachmentValidationIssue {
  code:
    | 'count_exceeded'
    | 'size_exceeded'
    | 'empty_file'
    | 'dangerous_filename';
  index?: number;
  message: string;
}

export type AttachmentValidationResult =
  | { ok: true }
  | { ok: false; issue: AttachmentValidationIssue };

const LOCAL_REFERENCE_KEYS = /^(?:uri|url|path|absolutePath|savedPath|displayPath|relativePath|previewUrl|localPath|file)$/i;
const LOCAL_REFERENCE_VALUE = /^(?:file|content|blob):|^(?:[a-zA-Z]:[\\/]|\/Users\/|\/home\/|\/var\/mobile\/|\/data\/user\/)/i;
const BIDI_CONTROL = /[\u202a-\u202e\u2066-\u2069]/;

/** 客户端只挡结构性风险；扩展名、MIME 与内容分类统一由服务端处理。 */
export function validateAttachmentSelection(
  files: readonly AttachmentSelectionMetadata[],
  limits: { maxFiles?: number; maxBytes?: number } = {},
): AttachmentValidationResult {
  const maxFiles = limits.maxFiles ?? MAX_UPLOAD_FILES_PER_REQUEST;
  const maxBytes = limits.maxBytes ?? MAX_UPLOAD_FILE_SIZE;
  if (files.length > maxFiles) {
    return { ok: false, issue: { code: 'count_exceeded', message: `单次最多上传 ${maxFiles} 个文件` } };
  }
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const name = file.name.normalize('NFC');
    if (!name || name !== name.trim() || /[\0-\x1f\x7f/\\]/.test(name) || BIDI_CONTROL.test(name) || name === '.' || name === '..') {
      return { ok: false, issue: { code: 'dangerous_filename', index, message: `文件名不安全：${file.name}` } };
    }
    if (!Number.isSafeInteger(file.size) || file.size <= 0) {
      return { ok: false, issue: { code: 'empty_file', index, message: `文件为空或大小无效：${file.name}` } };
    }
    if (file.size > maxBytes) {
      return { ok: false, issue: { code: 'size_exceeded', index, message: `文件超过大小限制：${file.name}` } };
    }
  }
  return { ok: true };
}

export function createAttachmentUploadIntent(input: AttachmentSelectionMetadata & {
  localIntentId: string;
  uploadRequestId: string;
}): AttachmentUploadIntent {
  return { ...input, attempt: 1, status: 'selected', progress: 0 };
}

/** Pure upload state machine. A late authoritative server success wins a cancel race. */
export function reduceAttachmentUpload(
  state: AttachmentUploadIntent,
  event: AttachmentUploadEvent,
): AttachmentUploadIntent {
  if (event.type === 'server_uploaded') {
    if (!ATTACHMENT_ID_PATTERN.test(event.attachmentId)) {
      return { ...state, status: 'failed', errorCode: 'attachment_id_invalid' };
    }
    return { ...state, status: 'uploaded', progress: 1, attachmentId: event.attachmentId, errorCode: undefined, requiresReselection: undefined };
  }
  switch (event.type) {
    case 'validate':
      return state.status === 'selected' ? { ...state, status: 'validating' } : state;
    case 'validation_passed':
      return state.status === 'validating' ? { ...state, status: 'uploading', progress: Math.max(0, state.progress) } : state;
    case 'validation_failed':
      return state.status === 'validating' ? { ...state, status: 'failed', errorCode: event.code } : state;
    case 'progress':
      return state.status === 'uploading'
        ? { ...state, progress: Math.max(state.progress, Math.min(0.999, Math.max(0, event.value))) }
        : state;
    case 'upload_failed':
      return state.status === 'uploading' ? { ...state, status: 'failed', errorCode: event.code } : state;
    case 'cancel':
      return state.status === 'uploaded' || state.status === 'expired' ? state : { ...state, status: 'cancelled', errorCode: 'cancelled' };
    case 'expire':
      return state.status === 'uploaded' ? { ...state, status: 'expired', errorCode: 'attachment_expired' } : state;
    case 'retry_same_request':
      return state.status === 'failed' || state.status === 'cancelled'
        ? { ...state, status: 'uploading', attempt: state.attempt + 1, progress: 0, errorCode: undefined, requiresReselection: undefined }
        : state;
    case 'retry_new_request':
      return state.status === 'failed' || state.status === 'cancelled'
        ? { ...state, status: 'uploading', uploadRequestId: event.uploadRequestId, retryOfRequestId: state.uploadRequestId, attempt: state.attempt + 1, progress: 0, errorCode: undefined, requiresReselection: undefined }
        : state;
    case 'fence':
      if (state.status === 'uploaded' || state.status === 'expired') return state;
      return {
        ...state,
        status: event.reason === 'background_killed' ? 'failed' : 'cancelled',
        errorCode: event.reason,
        requiresReselection: true,
      };
  }
}

/** Kill/relaunch only trusts server snapshots; it never schedules a local picker source for retransmit. */
export function recoverAttachmentUploadIntent(
  local: AttachmentUploadIntent,
  serverUploaded?: Pick<AttachmentUploadIntent, 'attachmentId' | 'name' | 'size' | 'mimeType'>,
): AttachmentUploadIntent {
  if (serverUploaded?.attachmentId && ATTACHMENT_ID_PATTERN.test(serverUploaded.attachmentId)) {
    return { ...local, ...serverUploaded, status: 'uploaded', progress: 1, requiresReselection: undefined, errorCode: undefined };
  }
  if (local.status === 'uploaded' && local.attachmentId) return local;
  return { ...local, status: 'failed', errorCode: 'local_source_lost', requiresReselection: true, progress: 0 };
}

export function assertNoLocalAttachmentReference(value: unknown): void {
  const visit = (current: unknown, key?: string): void => {
    if (key && LOCAL_REFERENCE_KEYS.test(key)) throw new Error(`Local attachment reference key is forbidden: ${key}`);
    if (typeof current === 'string' && LOCAL_REFERENCE_VALUE.test(current)) throw new Error('Local attachment reference value is forbidden');
    if (Array.isArray(current)) current.forEach((item) => visit(item));
    else if (current && typeof current === 'object') {
      Object.entries(current as Record<string, unknown>).forEach(([childKey, child]) => visit(child, childKey));
    }
  };
  visit(value);
}

export interface AttachmentRenderCard {
  kind: 'image' | 'file';
  attachmentId?: string;
  name: string;
  mimeType: string;
  size: number;
  status: AttachmentUploadStatus | 'queued';
  canPreview: boolean;
  canFullscreen: boolean;
  canDownload: boolean;
  canRetry: boolean;
  canRemove: boolean;
}

const SAFE_RASTER_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function selectAttachmentRenderCard(input: {
  attachmentId?: string;
  name: string;
  mimeType?: string;
  size?: number;
  status?: AttachmentUploadStatus | 'queued';
}): AttachmentRenderCard {
  const mimeType = input.mimeType?.toLowerCase() || 'application/octet-stream';
  const status = input.status ?? 'uploaded';
  const image = SAFE_RASTER_MIMES.has(mimeType);
  const available = (status === 'uploaded' || status === 'queued') && !!input.attachmentId;
  return {
    kind: image ? 'image' : 'file',
    attachmentId: input.attachmentId,
    name: input.name,
    mimeType,
    size: input.size ?? 0,
    status,
    canPreview: image && available,
    canFullscreen: image && available,
    canDownload: available,
    canRetry: status === 'failed',
    canRemove: status !== 'expired',
  };
}
