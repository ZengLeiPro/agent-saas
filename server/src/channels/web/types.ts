import type { UploadedFileInfo } from '../../types/index.js';

export interface VoiceFileInfo {
  /** 上传后的绝对路径 */
  savedPath: string;
  /** 相对于 userCwd 的路径 */
  relativePath: string;
  /** 录音时长（毫秒） */
  duration: number;
}

export interface ChatRequest {
  message: string;
  sessionId?: string;
  attachments?: UploadedFileInfo[];
  model?: string;
  /** 语音消息附带的音频文件信息 */
  voiceFile?: VoiceFileInfo;
}
