import type { ExecutionInvocationAudit, ToolDescriptor, ToolResult } from '../agent/toolRuntime.js';
import type { ToolAuthorization, ToolRisk, ExecutionTargetKind } from '../agent/toolRuntime.js';
import type { AgentRunHooks, SdkResultModelUsage, ToolApprovalPolicyOptions } from '../agent/types.js';
import type { ChannelContext, InboundMessage, OutboundEvent } from '../types/index.js';
import type { RunStatus } from './runStore.js';
import type { HandStatus } from './handStore.js';

export interface RuntimeConnection {
  apiKey?: string;
  baseUrl?: string;
}

export interface RunContext {
  runId: string;
  sessionId: string;
  model: string;
  cwd: string;
  workspaceId?: string;
  sandboxScopeId?: string;
  mountSubPath?: string;
  tenantId?: string;
  executionTarget?: ExecutionTargetKind;
  sandboxPolicy?: {
    denyRead: string[];
  };
  workerId?: string;
  channelContext: ChannelContext;
  approvalPolicy?: ToolApprovalPolicyOptions;
  hooks?: AgentRunHooks;
  signal?: AbortSignal;
  /**
   * 模型 HTTP attempt 的内部诊断旁路。由 RawAgentLoop 注入，adapter 只记录不消费；
   * 写入失败不得反向打断模型请求。
   */
  recordModelRequestDiagnostic?: (event: ModelRequestDiagnostic) => Promise<boolean | void>;
}

export interface RunInput {
  message: InboundMessage;
  prompt: string;
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
  maxTurns: number;
  connection: Required<RuntimeConnection>;
}

export interface ModelToolDefinition {
  id: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  /**
   * Reasoning 模型（gpt-5.5 / doubao / glm 等）的思考 token 数。
   * 注：这是 outputTokens 的**子集**，不额外计费——output 单价已覆盖。
   * 上游字段：Responses API `output_tokens_details.reasoning_tokens`
   *          Chat Completions `completion_tokens_details.reasoning_tokens`
   */
  reasoningTokens?: number;
  apiRequestCount?: number;
}

export type ModelTerminalStatus = 'completed' | 'incomplete' | 'failed' | 'cancelled';

export type ModelRequestDiagnostic =
  | {
    type: 'started';
    modelRequestId: string;
    attemptId: string;
    attempt: number;
    clientRequestId: string;
    model: string;
    protocol: 'responses';
    responseMode: ModelResponseMode;
    maxOutputTokens: number;
    requestBodyBytes: number;
    toolsCount: number;
    hasPreviousResponseId: boolean;
  }
  | {
    type: 'checkpoint';
    modelRequestId: string;
    attemptId: string;
    attempt: number;
    stage: 'response_created' | 'terminal_received';
    elapsedMs: number;
    responseIdHash?: string;
    actualModel?: string;
    terminalEventType?: string;
    terminalStatus?: ModelTerminalStatus;
    incompleteReason?: string;
    errorCode?: string;
  }
  | {
    type: 'finished';
    modelRequestId: string;
    attemptId: string;
    attempt: number;
    outcome:
      | 'completed'
      | 'http_error'
      | 'network_error'
      | 'aborted'
      | 'response_incomplete'
      | 'response_failed'
      | 'provider_error'
      | 'eof_without_terminal'
      | 'unterminated_tail'
      | 'parse_error'
      | 'stream_error';
    durationMs: number;
    httpStatus?: number;
    contentType?: string;
    upstreamRequestId?: string;
    responseIdHash?: string;
    responseBytes?: number;
    frameCount?: number;
    eventTypeCounts?: Record<string, number>;
    unknownEventTypes?: string[];
    receivedDone?: boolean;
    lastSequenceNumber?: number;
    terminalEventType?: string;
    terminalStatus?: ModelTerminalStatus;
    incompleteReason?: string;
    errorCode?: string;
    errorMessage?: string;
    tailBytes?: number;
    tailHash?: string;
    usage?: ModelUsage;
    willRetry?: boolean;
  };

