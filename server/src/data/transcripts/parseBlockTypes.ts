/**
 * Transcript block 的公开形状。
 *
 * 从 parse.ts 抽出（解析逻辑与数据形状分家）；parse.ts 原样转发，
 * 外部继续从 './parse.js' 引用这些类型。
 */
import type { MessageAttachmentDisplay } from '@agent/shared';
import type { RuntimeFailureKind } from '../../types/index.js';

export type TranscriptBlockKind =
  'prompt' | 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'compaction' | 'meta';

export interface TranscriptSubagentActivity {
  agentType: string;
  description: string;
  childSessionId: string;
  childRunId: string;
  model?: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout';
  durationMs?: number;
  totalTokens?: number;
  toolUseCount?: number;
  turnCount?: number;
  errorMessage?: string;
  failureKind?: RuntimeFailureKind;
  recoveryAction?: 'switch_model';
  resultPreview?: string;
}
export interface TranscriptBlock {
  id: string;
  tsMs?: number;
  kind: TranscriptBlockKind;
  title: string;
  defaultOpen: boolean;
  /** Human-friendly content shown by default */
  content: string;
  /** Optional raw JSON for debugging */
  raw?: string;
  /** Mark blocks that represent an error */
  isError?: boolean;
  /** Tool name (for tool_use/tool_result) */
  toolName?: string;
  /** Tool use ID (for correlation) */
  toolId?: string;
  /** Activity duration derived from runtime events, when available */
  durationMs?: number;
  /** Tool lifecycle state derived from durable runtime events */
  executionStatus?: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  /** Agent 工具对应的 durable child run 元数据。 */
  subagent?: TranscriptSubagentActivity;
  /** User prompt originated from mobile voice transcription */
  isVoiceTranscript?: boolean;
  /** User prompt 携带的附件元数据（来自 transcript user 行顶层 attachments 字段） */
  attachments?: MessageAttachmentDisplay[];
  /** 用户消息客户端幂等 ID；刷新后继续用于消息与队列精确对账。 */
  clientMsgId?: string;
  /** 插话来源 run ID；detail API 据此排除已经投影进时间线的 pending steering。 */
  interjectionSourceRunId?: string;
  /** compaction block：被摘要替代的历史事件数 */
  coveredEventCount?: number;
  /** assistant 行对应的 runtime event id；用于按成功 Run 终态追认最终输出。 */
  sourceEventId?: string;
  /** assistant 行所属 runtime run id。 */
  runId?: string;
  /** text block 是否是所属 Run 成功终态的最终输出。 */
  finalOutput?: boolean;
  /** 门禁拒答合成 assistant 行关联的 guardrail event id（员工申诉入口用） */
  guardrailEventId?: string;
  /** Explicit moderation domain fact; never inferred from text/error/tool payloads. */
  moderation?: { eventId: string; outcome: 'allowed' | 'blocked' | 'flagged'; reasonCode?: string };
  /**
   * tool_use block：工具执行的「给人看」摘要。
   *
   * 类型刻意是 `unknown` 而非 ToolPresentation——本文件是不可信边界
   * （JSONL 可能被手改、可能来自旧版本、可能来自 fork），真正的校验器是
   * shared 的 `normalizeToolPresentation`。在这里标强类型等于把校验责任
   * 错放到一个不做校验的地方。
   *
   * 落盘写在 tool_result 行上（tool_use 行在工具执行前就已写出），
   * 解析时按 tool_use_id 反向嫁接到对应的 tool_use block。
   */
  presentation?: unknown;
  /**
   * tool_use block：工具执行的结构化事实（exitCode / 字节数 / 耗时 …）。
   * 与 presentation 同一条落盘与嫁接通道，类型同样刻意是 `unknown`——本文件是
   * 不可信边界，权威校验器是 shared 的 `normalizeToolResultMetadata`；公开分享安全活动以 `publicActivityOnly` 标记。
   */
  toolMetadata?: unknown;
  publicActivityOnly?: boolean;
}
