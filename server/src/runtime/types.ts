import type { ContextUsageBreakdown, RuntimeFailureKind, RuntimeRecoveryAction } from '../types/index.js';
import type { ApprovalDecision } from './approvalTypes.js';
import type {
  ModelRequestDiagnostic,
  ModelResponseMode,
  ModelTerminalStatus,
  ModelUsage,
  ModelWireMode,
} from './modelRequestTypes.js';
import type { ExecutionInvocationAudit } from '../agent/toolRuntime.js';
import type { ToolPresentation } from '../agent/toolPresentationBuilder.js';
import type { ToolAuthorization, ToolRisk, ExecutionTargetKind, WorkspaceRef } from '../agent/toolRuntime.js';
import type {
  AgentRunHooks,
  RuntimeDrainHandoffState,
  SdkResultModelUsage,
  ToolApprovalPolicyOptions,
} from '../agent/types.js';
import type { ChannelContext, InboundMessage, OutboundEvent } from '../types/index.js';
import type { RunStatus } from './runStore.js';
import type { HandStatus } from './handStore.js';
import type { SessionReadStateChangedEvent } from './sessionReadStateChangedEvent.js';
export type { SessionReadStateChangedEvent } from './sessionReadStateChangedEvent.js';
export type {
  ModelRequestDiagnostic,
  ModelResponseMode,
  ModelTerminalStatus,
  ModelUsage,
  ModelWireMode,
} from './modelRequestTypes.js';
export type { ModelRetryBlockedReason, ModelRetryReason } from './modelRetryTypes.js'; export interface RuntimeConnection { apiKey?: string; baseUrl?: string; }
export type SuccessfulCompletionDecision = { action: 'allow' } | { action: 'continue'; prompt: string } | { action: 'reject'; error: string };
/** 已完成附件解析、可直接注入下一次模型请求的插话消息。 */
export interface QueuedInterjection {
  inputId: string;
  sourceRunId: string;
  clientMsgId?: string;
  message: InboundMessage;
  prompt: string;
  attachments?: ModelAttachmentRef[];
  visionAnalysis?: ModelVisionAnalysis;
}
export interface RunContext {
  runId: string;
  sessionId: string;
  /** models.groups 下的稳定配置身份（group/model），用于隔离同名 provider 模型配置。 */
  modelRef?: string;
  model: string;
  cwd: string;
  workspaceId?: string;
  /**
   * 顶层会话 ID（per-session Sandbox，2026-08-10 A 方案）。顶层会话＝自身 sessionId；
   * 子 Agent / 后台任务继承父值以保证「父 + 全部后代」同 pod（决策 7）。
   */
  topLevelSessionId?: string;
  sandboxScopeId?: string; workload?: WorkspaceRef['workload'];
  mountSubPath?: string; sandboxResources?: WorkspaceRef['sandboxResources'];
  tenantId?: string;
  executionTarget?: ExecutionTargetKind;
  /** 当前任务从能力中心已启用连接器解析出的运行态凭据环境变量。 */
  env?: Record<string, string>;
  sandboxPolicy?: {
    denyRead: string[];
  };
  workerId?: string;
  channelContext: ChannelContext;
  approvalPolicy?: ToolApprovalPolicyOptions;
  /** Immutable Agent Profile identity pinned on SessionMeta. */
  profileId?: string;
  profileVersionId?: string;
  profileConfigDigest?: string;
  /** 隐藏记忆审查从父会话读取 Context Projection，当前 Run 仍写自身会话。 */ replaySourceSessionId?: string;
  /** 隐藏记忆审查完整重放，不读写 previous_response_id。 */ disableResponseRelay?: boolean;
  /** 工具执行层的内部记忆维护标记。 */ memoryMaintenanceMode?: 'consolidation';
  hooks?: AgentRunHooks;
  signal?: AbortSignal;
  /** 蓝绿排水协作信号；只在模型轮/工具批次已完整闭合后读取。 */
  drainHandoff?: RuntimeDrainHandoffState;
  /**
   * 模型 HTTP attempt 的内部诊断旁路。由 RawAgentLoop 注入，adapter 只记录不消费；
   * 写入失败不得反向打断模型请求。
   */
  recordModelRequestDiagnostic?: (event: ModelRequestDiagnostic) => Promise<boolean | void>;
  /** 每次真正发起模型请求前执行计费重检；拒绝时抛错并由 loop 正常收尾。 */
  authorizeModelTurn?: () => Promise<void>;
  /** 最终文本落库后、成功终态写入前执行；可要求继续模型轮或拒绝成功收尾。 */ checkSuccessfulCompletion?: () => Promise<SuccessfulCompletionDecision>;
  /** Trusted host metadata for an automation execution; never sourced from model input. */
  automationFence?: { automationId:string; incarnationId:string; generation:number; specVersion:number; executionId:string; runId:string; rootSessionId?:string; rootRunId?:string };
  /** 在模型轮边界读取本 run 尚未消费的 durable 插话消息。 */
  loadQueuedInterjections?: () => Promise<QueuedInterjection[]>;
  /**
   * 当前 run 的内联自动压缩判定器。最终回答落库后、run_finished 之前调用；
   * forceReason 来自已持久化的 context pressure，不受 governor 裁剪后的 usage 干扰。
   */
  evaluateAutoCompaction?: (
    events: PlatformEvent[],
    forceReason?: string,
  ) => {
    shouldCompact: boolean;
    reason: string;
    currentTokens?: number;
    contextWindow?: number;
    thresholdRatio?: number;
    thresholdTokens?: number;
  };
  /** 当前逻辑模型轮是否已经用过 Web 部分草稿恢复机会。 */
  replaceableDraftRetryUsed?: boolean;
}
/** Input for one durable runtime run. */
export interface RunInput {
  message: InboundMessage;
  prompt: string;
  /** 用户提交幂等键；写入 durable user_message，供队列消费与前端回放对账。 */
  clientMsgId?: string;
  /** 服务端校验并规范化后的本轮附件；绝不直接使用客户端路径。 */
  attachments?: ModelAttachmentRef[];
  /** text-only 主模型使用的显式辅助视觉结果；原图引用仍保留在 attachments。 */
  visionAnalysis?: ModelVisionAnalysis;
  /**
   * 默认 true。设为 false 时 prompt 仍发给模型，但不追加 user_message 事件、
   * 不投影到 legacy transcript / 前端；用于恢复已持久化用户消息后的隐藏 continue。
   */
  recordUserMessage?: boolean;
  memoryContext?: string;
  instructions: string;
  instructionSections?: InstructionSection[];
  maxTurns: number;
  connection: Required<RuntimeConnection>;
}

