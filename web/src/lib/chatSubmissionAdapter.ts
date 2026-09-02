import {
  normalizeChatSubmission,
  normalizeChatSubmissionAttachments,
  toCanonicalChatSubmissionWireMessage,
  type CanonicalChatSubmissionWireMessage,
  type ChatSubmissionInput,
  type ChatSubmissionResult,
  type UploadedFile,
} from '@agent/shared';

/** Thin Web adapter: shares the exact Mobile/server canonical normalizer. */
export function buildWebChatSubmission(input: ChatSubmissionInput): ChatSubmissionResult {
  return normalizeChatSubmission(input);
}

export function validateWebUploadedFiles(
  files: readonly UploadedFile[],
): ReturnType<typeof normalizeChatSubmissionAttachments> {
  return normalizeChatSubmissionAttachments(files);
}

export function toWebChatWireMessage(
  submission: Extract<ChatSubmissionResult, { ok: true }>['value'],
): CanonicalChatSubmissionWireMessage {
  return toCanonicalChatSubmissionWireMessage(submission, ['replaceable_drafts']);
}
