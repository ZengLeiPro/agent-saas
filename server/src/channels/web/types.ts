import type { UploadedFileInfo } from '../../types/index.js';
import type { CanonicalChatSubmission } from '@agent/shared/lib/chatSubmission';

export interface VoiceFileInfo {
  /** 上传后的绝对路径 */
  savedPath: string;
  /** 相对于 userCwd 的路径 */
  relativePath: string;
  /** 录音时长（毫秒） */
  duration: number;
}

/** Canonical HTTP-equivalent boundary (the active transport is WS). */
export interface ChatRequest {
  submission: CanonicalChatSubmission;
  /** M50-04 isolated legacy voice payload. */
  voiceFile?: VoiceFileInfo;
}

/** @deprecated N-1 HTTP shape retained only for explicit compatibility adapters. */
export interface LegacyChatRequest {
  message: string;
  sessionId?: string;
  attachments?: UploadedFileInfo[];
  model?: string;
  voiceFile?: VoiceFileInfo;
}
