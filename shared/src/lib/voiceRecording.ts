import { ATTACHMENT_ID_PATTERN } from './chatSubmission';

export const VOICE_MIN_DURATION_MS = 1_000;
export const VOICE_MAX_DURATION_MS = 180_000;
export const VOICE_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const VOICE_MIME_TYPES = ['audio/wav', 'audio/x-wav'] as const;

export type VoiceStatus =
  | 'idle'
  | 'requesting_permission'
  | 'recording'
  | 'stopping'
  | 'uploading'
  | 'transcribing'
  | 'ready'
  | 'failed'
  | 'cancelled';

export type VoiceErrorCode =
  | 'permission_denied'
  | 'permission_permanently_denied'
  | 'too_short'
  | 'too_long'
  | 'file_too_large'
  | 'unsupported_format'
  | 'interrupted'
  | 'backgrounded'
  | 'identity_boundary'
  | 'upload_failed'
  | 'stt_timeout'
  | 'stt_silence'
  | 'stt_not_configured'
  | 'stt_provider_error'
  | 'stt_validation_failed'
  | 'cancelled';

export interface VoiceTranscriptMetadata {
  status: 'ready';
  text: string;
  editedText?: string;
  edited: boolean;
  source: 'server_stt';
}

/** Durable, path-free voice intent. Platform recorder URIs live only in an ephemeral adapter. */
export interface VoiceIntent {
  voiceIntentId: string;
  uploadRequestId: string;
  status: VoiceStatus;
  durationMs: number;
  mimeType: typeof VOICE_MIME_TYPES[number];
  size?: number;
  attachmentId?: string;
  transcriptionId?: string;
  transcript?: VoiceTranscriptMetadata;
  errorCode?: VoiceErrorCode;
  canOpenSettings?: boolean;
  attempt: number;
  dispatchCount: number;
}

export type VoiceEvent =
  | { type: 'press_record' }
  | { type: 'permission_granted' }
  | { type: 'permission_denied'; permanent: boolean }
  | { type: 'tick'; durationMs: number }
  | { type: 'stop' }
  | { type: 'recorded'; durationMs: number; size: number; mimeType: string }
  | { type: 'upload_succeeded'; attachmentId: string }
  | { type: 'upload_failed' }
  | { type: 'transcription_started' }
  | { type: 'transcription_succeeded'; transcriptionId: string; text: string }
  | { type: 'transcription_failed'; code: Extract<VoiceErrorCode, `stt_${string}`> }
  | { type: 'edit_transcript'; text: string }
  | { type: 'dispatch' }
  | { type: 'retry_upload' }
  | { type: 'retry_transcription' }
  | { type: 'cancel'; reason?: 'cancelled' | 'interrupted' | 'backgrounded' | 'identity_boundary' };

const UUID_RE = ATTACHMENT_ID_PATTERN;

export function createVoiceIntent(input: {
  voiceIntentId: string;
  uploadRequestId: string;
  mimeType?: typeof VOICE_MIME_TYPES[number];
}): VoiceIntent {
  if (!UUID_RE.test(input.voiceIntentId) || !UUID_RE.test(input.uploadRequestId)) {
    throw new Error('Voice intent IDs must be UUIDs');
  }
  return {
    voiceIntentId: input.voiceIntentId,
    uploadRequestId: input.uploadRequestId,
    status: 'idle',
    durationMs: 0,
    mimeType: input.mimeType ?? 'audio/wav',
    attempt: 1,
    dispatchCount: 0,
  };
}

function fail(state: VoiceIntent, errorCode: VoiceErrorCode, patch: Partial<VoiceIntent> = {}): VoiceIntent {
  return { ...state, ...patch, status: 'failed', errorCode };
}

