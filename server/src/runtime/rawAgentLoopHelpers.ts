import type {
  InteractionEvent,
  InteractionResponse,
} from '../agent/types.js';
import {
  ModelProviderError,
  type ModelChatMessage,
  type ModelEvent,
  type ModelToolCall,
  type ModelUsage,
  type PlatformEvent,
  type RunContext,
} from './types.js';
import type { OutboundEvent } from '../types/index.js';
import type { ToolDescriptor } from '../agent/toolRuntime.js';
import { POLICY_REJECTION_CUSTOMER_MESSAGE, QUOTA_EXHAUSTED_CUSTOMER_MESSAGE, type RuntimeFailureProtocol } from './runtimeFailure.js';
import {
  buildMcpCapabilityDescription,
  buildMcpNamespaceName,
} from './mcpToolLoading.js';

/**
 * RawAgentLoop 的模块级 helper。
 *
 * 从 `rawAgentLoop.ts` 尾部原样抽出：这些函数不依赖 RawAgentLoop 实例状态，
 * 只做纯判定 / 纯转换（drain 判定、模型终态断言、工具定义与结果格式化、
 * usage 合并、zombie 超时解析、Hand 失败归类），单独成文件后既便于直接单测，
 * 也让 rawAgentLoop 只留循环编排逻辑。
 */

export function isForcedDrainHandoff(context: RunContext): boolean {
  if (!context.drainHandoff?.requested || !context.signal?.aborted) return false;
  const reason = context.signal.reason;
  const message = reason instanceof Error ? reason.message : String(reason ?? '');
  return message === 'server_drain_deadline';
}

export interface InvalidPromptRequestBlockedFailure {
  modelRequestId: string;
  attemptId: string;
}

export function isInvalidPromptRequestBlocked(error: unknown): boolean {
  if (error instanceof ModelProviderError) {
    return error.code.toLowerCase() === 'invalid_prompt'
      && error.message.toLowerCase().includes('request blocked');
  }
  return false;
}

export function getInvalidPromptRequestBlockedFailure(error: unknown): InvalidPromptRequestBlockedFailure | null {
  if (error instanceof ModelProviderError) {
    if (!isInvalidPromptRequestBlocked(error) || error.emittedOutputCount !== 0) return null;
    return { modelRequestId: error.modelRequestId, attemptId: error.attemptId };
  }
  if (!error || typeof error !== 'object' || (error as { type?: unknown }).type !== 'completed') return null;
  const completed = error as Extract<ModelEvent, { type: 'completed' }>;
  if (
    completed.terminalStatus !== 'failed'
    || completed.errorCode?.toLowerCase() !== 'invalid_prompt'
    || !completed.errorMessage?.toLowerCase().includes('request blocked')
    || completed.emittedOutputCount !== 0
    || completed.content.length > 0
    || completed.toolCalls.length > 0
    || !completed.modelRequestId
    || !completed.attemptId
  ) return null;
  return { modelRequestId: completed.modelRequestId, attemptId: completed.attemptId };
}

export function getStructuredModelFailure(error: unknown): RuntimeFailureProtocol | undefined {
  if (!(error instanceof ModelProviderError) || !error.failureKind || !error.recoveryAction) return undefined;
  return {
    failureKind: error.failureKind,
    recoveryAction: error.recoveryAction,
    ...(error.quotaResetAt ? { quotaResetAt: error.quotaResetAt } : {}),
  };
}

export function describeRuntimeFailure(
  error: unknown,
  pendingTurnText: string,
  invalidPromptCustomerMessage: string,
): {
  diagnosticMessage: string;
  message: string;
  surfacedMessage: string;
  preservedTurnText: string;
  failureProtocol?: RuntimeFailureProtocol;
} {
  const diagnosticMessage = error instanceof Error ? error.message : String(error);
  const failureProtocol = getStructuredModelFailure(error);
  const preservedTurnText = pendingTurnText || (failureProtocol?.failureKind === 'policy_rejection' && error instanceof ModelProviderError ? error.partialContent ?? '' : '');
  // 配额型终态同样必须换成客户面文案：原始技术串（HTTP 429 usage_limit_reached）
  // 既不可读，也会让用户以为「继续」还有用。
  const message = failureProtocol?.failureKind === 'policy_rejection'
    ? POLICY_REJECTION_CUSTOMER_MESSAGE
    : failureProtocol?.failureKind === 'quota_exhausted'
      ? QUOTA_EXHAUSTED_CUSTOMER_MESSAGE
      : isInvalidPromptRequestBlocked(error)
        ? invalidPromptCustomerMessage
        : diagnosticMessage;
  return {
    diagnosticMessage,
    message,
    preservedTurnText,
    surfacedMessage: failureProtocol?.failureKind === 'policy_rejection'
      || failureProtocol?.failureKind === 'quota_exhausted'
      ? message
      : preservedTurnText
        ? `${message}；已保留本次未完成正文，可发送“继续”接着完成。`
        : message,
    ...(failureProtocol ? { failureProtocol } : {}),
  };
}

