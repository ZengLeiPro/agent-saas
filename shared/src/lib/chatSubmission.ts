import type { SandboxProfile } from '../types/session';
import { parseAgentTarget, type AgentTarget } from './agentTarget';

/** M20-01 capability: clients declaring this send only the canonical nested submission DTO. */
export const CHAT_SUBMISSION_V1_CAPABILITY = 'chat_submission_v1' as const;
export const CHAT_SUBMISSION_VERSION = 1 as const;

/** UUID form emitted by the upload service. Authenticity/ownership is verified by the server state store. */
export const ATTACHMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ChatClientCapability =
  | typeof CHAT_SUBMISSION_V1_CAPABILITY
  | 'replaceable_drafts';

export type ChatDeliveryMode = 'queue' | 'steer';

/** Non-authoritative presentation data. The attachmentId is the only attachment authority. */
export interface CanonicalChatAttachmentDisplay {
  originalName: string;
  mimeType?: string;
  size?: number;
  isImage?: boolean;
}

export interface CanonicalChatAttachment {
  attachmentId: string;
  display: CanonicalChatAttachmentDisplay;
}

export interface CanonicalChatTarget {
  sessionId?: string;
  /** Only honored while creating a session. */
  sandboxProfile?: SandboxProfile;
  /** M20-06 explicit tenant-scoped target. Required for V1 new clients. */
  agentTarget?: AgentTarget;
  /** @deprecated N-1 wire compatibility. Server never lets this override a persisted target. */
  orgAgentId?: string;
}

/**
 * Canonical chat submission V1.
 *
 * Deliberately absent: savedPath, relativePath, URI and any client-local/absolute path.
 * Queue snapshots and replay persist this value (or a projection of it), never an upload path.
 */
export interface CanonicalVoiceSubmission {
  voiceIntentId: string;
  uploadRequestId: string;
  attachmentId: string;
  transcriptionId: string;
  durationMs: number;
  transcript: { status: 'ready'; text: string; edited: boolean; source: 'server_stt' };
}

export interface CanonicalChatSubmission {
  version: typeof CHAT_SUBMISSION_VERSION;
  text: string;
  clientMsgId: string;
  target: CanonicalChatTarget;
  deliveryMode: ChatDeliveryMode;
  model?: string;
  attachments: CanonicalChatAttachment[];
  voice?: CanonicalVoiceSubmission;
}

/** Upload/client view accepted by the pure builder. Path fields may exist on the source object and are ignored. */
export interface ChatSubmissionAttachmentInput {
  attachmentId?: unknown;
  originalName?: unknown;
  mimeType?: unknown;
  size?: unknown;
  isImage?: unknown;
  display?: unknown;
  [key: string]: unknown;
}

export interface ChatSubmissionInput {
  text: unknown;
  clientMsgId: unknown;
  target?: unknown;
  deliveryMode?: unknown;
  model?: unknown;
  attachments?: readonly ChatSubmissionAttachmentInput[] | unknown;
  voice?: unknown;
}

export type ChatSubmissionIssueCode =
  | 'invalid_submission'
  | 'client_msg_id_missing'
  | 'client_msg_id_invalid'
  | 'empty_submission'
  | 'invalid_target'
  | 'attachment_id_missing'
  | 'attachment_id_invalid'
  | 'attachment_path_forbidden'
  | 'attachment_metadata_invalid'
  | 'voice_metadata_invalid';

export interface ChatSubmissionIssue {
  code: ChatSubmissionIssueCode;
  message: string;
  field?: string;
  attachmentIndex?: number;
}

export type ChatSubmissionResult<T = CanonicalChatSubmission> =
  | { ok: true; value: T }
  | { ok: false; issue: ChatSubmissionIssue };

export interface CanonicalChatSubmissionWireMessage {
  action: 'chat';
  clientCapabilities: ChatClientCapability[];
  submission: CanonicalChatSubmission;
}

const FORBIDDEN_ATTACHMENT_PATH_KEYS = [
  'savedPath',
  'relativePath',
  'absolutePath',
  'displayPath',
  'filePath',
  'localPath',
  'path',
  'uri',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
}

function attachmentIssue(
  code: ChatSubmissionIssueCode,
  message: string,
  attachmentIndex: number,
  field?: string,
): ChatSubmissionResult<never> {
  return { ok: false, issue: { code, message, attachmentIndex, ...(field ? { field } : {}) } };
}