/** 模型请求实际采用的上下文传递方式。 */
export type ModelResponseMode = 'full' | 'relay' | 'fallback_full';

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
    }>;
    /**
     * RFC v1 P1.5：保留 assistant 在该轮的 reasoning summary。
     * - 火山 Chat Completions 静默丢弃此字段（RFC §1.3 实测）
     * - Responses API previous_response_id 接力时不重传 messages，所以也无影响
     * - 价值场景：未来 Anthropic Messages（thinking block）/ OpenAI Responses 官方
     *   端点接入时，跨步推理上下文不被丢
     */
    reasoning_content?: string;
  }
  | { role: 'tool'; tool_call_id: string; content: string };

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
    type: 'completed';
    content: string;
    toolCalls: ModelToolCall[];
    usage?: ModelUsage;
    finishReason?: string;
    /** 仅明确 completed 的终态才允许 RawAgentLoop 接受输出、执行工具或保存接力状态。 */
    terminalStatus?: ModelTerminalStatus;
    incompleteReason?: string;
    errorCode?: string;
    /** Responses API 返回的 response.id（store=true 时存在），用于下一轮接力。 */
    responseId?: string;
    /** Responses API 返回的 response.expire_at（Unix epoch 秒）。 */
    responseExpireAt?: number;
    /** response.model 字段实际值（用于 actualModelSeen 校验）。 */
    actualModel?: string;
    /** 本次 Responses 请求是否实际使用 previous_response_id；降级全量重试时为 false。 */
    responseChained?: boolean;
    /** 比 responseChained 更完整：区分主动全量、接力与接力失败后的全量降级。 */
    responseMode?: ModelResponseMode;
    /** 本次请求最终成功前的 HTTP 尝试次数。 */
    modelRequestAttemptCount?: number;
    /** 发送给 provider 的稳定 prompt cache 路由键（内容指纹，不含明文提示词）。 */
    promptCacheKey?: string;
    /** 最终请求前 8 个 input item 的内容哈希，用于识别历史前缀被静默改写。 */
    requestInputPrefixHash?: string;
    /** 最终成功请求的 UTF-8 JSON body 大小。 */
    requestBodyBytes?: number;
  };

export interface ModelAdapter {
  stream(request: ModelRequest, context: RunContext): AsyncIterable<ModelEvent>;
}

export interface AgentLoop {
  run(input: RunInput, context: RunContext): AsyncIterable<OutboundEvent>;
}

export type PlatformEvent =
  | {
    id: string;
    timestamp: string;
    type: 'run_started';
    runId: string;
    sessionId: string;
    model: string;
    channel: string;
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
    requestBodyBytes?: number;
    /** True when the content was already delivered live via in-process outbound deltas. */
    streamed?: boolean;
    /** 模型流在完整终态前失败；正文是已实际产出的可继续片段。 */
    incomplete?: boolean;
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
     * @deprecated 2026-07-03 起不再写入（逐 token delta 体积占全表 ~89% 且无复盘价值）。
     * 类型保留用于读取存量历史数据；存量清理完成后可删除。
     */
    type: 'assistant_stream_event';
    runId: string;
    sessionId: string;
    blockType: 'thinking' | 'text';
    phase: 'start' | 'delta' | 'end';
    content?: string;
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
    requestBodyBytes?: number;
    /** True when the content was already delivered live via in-process outbound deltas. */
    streamed?: boolean;
    toolCalls: ModelToolCall[];
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
    error?: string;
  }
  | {
    id: string;
    timestamp: string;
    /**
     * 上下文压缩点（2026-07-03 /compact 真实现；2026-07-03 v2 黑箱化+保留窗口）。
     * buildContextProjection 以「最后一条 compaction」定位压缩：
     * - cutoffEventId 存在时：该事件 id 之前的历史被 summary 替代，之后的事件
     *   （剔除本 compaction 所属 run 自身的事件）正常重放——即「保留最近 N 轮原始交互」。
     * - cutoffEventId 缺失（v1 存量事件）：退化为以 compaction 自身为切分点，之前全替代。
     * 原始事件仍完整留在 EventStore（SessionSearchEvents 可查），本事件只改变
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
     * 由 compact() 计算为「倒数第 2 条真实用户消息」的事件 id。
     */
    cutoffEventId?: string;
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
    reason?: string;
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
    type: 'tool_invocation_started';
    runId: string;
    sessionId: string;
    invocationId: string;
    toolCallId: string;
    toolName: string;
    executionTarget: ExecutionTargetKind;
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
    /** 运行时错误的原始摘要；成功时缺省。 */
    errorMessage?: string;
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
    errorMessage?: string;
    resultPreview?: string;
  };

export type PlatformEventInput = PlatformEvent extends infer Event
  ? Event extends PlatformEvent
    ? Omit<Event, 'id' | 'timestamp'>
    : never
  : never;