/** Pure single-flight state machine. Late callbacks cannot revive cancelled/failed intents. */
export function reduceVoiceIntent(state: VoiceIntent, event: VoiceEvent): VoiceIntent {
  switch (event.type) {
    case 'press_record':
      return state.status === 'idle' ? { ...state, status: 'requesting_permission', errorCode: undefined } : state;
    case 'permission_granted':
      return state.status === 'requesting_permission' ? { ...state, status: 'recording' } : state;
    case 'permission_denied':
      return state.status === 'requesting_permission'
        ? fail(state, event.permanent ? 'permission_permanently_denied' : 'permission_denied', { canOpenSettings: event.permanent })
        : state;
    case 'tick':
      if (state.status !== 'recording') return state;
      return { ...state, durationMs: Math.min(VOICE_MAX_DURATION_MS, Math.max(state.durationMs, event.durationMs)) };
    case 'stop':
      return state.status === 'recording' ? { ...state, status: 'stopping' } : state;
    case 'recorded': {
      if (state.status !== 'stopping') return state;
      if (event.durationMs < VOICE_MIN_DURATION_MS) return fail(state, 'too_short', { durationMs: event.durationMs, size: event.size });
      if (event.durationMs > VOICE_MAX_DURATION_MS) return fail(state, 'too_long', { durationMs: event.durationMs, size: event.size });
      if (event.size > VOICE_MAX_FILE_BYTES) return fail(state, 'file_too_large', { durationMs: event.durationMs, size: event.size });
      if (!(VOICE_MIME_TYPES as readonly string[]).includes(event.mimeType.toLowerCase())) {
        return fail(state, 'unsupported_format', { durationMs: event.durationMs, size: event.size });
      }
      return { ...state, status: 'uploading', durationMs: event.durationMs, size: event.size, mimeType: event.mimeType.toLowerCase() as VoiceIntent['mimeType'], errorCode: undefined };
    }
    case 'upload_succeeded':
      return state.status === 'uploading' && UUID_RE.test(event.attachmentId)
        ? { ...state, status: 'transcribing', attachmentId: event.attachmentId, errorCode: undefined }
        : state.status === 'uploading' ? fail(state, 'upload_failed') : state;
    case 'upload_failed':
      return state.status === 'uploading' ? fail(state, 'upload_failed') : state;
    case 'transcription_started':
      return state.status === 'transcribing' ? state : state;
    case 'transcription_succeeded':
      return state.status === 'transcribing' && UUID_RE.test(event.transcriptionId)
        ? { ...state, status: 'ready', transcriptionId: event.transcriptionId, transcript: { status: 'ready', text: event.text, edited: false, source: 'server_stt' }, errorCode: undefined }
        : state;
    case 'transcription_failed':
      return state.status === 'transcribing' ? fail(state, event.code) : state;
    case 'edit_transcript':
      return state.status === 'ready' && state.transcript
        ? { ...state, transcript: { ...state.transcript, editedText: event.text, edited: event.text !== state.transcript.text } }
        : state;
    case 'dispatch':
      // Explicit send is exactly-once from this intent. Server/clientMsgId idempotency is the second fence.
      return state.status === 'ready' && state.dispatchCount === 0 ? { ...state, dispatchCount: 1 } : state;
    case 'retry_upload':
      return state.status === 'failed' && state.errorCode === 'upload_failed'
        ? { ...state, status: 'uploading', attempt: state.attempt + 1, errorCode: undefined }
        : state;
    case 'retry_transcription':
      return state.status === 'failed' && !!state.attachmentId && state.errorCode?.startsWith('stt_')
        ? { ...state, status: 'transcribing', transcriptionId: undefined, transcript: undefined, attempt: state.attempt + 1, errorCode: undefined }
        : state;
    case 'cancel':
      if (state.status === 'ready' && state.dispatchCount > 0) return state;
      return { ...state, status: 'cancelled', errorCode: event.reason ?? 'cancelled', transcript: undefined, transcriptionId: undefined };
  }
}

export interface VoiceRenderCard {
  status: VoiceStatus;
  durationMs: number;
  attachmentId?: string;
  transcript?: string;
  canPlay: boolean;
  canEdit: boolean;
  canSend: boolean;
  canRetryStt: boolean;
  canSendAsAttachment: boolean;
  canDelete: boolean;
  accessibilityLabel: string;
}

export function selectVoiceRenderCard(state: VoiceIntent): VoiceRenderCard {
  const text = state.transcript?.editedText ?? state.transcript?.text;
  return {
    status: state.status,
    durationMs: state.durationMs,
    attachmentId: state.attachmentId,
    transcript: text,
    canPlay: !!state.attachmentId && ['transcribing', 'ready', 'failed'].includes(state.status),
    canEdit: state.status === 'ready',
    canSend: state.status === 'ready' && state.dispatchCount === 0,
    canRetryStt: state.status === 'failed' && !!state.attachmentId && !!state.errorCode?.startsWith('stt_'),
    canSendAsAttachment: state.status === 'failed' && !!state.attachmentId,
    canDelete: state.status !== 'idle',
    accessibilityLabel: `语音 ${Math.round(state.durationMs / 1000)} 秒，${state.status}`,
  };
}

const LOCAL_KEY_RE = /^(?:voiceFile|savedPath|absolutePath|relativePath|fileUri|uri|path)$/i;
const LOCAL_VALUE_RE = /^(?:file|content):\/\//i;

export function assertNoLocalVoiceReference(value: unknown): void {
  const visit = (current: unknown, key?: string): void => {
    if (key && LOCAL_KEY_RE.test(key)) throw new Error(`Local voice reference key is forbidden: ${key}`);
    if (typeof current === 'string' && LOCAL_VALUE_RE.test(current)) throw new Error('Local voice reference value is forbidden');
    if (Array.isArray(current)) current.forEach((item) => visit(item));
    else if (current && typeof current === 'object') Object.entries(current as Record<string, unknown>).forEach(([childKey, child]) => visit(child, childKey));
  };
  visit(value);
}