export interface InstructionSection {
  key: string;
  name: string;
  content: string;
}

export interface ModelToolDefinition {
  id: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** OpenAI Responses 原生 tool_search：函数仍保留真实 name，只延迟 schema 加载。 */
  deferLoading?: boolean;
  /** MCP server 的稳定能力地图元数据；adapter 以 server 为单位生成 namespace。 */
  mcpServer?: {
    serverName: string;
    namespace: string;
    displayName: string;
    description: string;
  };
}

export interface ModelToolSearchResult {
  execution: 'server' | 'client';
  callId?: string;
  paths: string[];
  loadedToolNames: string[];
}

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: string;
  /** Responses namespace；执行仍按真实 name 路由，字段只用于忠实协议重放。 */
  namespace?: string;
}

/**
 * Provider-owned opaque state needed for stateless full-history replay.
 * The platform never decrypts or exposes encrypted_content; it only preserves order.
 */
export interface ModelProviderContinuation {
  provider: 'openai_codex_subscription';
  issuer: string;
  accountBindingHash: string;
  items: Array<{
    type: 'reasoning';
    encrypted_content: string;
    summary?: unknown[];
  }>;
}

export type ModelImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/**
 * EventStore / runtime 内部的稳定附件引用。只保存 workspace 相对路径和摘要元数据，
 * 不保存 base64，也不暴露宿主机/NAS 绝对路径。
 */
export interface ModelAttachmentRef {
  attachmentId: string;
  originalName: string;
  relativePath: string;
  sizeBytes: number;
  mimeType: string;
  isImage: boolean;
  sha256?: string;
  width?: number;
  height?: number;
  /** 图片发送给模型时使用的确定性规范化衍生图。 */
  modelRelativePath?: string;
  modelMimeType?: ModelImageMimeType;
  modelSizeBytes?: number;
}

export interface ModelVisionAnalysis {
  model: string;
  attachmentIds: string[];
  content: string;
}

/** checkpoint 中可恢复的用户任务锚点；不持久化附件正文或视觉分析。 */
export interface CheckpointTaskAnchor {
  eventId: string;
  timestamp: string;
  text: string;
  originalChars: number;
  attachments?: Array<{
    attachmentId: string;
    originalName: string;
  }>;
}
export interface ContextCheckpointMetadata {
  version: 1;
  trigger: 'manual' | 'threshold';
  /** 自动/运行中手动 checkpoint 固定为当前业务 run；空闲压缩可缺省。 */
  sourceRunId?: string;
  /** 触发运行中手动 checkpoint 的 steering source run；用于崩溃恢复去重。 */
  controlSourceRunIds?: string[];
  targetTokens: number;
  summaryBudgetTokens: number;
  summaryObservedTokens: number;
  rawTailBudgetTokens: number;
  rawTailObservedTokens: number;
  fixedTokens: number;
  taskAnchors: CheckpointTaskAnchor[];
  summaryAudit?: import('./compactionSummary.js').CompactionSummaryAudit;
  memorySnapshot?: string;
}
export type ModelUserContentPart =
  | { type: 'text'; text: string }
  | {
    type: 'image_attachment';
    attachmentId: string;
    displayName: string;
    relativePath: string;
    mimeType: ModelImageMimeType;
    sizeBytes: number;
    width?: number;
    height?: number;
    detail: 'high' | 'original';
    /**
     * true = 该 part 来自历史事件重放，而非用户本轮上传。
     * 历史图片的字节可能已随 `uploads/` 清空而消失，读不到时降级为文本占位并继续；
     * 本轮图片读不到属于真故障，必须 fail-fast。
     */
    historical?: boolean;
  }
  | {
    /** 仅供 text-only adapter 使用；视觉模型 adapter 会忽略，避免原图+摘要双重暗示。 */
    type: 'vision_summary';
    model: string;
    attachmentIds: string[];
    text: string;
  };