export const INTERNAL_MODEL_DIAGNOSTIC_EVENT_TYPES = [
  'model_request_started',
  'model_request_checkpoint',
  'model_request_finished',
] as const satisfies readonly PlatformEvent['type'][];

export function isInternalModelDiagnosticEvent(event: PlatformEvent): boolean {
  return (INTERNAL_MODEL_DIAGNOSTIC_EVENT_TYPES as readonly string[]).includes(event.type);
}

export interface EventListPage {
  events: PlatformEvent[];
  /**
   * Opaque cursor for the next page. File backend uses a line offset; PG backend
   * uses session-local sequence. Callers must not parse this outside tests.
   */
  nextCursor?: string;
  hasMore: boolean;
}

/**
 * 多组织改造 PR 3：所有 append 路径可选携带 tenantId（不进 PlatformEvent union
 * 类型，避免 18 个分支的 invasive 改动）。PG backend 写入 tenant_id 列；File
 * backend 忽略（jsonl 旁路文件物理隔离）。未传时 fallback 平台根组织。
 *
 * 调用方接通节奏：
 *   - PR 3 仅 store 层接口扩；调用方暂不强制传，旧数据迁移统一按 legacy tenant 回填
 *   - PR 4 dispatch/channel 把 user.tenantId 一路传到 append（真正按组织落库）
 */
export interface EventAppendContext {
  tenantId?: string;
}

export interface EventListOptions {
  /**
   * 仅用于 run 启动前的上下文/状态重放瘦身。断线重连的 durable replay 不传该参数，
   * 仍按 EventStore 事实源全量补齐工具输出中间段。
   */
  excludeTypes?: PlatformEvent['type'][];
}

export interface EventStore {
  append(event: PlatformEventInput, ctx?: EventAppendContext): Promise<PlatformEvent>;
  appendBatch?(events: PlatformEventInput[], ctx?: EventAppendContext): Promise<PlatformEvent[]>;
  list(sessionId: string, options?: EventListOptions): Promise<PlatformEvent[]>;
  listPage?(sessionId: string, options?: {
    afterCursor?: string;
    limit?: number;
    runId?: string;
    type?: PlatformEvent['type'];
    excludeTypes?: PlatformEvent['type'][];
  }): Promise<EventListPage>;
  listAround?(sessionId: string, eventId: string, options?: { before?: number; after?: number }): Promise<PlatformEvent[]>;
  listByRun?(sessionId: string, runId: string): Promise<PlatformEvent[]>;
  listByToolCall?(sessionId: string, toolCallId: string): Promise<PlatformEvent[]>;
  search?(sessionId: string, query: string, options?: {
    limit?: number;
    runId?: string;
    type?: PlatformEvent['type'];
    excludeTypes?: PlatformEvent['type'][];
  }): Promise<PlatformEvent[]>;
  getById?(eventId: string): Promise<PlatformEvent | null>;
}

export type ApprovalDecision = 'approved' | 'rejected' | 'timeout';

export interface ApprovalRequest {
  sessionId: string;
  runId: string;
  toolCallId: string;
  toolId: string;
  toolName: string;
  displayName?: string;
  executionTarget?: ExecutionTargetKind;
  input: unknown;
}

export interface ApprovalRecord extends ApprovalRequest {
  id: string;
  status: 'pending' | ApprovalDecision;
  createdAt: string;
  resolvedAt?: string;
  message?: string;
}

export interface ApprovalStore {
  create(request: ApprovalRequest): Promise<ApprovalRecord>;
  resolve(id: string, decision: ApprovalDecision, message?: string): Promise<void>;
  resolvePending(id: string, decision: ApprovalDecision, message?: string): Promise<ApprovalRecord | null>;
  get(id: string): Promise<ApprovalRecord | null>;
  list(sessionId?: string): Promise<ApprovalRecord[]>;
  listPending(sessionId?: string): Promise<ApprovalRecord[]>;
}

export type ToolPolicyDecision =
  | { type: 'allow' }
  | { type: 'requires_approval'; reason: string };

export interface ToolPolicy {
  decide(descriptor: ToolDescriptor, input: unknown, context: RunContext): Promise<ToolPolicyDecision>;
}

export interface AuthorizedToolCall {
  toolId: string;
  input: unknown;
}

export interface ToolExecutionOutcome {
  call: ModelToolCall;
  descriptor?: ToolDescriptor;
  input: unknown;
  result: ToolResult;
  isError?: boolean;
}