export function isValidAttachmentId(value: unknown): value is string {
  return typeof value === 'string' && ATTACHMENT_ID_PATTERN.test(value.trim());
}

/**
 * Sanitize one upload result into an ID-authoritative attachment. Source path fields are never copied.
 */
export function normalizeChatSubmissionAttachment(
  input: ChatSubmissionAttachmentInput | unknown,
  attachmentIndex = 0,
): ChatSubmissionResult<CanonicalChatAttachment> {
  if (!isRecord(input)) {
    return attachmentIssue('attachment_metadata_invalid', '附件信息无效，请重新上传', attachmentIndex);
  }
  const attachmentId = typeof input.attachmentId === 'string' ? input.attachmentId.trim() : '';
  if (!attachmentId) {
    return attachmentIssue('attachment_id_missing', '上传成功但未返回 attachmentId，请重新上传', attachmentIndex, 'attachmentId');
  }
  if (!isValidAttachmentId(attachmentId)) {
    return attachmentIssue('attachment_id_invalid', 'attachmentId 格式无效，请重新上传', attachmentIndex, 'attachmentId');
  }

  const nestedDisplay = isRecord(input.display) ? input.display : undefined;
  const originalName = nonEmptyString(nestedDisplay?.originalName ?? input.originalName, 1024);
  if (!originalName) {
    return attachmentIssue('attachment_metadata_invalid', '附件文件名无效，请重新上传', attachmentIndex, 'originalName');
  }

  const mimeValue = nestedDisplay?.mimeType ?? input.mimeType;
  const mimeType = mimeValue === undefined ? undefined : nonEmptyString(mimeValue, 255);
  if (mimeValue !== undefined && !mimeType) {
    return attachmentIssue('attachment_metadata_invalid', '附件 MIME 信息无效', attachmentIndex, 'mimeType');
  }

  const sizeValue = nestedDisplay?.size ?? input.size;
  const size = sizeValue === undefined
    ? undefined
    : typeof sizeValue === 'number' && Number.isFinite(sizeValue) && sizeValue >= 0
      ? sizeValue
      : undefined;
  if (sizeValue !== undefined && size === undefined) {
    return attachmentIssue('attachment_metadata_invalid', '附件大小信息无效', attachmentIndex, 'size');
  }

  const imageValue = nestedDisplay?.isImage ?? input.isImage;
  if (imageValue !== undefined && typeof imageValue !== 'boolean') {
    return attachmentIssue('attachment_metadata_invalid', '附件图片标记无效', attachmentIndex, 'isImage');
  }

  return {
    ok: true,
    value: {
      attachmentId,
      display: {
        originalName,
        ...(mimeType ? { mimeType } : {}),
        ...(size !== undefined ? { size } : {}),
        ...(typeof imageValue === 'boolean' ? { isImage: imageValue } : {}),
      },
    },
  };
}

export function normalizeChatSubmissionAttachments(
  value: readonly ChatSubmissionAttachmentInput[] | unknown,
): ChatSubmissionResult<CanonicalChatAttachment[]> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) {
    return { ok: false, issue: { code: 'invalid_submission', message: 'attachments 必须是数组', field: 'attachments' } };
  }
  const attachments: CanonicalChatAttachment[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const result = normalizeChatSubmissionAttachment(value[index], index);
    if (!result.ok) return result;
    attachments.push(result.value);
  }
  return { ok: true, value: attachments };
}

function normalizeVoice(value: unknown): ChatSubmissionResult<CanonicalVoiceSubmission | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (!isRecord(value) || !isRecord(value.transcript)) {
    return { ok: false, issue: { code: 'voice_metadata_invalid', message: 'voice metadata 无效', field: 'voice' } };
  }
  const voiceIntentId = nonEmptyString(value.voiceIntentId, 64);
  const uploadRequestId = nonEmptyString(value.uploadRequestId, 64);
  const attachmentId = nonEmptyString(value.attachmentId, 64);
  const transcriptionId = nonEmptyString(value.transcriptionId, 64);
  const durationMs = value.durationMs;
  const transcriptText = typeof value.transcript.text === 'string' ? value.transcript.text.trim() : '';
  if (!voiceIntentId || !uploadRequestId || !attachmentId || !transcriptionId
    || !ATTACHMENT_ID_PATTERN.test(voiceIntentId) || !ATTACHMENT_ID_PATTERN.test(uploadRequestId)
    || !ATTACHMENT_ID_PATTERN.test(attachmentId) || !ATTACHMENT_ID_PATTERN.test(transcriptionId)
    || !Number.isSafeInteger(durationMs) || (durationMs as number) < 1_000 || (durationMs as number) > 180_000
    || value.transcript.status !== 'ready' || value.transcript.source !== 'server_stt'
    || typeof value.transcript.edited !== 'boolean' || !transcriptText || transcriptText.length > 100_000) {
    return { ok: false, issue: { code: 'voice_metadata_invalid', message: 'voice metadata 无效', field: 'voice' } };
  }
  return { ok: true, value: {
    voiceIntentId, uploadRequestId, attachmentId, transcriptionId,
    durationMs: durationMs as number,
    transcript: { status: 'ready', text: transcriptText, edited: value.transcript.edited, source: 'server_stt' },
  } };
}