export type ModelUserContent = string | ModelUserContentPart[];

export type ModelChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: ModelUserContent }
  | {
    role: 'assistant';
    content: string | null;
    tool_calls?: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
      namespace?: string;
    }>;
    /**
     * RFC v1 P1.5：保留 assistant 在该轮的 reasoning summary。
     * - 火山 Chat Completions 静默丢弃此字段（RFC §1.3 实测）
     * - Responses API previous_response_id 接力时不重传 messages，所以也无影响
     * - 价值场景：未来 Anthropic Messages（thinking block）/ OpenAI Responses 官方
     *   端点接入时，跨步推理上下文不被丢
     */
    reasoning_content?: string;
    /** Opaque provider state replayed only by the matching issuer/account transport. */
    provider_continuation?: ModelProviderContinuation;
  }
  | { role: 'tool'; tool_call_id: string; content: string; images?: Array<Extract<ModelUserContentPart, { type: 'image_attachment' }>> }
  | { role: 'additional_tools'; tools: ModelToolDefinition[]; content?: undefined };
export interface ModelRequest {
  model: string;
  messages: ModelChatMessage[];
  tools: ModelToolDefinition[];
  signal?: AbortSignal;
  /**
   * Responses API 接力字段（RFC v1）：上一轮 store=true 拿到的 response.id。
   * - ResponsesApiAdapter 收到后会用 previous_response_id 接力，并只发新 user input。
   * - ChatCompletionsAdapter 收到非空值会抛错（cross-API 防御 P0.3）。
   */
  previousResponseId?: string;
  /** tool_choice 模式（默认 auto）。由 adapter 按 model.toolChoiceModes 校验兼容性。 */
  toolChoice?: 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } };
  /** 客户端期望的 max_output_tokens 上限；adapter 强制下限 ≥64（≤16 触发 500）。 */
  maxOutputTokens?: number;
}

export type ModelEvent =
  | { type: 'text_delta'; content: string }
  | { type: 'thinking_delta'; content: string }
  | {
    /** Web 可撤销草稿：丢弃当前未完成 attempt 的可见输出，再由同一请求重试替换。 */
    type: 'draft_reset';
    /** 已失败的模型请求 attempt（从 1 开始）。 */
    attempt: number;
  }
  | {
    type: 'completed';
    content: string;
    toolCalls: ModelToolCall[];
    usage?: ModelUsage;
    finishReason?: string;
    /** 仅明确 completed 的终态才允许 RawAgentLoop 接受输出、执行工具或保存接力状态。 */
    terminalStatus?: ModelTerminalStatus;
    incompleteReason?: string;
    errorCode?: string; failureKind?: RuntimeFailureKind; recoveryAction?: RuntimeRecoveryAction;
    /** Provider 结构化失败消息；只用于恢复判定和后台诊断，不直接展示给客户。 */
    errorMessage?: string;
    /** 本次 provider 请求与 attempt 的诊断关联键。 */
    modelRequestId?: string;
    attemptId?: string;
    /** 本 attempt 已产生的模型输出项数量（正文、思考、tool call 等）。 */
    emittedOutputCount?: number;
    /** Responses HTTP 状态；流内终态通常为 200。 */
    providerStatus?: number;
    /** Responses API 返回的 response.id（store=true 时存在），用于下一轮接力。 */
    responseId?: string;
    /** Responses API 返回的 response.expire_at（Unix epoch 秒）。 */
    responseExpireAt?: number;
    /** response.model 字段实际值（用于 actualModelSeen 校验）。 */
    actualModel?: string;
    /** 本次 Responses 请求是否实际使用 previous_response_id；降级全量重试时为 false。 */
    responseChained?: boolean;
    /**
     * 当前 provider response 不能继续作为 previous_response_id（例如普通文本被本地提升为
     * function_call，provider 端状态并不存在该 call id）；RawAgentLoop 下一轮必须全量重放。
     */
    responseStateReset?: boolean;
    /** 比 responseChained 更完整：区分主动全量、接力与接力失败后的全量降级。 */
    responseMode?: ModelResponseMode;
    /** 本次请求最终成功前的 HTTP 尝试次数。 */
    modelRequestAttemptCount?: number;
    /** 发送给 provider 的稳定 prompt cache 路由键（内容指纹，不含明文提示词）。 */
    promptCacheKey?: string;
    /** 最终请求前 8 个 input item 的内容哈希，用于识别历史前缀被静默改写。 */
    requestInputPrefixHash?: string;
    /** Stable request prefix components for cache drift diagnosis. */
    requestInstructionsHash?: string;
    requestToolsHash?: string;
    requestHistoryHash?: string;
    cacheEligible?: boolean;
    /** 最终成功请求的 UTF-8 JSON body 大小。 */
    requestBodyBytes?: number;
    /** 实际 provider wire 形态；不参与模型上下文 Token 核算。 */
    wireMode?: ModelWireMode;
    /** 实际 wire payload 大小；WebSocket relay 时可显著小于 requestBodyBytes。 */
    wireRequestBodyBytes?: number;
    /** WebSocket 不可用并回退 HTTP/SSE 时的脱敏原因码。 */
    wireFallbackReason?: string;
    /** 原生 Responses tool_search 的终态事实；为空表示本轮未搜索/加载。 */
    toolSearchResults?: ModelToolSearchResult[];
    /** Opaque encrypted reasoning items; never projected to client-visible transcript JSONL. */
    providerContinuation?: ModelProviderContinuation;
    /** Prior opaque items were rejected and intentionally dropped before the successful retry. */
    providerContinuationReset?: boolean;
  };

