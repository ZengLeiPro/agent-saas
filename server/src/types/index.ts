/**
 * Shared Type Definitions
 *
 * 系统核心运行时契约 + 全局配置类型的统一导出。
 * 所有模块统一从此文件导入，不要直接导入 app/config.js。
 */

import type { Express } from "express";

// ============================================
// Core Runtime Contracts
// ============================================

export type ChannelType = "web" | "dingtalk" | "cron";

export interface UploadedFileInfo {
  /** 服务端生成的不可猜附件标识；旧客户端/钉钉存量消息可能缺失。 */
  attachmentId?: string;
  originalName: string;
  /** 仅服务端通道（如钉钉下载）可提供；Web 客户端不再接收或回传宿主机绝对路径。 */
  savedPath?: string;
  relativePath: string;
  size: number;
  mimeType: string;
  isImage: boolean;
}

export interface InboundMessage {
  channel: ChannelType;
  chatId: string;
  content: string;
  senderId?: string;
  senderName?: string;
  attachments?: UploadedFileInfo[];
  metadata?: Record<string, unknown>;
}

export type OutboundEventType =
  | "session_init"
  | "thinking_start"
  | "thinking_delta"
  | "thinking_end"
  | "text_start"
  | "text_delta"
  | "text_end"
  | "tool_start"
  | "tool_input_delta"
  | "tool_end"
  | "tool_execution_start"
  | "tool_execution_end"
  | "tool_result"
  | "permission_request"
  | "ask_user"
  | "subagent_start"
  | "subagent_end"
  // SDK 0.2.112+：每轮 result 后推送上下文占用细分（分类堆叠 + memoryFiles + mcpTools + autoCompact 阈值）
  | "context_usage"
  // SDK 0.2.112+ system message 新增 subtype：plugin 安装进度 / REPL 通知 / 记忆召回
  | "plugin_install"
  | "notification"
  | "memory_recall"
  // /compact v2（2026-07-03）：压缩过程黑箱化，只对外发开始/结束两个事件
  | "compaction_start"
  | "compaction_end"
  | "done"
  | "error";

/** compaction_end 携带的压缩结果（黑箱压缩对外唯一的数据出口） */
export interface CompactionOutboundData {
  /** 摘要正文（前端 debugMode 展开查看用；skipped 时为空） */
  summary?: string;
  /** 被摘要替代的历史事件数 */
  coveredEventCount: number;
  /** 历史过短，本次未执行压缩 */
  skipped?: boolean;
  /** skipped 时的用户可读说明 */
  note?: string;
}

export interface ContextUsageData {
  totalTokens: number;
  maxTokens?: number;
  percentage?: number;
  model?: string;
  categories: Array<{
    name: string;
    tokens: number;
    color: string;
    isDeferred?: boolean;
  }>;
  memoryFiles: Array<{ path: string; type: string; tokens: number }>;
  mcpTools: Array<{
    name: string;
    serverName: string;
    tokens: number;
    isLoaded?: boolean;
  }>;
  /** Cumulative cache hit tokens in the current session/run snapshot. */
  cacheReadTokens?: number;
  /** Cumulative cache hit denominator with model-specific accounting applied. */
  cacheHitDenominatorTokens?: number;
  /** Cumulative cache hit ratio. Null means there is no valid denominator yet. */
  cacheHitRatio?: number | null;
  /** Cache hit ratio for the latest completed model request. */
  lastRequestCacheHitRatio?: number | null;
  lastRequestCacheReadTokens?: number;
  lastRequestCacheHitDenominatorTokens?: number;
  autoCompactThreshold?: number;
  isAutoCompactEnabled?: boolean;
}

export interface PluginInstallData {
  status: "started" | "installed" | "failed" | "completed";
  name?: string;
  errorMessage?: string;
}

export interface NotificationData {
  key: string;
  text: string;
  priority: "low" | "medium" | "high" | "immediate";
  color?: string;
  timeoutMs?: number;
}

export interface MemoryRecallData {
  mode: "select" | "synthesize";
  memories: Array<{
    path: string;
    scope: "personal" | "team";
    content?: string;
  }>;
}

