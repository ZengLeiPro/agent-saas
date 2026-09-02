import {
  normalizeChatSubmission,
  normalizeChatSubmissionAttachments,
  toCanonicalChatSubmissionWireMessage,
  type CanonicalChatSubmissionWireMessage,
  type ChatSubmissionInput,
  type ChatSubmissionResult,
  type UploadedFile,
} from '@agent/shared';

/** Thin Mobile adapter: all validation/sanitization remains authoritative in @agent/shared. */
export function buildMobileChatSubmission(
  input: ChatSubmissionInput,
): ChatSubmissionResult {
  return normalizeChatSubmission(input);
}

export function validateMobileUploadedFiles(
  files: readonly UploadedFile[],
): ReturnType<typeof normalizeChatSubmissionAttachments> {
  return normalizeChatSubmissionAttachments(files);
}

export function toMobileChatWireMessage(
  submission: Extract<ChatSubmissionResult, { ok: true }>['value'],
): CanonicalChatSubmissionWireMessage {
  return toCanonicalChatSubmissionWireMessage(submission);
}
