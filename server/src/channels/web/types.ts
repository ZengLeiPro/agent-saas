import type { UploadedFileInfo } from '../../types/index.js';
import type { CanonicalChatSubmission } from '@agent/shared';

/** Canonical HTTP-equivalent boundary (the active transport is WS). */
export interface ChatRequest {
  submission: CanonicalChatSubmission;
}

/** @deprecated N-1 HTTP shape retained only for explicit compatibility adapters. */
export interface LegacyChatRequest {
  message: string;
  sessionId?: string;
  attachments?: UploadedFileInfo[];
  model?: string;
}