export interface ModelProviderOptions {
  thinking?: unknown;
  reasoningEffort?: string;
  extraBody?: Record<string, unknown>;
  /** 显式输入模态能力；undefined 表示 unknown，SaaS 侧不得按模型名称自动推断。 */
  inputModalities?: Array<'text' | 'image'>;
  /**
   * 单轮回答最大输出 token（配置层 max_output_tokens 的运行时映射）。
   * 优先级：ModelRequest.maxOutputTokens（调用方显式）> 本字段 > adapter 默认 4096。
   */
  maxOutputTokens?: number;
  /**
   * Responses 发流前瞬时故障的退避间隔。数组每一项代表一次额外重试；未配置时不重试。
   * 仅覆盖 fetch 网络错误、502/503/504，以及错误信息明确包含 EOF/连接断开的 HTTP 500。
   */
  preStreamRetryDelaysMs?: number[];
  // ── Responses API v1（RFC P0.5）：仅 protocol="responses" 时生效 ──
  /** 协议路由，默认 chat_completions（保持现有行为）。 */
  protocol?: "chat_completions" | "responses";
  /** response.model 字段的实际别名值（用于 actualModelSeen 校验）。 */
  aliasActual?: string;
  /** 模型是否在响应里公开 reasoning summary（隐藏派=false，公开派=true）。 */
  supportsReasoningOutput?: boolean;
  /** 工具调用链路是否真正 think（doubao 被绕过=false）。 */
  supportsToolReasoning?: boolean;
  /** 模型支持的 tool_choice 模式白名单（glm 只接受 auto/none）。 */
  toolChoiceModes?: Array<"auto" | "required" | "none" | "specific">;
  /** call_id 格式（base62-24 / hex-24 / base32-24 / unknown），记录用。 */
  callIdFormat?: string;
  /** 伪推理模型标记（reasoning_tokens 永 0，且 Responses+tools 不兼容时设 true）。 */
  isPseudoReasoning?: boolean;
  /**
   * 关闭 Responses API 有状态接力（previous_response_id）。设 true 时 adapter 忽略
   * previousResponseId，每轮发全量 input（含成对 function_call + function_call_output），
   * 不依赖上游 store。用于无状态 OpenAI 兼容代理（cli-proxy 等）。
   */
  disableResponseChaining?: boolean;
  /**
   * 关闭 prompt_cache_key 传递。默认 false：adapter 以内容指纹（model + system/instructions
   * + sorted tool names 的 sha256 前 32 hex）作为 prompt_cache_key 发给上游，让相同前缀
   * 的请求路由到同一缓存分片、命中 prompt cache。设 true 时不传该字段。
   * 07-04 实测：CLIProxyAPI 会自动为每次请求生成新 UUID 覆盖 prompt_cache_key，
   * 显式传稳定 key 后 cached_tokens 命中率 76%+。默认关闭对所有主流兼容端点无害。
   */
  disablePromptCacheKey?: boolean;
  /** MCP 目录策略：auto 未验证能力时回退 eager；deferred 未验证时配置报错。 */
  mcpLoadingMode?: 'auto' | 'eager' | 'deferred';
  /** provider 原生工具搜索能力，必须由平台模型配置显式声明。 */
  toolSearchProtocol?: 'none' | 'openai_responses_hosted';
  /**
   * D1：deepseek-v4-pro 在 emit tool_call.arguments JSON string 字段时
   * 把反斜杠多 escape 一层（实测 2/2 稳定复现）。开启此 flag 后 ResponsesApiAdapter
   * 在 SSE 累积完成后会对每个 toolCall.arguments 做一次反向 unescape。仅对 deepseek 路径开启。
   */
  applyDeepseekArgumentUnescape?: boolean;
}

/** 原始上下文用量结构（透传给前端以便未来字段扩展） */
export type ContextUsageRaw = Record<string, unknown>;

export interface AskUserQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}

export interface OutboundEvent {
  type: OutboundEventType;
  sessionId?: string;
  content?: string;
  toolName?: string;
  toolId?: string;
  partialJson?: string;
  toolResult?: string;
  isError?: boolean;
  invocationId?: string;
  status?: "success" | "error" | "cancelled";
  durationMs?: number;
  error?: string;
  interactionId?: string;
  displayName?: string;
  toolInput?: Record<string, unknown>;
  questions?: AskUserQuestion[];
  agentType?: string;
  transcriptPath?: string;
  contextUsage?: ContextUsageData;
  pluginInstall?: PluginInstallData;
  notification?: NotificationData;
  memoryRecall?: MemoryRecallData;
  compaction?: CompactionOutboundData;
}

export interface UserPermissions {
  maxTurns?: number;
  rateLimit?: { maxRequests?: number; windowMs?: number };
}

export interface UserIdentity {
  id: string;
  username: string;
  role: "admin" | "user";
  /**
   * Tenant 归属（多组织改造 PR 4）。channels/dingtalk 等入口构造 UserIdentity
   * 时应从 UserRecord.tenantId 透传；未传则下游 resolveUserCwd fallback DEFAULT。
   */
  tenantId?: string;
  realName?: string;
  externalId?: string;
  dingtalkStaffId?: string;
  permissions?: UserPermissions;
}

export interface ChannelContext {
  channel: ChannelType;
  resumeSessionId?: string;
  systemContext?: string;
  timezone?: string;
  user?: UserIdentity;
  /** Admin 代操作时：会话原归属者的身份（用于 AI 身份注入） */
  sessionOwner?: UserIdentity;
  /** Admin 代操作时：覆盖 dispatch 的 cwd（指向会话所有者的 workspace） */
  targetCwd?: string;
}

export interface SendOptions {
  chatId: string;
  content: string;
  msgType?: "text" | "markdown";
  metadata?: Record<string, unknown>;
}

export interface BaseChannel {
  readonly name: ChannelType;
  start(app: Express): Promise<void>;
  stop(): Promise<void>;
  send?(options: SendOptions): Promise<void>;
}

// ============================================
// Configuration Types
// ============================================

export type {
  ProxyConfig,
  AgentPermissionMode,
  AgentSettingSource,
  AgentConfig,
  ServerConfig,
  CronConfig,
  DingtalkRobotConfig,
  DingtalkConfig,
  DingtalkSendMessageConfig,
  TtsConfig,
  WebMessageDisplayConfig,
  DingtalkMessageDisplayConfig,
  MessageDisplayConfig,
  DispatchRateLimitConfig,
  DispatchConfig,
  ObservabilityAuditConfig,
  ObservabilityConfig,
  SystemMonitorConfig,
  AlertingConfig,
  MemoryInjectContextConfig,
  MemoryMaintenanceConfig,
  MemoryConfig,
  AuthConfig,
  ModelItem,
  ModelGroup,
  ModelsConfig,
  TitleGeneratorAppConfig,
  RuntimeEventRetentionConfig,
  AppConfig,
} from "../app/config.js";