function normalizeTarget(value: unknown): ChatSubmissionResult<CanonicalChatTarget> {
  if (value === undefined) return { ok: true, value: {} };
  if (!isRecord(value)) {
    return { ok: false, issue: { code: 'invalid_target', message: 'target 必须是对象', field: 'target' } };
  }
  const sessionId = value.sessionId === undefined ? undefined : nonEmptyString(value.sessionId, 512);
  if (value.sessionId !== undefined && !sessionId) {
    return { ok: false, issue: { code: 'invalid_target', message: 'sessionId 无效', field: 'target.sessionId' } };
  }
  const orgAgentId = value.orgAgentId === undefined ? undefined : nonEmptyString(value.orgAgentId, 512);
  if (value.orgAgentId !== undefined && !orgAgentId) {
    return { ok: false, issue: { code: 'invalid_target', message: 'orgAgentId 无效', field: 'target.orgAgentId' } };
  }
  const sandboxProfile = value.sandboxProfile;
  if (sandboxProfile !== undefined && sandboxProfile !== 'daily' && sandboxProfile !== 'coding') {
    return { ok: false, issue: { code: 'invalid_target', message: 'sandboxProfile 无效', field: 'target.sandboxProfile' } };
  }
  const agentTarget = value.agentTarget === undefined ? undefined : parseAgentTarget(value.agentTarget);
  if (value.agentTarget !== undefined && !agentTarget) {
    return { ok: false, issue: { code: 'invalid_target', message: 'agentTarget 无效', field: 'target.agentTarget' } };
  }
  if (agentTarget?.kind === 'org-agent' && orgAgentId && agentTarget.orgAgentId !== orgAgentId) {
    return { ok: false, issue: { code: 'invalid_target', message: 'agentTarget 与 orgAgentId 不一致', field: 'target' } };
  }
  if (agentTarget?.kind === 'personal' && orgAgentId) {
    return { ok: false, issue: { code: 'invalid_target', message: 'personal target 不允许 orgAgentId', field: 'target' } };
  }
  return {
    ok: true,
    value: {
      ...(sessionId ? { sessionId } : {}),
      ...(sandboxProfile ? { sandboxProfile } : {}),
      ...(agentTarget ? { agentTarget } : {}),
      ...(orgAgentId ? { orgAgentId } : {}),
    },
  };
}