export function mergeRuntimeFailureResultText(finalText: string, preservedTurnText: string): string {
  if (!preservedTurnText || finalText.endsWith(preservedTurnText)) return finalText;
  return `${finalText}${preservedTurnText}`;
}

export function assertSuccessfulModelTerminal(completed: Extract<ModelEvent, { type: 'completed' }>): void {
  if (completed.terminalStatus && completed.terminalStatus !== 'completed') {
    if (
      completed.errorCode
      && completed.errorMessage
      && completed.modelRequestId
      && completed.attemptId
      && completed.emittedOutputCount !== undefined
    ) {
      throw new ModelProviderError(
        completed.errorMessage,
        completed.providerStatus ?? 200,
        completed.errorCode,
        completed.modelRequestId,
        completed.attemptId,
        completed.emittedOutputCount,
        completed.failureKind,
        completed.recoveryAction,
        completed.failureKind === 'policy_rejection' ? completed.content : undefined,
        completed.quotaResetAt,
      );
    }
    throw new Error(
      `model terminal rejected: status=${completed.terminalStatus}`
      + `${completed.incompleteReason ? ` reason=${completed.incompleteReason}` : ''}`
      + `${completed.errorCode ? ` code=${completed.errorCode}` : ''}`,
    );
  }
  if (completed.finishReason === 'length' || completed.finishReason === 'content_filter') {
    throw new Error(
      `model output truncated: finish_reason=${completed.finishReason} (可能丢失了 tool_call,不应作为正常结束)`,
    );
  }
}

/**
 * 并行窗准入判定：工具必须显式 opt-in，且当前 descriptor 仍是 safe + 免审批。
 *
 * concurrency 是工具作者对“调用间无顺序依赖”的声明；risk / approvalMode 是
 * 运行时防御，避免后续风险分档调整后仍静默进入并行路径。未声明的动态工具
 * （包括 MCP）默认串行。
 */
export function isParallelSafeToolCall(
  call: ModelToolCall,
  descriptorsByName: Map<string, ToolDescriptor>,
): boolean {
  const descriptor = descriptorsByName.get(call.name);
  return !!descriptor
    && descriptor.concurrency === 'parallel'
    && descriptor.risk === 'safe'
    && descriptor.approvalMode === 'never';
}

export function toOutboundInteractionEvent(event: InteractionEvent): OutboundEvent {
  return {
    type: event.type,
    interactionId: event.interactionId,
    toolId: event.toolId,
    toolName: event.toolName,
    displayName: event.displayName,
    toolInput: event.toolInput,
    questions: event.questions,
  };
}

export function toModelToolDefinition(descriptor: ToolDescriptor) {
  // 优先用 descriptor 显式提供的 JSON Schema（MCP 工具透传 server inputSchema），
  // fallback 到 zod schema 自动转换。clone 避免下游 mutate 共享引用——MCP
  // descriptor 是 long-lived cache，删 $schema 字段会跨调用残留。
  const schema = descriptor.parametersJsonSchema
    ? { ...descriptor.parametersJsonSchema }
    : (descriptor.schema.toJSONSchema() as Record<string, unknown>);
  delete schema.$schema;
  return {
    id: descriptor.id,
    name: descriptor.name,
    description: descriptor.description,
    parameters: schema,
    ...(descriptor.mcp ? {
      mcpServer: {
        serverName: descriptor.mcp.serverName,
        namespace: buildMcpNamespaceName(descriptor.mcp.serverName),
        displayName: descriptor.mcp.serverDisplayName,
        description: buildMcpCapabilityDescription({
          serverName: descriptor.mcp.serverName,
          displayName: descriptor.mcp.serverDisplayName,
          description: descriptor.mcp.serverDescription,
        }),
      },
    } : {}),
  };
}

export function unavailableToolMessage(toolName: string): string {
  if (toolName.startsWith('mcp__')) {
    return `MCP tool unavailable: ${toolName}（当前授权/租户策略/全局开关不允许，或该工具 schema 已变化；请重新授权或新建会话后重试）`;
  }
  // WP3：定制项目能力（规范 §6.1）。工具面按会话冻结，因此「不在本轮」= 系统停用 /
  // 能力关闭 / 登记 digest 变了，客户面统一按「新会话生效」引导，不写技术归因。
  if (toolName.startsWith('app__')) {
    return `tool unavailable: ${toolName}（该系统的这个能力当前不可用；能力变更将在新会话生效）`;
  }
  return `tool unavailable: ${toolName}（不在本轮可用工具集中）`;
}