export interface ModelAdapterCapabilities {
  responseState: 'stored' | 'stateless';
}

export interface ModelAdapter {
  readonly capabilities?: ModelAdapterCapabilities;
  stream(request: ModelRequest, context: RunContext): AsyncIterable<ModelEvent>;
}

/** 发流前 provider 失败的结构化错误；避免在 adapter 边界退化成不可审计字符串。 */
export class ModelProviderError extends Error {
  readonly name = 'ModelProviderError';

  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly modelRequestId: string,
    readonly attemptId: string,
    readonly emittedOutputCount: number, readonly failureKind?: RuntimeFailureKind, readonly recoveryAction?: RuntimeRecoveryAction, readonly partialContent?: string,
  ) {
    super(message);
  }
}

export interface AgentLoop {
  run(input: RunInput, context: RunContext): AsyncIterable<OutboundEvent>;
}

export type PlatformEvent =
  | {
    id: string;
    timestamp: string;
    /**
     * 原生 deferred session 的首次 MCP 目录快照。后续 run 只会收紧授权交集，
     * 不把新授权或 tools/list_changed 静默漂入已有 session。
     */
    type: 'mcp_tool_catalog_snapshot';
    runId: string;
    sessionId: string;
    loadingMode: 'openai_responses_hosted';
    tools: ModelToolDefinition[];
  }
  | {
    id: string;
    timestamp: string;
    /** Search 命中的真实工具定义，按 provider 返回位置持久化供 full replay/compaction 恢复。 */
    type: 'mcp_tools_loaded';
    runId: string;
    sessionId: string;
    execution: 'server' | 'client';
    paths: string[];
    tools: ModelToolDefinition[];
  }
  | {
    id: string;
    timestamp: string;
    type: 'run_started';
    runId: string;
    sessionId: string;
    model: string;
    channel: string;
    profileId?: string;
    profileVersionId?: string;
    profileConfigDigest?: string;
  }
  | {
    id: string;
    timestamp: string;
    type: 'user_message';
    runId: string;
    sessionId: string;
    content: string;
    modelContent?: string;
    attachments?: ModelAttachmentRef[];
    visionAnalysis?: ModelVisionAnalysis;
    /** 插话来源 run；用于崩溃恢复时识别已持久化但尚未结算的输入。 */
    interjectionSourceRunId?: string;
    clientMsgId?: string;
    /** 平台自动生成的模型输入，不代表用户主动发送。 */
    systemGenerated?: boolean;
    recoveryKind?: 'invalid_prompt_rewind';
    /** durable 事实保留，但不投影到用户 transcript/UI。 */
    hiddenFromUserTranscript?: boolean;
  }
  | {
    id: string;
    timestamp: string;
    type: 'image_understanding';
    runId: string;
    sessionId: string;
    model: string;
    attachmentIds: string[];
    status: 'completed' | 'failed';
    usage?: ModelUsage;
    error?: string;
  }
  | {
    id: string;
    timestamp: string;
    type: 'compaction_usage';
    runId: string;
    sessionId: string;
    model: string;
    usage: ModelUsage;
  }
  | {
    id: string;
    timestamp: string;
    type: 'model_request_started';
    runId: string;
    sessionId: string;
    diagnostic: Extract<ModelRequestDiagnostic, { type: 'started' }>;
  }
  | {
    id: string;
    timestamp: string;
    type: 'model_request_checkpoint';
    runId: string;
    sessionId: string;
    diagnostic: Extract<ModelRequestDiagnostic, { type: 'checkpoint' }>;
  }
  | {
    id: string;
    timestamp: string;
    type: 'model_request_finished';
    runId: string;
    sessionId: string;
    diagnostic: Extract<ModelRequestDiagnostic, { type: 'finished' }>;
  }
  | {
    id: string;
    timestamp: string;
    /**
     * 平台内置工具按次计费事实（2026-07-15 GenerateImage 批次）。
     * 工具成功执行后 append；billing 投影把它转成一条 billable=false 的
     * usage event 行 + 一条独立固定 debit ledger 行（幂等键锚定本事件 id）。
     * 单价/成本在生成时按当时定价快照写死，事件即事实、可重放。
     */
    type: 'metered_tool_usage';
    runId: string;
    sessionId: string;
    /** 平台内置工具 id，如 'GenerateImage'。 */
    toolId: string;
    /** 计费 SKU，如 'image_gen:gpt-image-2'。 */
    sku: string;
    /** 计量数量（生图 = 实际产出张数）。 */
    quantity: number;
    /** 单价（micro-credits/件，1 credit = 1e6 micro）。 */
    unitCreditsMicro: number;
    /** 单件真实成本参考（micro-yuan/件），供毛利审计。 */
    unitCostYuanMicro: number;
    /** 仅兼容旧版已持久化事件；新事件不再生成固定费用预占键。 */
    holdKey?: string;
    /** 事件写入结果不确定时，投影与直接 fallback 共用的稳定扣费幂等键。 */
    billingChargeKey?: string;
    /** 规格备注（尺寸/质量档位等），进 ledger note 与 raw_usage_json。 */
    note?: string;
  }
  | {
    id: string;
    timestamp: string;
    type: 'memory_context';
    runId: string;
    sessionId: string;
    content: string;
  }
  | {
    id: string;
    timestamp: string;
    type: 'assistant_message';
    runId: string;
    sessionId: string;
    content: string;
    model?: string;
    usage?: ModelUsage;
    /** 本次模型请求是否实际使用 previous_response_id。存量事件可能缺失。 */
    responseChained?: boolean;
    responseMode?: ModelResponseMode;
    modelRequestAttemptCount?: number;
    promptCacheKey?: string;
    requestInputPrefixHash?: string;
    requestInstructionsHash?: string;
    requestToolsHash?: string;
    requestHistoryHash?: string;
    cacheEligible?: boolean;
    requestBodyBytes?: number;
    wireMode?: ModelWireMode;
    wireRequestBodyBytes?: number;
    wireFallbackReason?: string;
    contextBreakdown?: ContextUsageBreakdown;
    /** True when the content was already delivered live via in-process outbound deltas. */
    streamed?: boolean;
    /** 模型流在完整终态前失败；正文是已实际产出的可继续片段。 */
    incomplete?: boolean;
    /** EventStore-only opaque state. Projection and trace APIs must redact ciphertext. */
    providerContinuation?: ModelProviderContinuation;
    providerContinuationReset?: boolean;
  }
  | {
    id: string;
    timestamp: string;
    type: 'assistant_thinking';
    runId: string;
    sessionId: string;
    content: string;
    /** True when the content was already delivered live via in-process outbound deltas. */
    streamed?: boolean;
    /** Wall-clock thinking duration for this turn (ms). Source for UI "thought for Xs". */
    durationMs?: number;
  }
  | {
    id: string;
    timestamp: string;
    /**
     * Runtime Worker → ws-only 的有界批次流事件。
     * 2026-07-03 停写的是逐 token 版本；跨进程部署仅按短窗口/字符上限聚合后写入，
     * 供 PG NOTIFY live delivery 与 cursor replay，完整事实仍以聚合事件为准。
     */
    type: 'assistant_stream_event';
    runId: string;
    sessionId: string;
    blockType?: 'thinking' | 'text';
    phase: 'start' | 'delta' | 'end' | 'reset' | 'commit';
    content?: string;
    draftId?: string;
    attempt?: number;
  }
  | {
    id: string;
    timestamp: string;
    type: 'assistant_tool_calls';
    runId: string;
    sessionId: string;
    content: string;
    model?: string;
    usage?: ModelUsage;
    /** 本次模型请求是否实际使用 previous_response_id。存量事件可能缺失。 */
    responseChained?: boolean;
    responseMode?: ModelResponseMode;
    modelRequestAttemptCount?: number;
    promptCacheKey?: string;
    requestInputPrefixHash?: string;
    requestInstructionsHash?: string;
    requestToolsHash?: string;
    requestHistoryHash?: string;
    cacheEligible?: boolean;
    requestBodyBytes?: number;
    wireMode?: ModelWireMode;
    wireRequestBodyBytes?: number;
    wireFallbackReason?: string;
    contextBreakdown?: ContextUsageBreakdown;
    /** True when the content was already delivered live via in-process outbound deltas. */
    streamed?: boolean;
    toolCalls: ModelToolCall[];
    /** EventStore-only opaque state. Projection and trace APIs must redact ciphertext. */
    providerContinuation?: ModelProviderContinuation;
    providerContinuationReset?: boolean;
  }
  | {
    id: string;
    timestamp: string;
    type: 'approval_requested';
    runId: string;
    sessionId: string;
    approvalId: string;
    toolCallId: string;
    toolId: string;
    toolName: string;
    displayName?: string;
    executionTarget?: ExecutionTargetKind;
    input: unknown;
  }
  | {
    id: string;
    timestamp: string;
    type: 'approval_resolved';
    runId: string;
    sessionId: string;
    approvalId: string;
    decision: ApprovalDecision;
    message?: string;
  }
  | {
    id: string;
    timestamp: string;
    type: 'tool_result';
    runId: string;
    sessionId: string;
    toolCallId: string;
    toolName: string;
    content: string;
    isError?: boolean;
    modelImages?: Array<Extract<ModelUserContentPart, { type: 'image_attachment' }>>;
    /** 「给人看」摘要，与 content 并存的第二通道；不进入模型上下文 */
    presentation?: ToolPresentation;
    /**
     * 截断前的结构化执行事实（Shell 的 `exitCode`/`signal`/`durationMs`/字节数，
     * Read/Write/Edit 的行数与字节数），白名单见 `extractToolResultMetadata`。
     *
     * 纯追加字段：旧事件没有它 → undefined，读取方一律要有 fallback。
     * 存在理由：此前 exitCode 只以 `content` 里的 `Exit code: N` 文本行存活，
     * 任何消费方都得正则回捞；本字段让它以原值参与判定与统计。
     * 与 presentation 的分工：这里是给程序的原值，那里是给人的中文摘要。
     */
    metadata?: Record<string, unknown>;
  }
  | {
    id: string;
    timestamp: string;
    type: 'tool_audit';
    runId: string;
    sessionId: string;
    /**
     * 组织 slug（PR 10 跨组织隔离）。
     * - 写入：rawAgentLoop emit 时从 args.context.channelContext.user.tenantId 注入；缺失兜底平台根组织
     * - 读取：旧 jsonl 行没有该字段 → 投影到 DuckDB 时归 legacy tenant；admin route 按 caller.tenantId 过滤
     * - 字段标 optional 仅为前向兼容旧 jsonl；新写入路径必带
     */
    tenantId?: string;
    toolCallId: string;
    toolId: string;
    toolName: string;
    /** Skill 工具实际加载的技能名；其它工具为空。 */
    skillName?: string;
    risk: ToolRisk;
    approvalId?: string;
    authorization: ToolAuthorization;
    executionTarget: ExecutionTargetKind;
    status: 'success' | 'error';
    durationMs: number;
    executionInvocations?: ExecutionInvocationAudit[];
    error?: string;
  }
  | {
    id: string;
    timestamp: string;
    type: 'run_finished';
    runId: string;
    sessionId: string;
    subtype: 'success' | 'interrupted' | 'error';
    numTurns: number;
    modelUsage?: Record<string, SdkResultModelUsage>;
    /**
     * subtype === 'error' 时携带错误原因（模型层 / loop 级异常的 Error.message）。
     * 此前模型/loop 错误只 yield 到前端 + 进 server.log,不入 EventStore,
     * 导致仅凭 sessionId 无法在审计中复盘失败原因。本字段补齐这条断链。
     */
    error?: string; failureKind?: RuntimeFailureKind; recoveryAction?: RuntimeRecoveryAction;
  }
  | {
    id: string;
    timestamp: string;
    /** append-only 模型上下文回退；原始事件仍完整保留，只改变后续 prompt 投影。 */
    type: 'context_rewind';
    runId: string;
    sessionId: string;
    reason: 'invalid_prompt_request_blocked';
    message: '自动回退上一工具交互并继续';
    sourceModelRequestId: string;
    sourceAttemptId: string;
    excludedEventIds: string[];
    excludedToolCallIds: string[];
    /** 1-based session append order；PG 对应 session_sequence，File 对应 JSONL 顺序。 */
    excludedStartSequence: number;
    excludedEndSequence: number;
    createdAt: string;
    recoveryAttempt: 1;
  }
  | {
    id: string;
    timestamp: string;
    /**
     * 上下文压缩点（2026-07-03 /compact 真实现；2026-07-03 v2 黑箱化+保留窗口）。
     * buildContextProjection 以「最后一条 compaction」定位压缩：
     * - cutoffEventId 存在时：该事件 id 之前的历史被 summary 替代，之后的事件
     *   正常重放——即「保留最近 N 轮原始交互」。独立 /compact run 会剔除该命令
     *   run 自身；内联自动压缩保留当前业务 run 的最近一轮。
     * - cutoffEventId 缺失（v1 存量事件）：退化为以 compaction 自身为切分点，之前全替代。
     * 原始事件仍完整留在 EventStore（SessionContext 可查），本事件只改变
     * prompt 投影，不删数据。
     * v2 起投影到 legacy transcript（前端渲染为压缩分界线，摘要 debugMode 可展开）。
     */
    type: 'compaction';
    runId: string;
    sessionId: string;
    /** 压缩摘要正文，作为后续 run 上下文的开头 user message 注入 */
    summary: string;
    /** 被本次摘要覆盖的事件数（切分点之前的全部事件），观测/审计用 */
    coveredEventCount: number;
    /**
     * 保留窗口起点：投影时从该事件（含）开始保留原文，之前的历史被摘要替代。
     * 由 compact() 计算为「倒数第 1 条真实用户消息」的事件 id。
     */
    cutoffEventId?: string;
    /** true 表示 checkpoint 属于当前业务 run，而非独立 /compact 命令 run。 */
    inline?: boolean;
    /**
     * 统一可恢复 checkpoint 元数据。缺失表示 v1/v2 存量 compaction，继续按旧格式投影。
     * 原始事件从不删除；cutoffEventId 仅定义模型可见 raw tail 的起点。
     */
    checkpoint?: ContextCheckpointMetadata;
  }
  | {
    id: string;
    timestamp: string;
    type: 'run_enqueued';
    runId: string;
    sessionId: string;
    userId?: string;
    clientMsgId?: string;
  }
  | {
    id: string;
    timestamp: string;
    type: 'run_state_changed';
    runId: string;
    sessionId: string;
    status: RunStatus;
    previousStatus?: RunStatus;
    reason?: string; failureKind?: RuntimeFailureKind; recoveryAction?: RuntimeRecoveryAction;
  }
  | SessionReadStateChangedEvent
  | {
    id: string;
    timestamp: string;
    /** Cron 会话写入显式分组后的跨进程刷新信号。 */
    type: 'session_group_changed';
    sessionId: string;
    userId: string;
    groupId: string;
  }
  | {
    id: string;
    timestamp: string;
    type: 'run_lease_acquired';
    runId: string;
    sessionId: string;
    workerId: string;
    leaseExpiresAt: string;
  }
  | {
    id: string;
    timestamp: string;
    type: 'user_message_submitted';
    sessionId?: string;
    runId?: string;
    userId?: string;
    clientMsgId?: string;
    streamId?: string;
    content: string;
  }
  | {
    id: string;
    timestamp: string;
    type: 'interaction_requested';
    sessionId?: string;
    runId?: string;
    toolCallId?: string;
    invocationId?: string;
    interactionId: string;
    interactionType: 'approval' | 'ask_user' | 'permission_request';
    userId?: string;
    toolId?: string;
    toolName?: string;
    displayName?: string;
    questions?: unknown;
    toolInput?: unknown;
  }
  | {
    id: string;
    timestamp: string;
    type: 'interaction_resolved';
    sessionId: string;
    runId?: string;
    toolCallId?: string;
    invocationId?: string;
    interactionId: string;
    interactionType: 'approval' | 'ask_user' | 'permission_request';
    userId?: string;
    response?: unknown;
  }
  | {
    id: string;
    timestamp: string;
    type: 'tenant_lifecycle_changed';
    sessionId: string;
    tenantId: string;
    disabled: boolean;
    actorUserId: string;
    reason: string;
    updatedAt: string;
  }
  | {
    id: string;
    timestamp: string;
    type: 'run_cancel_requested';
    sessionId?: string;
    runId?: string;
    streamId?: string;
    userId?: string;
    reason?: string;
  }
  | {
    id: string;
    timestamp: string;
    /**
     * 插话已被目标 run 吸收（2026-08-04 BUG-2 修复）。durable 化的原因：生产是
     * ws-only + runtime-worker 双进程，loop yield 的 OutboundEvent 在 worker 进程
     * 没有 webRuntimeEventSink，「插话已应用」信号必须走 PG NOTIFY → 跨进程投影
     * 才能到达 web 进程（清 activeStreams/幂等缓存 + 通知前端清队列区）。
     */
    type: 'interjection_applied';
    runId: string;
    sessionId: string;
    sourceRunIds: string[];
    clientMsgIds: string[];
  }
  | {
    id: string;
    timestamp: string;
    type: 'tool_invocation_started';
    runId: string;
    sessionId: string;
    invocationId: string;
    toolCallId: string;
    toolName: string;
    executionTarget: ExecutionTargetKind; attemptId?: string;
  }
  | {
    id: string;
    timestamp: string;
    type: 'tool_invocation_cancel_requested';
    runId: string;
    sessionId: string;
    invocationId: string;
    toolCallId?: string;
    toolName?: string;
    userId?: string;
    reason?: string;
    metadata?: Record<string, unknown>;
  }
  | {
    id: string;
    timestamp: string;
    type: 'tool_invocation_completed';
    runId: string;
    sessionId: string;
    invocationId: string;
    toolCallId: string;
    toolName: string;
    status: 'success' | 'error' | 'cancelled';
    durationMs: number;
    error?: string;
  }
  | {
    id: string;
    timestamp: string;
    type: 'tool_output_delta' | 'tool_progress';
    runId: string;
    sessionId: string;
    invocationId: string;
    toolCallId: string;
    channel?: 'stdout' | 'stderr';
    content: string;
  }
  | {
    id: string;
    timestamp: string;
    type: 'tool_stream_summary';
    runId: string;
    sessionId: string;
    invocationId: string;
    toolCallId: string;
    toolName: string;
    status: 'success' | 'error' | 'cancelled';
    stdoutBytes: number;
    stderrBytes: number;
    outputChunks: number;
    progressCount: number;
    truncated: boolean;
    stdoutTail?: string;
    stderrTail?: string;
    progressTail?: string[];
  }
  | {
    id: string;
    timestamp: string;
    type: 'hand_provisioned';
    sessionId: string;
    handId: string;
    workspaceId: string;
    handType: ExecutionTargetKind;
    status: HandStatus;
  }
  /**
   * B3: Provisioning step audit log emitted by the brain after the hand-server's
   * /provision response is received. Each step records the recipe phase (e.g.
   * "workspace_ensure", "setup_command#0") with stdout/stderr/exitCode and
   * duration so audit can correlate provision failures with brain-side decisions.
   */
  | {
    id: string;
    timestamp: string;
    type: 'hand_provisioning_log';
    sessionId: string;
    handId: string;
    workspaceId: string;
    step: string;
    command?: string;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    durationMs?: number;
    status: 'ok' | 'error' | 'skipped';
    note?: string;
  }
  | {
    id: string;
    timestamp: string;
    type: 'hand_health_changed';
    sessionId: string;
    handId: string;
    workspaceId: string;
    status: HandStatus;
    detail?: string;
  }
  | {
    id: string;
    timestamp: string;
    type: 'hand_destroyed';
    sessionId: string;
    handId: string;
    workspaceId: string;
    reason?: string;
  }
  | {
    id: string;
    timestamp: string;
    type: 'hand_failure';
    sessionId: string;
    runId?: string;
    handId?: string;
    workspaceId?: string;
    toolName?: string;
    error: string;
    classifiedAs: 'auth' | 'timeout' | 'network' | 'unhealthy' | 'unknown';
  }
  /**
   * 子 agent 工具（Agent tool，2026-07-06）生命周期事件。写入**父 run 的 session**
   * （子 run 的执行细节在独立 childSessionId 里，绝不混入父 session），供：
   *   - durable replay / 跨进程 NOTIFY 重建前端 SubagentBlock（subagent_start/end WS 事件）
   *   - Run Trace 按 childSessionId/childRunId drill-down 挂树
   * contextProjection / legacyTranscriptProjection 对这两类事件走 default 忽略分支，
   * 不进模型 messages 投影（子 agent 的贡献只经 Agent 工具的 tool_result 回父上下文）。
   */
  | {
    id: string;
    timestamp: string;
    type: 'subagent_started';
    runId: string;
    sessionId: string;
    /** 父 run 中触发本次委派的 Agent 工具调用 id（前端用它锚定 SubagentBlock）。 */
    toolCallId: string;
    agentType: string;
    /** 模型提供的 3-5 词任务概述，UI 显示友好文案。 */
    description: string;
    childSessionId: string;
    childRunId: string;
    model: string;
  }
  | {
    id: string;
    timestamp: string;
    type: 'subagent_finished';
    runId: string;
    sessionId: string;
    toolCallId: string;
    agentType: string;
    description: string;
    childSessionId: string;
    childRunId: string;
    model?: string;
    /**
     * 终态来自 runtime outcome 枚举（D5 红线）：绝不从模型文本推断；
     * API 错误 / 超时 / 取消不会伪装成 completed。
     */
    status: 'completed' | 'failed' | 'cancelled' | 'timeout';
    totalTokens: number;
    toolUseCount: number;
    /** 存量事件可能缺失；新事件始终写入。 */
    turnCount?: number;
    durationMs: number;
    /** 面向调用方的脱敏错误摘要；成功时缺省。 */
    errorMessage?: string; failureKind?: RuntimeFailureKind; recoveryAction?: RuntimeRecoveryAction;
    /** 子任务最终文本的短预览；完整过程仍读取 childSessionId。 */
    resultPreview?: string;
  }
  /** durable 后台 Agent/命令生命周期；只作审计/观测，不进入模型上下文投影。 */
  | {
    id: string;
    timestamp: string;
    type: 'background_task_started';
    runId: string;
    sessionId: string;
    taskId: string;
    taskSessionId: string;
    toolCallId: string;
    agentType: string;
    description: string;
    model: string;
  }
  | {
    id: string;
    timestamp: string;
    type: 'background_task_finished';
    runId: string;
    sessionId: string;
    taskId: string;
    taskSessionId: string;
    toolCallId: string;
    agentType: string;
    description: string;
    status: 'completed' | 'failed' | 'cancelled' | 'timeout';
    totalTokens: number;
    durationMs: number;
    errorMessage?: string; failureKind?: RuntimeFailureKind; recoveryAction?: RuntimeRecoveryAction;
    resultPreview?: string;
  };

export type { EventAppendContext, EventListOptions, EventListPage, EventStore, PlatformEventInput } from './runtimeEventStoreTypes.js';

export { INTERNAL_MODEL_DIAGNOSTIC_EVENT_TYPES, isInternalModelDiagnosticEvent } from './eventDiagnostics.js';

// 审批与工具策略类型已迁至 ./approvalTypes.ts，这里按既有 import 路径继续对外转发。
export type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalRecord,
  ApprovalStore,
  ToolPolicyDecision,
  ToolPolicy,
  AuthorizedToolCall,
  ToolExecutionOutcome,
} from './approvalTypes.js';