/** Pure client/server builder. It strips all source paths by construction. */
export function normalizeChatSubmission(input: ChatSubmissionInput | unknown): ChatSubmissionResult {
  if (!isRecord(input)) {
    return { ok: false, issue: { code: 'invalid_submission', message: '提交内容必须是对象' } };
  }
  const text = typeof input.text === 'string' ? input.text : undefined;
  if (text === undefined) {
    return { ok: false, issue: { code: 'invalid_submission', message: 'text 必须是字符串', field: 'text' } };
  }
  const clientMsgId = nonEmptyString(input.clientMsgId, 200);
  if (!clientMsgId) {
    return {
      ok: false,
      issue: {
        code: input.clientMsgId === undefined || input.clientMsgId === null || input.clientMsgId === ''
          ? 'client_msg_id_missing'
          : 'client_msg_id_invalid',
        message: 'clientMsgId 无效',
        field: 'clientMsgId',
      },
    };
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(clientMsgId)) {
    return { ok: false, issue: { code: 'client_msg_id_invalid', message: 'clientMsgId 格式无效', field: 'clientMsgId' } };
  }

  const target = normalizeTarget(input.target);
  if (!target.ok) return target;
  const deliveryMode = input.deliveryMode ?? 'queue';
  if (deliveryMode !== 'queue' && deliveryMode !== 'steer') {
    return { ok: false, issue: { code: 'invalid_submission', message: 'deliveryMode 无效', field: 'deliveryMode' } };
  }
  const model = input.model === undefined || input.model === null || input.model === ''
    ? undefined
    : nonEmptyString(input.model, 512);
  if (input.model !== undefined && input.model !== null && input.model !== '' && !model) {
    return { ok: false, issue: { code: 'invalid_submission', message: 'model 无效', field: 'model' } };
  }
  const attachments = normalizeChatSubmissionAttachments(input.attachments);
  if (!attachments.ok) return attachments;
  const voice = normalizeVoice(input.voice);
  if (!voice.ok) return voice;
  if (voice.value && !attachments.value.some((attachment) => attachment.attachmentId === voice.value!.attachmentId)) {
    return { ok: false, issue: { code: 'voice_metadata_invalid', message: 'voice attachmentId 必须关联 canonical attachment', field: 'voice.attachmentId' } };
  }
  if (!text.trim() && attachments.value.length === 0 && !voice.value) {
    return { ok: false, issue: { code: 'empty_submission', message: '消息内容不能为空' } };
  }

  return {
    ok: true,
    value: {
      version: CHAT_SUBMISSION_VERSION,
      text,
      clientMsgId,
      target: target.value,
      deliveryMode,
      ...(model ? { model } : {}),
      attachments: attachments.value,
      ...(voice.value ? { voice: voice.value } : {}),
    },
  };
}

/**
 * Strict parser for the V1 wire/HTTP boundary. Unlike the client builder, path-shaped keys are rejected,
 * not merely stripped, so a caller cannot smuggle a path into a durable snapshot.
 */
export function parseCanonicalChatSubmission(value: unknown): ChatSubmissionResult {
  if (!isRecord(value) || value.version !== CHAT_SUBMISSION_VERSION) {
    return { ok: false, issue: { code: 'invalid_submission', message: 'chat submission version 无效', field: 'version' } };
  }
  if (isRecord(value.voice)) {
    for (const key of FORBIDDEN_ATTACHMENT_PATH_KEYS) {
      if (Object.prototype.hasOwnProperty.call(value.voice, key)) {
        return { ok: false, issue: { code: 'attachment_path_forbidden', message: `canonical voice 不允许字段 ${key}`, field: `voice.${key}` } };
      }
    }
  }
  if (Array.isArray(value.attachments)) {
    for (let index = 0; index < value.attachments.length; index += 1) {
      const attachment = value.attachments[index];
      if (!isRecord(attachment)) continue;
      const display = isRecord(attachment.display) ? attachment.display : undefined;
      for (const key of FORBIDDEN_ATTACHMENT_PATH_KEYS) {
        if (Object.prototype.hasOwnProperty.call(attachment, key)
          || (display && Object.prototype.hasOwnProperty.call(display, key))) {
          return attachmentIssue(
            'attachment_path_forbidden',
            `canonical attachment 不允许字段 ${key}`,
            index,
            `attachments[${index}].${key}`,
          );
        }
      }
    }
  }
  return normalizeChatSubmission(value);
}

/** Build the only V1 chat wire envelope. Legacy path fields are not representable here. */
export function toCanonicalChatSubmissionWireMessage(
  submission: CanonicalChatSubmission,
  capabilities: readonly Exclude<ChatClientCapability, typeof CHAT_SUBMISSION_V1_CAPABILITY>[] = [],
): CanonicalChatSubmissionWireMessage {
  return {
    action: 'chat',
    clientCapabilities: [CHAT_SUBMISSION_V1_CAPABILITY, ...capabilities],
    submission,
  };
}

export function canonicalChatAttachmentToDisplay(attachment: CanonicalChatAttachment): {
  name: string;
  attachmentId: string;
  mimeType?: string;
  size?: number;
  isImage?: boolean;
} {
  return {
    name: attachment.display.originalName,
    attachmentId: attachment.attachmentId,
    ...(attachment.display.mimeType ? { mimeType: attachment.display.mimeType } : {}),
    ...(attachment.display.size !== undefined ? { size: attachment.display.size } : {}),
    ...(attachment.display.isImage !== undefined ? { isImage: attachment.display.isImage } : {}),
  };
}
