import type { AgentProfile } from './agent';

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

/** API session list item */
export interface ApiSessionListItem {
  sessionId: string;
  projectKey?: string;
  updatedAtMs: number;
  createdAtMs?: number;
  title?: string;
  preview?: string;
  source?: { type: "web" | "dingtalk" | "cron"; label: string };
  owner?: SessionOwnerInfo;
  agent?: AgentProfile | null;
  model?: string;
  cronJobId?: string;
  cronJobName?: string;
  /** 公司级专职 Agent 绑定（2026-07 唯恩批次）；缺省 = 个人 Agent 会话 */
  orgAgentId?: string;
  /** 专职 Agent 名称（server 列表序列化时按 orgAgentId join；Agent 已删除时缺省） */
  orgAgentName?: string;
  /** 软删除时间戳，仅回收站列表返回 */
  deletedAt?: string;
  /** 执行删除的用户名，仅回收站列表返回 */
  deletedBy?: string;
}

/** 最近一次 run 的终态。后端从 EventStore 最末一条 run_state_changed 派生。 */
export interface ApiLastRunState {
  runId: string;
  /** RunStatus: running/completed/failed/cancelled/... */
  status: string;
  /** run_state_changed.reason —— failed/cancelled 时通常带 model error message */
  error?: string;
  /** 该 run_state_changed 事件的 ISO timestamp */
  finishedAt?: string;
}

/** API session detail */
export interface ApiSessionDetail {
  sessionId: string;
  stats: {
    lines: number;
    parsedLines: number;
    parseErrors: number;
  };
  blocks: ApiTranscriptBlock[];
  owner?: SessionOwnerInfo;
  source?: { type: string; label: string };
  /**
   * 最近一次 run 的终态。前端进会话时用于对账"后端早结束/失败、UI 仍在转" 的鬼状态。
   * 旧 transcript（无 run_state_changed 事件）会缺省此字段,前端走 legacy 路径。
   */
  lastRunState?: ApiLastRunState;
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

export interface TokenUsage {
  contextTokens: number;
  totalInputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalOutputTokens: number;
  subagentTotalTokens: number;
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

/** SDK 0.2.112+ getContextUsage() 实时返回的上下文占用细分 */
export interface ContextUsageData {
  totalTokens: number;
  maxTokens?: number;
  percentage?: number;
  model?: string;
  categories: Array<{ name: string; tokens: number; color: string; isDeferred?: boolean }>;
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

/** Format token count to compact string: 1234 -> "1.2k", 1234567 -> "1.2M" */
export function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

/** API transcript block */
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
  isVoiceTranscript?: boolean;
}
