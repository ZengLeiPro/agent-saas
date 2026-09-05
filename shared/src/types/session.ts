import type { AgentProfile } from './agent';
import type { MessageAttachmentDisplay } from './message';
import type { ToolPresentation } from '../lib/toolPresentation';
import type { RuntimeFailureKind, RuntimeRecoveryAction } from './runtimeFailure';
import type { ChatQueueSnapshot } from '../lib/chatQueue';
import type { RunLiveness } from '../lib/runLiveness';
import type { AgentTarget, AgentTargetIdentitySnapshot, AgentTargetUnavailableReason } from '../lib/agentTarget';
import type { CanonicalInteractionReceipt } from '../lib/activeInteraction';

/** ACS sandbox resource tier persisted on each session. */
export type SandboxProfile = 'daily' | 'coding';

/** 丰富的 owner 信息（含显示所需的头像、名字） */
export interface SessionOwnerInfo {
  userId: string;
  username: string;
  realName?: string;
  avatar?: string;
  avatarVersion?: number;
}

/** 会话参与者身份信息（用于消息渲染） */
export interface SessionParticipants {
  /** 会话所属用户的完整显示信息 */
  owner: SessionOwnerInfo;
  /** 该用户的 Agent 配置 */
  agent: AgentProfile | null;
}

export interface SessionListActiveInteraction {
  interactionId: string;
  type: 'ask_user' | 'permission_request' | 'approval';
  /** Stable monotonic server revision. */
  version: number;
  /** Stable FIFO server order; never derive from local timestamps. Optional only for N-1 servers. */
  order?: number;
  createdAt?: number;
  receipt?: CanonicalInteractionReceipt;
}

/** API session list item */
export interface ApiSessionListItem {
  sessionId: string;
  projectKey?: string;
  updatedAtMs: number;
  createdAtMs?: number;
  hasUnreadAiReply?: boolean;
  /** M20-07 monotonic metadata/read ordering fields. Optional for N-1 servers. */
  version?: number;
  readSeq?: number;
  readAt?: string;
  serverUpdatedAt?: string;
  sourceSeq?: number;
  title?: string;
  preview?: string;
  source?: { type: "web" | "dingtalk" | "cron"; label: string };
  owner?: SessionOwnerInfo;
  agent?: AgentProfile | null;
  model?: string;
  sandboxProfile?: SandboxProfile;
  cronJobId?: string;
  cronJobName?: string;
  /** 公司级专职 Agent 绑定（2026-07 唯恩批次）；缺省 = 个人 Agent 会话 */
  orgAgentId?: string;
  /** 专职 Agent 名称（server 列表序列化时按 orgAgentId join；Agent 已删除时缺省） */
  orgAgentName?: string;
  /** 当前登录用户是否仍可续聊该专职 Agent 会话；false 时前端进入只读态 */
  orgAgentAvailable?: boolean;
  /** M20-06 持久 Agent target；不得由 owner filter 推断。 */
  agentTarget?: AgentTarget;
  agentTargetBindingVersion?: number;
  /** Server-persisted authoritative header/list identity; never sourced from the current picker. */
  agentTargetSnapshot?: AgentTargetIdentitySnapshot;
  /** 历史可读、发送阻断时的结构化原因。 */
  agentTargetUnavailableReason?: AgentTargetUnavailableReason;
  /** M20-07 O(1) pending interaction summary; event history is never scanned by selectors. */
  activeInteraction?: SessionListActiveInteraction;
  /** 软删除时间戳，仅回收站列表返回 */
  deletedAt?: string;
  /** 执行删除的用户名，仅回收站列表返回 */
  deletedBy?: string;
}

export interface SessionListPage {
  sessions: ApiSessionListItem[];
  hasMore: boolean;
  /** Opaque base64url cursor encoding {v:1, updatedAtMs, sessionId}. */
  nextCursor?: string;
}

/** 最近一次 run 的终态。后端从 EventStore 最末一条 run_state_changed 派生。 */
export interface ApiLastRunState {
  runId: string;
  /** RunStatus: running/completed/failed/cancelled/... */
  status: string;
  /** run_state_changed.reason —— failed/cancelled 时通常带 model error message */
  error?: string;
  failureKind?: RuntimeFailureKind;
  recoveryAction?: RuntimeRecoveryAction;
  /** 配额窗口绝对重置时刻（ISO）；仅 failureKind='quota_exhausted' 时可能有 */
  quotaResetAt?: string;
  /** 该 run_state_changed 事件的 ISO timestamp */
  finishedAt?: string;
  /** Server-owned M40-02 projection; absent means legacy unknown. */
  liveness?: RunLiveness;
}

export type SessionDetailAccessMode = "owner" | "read_only";

