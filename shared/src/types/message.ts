import type { ToolPresentation } from '../lib/toolPresentation';
import type { ToolResultMetadata } from '../lib/toolResultMetadata';
import type { PresentationBlock } from '../lib/presentation/types';
import type { BusinessStepEventItem } from '../lib/extractTodos';
import type { CanonicalError } from '../lib/canonicalError';
import type { RuntimeFailureKind, RuntimeRecoveryAction } from './runtimeFailure';

/**
 * 业务步骤节：从步骤 start 事件到其终态事件之间的所有渲染单元，
 * 按原时间顺序收编为一节（内容不搬运、不倒流，只加一层归属）。
 * terminal 缺失 = 步骤仍在进行（或被打断）。
 */
export interface BusinessStepSection {
  type: 'business_step_section';
  id: string;
  start: BusinessStepEventItem;
  terminal?: BusinessStepEventItem;
  items: RenderItem[];
  /** 进行中且 run 活跃（流末尾的开放节）。 */
  isActive: boolean;
  /** 该开放节中途经过上下文压缩；run 空闲时应明确显示待恢复，而非未开始。 */
  resumePending?: boolean;
  /**
   * 跨层矛盾（2026-08-03 任务 C）：步骤宣称干净完成（complete 且 outcome tone 非
   * warn/fail），但区间内同类操作的**最后一次**调用平台事实仍是失败（presentation
   * status=warn）。渲染层在终态徽标旁加浅色「过程有异常」角标，不改写模型文本。
   * 失败→重试成功是正常模式，不触发（同类取最后一次）。
   */
  processAnomaly?: boolean;
  /**
   * 外部系统写操作行的 message id（2026-08-04 曾磊拍板）。步骤终态后过程整体收起，
   * 但「AI 动了客户自己的系统」要留痕——渲染层按这些 id 从 items 里挑行继续渲染。
   * 存 id 不存节点：items 由渲染层实例化，这里只表达「哪几条该留」。
   */
  systemActionIds?: string[];
}

export type AskUserAnswerValue = string | string[];
export type AskUserAnswers = Record<string, AskUserAnswerValue>;
export type SubagentStatus = "running" | "completed" | "failed" | "cancelled" | "timeout";

export interface MessageAttachmentDisplay {
  name: string;
  /** M20-01 authority for new submissions/replay. */
  attachmentId?: string;
  mimeType?: string;
  size?: number;
  isImage?: boolean;
  /** @deprecated Legacy transcript display only; never use as submission authority. */
  relativePath?: string;
}

export interface MessageModerationMetadata {
  eventId: string;
  moderationId: string;
  runId: string;
  messageId: string;
  blockId?: string;
  outcome: 'allowed' | 'blocked' | 'flagged';
  reasonCode?: string;
}

export type MessageItem =
  | { id: string; type: "user"; content: string; displayContent?: string; attachments?: MessageAttachmentDisplay[]; isVoiceTranscript?: boolean; status?: 'pending' | 'queued' | 'sent' | 'failed'; timestamp?: number; clientMsgId?: string; failedReason?: string; moderation?: MessageModerationMetadata }
  | { id: string; type: "text"; content: string; streaming?: boolean; draftId?: string; runId?: string; finalOutput?: boolean; voiceMarkers?: Array<{ text: string; voice?: string; speed?: number }>; owner?: string; timestamp?: number; guardrailEventId?: string; display?: PresentationBlock[]; moderation?: MessageModerationMetadata }
  | { id: string; type: "system_event"; title: string; content: string; timestamp?: number }
  | { id: string; type: "thinking"; content: string; streaming?: boolean; draftId?: string; startedAt?: number; durationMs?: number }
  | {
      id: string;
      type: "tool_use";
      toolName: string;
      toolInput: string;
      toolId: string;
      /** 所属 runtime run；用于把跨 user turn 的同一次业务执行保持为一个步骤计划。 */
      runId?: string;
      streaming?: boolean;
      result?: string;
      resultReady?: boolean;
      executionStatus?: "pending" | "running" | "completed" | "failed" | "cancelled";
      invocationId?: string;
      durationMs?: number;
      lastProgress?: string;
      error?: string;
      /** 「给人看」摘要；有值时非 debug 视图也渲染，debug 视图额外叠加原始 payload */
      presentation?: ToolPresentation;
      /**
       * 结构化执行事实（exitCode / 字节数 / 耗时 …），已过 normalizeToolResultMetadata。
       * 渲染层据此判定 ✓/✗——原值优先于从正文正则回捞的 `Exit code: N` 行。
       */
      toolMetadata?: ToolResultMetadata;
      /**
       * 默认展开摘要详情（来自 transcript block 的 defaultOpen）。
       * 真实会话的 tool_use 块 defaultOpen 恒为 false（parse.ts），
       * 该通道现阶段仅由演示剧本携带高价值执行块时使用。
       */
      defaultExpanded?: boolean;
    }
  | { id: string; type: "tool_result"; toolName: string; result: string; toolId: string; presentation?: ToolPresentation }
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
      interactionVersion?: number;
      interactionOrder?: number;
      toolName: string;
      toolInput: string;
      status: "pending" | "allowed" | "denied";
    }
  | {
      id: string;
      type: "ask_user";
      interactionId: string;
      interactionVersion?: number;
      interactionOrder?: number;
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
      failureKind?: RuntimeFailureKind;
      recoveryAction?: RuntimeRecoveryAction;
      resultPreview?: string;
      /** 「给人看」摘要；有值时非 debug 视图也呈现子任务 */
      presentation?: ToolPresentation;
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
       * Artifact 归档标识。Artifact(action="deliver") 产出的正式交付物会带上此字段：
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
      /** Same-origin authenticated attachment route; never file://. */
      audioUrl: string;
      attachmentId?: string;
      voiceIntentId?: string;
      uploadRequestId?: string;
      transcriptionId?: string;
      duration: number;
      transcribedText?: string;
      status: 'uploading' | 'transcribing' | 'ready' | 'sent' | 'failed';
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
      failureKind?: RuntimeFailureKind;
      recoveryAction?: RuntimeRecoveryAction;
      /** M40-05 sanitized cross-transport authority; safe to persist and restore. */
      canonicalFailure?: CanonicalError;
      /** 终态所属 runtime run；用于 live 与 durable refresh 稳定去重。 */
      runId?: string;
      timestamp?: number;
    };

/** MessageItem with `id` optional -- used when creating messages before storage assigns an ID */
export type MessageItemInput = MessageItem extends infer T ? T extends MessageItem ? Omit<T, 'id'> & { id?: string } : never : never;

export interface UploadedFile {
  /** Server-issued upload authority. Canonical chat V1 requires this to be present and valid. */
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

/** MessageList render unit = message | activity group | business step event | business step section */
export type RenderItem = MessageItem | ActivityGroup | BusinessStepEventItem | BusinessStepSection;
