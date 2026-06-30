/**
 * Agent Dispatch Types
 *
 * Agent 调度相关的核心类型：调度函数签名、运行选项、生命周期钩子。
 * 供 OpenAI runner（生产者）、engine/dispatch（中间件增强）、channels/cron（消费者）共同使用。
 */

import type {
  ChannelContext,
  InboundMessage,
  OutboundEvent,
  AskUserQuestion,
  ModelProviderOptions,
} from '../types/index.js';
import type { ExecutionTargetKind } from './toolRuntime.js';

export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'
  | 'auto';

/**
 * 模型 usage 按模型聚合后的字段。
 */
export interface SdkResultModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  apiRequestCount?: number;
  costUSD?: number;
  webSearchRequests?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface AgentRunResultMeta {
  subtype?: string;
  numTurns?: number;
  resultText?: string;
  totalCostUsd?: number;
  /** SDK Result 累计 usage（按模型聚合后的 modelUsage 同样可用） */
  modelUsage?: Record<string, SdkResultModelUsage>;
  /** SDK 上报的 API 耗时（ms） */
  durationApiMs?: number;
}

export interface InteractionEvent {
  type: 'permission_request' | 'ask_user';
  interactionId: string;
  sessionId?: string;
  runId?: string;
  toolCallId?: string;
  invocationId?: string;
  toolId?: string;
  toolName?: string;
  displayName?: string;
  toolInput?: Record<string, unknown>;
  questions?: AskUserQuestion[];
}

export interface InteractionResponse {
  allow?: boolean;
  message?: string;
  answers?: Record<string, string | string[]>;
}

export interface SubagentStartInfo {
  agentType: string;
  toolUseId: string;
}

export interface SubagentEndInfo {
  transcriptPath?: string;
  toolUseId: string;
}

export interface AgentRunHooks {
  onSessionStart?: (
    sessionId: string,
    transcriptPath?: string,
  ) => void | Promise<void>;
  onResult?: (meta: AgentRunResultMeta) => void | Promise<void>;
  onInteraction?: (event: InteractionEvent) => Promise<InteractionResponse>;
  onSubagentStart?: (info: SubagentStartInfo) => void | Promise<void>;
  onSubagentEnd?: (info: SubagentEndInfo) => void | Promise<void>;
}

export interface ToolApprovalPolicyOptions {
  /** Session/run scoped opt-in: platform-admin runs may execute non-safe tools without Web approval. */
  autoApproveTools?: boolean;
  /** @deprecated Legacy client field. Treated the same as autoApproveTools. */
  autoApproveRunShell?: boolean;
}

export interface AgentRunOptions {
  cwd?: string;
  permissionMode?: PermissionMode;
  allowDangerouslySkipPermissions?: boolean;
  sandbox?: unknown;
  model?: string;
  maxTurns?: number;
  abortController?: AbortController;
  persistSession?: boolean;
  includePartialMessages?: boolean;
  resumeSessionId?: string;
  env?: Record<string, string>;
  additionalDirectories?: string[];
  /** 预批准的工具白名单（dontAsk 模式下，白名单外的工具一律拒绝） */
  allowedTools?: string[];
  /** inline settings（flag settings 层，最高优先级）用于注入 path-scoped 权限规则 */
  settings?: unknown;
  /** 跳过 system prompt 注入（使用最小化 preset） */
  skipSystemPrompt?: boolean;
  /** 跳过 PERSONA.md 注入 */
  skipPersona?: boolean;
  /** 跳过 MEMORY.md 注入 */
  skipMemory?: boolean;
  /**
   * provider-neutral 模型连接信息。raw runtime 与历史 OpenAI Agents runner 都可读取。
   */
  modelConnection?: { apiKey?: string; baseUrl?: string };
  /**
   * 模型/供应商专用请求选项。raw Chat Completions 运行时会映射到请求体。
   */
  modelProviderOptions?: ModelProviderOptions;
  /**
   * 内部验收/管理员开关：选择工具执行后端。默认 server-local。
   */
  executionTarget?: ExecutionTargetKind;
  approvalPolicy?: ToolApprovalPolicyOptions;
  /**
   * RuntimeScheduler auto-wake 内部入口：复用已 acquire lease 的 durable runId，
   * 避免恢复执行时再创建一个新的 run record。
   */
  runtimeRunId?: string;
  /**
   * RuntimeScheduler auto-wake 内部入口：把本次 prompt 发送给模型，但不追加
   * user_message 事件、不写 legacy transcript。用于已持久化用户消息后的隐藏 continue。
   */
  recordUserMessage?: boolean;
  /**
   * RuntimeScheduler auto-wake 内部入口：记录当前执行 run lease 的 worker，
   * 供 durable tool invocation / cancel delivery 做 ownership 校验。
   */
  runtimeWorkerId?: string;
  /**
   * 兼容旧字段名：保留给尚未清理的通道/测试代码。
   * 新代码应使用 modelConnection。
   */
  openaiAgentsConnection?: { apiKey?: string; baseUrl?: string };
}

export type AgentDispatch = (
  message: InboundMessage,
  context: ChannelContext,
) => AsyncGenerator<OutboundEvent>;

export type AgentRunDispatch = (
  message: InboundMessage,
  context: ChannelContext,
  options?: AgentRunOptions,
  hooks?: AgentRunHooks,
) => AsyncGenerator<OutboundEvent>;