/** API session detail */
export interface ApiSessionDetail {
  sessionId: string;
  stats: {
    lines: number;
    parsedLines: number;
    parseErrors: number;
  };
  blocks: ApiTranscriptBlock[];
  /**
   * full = 用当前快照替换本地；delta = 刷新尾部并追加新增块；
   * before = 向当前最早游标之前加载一页历史。
   * 字段可选以兼容尚未升级的服务端，缺省按 full 处理。
   */
  mode?: "full" | "delta" | "before";
  /** 当前服务端快照最后一个 transcript block 的稳定 ID，供下一次增量拉取。 */
  cursor?: string;
  /** 当前页面最早 transcript block 的稳定 ID，供向前分页。 */
  oldestCursor?: string;
  /** 当前客户端已加载到 transcript 起点。 */
  historyComplete?: boolean;
  /** M40-02 canonical history pager. Cursor encodes sequence/event index + stable id. */
  nextCursor?: string;
  hasMore?: boolean;
  /** Fences old in-flight pages after transcript compaction/replacement. */
  historyRevision?: string;
  /** delta 响应所基于的客户端游标。 */
  after?: string;
  /** before 响应所基于的客户端最早游标。 */
  before?: string;
  /** owner 可交互；read_only 仅允许查看 TaskBoard execution 历史。 */
  accessMode?: SessionDetailAccessMode;
  owner?: SessionOwnerInfo;
  source?: { type: string; label: string };
  sandboxProfile?: SandboxProfile;
  /** M30-03 authoritative identity for the detail header. */
  agentTarget?: AgentTarget;
  agentTargetBindingVersion?: number;
  agentTargetSnapshot?: AgentTargetIdentitySnapshot;
  agentTargetUnavailableReason?: AgentTargetUnavailableReason;
  /**
   * 最近一次 run 的终态。前端进会话时用于对账"后端早结束/失败、UI 仍在转" 的鬼状态。
   * 旧 transcript（无 run_state_changed 事件）会缺省此字段,前端走 legacy 路径。
   */
  lastRunState?: ApiLastRunState;
  /** M20-02 structured server-authoritative queue/runtime snapshot. */
  queueSnapshot?: ChatQueueSnapshot;
  /**
   * @deprecated N-1 pending-only projection. V1 clients consume queueSnapshot.
   * 服务端已持久接收、尚未开始执行的消息。普通 queue 与显式 steer 共用该权威快照，
   * 刷新、切会话和重连都据此恢复，客户端本地临时状态不得覆盖它。
   */
  queuedMessages?: Array<{
    sourceRunId: string;
    runId?: string;
    clientMsgId?: string;
    deliveryMode?: 'queue' | 'steer';
    targetRunId?: string;
    queuePosition?: number;
    content: string;
    /** Canonical queue snapshot: attachmentId + display metadata, never a path. */
    attachments?: Array<{
      name: string;
      attachmentId: string;
      size?: number;
      mimeType?: string;
      isImage?: boolean;
    }>;
    acceptedAt: string;
  }>;
}

/** Token usage statistics */
export interface TokenContextAccounting {
  /**
   * Whether `contextTokens` is an exact current-context count.
   * Exact means provider-reported usage covers the full context — true for
   * full-history requests AND stateful Responses chaining (upstream reports
   * cumulative input_tokens per turn, verified on Ark).
   */
  exact: boolean;
  kind: 'exact_current' | 'stateful_response_exact' | 'unknown';
  source: 'provider_usage' | 'unknown';
  label: string;
  reason?: string;
  /** Last provider request total kept for diagnostics when exact=false. */
  lastRequestTokens?: number;
}

/** 子 Agent 独立 child session 的累计模型用量。 */
export interface SubagentUsageBreakdown {
  childCount: number;
  requestCount: number;
  /** Provider 输入口径；OpenAI-compatible 模型中已包含缓存命中部分。 */
  inputTokens: number;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  /** Provider 上报值；0 不代表一定没有创建缓存。 */
  cacheCreationTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheHitDenominatorTokens: number;
  cacheHitRatio: number | null;
}

export interface TokenUsage {
  contextTokens: number;
  totalInputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalOutputTokens: number;
  subagentTotalTokens: number;
  /** 新 Agent 工具的 durable child-session 用量分项。 */
  subagentUsage?: SubagentUsageBreakdown;
  /** Cumulative token total with model-specific cache accounting applied. */
  totalTokens?: number;
  /** Cache hit denominator with model-specific accounting applied. */
  cacheHitDenominatorTokens?: number;
  /** Cumulative cache hit ratio. Null means there is no valid denominator yet. */
  cacheHitRatio?: number | null;
  contextAccounting?: TokenContextAccounting;
  /** 累积等效 API 成本（美元） */
  totalCostUsd?: number | null;
}

/** 上下文分项的统计口径。 */
export type ContextUsageAccuracy = 'provider' | 'estimated' | 'derived';

/** 当前模型上下文的结构化构成。 */
export interface ContextUsageCategory {
  key: string;
  name: string;
  tokens: number;
  color: string;
  accuracy: ContextUsageAccuracy;
  isDeferred?: boolean;
  children?: ContextUsageCategory[];
}

/** 当前模型请求采用的平台侧估算快照。 */
export interface ContextUsageBreakdown {
  method: 'utf8_bytes_v1';
  estimatedTokens: number;
  providerInputTokens?: number;
  providerContextTokens?: number;
  unattributedTokens: number;
  categories: ContextUsageCategory[];
  memoryFiles?: Array<{ path: string; type: string; tokens: number }>;
  mcpTools?: Array<{ name: string; serverName: string; tokens: number; isLoaded?: boolean }>;
  capturedAt?: string;
}

