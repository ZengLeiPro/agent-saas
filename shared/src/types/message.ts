export type AskUserAnswerValue = string | string[];
export type AskUserAnswers = Record<string, AskUserAnswerValue>;
export type SubagentStatus = "running" | "completed" | "failed" | "cancelled" | "timeout";

export type MessageItem =
  | { id: string; type: "user"; content: string; displayContent?: string; attachments?: Array<{ name: string; isImage?: boolean; relativePath?: string }>; isVoiceTranscript?: boolean; status?: 'pending' | 'sent' | 'failed'; timestamp?: number; clientMsgId?: string; failedReason?: string }
  | { id: string; type: "text"; content: string; streaming?: boolean; voiceMarkers?: Array<{ text: string; voice?: string; speed?: number }>; owner?: string; timestamp?: number; guardrailEventId?: string }
  | { id: string; type: "thinking"; content: string; streaming?: boolean; startedAt?: number; durationMs?: number }
  | {
      id: string;
      type: "tool_use";
      toolName: string;
      toolInput: string;
      toolId: string;
      streaming?: boolean;
      result?: string;
      resultReady?: boolean;
      executionStatus?: "pending" | "running" | "completed" | "failed" | "cancelled";
      invocationId?: string;
      durationMs?: number;
      lastProgress?: string;
      error?: string;
    }
  | { id: string; type: "tool_result"; toolName: string; result: string; toolId: string }
  | {
      id: string;
      type: "runtime_status";
      status: "sending" | "queued" | "running" | "waiting_hand" | "waiting_approval" | "waiting_user" | "reconnecting";
      content?: string;
      streamId?: string;
      runId?: string;
      streaming?: boolean;
      timestamp?: number;
    }
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
      answers?: AskUserAnswers;
    }
  | {
      id: string;
      type: "subagent";
      toolId: string;
      agentType: string;
      status: SubagentStatus;
      childSessionId?: string;
      childRunId?: string;
      model?: string;
      durationMs?: number;
      totalTokens?: number;
      toolUseCount?: number;
      turnCount?: number;
      errorMessage?: string;
      resultPreview?: string;
    }
  | {
      id: string;
      type: "file_download";
      fileName: string;
      fileType: string;
      filePath: string;
      fileSize: number;
      owner?: string;
      /**
       * Artifact 归档标识。CreateArtifact 工具产出的正式交付物会带上此字段：
       * 有 artifactId 时前端走 /api/artifacts/:id/read-url 签名 URL 下载/预览；
       * 未提供（老的 [FILE] 标记路径）则走 /api/file/download 直读工作区文件。
       */
      artifactId?: string;
      /** artifact 分类，仅 artifactId 存在时有意义 */
      artifactKind?: 'file' | 'screenshot' | 'patch' | 'log' | 'blob';
      /** artifact blob 的 MIME 类型（内容寻址存储侧真实值） */
      mimeType?: string;
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
   * 会话级终态提示。区别于 user/tool/AI 输出，用来表达运行异常、用户取消，
   * 以及余额不足等可预期的账户状态。WS done.error / session_status / 进会话时
   * lastRunState 都会注入这种消息，UI 按 severity 使用不同语义样式。
   */
  | {
      id: string;
      type: "system-error";
      /** 面向用户的终态说明 */
      content: string;
      /** UI 语义：运行异常 / 用户取消 / 积分余额不足 */
      severity?: 'error' | 'cancelled' | 'billing';
      timestamp?: number;
    };

/** MessageItem with `id` optional -- used when creating messages before storage assigns an ID */
export type MessageItemInput = MessageItem extends infer T ? T extends MessageItem ? Omit<T, 'id'> & { id?: string } : never : never;

export interface UploadedFile {
  attachmentId?: string;
  originalName: string;
  savedPath?: string;
  relativePath: string;
  size: number;
  mimeType: string;
  isImage: boolean;
  previewUrl?: string;
}

/** Activity types that can be grouped */
export const ACTIVITY_TYPES: Set<MessageItem['type']> = new Set([
  'runtime_status', 'thinking', 'tool_use', 'subagent',
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
