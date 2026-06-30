export type MessageItem =
  | { id: string; type: "user"; content: string; displayContent?: string; attachments?: Array<{ name: string; isImage?: boolean }>; isVoiceTranscript?: boolean; status?: 'pending' | 'sent' | 'failed'; timestamp?: number; clientMsgId?: string; failedReason?: string }
  | { id: string; type: "text"; content: string; streaming?: boolean; voiceMarkers?: Array<{ text: string; voice?: string; speed?: number }>; owner?: string; timestamp?: number }
  | { id: string; type: "thinking"; content: string; streaming?: boolean }
  | { id: string; type: "tool_use"; toolName: string; toolInput: string; toolId: string; streaming?: boolean; result?: string; resultReady?: boolean }
  | { id: string; type: "tool_result"; toolName: string; result: string; toolId: string }
  | {
      id: string;
      type: "permission_request";
      interactionId: string;
      toolName: string;
      toolInput: string;
      status: "pending" | "allowed" | "denied";
    }
  | {
      id: string;
      type: "ask_user";
      interactionId: string;
      questions: Array<{
        question: string;
        header: string;
        options: Array<{ label: string; description: string }>;
        multiSelect: boolean;
      }>;
      status: "pending" | "answered";
      answers?: Record<string, string>;
    }
  | {
      id: string;
      type: "subagent";
      toolId: string;
      agentType: string;
      status: "running" | "completed";
    }
  | {
      id: string;
      type: "file_download";
      fileName: string;
      fileType: string;
      filePath: string;
      fileSize: number;
      owner?: string;
    }
  | {
      id: string;
      type: "voice";
      voiceMarkers: Array<{ text: string; voice?: string; speed?: number }>;
    }
  | {
      id: string;
      type: "user-voice";
      audioUrl: string;
      duration: number;
      transcribedText?: string;
      status: 'uploading' | 'transcribing' | 'sent' | 'failed';
      timestamp?: number;
      clientMsgId?: string;
      failedReason?: string;
    }
  /**
   * 会话级失败/取消提示。区别于 user/tool/AI 输出,这条用于明确告知用户
   * "这次 run 异常结束"。WS done.error / session_status.failed/cancelled / 进会话
   * 时 lastRunState.failed 都会注入这种消息,UI 用红/灰边框 + 图标突出渲染,
   * 与普通 AI 文本明确区分。
   */
  | {
      id: string;
      type: "system-error";
      /** 错误描述,通常是 model error message 或泛化提示文案 */
      content: string;
      /** 失败种类,UI 用来微调外观;默认 'error' */
      severity?: 'error' | 'cancelled';
      timestamp?: number;
    };

/** MessageItem with `id` optional -- used when creating messages before storage assigns an ID */
export type MessageItemInput = MessageItem extends infer T ? T extends MessageItem ? Omit<T, 'id'> & { id?: string } : never : never;

export interface UploadedFile {
  originalName: string;
  savedPath: string;
  relativePath: string;
  size: number;
  mimeType: string;
  isImage: boolean;
  previewUrl?: string;
}

/** Activity types that can be grouped */
export const ACTIVITY_TYPES: Set<MessageItem['type']> = new Set([
  'thinking', 'tool_use', 'subagent',
]);

/** Render-layer activity group */
export interface ActivityGroup {
  type: 'activity_group';
  id: string;
  items: MessageItem[];
  isActive: boolean;
}

/** MessageList render unit = message | activity group */
export type RenderItem = MessageItem | ActivityGroup;