export function parseToolArguments(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    return { __raw: raw, __parseError: err instanceof Error ? err.message : String(err) };
  }
}

export function formatAskUserQuestionResult(response: InteractionResponse): string {
  return JSON.stringify(
    {
      answers: response.answers ?? {},
      message: response.message,
      schemaNote: 'For questions with multiSelect=true, the answer may be a comma-separated list.',
    },
    null,
    2,
  );
}

export function formatMemoryContext(memoryContext: string): string {
  return `<memory-context>\n[长期记忆]\n${memoryContext}\n</memory-context>`;
}

export function clearProviderContinuations(messages: ModelChatMessage[]): void {
  for (const message of messages) {
    if (message.role === 'assistant' && message.provider_continuation) {
      delete message.provider_continuation;
    }
  }
}

export function loadedMcpToolNamesFromMessages(messages: ModelChatMessage[]): Set<string> {
  return new Set(
    messages
      .filter((message): message is Extract<ModelChatMessage, { role: 'additional_tools' }> => (
        message.role === 'additional_tools'
      ))
      .flatMap((message) => message.tools.map((tool) => tool.name)),
  );
}

export function loadedMcpToolNamesFromEvents(events: PlatformEvent[]): Set<string> {
  return new Set(
    events
      .filter((event): event is Extract<PlatformEvent, { type: 'mcp_tools_loaded' }> => (
        event.type === 'mcp_tools_loaded'
      ))
      .flatMap((event) => event.tools.map((tool) => tool.name)),
  );
}

export function mergeUsage(a: ModelUsage | undefined, b: ModelUsage): ModelUsage {
  return {
    inputTokens: (a?.inputTokens ?? 0) + (b.inputTokens ?? 0),
    outputTokens: (a?.outputTokens ?? 0) + (b.outputTokens ?? 0),
    cacheReadInputTokens: (a?.cacheReadInputTokens ?? 0) + (b.cacheReadInputTokens ?? 0),
    cacheCreationInputTokens: (a?.cacheCreationInputTokens ?? 0) + (b.cacheCreationInputTokens ?? 0),
    apiRequestCount: (a?.apiRequestCount ?? 0) + (b.apiRequestCount ?? 1),
  };
}

export function buildModelUsage(model: string, usage: ModelUsage | undefined) {
  if (!usage) return undefined;
  if ((usage.inputTokens ?? 0) <= 0 && (usage.outputTokens ?? 0) <= 0) return undefined;
  return {
    [model]: {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
      cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
      apiRequestCount: Math.max(1, usage.apiRequestCount ?? 1),
    },
  };
}


export const DEFAULT_ZOMBIE_TOOL_CALL_TIMEOUT_MS = 35 * 60_000;

/**
 * 优先级：constructor option > env > 默认 35 分钟。仅接受 >=0 的有限数字，否则回退默认。
 * 预留给前台 Shell 30 分钟上限及远端收尾宽限，避免长命令在会话恢复时被过早判成 zombie。
 * 06-24 引入：与 describeBlockingToolCall 的 zombie 判定配合，应对 SIGKILL 残留。
 */
export function resolveZombieToolCallTimeoutMs(optionValue?: number): number {
  if (typeof optionValue === 'number' && Number.isFinite(optionValue) && optionValue >= 0) {
    return optionValue;
  }
  const envRaw = process.env.AGENT_SAAS_ZOMBIE_TOOL_CALL_TIMEOUT_MS;
  if (envRaw) {
    const parsed = Number.parseInt(envRaw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_ZOMBIE_TOOL_CALL_TIMEOUT_MS;
}

export function classifyHandFailure(message: string): 'auth' | 'timeout' | 'network' | 'unhealthy' | 'unknown' {
  const lower = message.toLowerCase();
  if (lower.includes('鉴权') || lower.includes('unauthorized') || lower.includes('forbidden') || lower.includes('401') || lower.includes('403')) return 'auth';
  if (lower.includes('超时') || lower.includes('timeout') || lower.includes('timed out')) return 'timeout';
  if (lower.includes('fetch') || lower.includes('econn') || lower.includes('network') || lower.includes('http')) return 'network';
  if (lower.includes('health') || lower.includes('unhealthy')) return 'unhealthy';
  return 'unknown';
}
