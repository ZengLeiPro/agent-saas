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
  RuntimeFailureKind,
  RuntimeRecoveryAction,
} from '../types/index.js';
import type { SandboxWorkloadDescriptor } from '@agent/shared';
import type { ExecutionTargetKind } from './toolRuntime.js';

/** Stable ACS-side workload wire contract (`class`, never shared `kind`). */
export interface SandboxWorkloadWireDescriptor {
  class: 'interactive' | 'taskboard' | 'cron' | 'memory';
  taskKind?: 'delivery' | 'advisory' | 'integration' | 'remediation';
  purpose?: 'work' | 'review' | 'merge';
}

export type PermissionMode =
  'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';

/**
 * 模型 usage 按模型聚合后的字段。
 */
export interface SdkResultModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  /** Reasoning token 数（outputTokens 的子集，不额外计费）。详见 runtime/types.ts ModelUsage。 */
  reasoningTokens?: number;
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
  failureKind?: RuntimeFailureKind;
  recoveryAction?: RuntimeRecoveryAction;
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
  /** 保持 durable approval 为 pending，由其他可信通道稍后处理。 */
  deferred?: boolean;
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
  onSessionStart?: (sessionId: string, transcriptPath?: string) => void | Promise<void>;
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
  /**
   * 2026-08-29（TASK-256）：个人「低风险常开」档。仅当 autoApproveTools=true 时生效：
   * 自动批准上限到 workspace_write，dangerous 仍走人工批准（neverAutoApprove 不变）。
   */
  lowRiskOnly?: boolean;
}

/**
 * 蓝绿排水的进程内协作信号。它不是取消：Agent 只在完整模型轮/工具批次边界
 * 让出执行权，durable run 继续保持 running，由下一 runtime worker 接力。
 */
export interface RuntimeDrainHandoffState {
  requested: boolean;
  reason?: string;
  requestedAt?: string;
}

export interface AgentRunOptions {
  cwd?: string;
  permissionMode?: PermissionMode;
  allowDangerouslySkipPermissions?: boolean;
  sandbox?: unknown;
  model?: string;
  /** 配置侧模型引用（group/model），用于 session meta 与子 agent 继承；model 仍是上游模型 id。 */
  modelRef?: string;
  maxTurns?: number;
  abortController?: AbortController;
  persistSession?: boolean;
  includePartialMessages?: boolean;
  resumeSessionId?: string;
  /**
   * 公司级专职 Agent 绑定（2026-07 唯恩批次）。新会话由 channel 从 WsChatMessage
   * 解析后传入；resume 路径以 session meta 为准兜底。dispatch 侧解析失败
   * （record 缺失/disabled/租户不符）一律 fail-closed yield error，绝不静默
   * 回退个人 persona + 全量 skill。
   */
  orgAgentId?: string;
  env?: Record<string, string>;
  /** 内部标记：记录连接器 env 的不可变 owner 与注入 key，raw runtime 可校验或剥离后重建。 */
  connectorEnvResolvedFor?: { userId: string; username: string; tenantId: string };
  connectorEnvKeys?: string[];
  /** 任务看板整体提示语与当前阶段提示语（wake 路径从 run.metadata 恢复）。 */
  taskboardBoardPrompt?: string;
  taskboardStagePrompt?: string;
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
   * Per-run 工具 profile（2026-07-14 记忆轮询批次）。'memory_poll' = 受限白名单
   * （只读工具 + 路径受限的 Write/Edit），由平台内部执行器（L2 consolidation /
   * L3 cron executor）设置，随 run.metadata 持久化供 resume/wake 恢复；用户不能经
   * API 指定。见 runtime/toolProfiles.ts。
   */
  toolProfile?: 'memory_poll' | 'memory_consolidate';
  /** Server-only workload fact; ordinary clients must not author this field. */
  sandboxWorkloadDescriptor?: SandboxWorkloadDescriptor;
  /**
   * L2 会话结束记忆审查的内部入口。模型上下文从指定父会话完整重放，
   * 当前隐藏 Run 的事件仍写入新会话；普通 API/通道不得设置。
   */
  memoryConsolidationSourceSessionId?: string;
  /**
   * RuntimeScheduler auto-wake 内部入口：复用已 acquire lease 的 durable runId，
   * 避免恢复执行时再创建一个新的 run record。
   */
  runtimeRunId?: string;
  /** Cron 等内部调度器预分配的新会话 ID；不同于 resume，不读取历史上下文。 */
  runtimeSessionId?: string;
  /** Cron 首次派发：预分配 runId 必须 create-only，禁止复活既有 Run。 */
  runtimeRunCreateOnly?: boolean;
  /** 内部入口：dispatcher 仅播报 durable Worker 终态，硬禁再次派发。 */
  dispatcherCompletion?: boolean;
  /** Server-only persisted run metadata used to re-derive Integration isolation on wake/resume. */
  runtimeIsolationMetadata?: Record<string, unknown>;
  /** RuntimeScheduler auto-wake 透传用户提交幂等键，写入 user_message 事件。 */
  runtimeClientMsgId?: string;
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
  /** RuntimeScheduler 内部字段：蓝绿排水时在安全边界让出 durable run lease。 */
  runtimeDrainHandoff?: RuntimeDrainHandoffState;
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