/** 会话累计模型用量。 */
export interface ContextUsageTotals {
  inputTokens: number;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

/** SDK 0.2.112+ getContextUsage() 实时返回的上下文占用细分 */
export interface ContextUsageData {
  totalTokens: number;
  maxTokens?: number;
  percentage?: number;
  model?: string;
  /** 旧客户端兼容字段；新客户端优先展示 breakdown.categories。 */
  categories: Array<{ name: string; tokens: number; color: string; isDeferred?: boolean }>;
  breakdown?: ContextUsageBreakdown;
  usageTotals?: ContextUsageTotals;
  memoryFiles: Array<{ path: string; type: string; tokens: number }>;
  mcpTools: Array<{ name: string; serverName: string; tokens: number; isLoaded?: boolean }>;
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

/** SDK 0.2.112+ 插件安装进度事件 */
export interface PluginInstallData {
  status: 'started' | 'installed' | 'failed' | 'completed';
  name?: string;
  errorMessage?: string;
}

/** SDK 0.2.112+ REPL 级通知事件 */
export interface NotificationData {
  key: string;
  text: string;
  priority: 'low' | 'medium' | 'high' | 'immediate';
  color?: string;
  timeoutMs?: number;
}

/** SDK 0.2.112+ 记忆召回事件 */
export interface MemoryRecallData {
  mode: 'select' | 'synthesize';
  memories: Array<{ path: string; scope: 'personal' | 'team'; content?: string }>;
}

/** Format token count to compact string: 1234 -> "1.2k", 1234567 -> "1.2M", 1234567890 -> "1.2B" */
export function formatTokenCount(count: number): string {
  if (count >= 1_000_000_000) return `${(count / 1_000_000_000).toFixed(1)}B`;
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

/** API transcript block */
export interface ApiSubagentActivity {
  agentType: string;
  description: string;
  childSessionId: string;
  childRunId: string;
  model?: string;
  status: "running" | "completed" | "failed" | "cancelled" | "timeout";
  durationMs?: number;
  totalTokens?: number;
  toolUseCount?: number;
  turnCount?: number;
  errorMessage?: string;
  failureKind?: RuntimeFailureKind;
  recoveryAction?: RuntimeRecoveryAction;
  resultPreview?: string;
}

export interface ApiTranscriptBlock {
  id: string;
  tsMs?: number;
  kind: "prompt" | "text" | "thinking" | "tool_use" | "tool_result" | "meta";
  title: string;
  defaultOpen: boolean;
  content: string;
  raw?: string;
  isError?: boolean;
  toolName?: string;
  toolId?: string;
  durationMs?: number;
  executionStatus?: "pending" | "running" | "completed" | "failed" | "cancelled";
  subagent?: ApiSubagentActivity;
  isVoiceTranscript?: boolean;
  /** prompt block：用户消息携带的附件元数据（transcript user 行结构化字段） */
  attachments?: MessageAttachmentDisplay[];
  /** prompt block：用户消息客户端幂等 ID。 */
  clientMsgId?: string;
  /** prompt block：插话来源 run ID，用于与服务端队列真源对账。 */
  interjectionSourceRunId?: string;
  /** text block：来源 runtime event id，用于由成功 Run 终态确定性追认最终输出。 */
  sourceEventId?: string;
  /** text / tool_use block：所属 runtime run id；实时与历史使用同一关联语义。 */
  runId?: string;
  /** text block：该文本是所属 Run 成功终态的最终输出。 */
  finalOutput?: boolean;
  /** text block：门禁拒答气泡关联的 guardrail event id（员工申诉入口用） */
  guardrailEventId?: string;
  /** Explicit moderation outcome hydrated from trusted transcript metadata. */
  moderation?: { eventId: string; outcome: 'allowed' | 'blocked' | 'flagged'; reasonCode?: string };
  /** 演示剧本入口事件直接完整展示，不模拟 Agent 流式输出。 */
  replayInstant?: boolean;
  /**
   * tool_use block：工具执行的「给人看」摘要。
   * 与 content/raw（给模型看的原始 payload）并存；缺省时渲染回退到原始 payload。
   */
  presentation?: ToolPresentation;
  /**
   * tool_use block：工具执行的结构化事实（exitCode / 字节数 / 耗时 …）。
   * 类型为 unknown——同样来自不可信来源，权威校验器是 normalizeToolResultMetadata。
   */
  toolMetadata?: unknown;
  /** 公开分享安全活动摘要：跳过 AskUser/Plan/Agent 的交互历史恢复，不读取原始 payload。 */
  publicActivityOnly?: boolean;
  /** M40-02 canonical semantic order; never derived from tsMs. */
  semanticOrder?: { sequence: number; eventIndex: number; stableId: string };
  /**
   * text block：附加呈现块。类型为 unknown——本字段来自不可信来源
   * （transcript 文件 / 演示剧本 / 工具产出），权威校验器是 normalizeDisplay。
   */
  display?: unknown;
}
