import { randomUUID } from 'node:crypto';
import type {
  InteractionEvent,
  InteractionResponse,
} from '../agent/types.js';
import {
  INTERNAL_MODEL_DIAGNOSTIC_EVENT_TYPES,
  type ModelRequestDiagnostic,
  type AgentLoop,
  type ApprovalStore,
  type ApprovalRecord,
  type EventStore,
  type ModelAdapter,
  type ModelChatMessage,
  type ModelEvent,
  type ModelToolCall,
  type ModelUsage,
  type RunContext,
  type RunInput,
  type ToolExecutionOutcome,
  type ToolPolicy,
  type PlatformEvent,
} from './types.js';
import { canonicalToolInputDigest } from './canonicalToolInput.js'; import { createExecutionAttempt, createInvocationCorrelation, runWithInvocationCorrelation } from './invocationCorrelation.js';
import { requireEventTenantId, TenantProjectingEventSink } from './rawAgentLoopEventSink.js';
import { buildFailurePresentation, ToolExecutionError, type ToolPresentation } from '../agent/toolPresentationBuilder.js';
export { canonicalToolInputDigest } from './canonicalToolInput.js';
import type { InboundMessage, OutboundEvent } from '../types/index.js';
import {
  createExecutionAuditRecorder,
  LocalWorkspaceProvider,
  PlatformToolRuntime,
  type ToolCallContext,
  type ToolAuthorization,
  type ToolDescriptor,
  type ToolResult,
  type ToolRuntime,
  type WorkspaceProvider,
} from '../agent/toolRuntime.js';
import { tryParseToolInput } from '../agent/toolRuntimePaths.js';
import { DefaultToolPolicy } from './toolPolicy.js';
import { refreshRunApprovalPolicy } from './approvalPolicyResolution.js';
import { DEFAULT_COMPACTION_REQUEST_PROMPT } from '../systemPrompts/compaction.js';
import { standardizeToolError } from './agentPlanDefense.js';
import { LegacyTranscriptProjection } from './legacyTranscriptProjection.js';
import { buildModelUserContent } from './imageAttachments.js';
import {
  buildContextProjection,
  findLastCompleteToolInteractionUnit,
  type ContextReconstructionPolicy,
} from './contextProjection.js';
import { RuntimeContextUsageTracker } from './contextUsage.js';
import {
  buildContextBreakdownSnapshot,
  calibrateContextBreakdown,
  estimateContextTokens,
} from './contextBreakdown.js';
import { governModelRequestMessages } from './contextGovernor.js';
import {
  hasActiveCheckpointForRun,
  planContextCheckpoint,
} from './contextCheckpoint.js';
import { createCompactionSummaryAudit, formatCompactionSummaryWarning } from './compactionSummary.js';
import {
  getModelAutoCompactThreshold,
  getModelContextWindow,
} from '../data/usage/pricing.js';
import { projectToolResultContentForModel } from './replayEventBounds.js';
import {
  buildRuntimeReplayState,
  type RuntimeReplayState,
  type RuntimeToolCallBatchState,
} from './replay.js';
import {
  buildSyntheticToolResultContent,
  closeUnfinishedReplayToolCalls,
  describeBlockingToolCall,
} from './rawAgentLoopRecovery.js';
import type { ToolInvocationStore } from './toolInvocationStore.js';
import { selectRuntimeHandRoute, type HandStore } from './handStore.js';
import type { RuntimeIsolationRequirement } from './runtimeIsolationEvidence.js';
import type { RunStore } from './runStore.js';
import { createLogger } from '../utils/logger.js';
import { resolveRunTenantId, withDurableRunCancellation } from './runContextGovernance.js';
import { supportsReplaceableDrafts } from './modelOutputTransaction.js';
import { WebFetchCircuitOpenError } from '../agent/webToolProvider.js';
import { isCompactCommand } from '../agent/prompt.js';
import {
  buildMcpNamespaceName,
  resolveLoadedMcpTools,
  resolveSessionMcpTools,
  type EffectiveMcpLoadingMode,
} from './mcpToolLoading.js';
// 模块级 helper 已迁至 ./rawAgentLoopHelpers.ts，本文件内部继续按原符号名使用。
import {
  assertSuccessfulModelTerminal,
  buildModelUsage,
  classifyHandFailure,
  clearProviderContinuations,
  describeRuntimeFailure,
  formatAskUserQuestionResult,
  formatMemoryContext,
  getInvalidPromptRequestBlockedFailure,
  isForcedDrainHandoff,
  isInvalidPromptRequestBlocked,
  mergeRuntimeFailureResultText,
  mergeUsage,
  parseToolArguments,
  resolveZombieToolCallTimeoutMs,
  toModelToolDefinition,
  toOutboundInteractionEvent,
  unavailableToolMessage,
  type InvalidPromptRequestBlockedFailure,
} from './rawAgentLoopHelpers.js';
import { ApprovalAlreadyResolvedError, ApprovalPendingWithoutInteractionHook, InteractionPendingWithoutInteractionHook, RunLeaseLostError, ToolInvocationClaimLostError, captureModelStreamError, handleInvocationClaimLoss, readRunLeaseState, resolveClaimedWorkerId } from './rawAgentLoopControlErrors.js';
import { collectParallelToolCallSegment, type PreparedParallelToolCall } from './toolParallelism.js';
import { createSuccessfulCompletionController, finishSuccessfulRun } from './rawAgentLoopCompletion.js';
import { SteeringInterjectionCoordinator } from './rawAgentLoopInterjections.js';
import { buildUserInterjectionSkippedToolResults, hasQueuedUserInputAtToolBoundary, skipToolCallForQueuedUserInput } from './rawAgentLoopToolInterjection.js';
import {
  COMPACT_COMMAND_MODEL_CONTENT,
  MIN_COMPACTABLE_MESSAGES,
  StreamEventBatcher,
  THINKING_ONLY_CONTINUATION_PROMPT,
  ToolStreamSummaryBuilder,
  findLastUserMessageIndex,
  isEmergencyContextPressure,
  parseContextPressureState,
  parseReplaceableDraftRunState,
  prepareCompactionInputMessages,
  resolveInvokedSkillName,
  type CompactionOptions,
  type CompactionOutcome,
  type ContextPressureState,
  type ReplaceableDraftRunState,
  type StreamEventBatchOptions,
} from './rawAgentLoopSupport.js';
export {
  StreamEventBatcher,
  ToolStreamSummaryBuilder,
  type StreamEventBatchOptions,
} from './rawAgentLoopSupport.js';

/**
 * RawAgentLoop 自身原本完全依赖 EventStore 留痕,不打 logger 日志。
 * 但 enqueue-only 异步路径绕过 dispatch wrapper,导致 server.log 里完全
 * 看不到会话执行痕迹。补几条关键节点日志（start / finished / failed）,
 * 让运维 grep sessionId 时至少能看到会话边界与失败原因;sessionId 由
 * rawRuntimeRunDispatch 的 enterSessionContext 自动注入到 trace 前缀。
 */
const logger = createLogger('RawAgentLoop');
const INTERACTIVE_TOOL_NAMES = new Set(['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode']);
const SESSION_CONTEXT_RECOVERY_TOOL_NAMES = new Set([
  // 2026-08-03 工具面收敛批次：三个会话检索工具合并为 SessionContext。
  // 旧名保留在集合里以兼容存量会话/历史投影中的旧工具名判定，无副作用。
  'SessionContext',
  'SessionGetEvents',
  'SessionSearchEvents',
  'SessionGetToolTrace',
]);
const RUN_START_REPLAY_EXCLUDED_EVENT_TYPES = [
  'tool_output_delta',
  'tool_progress',
  'assistant_stream_event',
  ...INTERNAL_MODEL_DIAGNOSTIC_EVENT_TYPES,
] satisfies PlatformEvent['type'][];
const WEB_FETCH_SYNTHESIS_PROMPT = [
  '[平台收束指令]',
  'WebFetch 已因持续高失败率熔断。停止继续扩散 URL，也不要再调用其他工具。',
  '请立即基于当前上下文中已经取得的材料完成任务；明确区分已核实事实、证据不足项与未完成项。',
].join('\n');
const CONTEXT_EMERGENCY_THRESHOLD_RATIO = 0.95;
const CONTEXT_SYNTHESIS_PROMPT = [
  '[平台收束指令]',
  '本次任务的上下文已达到安全阈值。除 SessionContext（action=events|search|trace）外，不要调用其他工具。',
  '当前模型可见历史保持不变。若固定节选的工具结果不足，可先用该只读会话工具检索完整事实源；随后基于当前上下文完成任务，并明确区分已核实事实、证据不足项与未完成项。',
].join('\n');
const INVALID_PROMPT_RECOVERY_INPUT = '继续';
const INVALID_PROMPT_CUSTOMER_ERROR = 'Agent 开小差了，请发送「继续」';

export interface RawAgentLoopOptions {
  modelAdapter: ModelAdapter;
  eventStore: EventStore;
  approvalStore: ApprovalStore;
  transcriptProjection: LegacyTranscriptProjection;
  toolRuntime?: ToolRuntime;
  workspaceProvider?: WorkspaceProvider;
  toolPolicy?: ToolPolicy;
  contextPolicy?: ContextReconstructionPolicy;
  toolInvocationStore?: ToolInvocationStore;
  /** Durable hand registry shared with tool transport routing. */
  handStore?: HandStore;
  runtimeIsolationRequirement?: RuntimeIsolationRequirement;
  /**
   * RFC v1 P0.4：跨 turn / 跨 run 持久化 Responses API session state（last_response_id 等）。
   * 不传则不做接力，所有请求都走全量 input（行为退化为不使用 Responses API 接力）。
   */
  runStore?: RunStore;
  /** 已由显式 model capability 解析出的 MCP 加载方式；缺省保持 eager 零回归。 */
  mcpLoadingMode?: EffectiveMcpLoadingMode; compactionPrompt?: string;
  streamEventBatch?: StreamEventBatchOptions;
  /**
   * 把「invocationStarted 但既无 completed 也无 cancel_requested」的工具调用判定
   * 为 zombie 的年龄阈值（毫秒）。tool_invocation_started 写入超过此阈值且无任何
   * 后续事件时，replay 视为 SIGKILL/crash 残留，让 recoverUnclosedToolCalls 的
   * 合成 tool_result 默认分支收尾，避免会话被永久卡在「请稍后重试」。
   *
   * 默认 35 分钟，可通过 env `AGENT_SAAS_ZOMBIE_TOOL_CALL_TIMEOUT_MS` 覆盖。
   * 设 0 表示「任意 invocationStarted 都立刻视为 zombie」（仅测试用）。
   */
  zombieToolCallTimeoutMs?: number;
}

export interface CompactInput {
  message: InboundMessage;
  /**
   * 会话的正常 system prompt。压缩调用沿用同一 system 与工具定义，并发送
   * checkpoint planner 选出的待压缩前缀；最近的完整执行尾部由平台原文保留。
   */
  instructions: string;
}

export interface ResumeApprovalInput {
  approvalId: string;
  response: InteractionResponse;
  instructions: string;
  maxTurns: number;
}

export interface ResumeInteractionInput {
  interactionId: string;
  response: InteractionResponse;
  instructions: string;
  maxTurns: number;
}


export class RawAgentLoop implements AgentLoop {
  private readonly modelAdapter: ModelAdapter;
  private readonly eventStore: EventStore;
  private readonly approvalStore: ApprovalStore;
  private readonly transcriptProjection: LegacyTranscriptProjection;
  private readonly eventSink: TenantProjectingEventSink;
  private readonly toolRuntime: ToolRuntime;
  private readonly workspaceProvider: WorkspaceProvider;
  private readonly toolPolicy: ToolPolicy;
  private readonly contextPolicy?: ContextReconstructionPolicy;
  private readonly toolInvocationStore?: ToolInvocationStore;
  private readonly handStore?: HandStore;
  private readonly runtimeIsolationRequirement?: RuntimeIsolationRequirement;
  private readonly runStore?: RunStore;
  private readonly mcpLoadingMode: EffectiveMcpLoadingMode; private readonly compactionPrompt: string;
  private readonly streamEventBatch: Required<StreamEventBatchOptions>;
  private readonly zombieToolCallTimeoutMs: number;
  private readonly parallelInvocationGates = new WeakMap<RunContext, {
    onClaimed: () => void;
    waitForRelease: Promise<void>;
  }>();
  private webFetchSynthesisReason?: string;
  private forcedSynthesisReason?: string;
  private forcedSynthesisPrompt = CONTEXT_SYNTHESIS_PROMPT;
  private forcedSynthesisPromptAppended = false;
  private forcedSynthesisAllowsSessionRecovery = false;
  private activeTenantId?: string;

  constructor(options: RawAgentLoopOptions) {
    this.modelAdapter = options.modelAdapter;
    this.eventStore = options.eventStore;
    this.approvalStore = options.approvalStore;
    this.transcriptProjection = options.transcriptProjection;
    this.eventSink = new TenantProjectingEventSink(options.eventStore, options.transcriptProjection, () => this.activeTenantId);
    this.toolRuntime = options.toolRuntime ?? new PlatformToolRuntime();
    this.workspaceProvider = options.workspaceProvider ?? new LocalWorkspaceProvider();
    this.toolPolicy = options.toolPolicy ?? new DefaultToolPolicy();
    this.contextPolicy = options.contextPolicy;
    this.toolInvocationStore = options.toolInvocationStore;
    this.handStore = options.handStore;
    this.runtimeIsolationRequirement = options.runtimeIsolationRequirement;
    this.runStore = options.runStore;
    this.mcpLoadingMode = options.mcpLoadingMode ?? 'eager'; this.compactionPrompt = options.compactionPrompt?.trim() || DEFAULT_COMPACTION_REQUEST_PROMPT;
    this.streamEventBatch = {
      maxEvents: options.streamEventBatch?.maxEvents ?? 25,
      maxBytes: options.streamEventBatch?.maxBytes ?? 32 * 1024,
      flushIntervalMs: options.streamEventBatch?.flushIntervalMs ?? 100,
    };
    this.zombieToolCallTimeoutMs = resolveZombieToolCallTimeoutMs(options.zombieToolCallTimeoutMs);
  }

  private async appendSemanticFailureUsage(
    context: RunContext,
    usage: ModelUsage | undefined,
    errorCode: string,
  ): Promise<void> {
    if (!usage) return;
    await this.eventSink.append({
      type: 'model_request_finished',
      runId: context.runId,
      sessionId: context.sessionId,
      diagnostic: {
        type: 'finished',
        modelRequestId: randomUUID(),
        attemptId: randomUUID(),
        attempt: 1,
        outcome: 'provider_error',
        durationMs: 0,
        errorCode,
        usage,
      },
    });
  }

  private withModelRequestDiagnostics(context: RunContext): RunContext {
    return {
      ...context,
      recordModelRequestDiagnostic: async (diagnostic: ModelRequestDiagnostic) => {
        try {
          if (diagnostic.type === 'started') {
            await this.eventSink.append({
              type: 'model_request_started',
              runId: context.runId,
              sessionId: context.sessionId,
              diagnostic,
            });
          } else if (diagnostic.type === 'checkpoint') {
            await this.eventSink.append({
              type: 'model_request_checkpoint',
              runId: context.runId,
              sessionId: context.sessionId,
              diagnostic,
            });
          } else {
            await this.eventSink.append({
              type: 'model_request_finished',
              runId: context.runId,
              sessionId: context.sessionId,
              diagnostic,
            });
          }
          return true;
        } catch (err) {
          logger.warn(
            `model request diagnostic append failed session=${context.sessionId} run=${context.runId}: `
            + `${err instanceof Error ? err.message : String(err)}`,
          );
          return false;
        }
      },
    };
  }

  private async autoSelectTenantHandId(sessionId?: string, runId?: string, executionTarget?: import('../agent/toolRuntime.js').ExecutionTargetKind): Promise<string | undefined> {
    if (!this.handStore || !sessionId) {
      if (this.runtimeIsolationRequirement) throw new Error('RUNTIME_ISOLATION_HAND_STORE_MISSING'); else return undefined;
    }
    try {
      const hands = await this.handStore.listBySession(sessionId);
      const decision = selectRuntimeHandRoute(hands, {
        runId, executionTarget, runtimeIsolationRequirement: this.runtimeIsolationRequirement,
      });
      if (decision.kind === 'blocked') throw new Error(decision.message);
      return decision.kind === 'ready' ? decision.handId : undefined;
    } catch (err) { if (this.runtimeIsolationRequirement) throw err;
      return undefined;
    }
  }

  /**
   * RFC v1 P0.4：跨 run 接力 — 启动时从 runStore 查上一 run 的 last_response_id（未过期）。
   * RunStore 缺失 / 接口未实现 / 查询出错全部退化为不接力（绝不阻断主流程）。
   *
   * 2026-07-02 模型匹配防线：response id 是上游后端的私有状态，只在「同一 model」下有效。
   * 会话中途切模型后，上一 run 的 id 对新后端不存在，接力必报 PreviousResponseNotFound
   * （实证：gpt-5.5 的 resp id 发给火山 glm-5.2 → HTTP 400）。lastResponseModel 与当前
   * model 不一致（含存量数据缺失）一律不接力，退化为全量首轮——中间插过别的模型的对话
   * 本就不在旧 response 链上，全量才是语义正确的选择，不只是安全退化。
   */
  private async loadInitialResponseId(
    sessionId: string,
    model: string,
    profileConfigDigest?: string,
  ): Promise<string | undefined> {
    if (!this.runStore?.findLatestResponseSessionStateBySession) return undefined;
    try {
      const state = await this.runStore.findLatestResponseSessionStateBySession(sessionId);
      if (!state?.lastResponseId) return undefined;
      if (state.lastResponseModel !== model) {
        logger.info(
          `[responses-chain] skip cross-model relay session=${sessionId} `
          + `prevModel=${state.lastResponseModel ?? '<unknown>'} currentModel=${model}`,
        );
        return undefined;
      }
      if (state.lastResponseProfileDigest !== profileConfigDigest) {
        logger.info(
          `[responses-chain] skip cross-profile relay session=${sessionId} `
          + `prevProfile=${state.lastResponseProfileDigest ?? '<legacy>'} currentProfile=${profileConfigDigest ?? '<legacy>'}`,
        );
        return undefined;
      }
      return state.lastResponseId;
    } catch {
      return undefined;
    }
  }

  /**
   * RFC v1 P0.4：把 turn 内 completed event 里的 responseId/expireAt/actualModel 落库。
   * input_tokens 增量同时累加到 cumulative_input_tokens。
   * model 作为接力身份键一并落库（loadInitialResponseId 据此拒绝跨模型接力）。
   */
  private async persistResponseSessionState(
    runId: string,
    completed: Extract<ModelEvent, { type: 'completed' }>,
    model: string,
    profileConfigDigest?: string,
  ): Promise<void> {
    if (!this.runStore?.updateResponseSessionState || !completed.responseId) return;
    try {
      await this.runStore.updateResponseSessionState(runId, {
        lastResponseId: completed.responseId,
        lastResponseModel: model,
        ...(profileConfigDigest ? { lastResponseProfileDigest: profileConfigDigest } : {}),
        ...(typeof completed.responseExpireAt === 'number'
          ? { lastResponseExpireAt: new Date(completed.responseExpireAt * 1000).toISOString() }
          : {}),
        ...(completed.actualModel ? { actualModelSeen: completed.actualModel } : {}),
        ...(completed.usage?.inputTokens
          ? { cumulativeInputTokensDelta: completed.usage.inputTokens }
          : {}),
      });
    } catch {
      // 持久化失败不阻断 agent loop（下个 turn 会重试）
    }
  }

  /** Local tool-call repair creates a call id absent from provider-owned response state. */
  private async clearResponseSessionStateForRepair(runId: string, sessionId: string): Promise<void> {
    if (!this.runStore) return;
    try {
      if (this.runStore.clearResponseSessionStateBySession) {
        await this.runStore.clearResponseSessionStateBySession(sessionId);
      } else if (this.runStore.updateResponseSessionState) {
        await this.runStore.updateResponseSessionState(runId, {
          lastResponseId: null,
          lastResponseExpireAt: null,
          actualModelSeen: null,
          lastResponseModel: null,
          lastResponseProfileDigest: null,
        });
      }
    } catch {
      // State persistence is best-effort; in-memory currentResponseId is still cleared immediately.
    }
  }

  private async loadReplaceableDraftState(context: RunContext): Promise<ReplaceableDraftRunState | null> {
    if (!supportsReplaceableDrafts(context.channelContext) || !this.runStore) return null;
    try {
      const run = await this.runStore.get(context.runId);
      return parseReplaceableDraftRunState(run?.metadata?.replaceableDraftState);
    } catch (err) {
      logger.warn(
        `[web-draft] restore state failed session=${context.sessionId} run=${context.runId}: `
        + `${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private async persistReplaceableDraftState(
    context: RunContext,
    state: ReplaceableDraftRunState | null,
  ): Promise<void> {
    if (!supportsReplaceableDrafts(context.channelContext) || !this.runStore?.patchMetadata) return;
    try {
      await this.runStore.patchMetadata(context.runId, { replaceableDraftState: state });
    } catch (err) {
      logger.warn(
        `[web-draft] persist state failed session=${context.sessionId} run=${context.runId}: `
        + `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private forceWebFetchSynthesis(reason: string, context: RunContext): void {
    if (!this.webFetchSynthesisReason) this.webFetchSynthesisReason = reason;
    this.forceSynthesis(reason, context, WEB_FETCH_SYNTHESIS_PROMPT);
    logger.warn(`[web-fetch-circuit] force synthesis session=${context.sessionId} run=${context.runId}: ${reason}`);
  }

  private forceSynthesis(
    reason: string,
    context: RunContext,
    prompt = CONTEXT_SYNTHESIS_PROMPT,
    allowSessionRecovery = false,
  ): void {
    if (this.forcedSynthesisReason) return;
    this.forcedSynthesisReason = reason;
    this.forcedSynthesisPrompt = prompt;
    this.forcedSynthesisAllowsSessionRecovery = allowSessionRecovery;
    logger.warn(`[context-governor] force synthesis session=${context.sessionId} run=${context.runId}: ${reason}`);
  }

  private prepareForcedSynthesis(messages: ModelChatMessage[]): boolean {
    if (!this.forcedSynthesisReason) return false;
    if (!this.forcedSynthesisPromptAppended) {
      messages.push({ role: 'user', content: `${this.forcedSynthesisPrompt}\n原因：${this.forcedSynthesisReason}` });
      this.forcedSynthesisPromptAppended = true;
    }
    return true;
  }

  private clearForcedSynthesis(): void {
    this.forcedSynthesisReason = undefined;
    this.forcedSynthesisPrompt = CONTEXT_SYNTHESIS_PROMPT;
    this.forcedSynthesisPromptAppended = false;
    this.forcedSynthesisAllowsSessionRecovery = false;
  }

  private async prepareSessionTools(
    descriptors: ToolDescriptor[],
    priorEvents: PlatformEvent[],
    context: RunContext,
  ): Promise<{
    tools: ReturnType<typeof toModelToolDefinition>[];
    descriptorsByName: Map<string, ToolDescriptor>;
  }> {
    const resolved = resolveSessionMcpTools({
      liveTools: descriptors.map(toModelToolDefinition),
      priorEvents,
      loadingMode: this.mcpLoadingMode,
    });
    if (resolved.needsSnapshot) {
      await this.eventSink.append({
        type: 'mcp_tool_catalog_snapshot',
        runId: context.runId,
        sessionId: context.sessionId,
        loadingMode: 'openai_responses_hosted',
        tools: resolved.snapshotTools,
      });
    }
    const visibleNames = new Set(resolved.tools.map((tool) => tool.name));
    return {
      tools: resolved.tools,
      descriptorsByName: new Map(
        descriptors
          .filter((descriptor) => visibleNames.has(descriptor.name))
          .map((descriptor) => [descriptor.name, descriptor]),
      ),
    };
  }

  private async persistLoadedMcpTools(
    completed: Extract<ModelEvent, { type: 'completed' }>,
    availableTools: ReturnType<typeof toModelToolDefinition>[],
    messages: ModelChatMessage[],
    context: RunContext,
  ): Promise<void> {
    if (!completed.toolSearchResults?.length) return;
    const previouslyLoaded = new Set(
      messages
        .filter((message): message is Extract<ModelChatMessage, { role: 'additional_tools' }> => (
          message.role === 'additional_tools'
        ))
        .flatMap((message) => message.tools.map((tool) => tool.name)),
    );
    for (const result of completed.toolSearchResults) {
      const tools = resolveLoadedMcpTools(result.loadedToolNames, availableTools, result.paths)
        .filter((tool) => !previouslyLoaded.has(tool.name));
      if (tools.length === 0) continue;
      for (const tool of tools) previouslyLoaded.add(tool.name);
      await this.eventSink.append({
        type: 'mcp_tools_loaded',
        runId: context.runId,
        sessionId: context.sessionId,
        execution: result.execution,
        paths: result.paths,
        tools,
      });
      messages.push({ role: 'additional_tools', tools });
    }
  }

  private filterLoadedToolMessages(
    messages: ModelChatMessage[],
    availableTools: ReturnType<typeof toModelToolDefinition>[],
  ): ModelChatMessage[] {
    if (this.mcpLoadingMode === 'eager') {
      return messages.filter((message) => message.role !== 'additional_tools');
    }
    const allowed = new Set(availableTools.map((tool) => tool.name));
    return messages.flatMap((message): ModelChatMessage[] => {
      if (message.role !== 'additional_tools') return [message];
      const tools = message.tools.filter((tool) => allowed.has(tool.name));
      return tools.length > 0 ? [{ role: 'additional_tools', tools }] : [];
    });
  }

  private restrictDeferredMcpDescriptors(
    descriptorsByName: Map<string, ToolDescriptor>,
    loadedToolNames: ReadonlySet<string>,
  ): Map<string, ToolDescriptor> {
    if (this.mcpLoadingMode === 'eager') return descriptorsByName;
    return new Map(
      [...descriptorsByName].filter(([name, descriptor]) => !descriptor.mcp || loadedToolNames.has(name)),
    );
  }

  private callableDescriptorsForMessages(
    descriptorsByName: Map<string, ToolDescriptor>,
    messages: ModelChatMessage[],
  ): Map<string, ToolDescriptor> {
    const loadedToolNames = new Set(
      messages
        .filter((message): message is Extract<ModelChatMessage, { role: 'additional_tools' }> => (
          message.role === 'additional_tools'
        ))
        .flatMap((message) => message.tools.map((tool) => tool.name)),
    );
    return this.restrictDeferredMcpDescriptors(descriptorsByName, loadedToolNames);
  }

  private callableDescriptorsForEvents(
    descriptorsByName: Map<string, ToolDescriptor>,
    events: PlatformEvent[],
  ): Map<string, ToolDescriptor> {
    const loadedToolNames = new Set(
      events
        .filter((event): event is Extract<PlatformEvent, { type: 'mcp_tools_loaded' }> => (
          event.type === 'mcp_tools_loaded'
        ))
        .flatMap((event) => event.tools.map((tool) => tool.name)),
    );
    return this.restrictDeferredMcpDescriptors(descriptorsByName, loadedToolNames);
  }

  async *run(input: RunInput, context: RunContext): AsyncIterable<OutboundEvent> {
    context = withDurableRunCancellation(context, this.runStore);
    this.activeTenantId = requireEventTenantId(context);
    const workspace = this.workspaceProvider.resolve(context.channelContext, {
      cwd: context.cwd,
      sessionId: context.sessionId,
      topLevelSessionId: context.topLevelSessionId,
      workspaceId: context.workspaceId,
      sandboxScopeId: context.sandboxScopeId,
      mountSubPath: context.mountSubPath, sandboxResources: context.sandboxResources,
      executionTarget: context.executionTarget,
      sandboxPolicy: context.sandboxPolicy,
    });
    const baseToolContext: ToolCallContext = {
      channelContext: context.channelContext,
      workspace,
      env: context.env,
      sessionId: context.sessionId,
      runId: context.runId,
      ...(context.memoryMaintenanceMode ? { memoryMaintenanceMode: context.memoryMaintenanceMode } : {}),
      ...(this.runtimeIsolationRequirement ? { runtimeIsolationRequirement: this.runtimeIsolationRequirement } : {}),
      hooks: context.hooks,
      signal: context.signal,
    };
    const descriptors = this.toolRuntime.list(baseToolContext);
    const replayListOptions = {
      excludeTypes: RUN_START_REPLAY_EXCLUDED_EVENT_TYPES,
      replayMode: 'bounded' as const,
    };
    const sourceEvents = context.replaySourceSessionId
      ? closeUnfinishedReplayToolCalls(
          await this.eventStore.list(requireEventTenantId(context), context.replaySourceSessionId, replayListOptions),
          context.replaySourceSessionId,
        )
      : [];
    const loadCurrentEvents = () => this.eventStore.list(requireEventTenantId(context), context.sessionId, replayListOptions);
    const combineReplayEvents = (currentEvents: PlatformEvent[]) => (
      context.replaySourceSessionId ? [...sourceEvents, ...currentEvents] : currentEvents
    );
    // replay 父事件始终是只读快照；压缩 checkpoint 只写当前隐藏会话，
    // 但评估和投影必须基于“父快照 + 隐藏增量”，否则无法缓解 replay 上下文压力。
    const loadEffectiveEvents = async () => combineReplayEvents(await loadCurrentEvents());
    let currentEvents = await loadCurrentEvents();
    const priorEvents = combineReplayEvents(currentEvents);
    const { tools, descriptorsByName } = await this.prepareSessionTools(descriptors, priorEvents, context);
    // 普通会话恢复自身；隐藏审查只恢复隐藏会话自身。父会话永远只读，缺失的
    // tool_result 已由 closeUnfinishedReplayToolCalls 在内存投影中补齐。
    const replayState = buildRuntimeReplayState(
      currentEvents,
      await this.approvalStore.list(context.sessionId),
      context.sessionId,
    );
    const recovery = await this.recoverUnclosedToolCalls(replayState);
    if (recovery.blocking) {
      yield { type: 'error', error: recovery.message };
      return;
    }
    if (recovery.recovered > 0) currentEvents = await loadCurrentEvents();
    const recoveredEvents = combineReplayEvents(currentEvents);
    const restoredDraftState = await this.loadReplaceableDraftState(context);
    let restoredDraftRecoveryUsed = false;
    if (restoredDraftState) {
      const draftStartedAt = Date.parse(restoredDraftState.startedAt);
      const canonicalCommitted = recoveredEvents.some((event) => (
        (event.type === 'assistant_message' || event.type === 'assistant_tool_calls')
        && event.runId === context.runId
        && Date.parse(event.timestamp) >= draftStartedAt
      ));
      yield canonicalCommitted
        ? { type: 'draft_commit', draftId: restoredDraftState.draftId }
        : { type: 'draft_reset', draftId: restoredDraftState.draftId };
      restoredDraftRecoveryUsed = !canonicalCommitted;
      await this.persistReplaceableDraftState(context, null);
    }
    let contextUsageTracker = new RuntimeContextUsageTracker(
      context.model,
      recoveredEvents,
      context.modelRef,
    );
    const previousContextModel = contextUsageTracker.resetActiveContextIfModelChanged(context.model);
    if (previousContextModel) {
      logger.info(
        `[context-usage] reset active chain after model switch session=${context.sessionId} `
        + `run=${context.runId} previousModel=${previousContextModel} currentModel=${context.model}`,
      );
    }
    let contextPressureForceReason: string | undefined;
    if (context.evaluateAutoCompaction && this.runStore?.get) {
      try {
        const currentRun = await this.runStore.get(context.runId);
        contextPressureForceReason = parseContextPressureState(currentRun?.metadata?.contextPressure)?.reason;
      } catch (err) {
        logger.warn(
          `[auto-compact] restore context pressure failed session=${context.sessionId} run=${context.runId}: `
          + `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    let autoCompactionSuppressed = false;
    const activeRecoveredCheckpoint = hasActiveCheckpointForRun(recoveredEvents, context.runId);
    if (activeRecoveredCheckpoint) {
      contextPressureForceReason = undefined;
      try {
        await this.runStore?.patchMetadata?.(context.runId, { contextPressure: null });
      } catch (err) {
        logger.warn(
          `[auto-compact] clear recovered checkpoint pressure failed session=${context.sessionId} `
          + `run=${context.runId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const contextProjection = buildContextProjection(recoveredEvents, {
      sessionId: context.replaySourceSessionId ?? context.sessionId,
      runId: context.runId,
      policy: context.replaySourceSessionId ? { type: 'full_replay' } : this.contextPolicy,
      excludeMemoryContext: Boolean(input.memoryContext),
    });
    const memoryMessage = input.memoryContext
      ? [{ role: 'user' as const, content: formatMemoryContext(input.memoryContext) }]
      : [];
    let contextRewindRecoveryUsed = recoveredEvents.some((event) => (
      event.type === 'context_rewind' && event.runId === context.runId
    ));
    const omitWakeContinuation = contextRewindRecoveryUsed && input.recordUserMessage === false;
    let messages: ModelChatMessage[] = [
      { role: 'system', content: input.instructions },
      ...memoryMessage,
      ...this.filterLoadedToolMessages(contextProjection.messages, tools),
      ...(!activeRecoveredCheckpoint && !omitWakeContinuation
        ? [{ role: 'user' as const, content: buildModelUserContent(input.prompt, input.attachments, input.visionAnalysis) }]
        : []),
    ];
    if (contextRewindRecoveryUsed) clearProviderContinuations(messages);
    let currentUserMessageIndex = findLastUserMessageIndex(messages);
    const steeringInterjections = new SteeringInterjectionCoordinator({
      context,
      messages,
      priorEvents: recoveredEvents,
      currentUserMessageIndex,
      runStore: this.runStore,
      eventStore: this.eventStore,
      tenantId: requireEventTenantId(context),
      transcriptProjection: this.transcriptProjection,
      append: (event) => this.eventSink.append(event),
      warn: (message) => logger.warn(message),
    });
    const manualCheckpointSourceRunIds = steeringInterjections.manualCheckpointSourceRunIds;
    const drainQueuedInterjections = async () => {
      const interjections = await steeringInterjections.drain();
      currentUserMessageIndex = steeringInterjections.currentUserMessageIndex;
      return interjections;
    };
    const announceAppliedInterjections = (
      interjections: Awaited<ReturnType<typeof drainQueuedInterjections>>,
    ) => steeringInterjections.announce(interjections);

    if (contextProjection.summaryEvent && !context.replaySourceSessionId) {
      await this.eventSink.append(contextProjection.summaryEvent);
    }
    if (input.memoryContext) {
      await this.eventSink.append({
        type: 'memory_context',
        runId: context.runId,
        sessionId: context.sessionId,
        content: formatMemoryContext(input.memoryContext),
      });
    }
    await this.eventSink.append({
      type: 'run_started',
      runId: context.runId,
      sessionId: context.sessionId,
      model: context.model,
      channel: context.channelContext.channel,
      ...(context.profileId ? { profileId: context.profileId } : {}),
      ...(context.profileVersionId ? { profileVersionId: context.profileVersionId } : {}),
      ...(context.profileConfigDigest ? { profileConfigDigest: context.profileConfigDigest } : {}),
    });
    logger.info(`[run] start session=${context.sessionId} model=${context.model} channel=${context.channelContext.channel}`);
    if (input.recordUserMessage !== false) {
      await this.eventSink.append({
        type: 'user_message',
        runId: context.runId,
        sessionId: context.sessionId,
        content: input.message.content,
        modelContent: input.prompt,
        ...(input.clientMsgId ? { clientMsgId: input.clientMsgId } : {}),
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        ...(input.visionAnalysis ? { visionAnalysis: input.visionAnalysis } : {}),
      });
    }

    let textStarted = false;
    let thinkingStarted = false;
    let totalUsage: ModelUsage | undefined;
    let finalText = '';
    let turn = 0;
    let turnLimit = input.maxTurns;
    const successfulCompletion = createSuccessfulCompletionController((message) => logger.warn(message));
    let thinkingOnlyContinuationUsed = false;
    let pendingTurnText = '';
    // safe boundary 在上一轮收尾/工具后完成 reserve+apply 时，把通知归属带到下一模型轮次。
    let carriedBoundaryInterjections: Awaited<ReturnType<typeof drainQueuedInterjections>> = [];

    // RFC v1 P0.4：跨 run 接力 Responses API session state；启动时读取 72h 内的 last_response_id。
    // ChatCompletionsAdapter 不消费 previousResponseId；dispatcher 已按 protocol 路由 adapter。
    const usesStoredResponseState = !context.disableResponseRelay
      && this.modelAdapter.capabilities?.responseState !== 'stateless';
    if (contextRewindRecoveryUsed) await this.clearResponseRelayState(context.sessionId, 'run wake');
    let currentResponseId = usesStoredResponseState && !contextRewindRecoveryUsed
      ? await this.loadInitialResponseId(context.sessionId, context.model, context.profileConfigDigest)
      : undefined;

    try {
      for (turn = 1; turn <= turnLimit; turn++) {
        if (context.drainHandoff?.requested) {
          logger.info(
            `[run] safe drain handoff session=${context.sessionId} run=${context.runId} afterTurns=${turn - 1}`,
          );
          return;
        }
        let boundaryInterjections = carriedBoundaryInterjections;
        carriedBoundaryInterjections = [];
        if (boundaryInterjections.length === 0) {
          try {
            boundaryInterjections = await drainQueuedInterjections();
          } catch (error) {
            if (context.signal?.aborted) throw error;
            logger.warn(
              `[run] steering drain failed at turn start (degraded): run=${context.runId} error=${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        if (boundaryInterjections.length > 0) {
          // reserve + durable append + apply 已完成，所有权真源已一致；无需再等待模型首事件。
          // 立即通知 Web 清队列，避免 provider 在首事件前失败或部分 apply handoff 时
          // 留下 live 幽灵条目。
          yield await announceAppliedInterjections(boundaryInterjections);
        }
        if (context.drainHandoff?.requested) return;
        context.replaceableDraftRetryUsed = turn === 1 && restoredDraftRecoveryUsed;
        let completed: Extract<ModelEvent, { type: 'completed' }> | null = null;
        let turnContextUsage: OutboundEvent['contextUsage'] | null = null;
        let turnText = '';
        let turnThinking = '';
        const turnFinalTextStart = finalText.length;
        const draftId = supportsReplaceableDrafts(context.channelContext) ? randomUUID() : undefined;
        const draftStartedAt = new Date().toISOString();
        let draftStatePersisted = false;
        const ensureDraftStatePersisted = async () => {
          if (!draftId || draftStatePersisted) return;
          await this.persistReplaceableDraftState(context, {
            draftId,
            recoveryUsed: context.replaceableDraftRetryUsed === true,
            startedAt: draftStartedAt,
          });
          draftStatePersisted = true;
        };
        // RawAgentLoop 不逐 token 落 assistant_stream_event；多进程传输层仅写有界聚合批次。UI 的"思考 Xs"
        // 时长改由 assistant_thinking 聚合行的 durationMs 携带。
        let turnThinkingMs = 0;
        let thinkingSegmentStartedAt: number | undefined;
        pendingTurnText = '';

        await this.assertNoOpenToolCallBatchesBeforeModel(context.sessionId);
        if (manualCheckpointSourceRunIds.size > 0) {
          const controlSourceRunIds = [...manualCheckpointSourceRunIds];
          const checkpointEvents = await loadEffectiveEvents();
          const alreadyCheckpointed = controlSourceRunIds.every((sourceRunId) => (
            checkpointEvents.some((event) => (
              event.type === 'compaction'
              && event.checkpoint?.controlSourceRunIds?.includes(sourceRunId)
            ))
          ));
          if (!alreadyCheckpointed) {
            const outcome = yield* this.compactHistory(
              { instructions: input.instructions },
              context,
              checkpointEvents,
              {
                inline: true,
                trigger: 'manual',
                sourceRunId: context.runId,
                controlSourceRunIds,
                baseFixedTokens: estimateContextTokens([input.instructions, tools]),
              },
            );
            if (outcome.usage) totalUsage = mergeUsage(totalUsage, outcome.usage);
            if (outcome.status === 'aborted') {
              const reason = context.signal?.reason;
              throw reason instanceof Error ? reason : new Error(String(reason ?? 'run aborted'));
            }
            if (outcome.status === 'compacted') {
              const compactedEvents = await loadEffectiveEvents();
              const compactedProjection = buildContextProjection(compactedEvents, {
                sessionId: context.replaySourceSessionId ?? context.sessionId,
                runId: context.runId,
                policy: context.replaySourceSessionId ? { type: 'full_replay' } : this.contextPolicy,
                excludeMemoryContext: Boolean(input.memoryContext),
              });
              messages.splice(
                0,
                messages.length,
                { role: 'system', content: input.instructions },
                ...memoryMessage,
                ...this.filterLoadedToolMessages(compactedProjection.messages, tools),
              );
              currentUserMessageIndex = findLastUserMessageIndex(messages);
              contextUsageTracker = new RuntimeContextUsageTracker(
                context.model,
                compactedEvents,
                context.modelRef,
              );
              currentResponseId = undefined;
              this.clearForcedSynthesis();
            } else if (outcome.status === 'error') {
              yield {
                type: 'compaction_end',
                compaction: {
                  skipped: true,
                  note: '手动压缩失败，已继续当前任务。',
                  coveredEventCount: 0,
                },
              };
            }
          }
          manualCheckpointSourceRunIds.clear();
        }
        const preflight = governModelRequestMessages(
          messages,
          context.model,
          currentUserMessageIndex,
          contextUsageTracker.currentContextTokens,
          context.modelRef,
        );
        if (preflight.shouldCompactBeforeRequest) {
          const pressure: ContextPressureState = {
            reason: 'context_governor',
            detectedAt: new Date().toISOString(),
            triggerTokens: preflight.triggerTokens ?? 0,
            thresholdTokens: preflight.thresholdTokens ?? 0,
            droppedMessages: preflight.droppedMessages,
          };
          contextPressureForceReason = pressure.reason;
          try {
            await this.runStore?.patchMetadata?.(context.runId, { contextPressure: pressure });
          } catch (err) {
            logger.warn(
              `[auto-compact] persist context pressure failed session=${context.sessionId} run=${context.runId}: `
              + `${err instanceof Error ? err.message : String(err)}`,
            );
          }

          let checkpointSucceeded = false;
          if (context.evaluateAutoCompaction && !autoCompactionSuppressed) {
            const checkpointEvents = await loadEffectiveEvents();
            const evaluation = context.evaluateAutoCompaction(checkpointEvents, pressure.reason);
            if (evaluation.shouldCompact) {
              logger.info(
                `[auto-compact] pre-request checkpoint session=${context.sessionId} run=${context.runId} `
                + `tokens=${preflight.triggerTokens}/${preflight.thresholdTokens}`,
              );
              const outcome = yield* this.compactHistory(
                { instructions: input.instructions },
                context,
                checkpointEvents,
                {
                  inline: true,
                  trigger: 'threshold',
                  sourceRunId: context.runId,
                  baseFixedTokens: estimateContextTokens([input.instructions, tools]),
                  },
              );
              if (outcome.usage) totalUsage = mergeUsage(totalUsage, outcome.usage);
              if (outcome.status === 'aborted') {
                const reason = context.signal?.reason;
                throw reason instanceof Error ? reason : new Error(String(reason ?? 'run aborted'));
              }
              if (outcome.status === 'compacted') {
                const compactedEvents = await loadEffectiveEvents();
                const compactedProjection = buildContextProjection(compactedEvents, {
                  sessionId: context.replaySourceSessionId ?? context.sessionId,
                  runId: context.runId,
                  policy: context.replaySourceSessionId ? { type: 'full_replay' } : this.contextPolicy,
                  excludeMemoryContext: Boolean(input.memoryContext),
                });
                messages.splice(
                  0,
                  messages.length,
                  { role: 'system', content: input.instructions },
                  ...memoryMessage,
                  ...this.filterLoadedToolMessages(compactedProjection.messages, tools),
                );
                currentUserMessageIndex = findLastUserMessageIndex(messages);
                contextUsageTracker = new RuntimeContextUsageTracker(
                  context.model,
                  compactedEvents,
                  context.modelRef,
                );
                currentResponseId = undefined;
                this.clearForcedSynthesis();
                contextPressureForceReason = undefined;
                checkpointSucceeded = true;
                try {
                  await this.runStore?.patchMetadata?.(context.runId, {
                    contextPressure: null,
                    autoCompactedAt: new Date().toISOString(),
                  });
                } catch (err) {
                  logger.warn(
                    `[auto-compact] clear context pressure failed session=${context.sessionId} run=${context.runId}: `
                    + `${err instanceof Error ? err.message : String(err)}`,
                  );
                }
              } else {
                autoCompactionSuppressed = true;
                if (outcome.status === 'error') {
                  logger.warn(
                    `[auto-compact] pre-request checkpoint failed; continuing session=${context.sessionId} `
                    + `run=${context.runId}: ${outcome.error ?? 'unknown error'}`,
                  );
                  yield {
                    type: 'compaction_end',
                    compaction: {
                      skipped: true,
                      note: '自动压缩失败，已继续当前会话。',
                      coveredEventCount: 0,
                    },
                  };
                }
              }
            } else if (!evaluation.shouldCompact) {
              autoCompactionSuppressed = true;
            }
          }
          if (!checkpointSucceeded) {
            autoCompactionSuppressed = true;
            if (isEmergencyContextPressure(preflight.triggerTokens, context.model, context.modelRef)) {
              this.forceSynthesis(
                `上下文 ${preflight.triggerTokens} tokens 已逼近模型硬窗口；自动 checkpoint 未能建立，进入紧急收束`,
                context,
                CONTEXT_SYNTHESIS_PROMPT,
                true,
              );
              currentResponseId = undefined;
            } else {
              logger.warn(
                `[auto-compact] soft checkpoint unavailable; continuing with normal tools `
                + `session=${context.sessionId} run=${context.runId} `
                + `tokens=${preflight.triggerTokens}/${preflight.thresholdTokens}`,
              );
            }
          }
        }
        const forceSynthesis = this.prepareForcedSynthesis(messages);
        const requestTools = forceSynthesis && this.forcedSynthesisAllowsSessionRecovery
          ? tools.filter((tool) => SESSION_CONTEXT_RECOVERY_TOOL_NAMES.has(tool.name))
          : tools;
        const allowSessionRecovery = forceSynthesis
          && this.forcedSynthesisAllowsSessionRecovery
          && requestTools.length > 0;
        const requestSystemIndex = messages.findIndex((message) => message.role !== 'system');
        const requestHistory = messages.slice(Math.max(0, requestSystemIndex));
        const requestCurrentUserMessage = requestHistory.at(-1);
        const requestCurrentUser = requestCurrentUserMessage?.role === 'user'
          ? requestCurrentUserMessage.content
          : '';
        const requestHistoryMessages = requestHistory.slice(0, -1);
        await context.authorizeModelTurn?.();
        const contextSnapshot = buildContextBreakdownSnapshot({
          instructionSections: input.instructionSections,
          instructions: input.instructions,
          memoryContext: input.memoryContext,
          historyMessages: requestHistoryMessages.filter((message, index) => (
            !(
              index === 0
              && input.memoryContext
              && message.role === 'user'
              && message.content === input.memoryContext
            )
          )),
          currentUserContent: requestCurrentUser,
          attachmentCount: input.attachments?.length,
          tools: requestTools,
          descriptorsByName,
        });
        let modelStreamError: unknown;
        const modelEvents = captureModelStreamError(
          this.modelAdapter.stream({
            model: context.model,
            // Adapter 可能为诊断/重试保留 request 引用；传快照，避免本轮结束后的上下文追加反向污染已发送请求。
            messages: [...messages],
            tools: requestTools,
            signal: context.signal,
            ...(forceSynthesis && !allowSessionRecovery ? { toolChoice: 'none' as const } : {}),
            ...(currentResponseId ? { previousResponseId: currentResponseId } : {}),
          }, this.withModelRequestDiagnostics(context)),
          (error) => { modelStreamError = error; },
        );
        for await (const event of modelEvents) {
          if (event.type === 'thinking_delta') {
            if (!thinkingStarted) {
              thinkingStarted = true;
              thinkingSegmentStartedAt = Date.now();
              await ensureDraftStatePersisted();
              yield { type: 'thinking_start', ...(draftId ? { draftId } : {}) };
            }
            turnThinking += event.content;
            yield { type: 'thinking_delta', content: event.content };
          } else if (event.type === 'text_delta') {
            if (thinkingStarted) {
              thinkingStarted = false;
              if (thinkingSegmentStartedAt !== undefined) {
                turnThinkingMs += Date.now() - thinkingSegmentStartedAt;
                thinkingSegmentStartedAt = undefined;
              }
              yield { type: 'thinking_end' };
            }
            if (!textStarted) {
              textStarted = true;
              await ensureDraftStatePersisted();
              yield { type: 'text_start', ...(draftId ? { draftId } : {}) };
            }
            turnText += event.content;
            pendingTurnText += event.content;
            finalText += event.content;
            yield { type: 'text_delta', content: event.content };
          } else if (event.type === 'draft_reset') {
            thinkingStarted = false;
            textStarted = false;
            thinkingSegmentStartedAt = undefined;
            turnThinkingMs = 0;
            turnThinking = '';
            turnText = '';
            pendingTurnText = '';
            finalText = finalText.slice(0, turnFinalTextStart);
            if (draftId) {
              context.replaceableDraftRetryUsed = true;
              await this.persistReplaceableDraftState(context, {
                draftId,
                recoveryUsed: true,
                startedAt: draftStartedAt,
              });
              yield { type: 'draft_reset', draftId, attempt: event.attempt };
            }
          } else {
            completed = event;
          }
        }
        if (thinkingStarted) {
          thinkingStarted = false;
          if (thinkingSegmentStartedAt !== undefined) {
            turnThinkingMs += Date.now() - thinkingSegmentStartedAt;
            thinkingSegmentStartedAt = undefined;
          }
          yield { type: 'thinking_end' };
        }

        if (completed?.usage) totalUsage = mergeUsage(totalUsage, completed.usage);
        const blockedFailure = getInvalidPromptRequestBlockedFailure(modelStreamError ?? completed);
        if (
          blockedFailure
          && !contextRewindRecoveryUsed
          && !turnText
          && !turnThinking
          && !pendingTurnText
        ) {
          const recovery = await this.buildInvalidPromptRecovery({
            failure: blockedFailure,
            context,
            instructions: input.instructions,
            tools,
          });
          if (recovery) {
            contextRewindRecoveryUsed = true;
            messages = recovery.messages;
            currentUserMessageIndex = findLastUserMessageIndex(messages);
            currentResponseId = undefined;
            contextUsageTracker = new RuntimeContextUsageTracker(context.model, recovery.replayEvents, context.modelRef);
            this.clearForcedSynthesis();
            turn -= 1;
            continue;
          }
        }
        if (modelStreamError) throw modelStreamError;
        if (!completed) throw new Error('model stream completed without completion event');
        assertSuccessfulModelTerminal(completed);
        const projectedContextTokens = completed.usage
          ? contextUsageTracker.previewCurrentContextTokens(
              context.model,
              completed.usage,
              completed.responseMode,
              completed.responseChained,
            )
          : undefined;
        const calibratedBreakdown = calibrateContextBreakdown(
          contextSnapshot.breakdown,
          completed.usage,
          projectedContextTokens,
        );
        if (completed.usage) {
          turnContextUsage = contextUsageTracker.record(
            context.model,
            completed.usage,
            completed.responseMode,
            completed.responseChained,
            {
              breakdown: calibratedBreakdown,
              memoryFiles: calibratedBreakdown.memoryFiles ?? contextSnapshot.memoryFiles,
              mcpTools: calibratedBreakdown.mcpTools ?? contextSnapshot.mcpTools,
            },
          );
        }
        if (turnThinking) {
          await this.eventSink.append({
            type: 'assistant_thinking',
            runId: context.runId,
            sessionId: context.sessionId,
            content: turnThinking,
            streamed: true,
            durationMs: turnThinkingMs,
          });
        }

        // RFC v1 P0.4：每轮持久化 Responses API session state。
        // currentResponseId 供同 run 下一轮及跨 run 接力。
        if (usesStoredResponseState && completed.responseStateReset) {
          currentResponseId = undefined;
          await this.clearResponseSessionStateForRepair(context.runId, context.sessionId);
        } else if (usesStoredResponseState && completed.responseId) {
          currentResponseId = completed.responseId;
          await this.persistResponseSessionState(context.runId, completed, context.model, context.profileConfigDigest);
        }
        await this.persistLoadedMcpTools(completed, tools, messages, context);

        if (completed.toolCalls.length === 0) {
          if (completed.content && completed.content !== turnText) {
            if (!textStarted) {
              textStarted = true;
              await ensureDraftStatePersisted();
              yield { type: 'text_start', ...(draftId ? { draftId } : {}) };
            }
            finalText += completed.content;
            yield { type: 'text_delta', content: completed.content };
          }
          const assistantContent = completed.content || turnText;
          if (!assistantContent) {
            await this.appendSemanticFailureUsage(context, completed.usage, 'semantic_empty_turn');
            if (turnThinking && !thinkingOnlyContinuationUsed) {
              thinkingOnlyContinuationUsed = true;
              messages.push({ role: 'user', content: THINKING_ONLY_CONTINUATION_PROMPT });
              if (draftId) {
                await this.persistReplaceableDraftState(context, null);
                yield { type: 'draft_commit', draftId };
              }
              if (turnContextUsage) yield { type: 'context_usage', contextUsage: turnContextUsage };
              logger.warn(`[run] thinking-only empty turn recovered session=${context.sessionId} turn=${turn}`);
              continue;
            }
            throw new Error(
              `model returned empty turn (no content, no tool_calls, finish_reason=${
                completed.finishReason ?? 'unknown'
              }${turnThinking ? ', thinking-only' : ''})`,
            );
          }
          await this.eventSink.append({
            type: 'assistant_message',
            runId: context.runId,
            sessionId: context.sessionId,
            content: assistantContent,
            model: context.model,
            ...(completed.usage ? { usage: completed.usage } : {}),
            ...(completed.responseChained !== undefined ? { responseChained: completed.responseChained } : {}),
            ...(completed.responseMode ? { responseMode: completed.responseMode } : {}),
            ...(completed.modelRequestAttemptCount !== undefined
              ? { modelRequestAttemptCount: completed.modelRequestAttemptCount }
              : {}),
            ...(completed.promptCacheKey ? { promptCacheKey: completed.promptCacheKey } : {}),
            ...(completed.requestInputPrefixHash
              ? { requestInputPrefixHash: completed.requestInputPrefixHash }
              : {}),
            ...(completed.requestInstructionsHash
              ? { requestInstructionsHash: completed.requestInstructionsHash }
              : {}),
            ...(completed.requestToolsHash ? { requestToolsHash: completed.requestToolsHash } : {}),
            ...(completed.requestHistoryHash ? { requestHistoryHash: completed.requestHistoryHash } : {}),
            ...(completed.cacheEligible !== undefined ? { cacheEligible: completed.cacheEligible } : {}),
            ...(completed.requestBodyBytes !== undefined ? { requestBodyBytes: completed.requestBodyBytes } : {}),
            ...(completed.wireMode ? { wireMode: completed.wireMode } : {}),
            ...(completed.wireRequestBodyBytes !== undefined
              ? { wireRequestBodyBytes: completed.wireRequestBodyBytes }
              : {}),
            ...(completed.wireFallbackReason ? { wireFallbackReason: completed.wireFallbackReason } : {}),
            ...(completed.providerContinuation
              ? { providerContinuation: completed.providerContinuation }
              : {}),
            ...(completed.providerContinuationReset
              ? { providerContinuationReset: true }
              : {}),
            contextBreakdown: calibratedBreakdown,
            ...(textStarted ? { streamed: true } : {}),
          });
          pendingTurnText = '';
          if (textStarted) {
            yield { type: 'text_end' };
          }
          if (draftId) {
            await this.persistReplaceableDraftState(context, null);
            yield { type: 'draft_commit', draftId };
          }
          if (turnContextUsage) yield { type: 'context_usage', contextUsage: turnContextUsage };
          if (completed.providerContinuationReset) clearProviderContinuations(messages);
          messages.push({
            role: 'assistant',
            content: assistantContent,
            ...(completed.providerContinuation
              ? { provider_continuation: completed.providerContinuation }
              : {}),
          });
          if (context.evaluateAutoCompaction && !autoCompactionSuppressed) {
            const compactionEvents = await loadEffectiveEvents();
            const evaluation = context.evaluateAutoCompaction(
              compactionEvents,
              contextPressureForceReason,
            );
            if (evaluation.shouldCompact) {
              logger.info(
                `[auto-compact] inline start session=${context.sessionId} run=${context.runId} `
                + `tokens=${evaluation.currentTokens ?? 'unknown'}/${evaluation.contextWindow ?? 'unknown'} `
                + `threshold=${evaluation.thresholdTokens ?? 'forced'}(${evaluation.thresholdRatio ?? 'unknown'}) `
                + `reason=${evaluation.reason}`,
              );
              const outcome = yield* this.compactHistory(
                { instructions: input.instructions },
                context,
                compactionEvents,
                {
                  inline: true,
                  trigger: 'threshold',
                  sourceRunId: context.runId,
                  baseFixedTokens: estimateContextTokens([input.instructions, tools]),
                  },
              );
              if (outcome.usage) totalUsage = mergeUsage(totalUsage, outcome.usage);
              if (outcome.status === 'aborted') {
                const reason = context.signal?.reason;
                throw reason instanceof Error ? reason : new Error(String(reason ?? 'run aborted'));
              }
              if (outcome.status === 'compacted') {
                const compactedEvents = await loadEffectiveEvents();
                const compactedProjection = buildContextProjection(compactedEvents, {
                  sessionId: context.replaySourceSessionId ?? context.sessionId,
                  runId: context.runId,
                  policy: context.replaySourceSessionId ? { type: 'full_replay' } : this.contextPolicy,
                  excludeMemoryContext: Boolean(input.memoryContext),
                });
                messages.splice(
                  0,
                  messages.length,
                  { role: 'system', content: input.instructions },
                  ...memoryMessage,
                  ...this.filterLoadedToolMessages(compactedProjection.messages, tools),
                );
                currentUserMessageIndex = findLastUserMessageIndex(messages);
                contextUsageTracker = new RuntimeContextUsageTracker(
                  context.model,
                  compactedEvents,
                  context.modelRef,
                );
                currentResponseId = undefined;
                this.clearForcedSynthesis();
                thinkingOnlyContinuationUsed = false;
                contextPressureForceReason = undefined;
                try {
                  await this.runStore?.patchMetadata?.(context.runId, {
                    contextPressure: null,
                    autoCompactedAt: new Date().toISOString(),
                  });
                } catch (err) {
                  logger.warn(
                    `[auto-compact] clear context pressure failed session=${context.sessionId} run=${context.runId}: `
                    + `${err instanceof Error ? err.message : String(err)}`,
                  );
                }
                logger.info(`[auto-compact] inline finished session=${context.sessionId} run=${context.runId}`);
              } else {
                autoCompactionSuppressed = true;
                if (outcome.status === 'error') {
                  logger.warn(
                    `[auto-compact] inline failed; continuing run session=${context.sessionId} run=${context.runId}: `
                    + `${outcome.error ?? 'unknown error'}`,
                  );
                  yield {
                    type: 'compaction_end',
                    compaction: {
                      skipped: true,
                      note: '自动压缩失败，已继续当前会话。',
                      coveredEventCount: 0,
                    },
                  };
                }
              }
            }
          }
          // 先吸收 completed 前已入队的消息。successful-completion 若要求续轮，窗口必须继续开放；
          // 只有确认即将终态时才 seal，并在封口竞态失败后再 drain 一次。
          let queuedInterjections: Awaited<ReturnType<typeof drainQueuedInterjections>> = [];
          try {
            queuedInterjections = await drainQueuedInterjections();
          } catch (error) {
            if (context.signal?.aborted) throw error;
            logger.warn(
              `[run] steering drain failed at text boundary (degraded): run=${context.runId} error=${error instanceof Error ? error.message : String(error)}`,
            );
          }
          if (context.drainHandoff?.requested) {
            if (queuedInterjections.length > 0) yield await announceAppliedInterjections(queuedInterjections);
            return;
          }
          if (queuedInterjections.length > 0) {
            carriedBoundaryInterjections = queuedInterjections;
            if (turn >= turnLimit) turnLimit = turn + input.maxTurns;
            continue;
          }
          if (await successfulCompletion.check(context, messages, assistantContent)) {
            currentResponseId = undefined;
            textStarted = false;
            if (turn >= turnLimit) turnLimit += 1;
            continue;
          }
          try {
            if (this.runStore?.trySealSteeringInputWindow) {
              const sealed = await this.runStore.trySealSteeringInputWindow(context.runId);
              if (!sealed) queuedInterjections = await drainQueuedInterjections();
            }
          } catch (error) {
            if (context.signal?.aborted) throw error;
            steeringInterjections.requestRecoveryHandoff('steering_seal_failed');
            logger.warn(
              `[run] steering seal failed; handing off run=${context.runId}: ${error instanceof Error ? error.message : String(error)}`,
            );
            return;
          }
          if (context.drainHandoff?.requested) {
            if (queuedInterjections.length > 0) yield await announceAppliedInterjections(queuedInterjections);
            return;
          }
          if (queuedInterjections.length > 0) {
            carriedBoundaryInterjections = queuedInterjections;
            if (turn >= turnLimit) turnLimit = turn + input.maxTurns;
            continue;
          }
          await finishSuccessfulRun({
            context, numTurns: turn, totalUsage, finalText,
            append: (event) => this.eventSink.append(event),
            log: () => logger.info(`[run] finished session=${context.sessionId} turns=${turn}`),
          });
          yield { type: 'done' };
          return;
        }

        successfulCompletion.reset();
        if (completed.content && completed.content !== turnText) {
          if (!textStarted) {
            textStarted = true;
            await ensureDraftStatePersisted();
            yield { type: 'text_start', ...(draftId ? { draftId } : {}) };
          }
          finalText += completed.content;
          yield { type: 'text_delta', content: completed.content };
        }
        const toolCallContentStreamed = textStarted;
        if (textStarted) {
          textStarted = false;
          yield { type: 'text_end' };
        }

        await this.eventSink.append({
          type: 'assistant_tool_calls',
          runId: context.runId,
          sessionId: context.sessionId,
          content: completed.content || turnText,
          model: context.model,
          ...(completed.usage ? { usage: completed.usage } : {}),
          ...(completed.responseChained !== undefined ? { responseChained: completed.responseChained } : {}),
          ...(completed.responseMode ? { responseMode: completed.responseMode } : {}),
          ...(completed.modelRequestAttemptCount !== undefined
            ? { modelRequestAttemptCount: completed.modelRequestAttemptCount }
            : {}),
          ...(completed.promptCacheKey ? { promptCacheKey: completed.promptCacheKey } : {}),
          ...(completed.requestInputPrefixHash
            ? { requestInputPrefixHash: completed.requestInputPrefixHash }
            : {}),
          ...(completed.requestInstructionsHash
            ? { requestInstructionsHash: completed.requestInstructionsHash }
            : {}),
          ...(completed.requestToolsHash ? { requestToolsHash: completed.requestToolsHash } : {}),
          ...(completed.requestHistoryHash ? { requestHistoryHash: completed.requestHistoryHash } : {}),
          ...(completed.cacheEligible !== undefined ? { cacheEligible: completed.cacheEligible } : {}),
          ...(completed.requestBodyBytes !== undefined ? { requestBodyBytes: completed.requestBodyBytes } : {}),
          ...(completed.wireMode ? { wireMode: completed.wireMode } : {}),
          ...(completed.wireRequestBodyBytes !== undefined
            ? { wireRequestBodyBytes: completed.wireRequestBodyBytes }
            : {}),
          ...(completed.wireFallbackReason ? { wireFallbackReason: completed.wireFallbackReason } : {}),
          ...(completed.providerContinuation
            ? { providerContinuation: completed.providerContinuation }
            : {}),
          ...(completed.providerContinuationReset
            ? { providerContinuationReset: true }
            : {}),
          contextBreakdown: calibratedBreakdown,
          ...(toolCallContentStreamed ? { streamed: true } : {}),
          toolCalls: completed.toolCalls,
        });
        pendingTurnText = '';
        if (draftId) {
          await this.persistReplaceableDraftState(context, null);
          yield { type: 'draft_commit', draftId };
        }
        if (turnContextUsage) yield { type: 'context_usage', contextUsage: turnContextUsage };
        if (completed.providerContinuationReset) clearProviderContinuations(messages);
        messages.push({
          role: 'assistant',
          content: completed.content || turnText || null,
          tool_calls: completed.toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.arguments },
            ...(call.namespace ? { namespace: call.namespace } : {}),
          })),
          ...(completed.providerContinuation
            ? { provider_continuation: completed.providerContinuation }
            : {}),
        });
        let yieldedToUserInput = false;
        yield* this.drainToolCalls({
          calls: completed.toolCalls,
          descriptorsByName: this.callableDescriptorsForMessages(descriptorsByName, messages),
          baseToolContext,
          context,
          messages,
          shouldYieldToUserInput: async () => (yieldedToUserInput = await hasQueuedUserInputAtToolBoundary({
            context, disabled: steeringInterjections.absorptionDisabled, warn: (message) => logger.warn(message),
          })),
        });
        if (yieldedToUserInput && turn >= turnLimit) turnLimit = turn + input.maxTurns;
        if (turn < turnLimit) {
          try {
            carriedBoundaryInterjections = await drainQueuedInterjections();
          } catch (error) {
            if (context.signal?.aborted) throw error;
            logger.warn(
              `[run] steering drain failed after tools (degraded): run=${context.runId} error=${error instanceof Error ? error.message : String(error)}`,
            );
          }
          if (context.drainHandoff?.requested) {
            if (carriedBoundaryInterjections.length > 0) {
              yield await announceAppliedInterjections(carriedBoundaryInterjections);
            }
            return;
          }
        }
      }

      if (textStarted) {
        textStarted = false;
        yield { type: 'text_end' };
      }
      throw new Error(`raw agent loop exceeded maxTurns=${turnLimit}`);
    } catch (err) {
      if (err instanceof RunLeaseLostError) {
        if (thinkingStarted) yield { type: 'thinking_end' };
        if (textStarted) yield { type: 'text_end' };
        return;
      }
      if (err instanceof ToolInvocationClaimLostError) {
        const failure = await handleInvocationClaimLoss(
          err, context, this.runStore, (event) => this.eventSink.append(event), 'run',
        );
        if (failure) yield failure;
        else {
          if (thinkingStarted) yield { type: 'thinking_end' };
          if (textStarted) yield { type: 'text_end' };
        }
        return;
      }
      if (err instanceof ApprovalPendingWithoutInteractionHook) {
        if (thinkingStarted) yield { type: 'thinking_end' };
        if (textStarted) {
          textStarted = false;
          yield { type: 'text_end' };
        }
        return;
      }
      if (err instanceof InteractionPendingWithoutInteractionHook) {
        if (thinkingStarted) yield { type: 'thinking_end' };
        if (textStarted) {
          textStarted = false;
          yield { type: 'text_end' };
        }
        yield toOutboundInteractionEvent(err.event);
        return;
      }
      if (thinkingStarted) yield { type: 'thinking_end' };
      if (textStarted) {
        textStarted = false;
        yield { type: 'text_end' };
      }
      const { diagnosticMessage, message, surfacedMessage, preservedTurnText, failureProtocol } = describeRuntimeFailure(err, pendingTurnText, INVALID_PROMPT_CUSTOMER_ERROR);
      const modelUsage = buildModelUsage(context.model, totalUsage);
      if (preservedTurnText) {
        await this.eventSink.append({
          type: 'assistant_message',
          runId: context.runId,
          sessionId: context.sessionId,
          content: preservedTurnText,
          model: context.model,
          streamed: true,
          incomplete: true,
        });
      }
      if (isForcedDrainHandoff(context)) {
        logger.warn(
          `[run] drain deadline forced safe handoff session=${context.sessionId} run=${context.runId} turn=${turn}`,
        );
        return;
      }
      await this.eventSink.append({
        type: 'run_finished',
        runId: context.runId,
        sessionId: context.sessionId,
        subtype: 'error',
        numTurns: turn,
        ...(modelUsage ? { modelUsage } : {}),
        error: surfacedMessage,
        ...(failureProtocol ?? {}),
      });
      await context.hooks?.onResult?.({
        subtype: 'error',
        numTurns: turn,
        resultText: mergeRuntimeFailureResultText(finalText, preservedTurnText),
        ...(modelUsage ? { modelUsage } : {}),
        ...(failureProtocol ?? {}),
      });
      logger.error(
        `[run] failed session=${context.sessionId} turns=${turn}: ${diagnosticMessage}`
        + `${message !== diagnosticMessage ? ` (client=${message})` : ''}`,
      );
      yield { type: 'error', error: surfacedMessage, ...(failureProtocol ? { runId: context.runId, ...failureProtocol } : {}) };
    }
  }

  /**
   * 空闲态 /compact：与自动阈值触发复用同一个 checkpoint planner，仅 trigger
   * 和命令 run 生命周期不同。事件顺序不可调换：
   *   run_started → user_message('/compact') → 生成摘要 → 清 Responses 接力链
   *   → compaction(checkpoint metadata + Token 预算切点) → run_finished
   * 摘要不落 assistant_message；对外只发 compaction_start / compaction_end，
   * 文本通道由 resultText 收到简短确认。若清接力链失败，checkpoint 不落库。
   */
  async *compact(input: CompactInput, context: RunContext): AsyncIterable<OutboundEvent> {
    this.activeTenantId = requireEventTenantId(context);
    const priorEvents = await this.eventStore.list(requireEventTenantId(context), context.sessionId, {
      excludeTypes: RUN_START_REPLAY_EXCLUDED_EVENT_TYPES,
      replayMode: 'bounded',
    });
    await this.eventSink.append({
      type: 'run_started',
      runId: context.runId,
      sessionId: context.sessionId,
      model: context.model,
      channel: context.channelContext.channel,
      ...(context.profileId ? { profileId: context.profileId } : {}),
      ...(context.profileVersionId ? { profileVersionId: context.profileVersionId } : {}),
      ...(context.profileConfigDigest ? { profileConfigDigest: context.profileConfigDigest } : {}),
    });
    logger.info(`[compact] start session=${context.sessionId} model=${context.model} events=${priorEvents.length}`);
    await this.eventSink.append({
      type: 'user_message',
      runId: context.runId,
      sessionId: context.sessionId,
      content: input.message.content,
      modelContent: COMPACT_COMMAND_MODEL_CONTENT,
    });
    const outcome = yield* this.compactHistory(input, context, priorEvents, {
      inline: false,
      trigger: 'manual',
      controlSourceRunIds: [context.runId],
    });
    const modelUsage = buildModelUsage(context.model, outcome.usage);
    if (outcome.status === 'compacted' || outcome.status === 'skipped') {
      await this.eventSink.append({
        type: 'run_finished',
        runId: context.runId,
        sessionId: context.sessionId,
        subtype: 'success',
        numTurns: outcome.numTurns,
        ...(modelUsage ? { modelUsage } : {}),
      });
      await context.hooks?.onResult?.({
        subtype: 'success',
        numTurns: outcome.numTurns,
        resultText: outcome.resultText,
        ...(modelUsage ? { modelUsage } : {}),
      });
      yield { type: 'done' };
      return;
    }
    if (outcome.status === 'aborted') {
      await this.eventSink.append({
        type: 'run_finished',
        runId: context.runId,
        sessionId: context.sessionId,
        subtype: 'interrupted',
        numTurns: 1,
        ...(modelUsage ? { modelUsage } : {}),
      });
      await context.hooks?.onResult?.({
        subtype: 'interrupted',
        numTurns: 1,
        resultText: '',
        ...(modelUsage ? { modelUsage } : {}),
      });
      logger.info(`[compact] aborted session=${context.sessionId}`);
      yield { type: 'done' };
      return;
    }
    const message = outcome.error ?? 'unknown error';
    await this.eventSink.append({
      type: 'run_finished',
      runId: context.runId,
      sessionId: context.sessionId,
      subtype: 'error',
      numTurns: 1,
      ...(modelUsage ? { modelUsage } : {}),
      error: message,
    });
    await context.hooks?.onResult?.({
      subtype: 'error',
      numTurns: 1,
      resultText: outcome.resultText,
      ...(modelUsage ? { modelUsage } : {}),
    });
    logger.error(`[compact] failed session=${context.sessionId}: ${message}`);
    yield { type: 'error', error: `上下文压缩失败: ${message}` };
  }
  private async *compactHistory(
    input: Pick<CompactInput, 'instructions'>,
    context: RunContext,
    priorEvents: PlatformEvent[],
    options: CompactionOptions,
  ): AsyncGenerator<OutboundEvent, CompactionOutcome> {
    yield { type: 'compaction_start' };
    let totalUsage: ModelUsage | undefined;
    let summaryText = '';
    try {
      const workspace = this.workspaceProvider.resolve(context.channelContext, {
        cwd: context.cwd,
        sessionId: context.sessionId,
        topLevelSessionId: context.topLevelSessionId,
        workspaceId: context.workspaceId,
        sandboxScopeId: context.sandboxScopeId,
        mountSubPath: context.mountSubPath, sandboxResources: context.sandboxResources,
        executionTarget: context.executionTarget,
        sandboxPolicy: context.sandboxPolicy,
      });
      const tools = this.toolRuntime.list({
        channelContext: context.channelContext,
        workspace,
        sessionId: context.sessionId,
        runId: context.runId,
        hooks: context.hooks,
        signal: context.signal,
      }).map(toModelToolDefinition);
      const configuredWindow = getModelContextWindow(context.model, context.modelRef);
      const estimatedCurrentTokens = estimateContextTokens([
        input.instructions,
        tools,
        buildContextProjection(priorEvents, {
          sessionId: context.replaySourceSessionId ?? context.sessionId,
          runId: context.runId,
          policy: context.replaySourceSessionId ? { type: 'full_replay' } : this.contextPolicy,
          excludeMemoryContext: true,
        }).messages,
      ]);
      const contextWindow = configuredWindow ?? Math.max(1, estimatedCurrentTokens * 2);
      const thresholdTokens = configuredWindow
        ? Math.floor(configuredWindow * getModelAutoCompactThreshold(context.model, context.modelRef))
        : Math.max(1, estimatedCurrentTokens);
      const plan = planContextCheckpoint({
        events: priorEvents,
        contextWindow,
        thresholdTokens,
        baseFixedTokens: options.baseFixedTokens ?? estimateContextTokens([input.instructions, tools]),
        sourceRunId: options.sourceRunId,
        adaptUserHistoryToTarget: configuredWindow !== undefined,
      });
      const compactInput = prepareCompactionInputMessages({
        compressedEvents: priorEvents.slice(0, plan.rawTailStartIndex), plan, contextWindow,
        fixedRequestTokens: estimateContextTokens([input.instructions, tools, this.compactionPrompt]),
        sessionId: context.replaySourceSessionId ?? context.sessionId, runId: context.runId,
        policy: context.replaySourceSessionId ? { type: 'full_replay' } : this.contextPolicy,
      });
      const compressedMessages = compactInput.messages;
      const minimumMessages = options.trigger === 'threshold' ? 1 : MIN_COMPACTABLE_MESSAGES;
      if (plan.coveredEventCount <= 0 || compactInput.projectedMessageCount < minimumMessages || compressedMessages.length === 0) {
        const note = '当前会话历史很短，无需压缩。';
        yield { type: 'compaction_end', compaction: { skipped: true, note, coveredEventCount: 0 } };
        return { status: 'skipped', numTurns: 0, resultText: note };
      }
      const requestMessages: ModelChatMessage[] = [
        { role: 'system', content: input.instructions },
        ...compressedMessages,
        { role: 'user', content: this.compactionPrompt },
      ];
      const requestUpperTokens = estimateContextTokens([requestMessages, tools]) + plan.summaryBudgetTokens;
      if (requestUpperTokens > contextWindow) {
        throw new Error(`compaction request exceeds context window: ${requestUpperTokens}/${contextWindow}`);
      }
      let completed: Extract<ModelEvent, { type: 'completed' }> | null = null;
      await context.authorizeModelTurn?.();
      // 黑箱消费：thinking 丢弃、text 静默累积，不向外 yield 流式内容。
      for await (const event of this.modelAdapter.stream({
        model: context.model,
        messages: requestMessages,
        tools,
        toolChoice: 'none',
        maxOutputTokens: plan.summaryBudgetTokens,
        signal: context.signal,
      }, this.withModelRequestDiagnostics(context))) {
        if (event.type === 'text_delta') {
          summaryText += event.content;
        } else if (event.type === 'draft_reset') {
          summaryText = '';
        } else if (event.type !== 'thinking_delta') {
          completed = event;
        }
      }
      if (!completed) throw new Error('model stream completed without completion event');
      if (completed.usage) totalUsage = mergeUsage(totalUsage, completed.usage);
      assertSuccessfulModelTerminal(completed);
      if (completed.usage) {
        // 先落 usage 再做摘要语义校验：空摘要同样已产生上游成本。
        await this.eventSink.append({
          type: 'compaction_usage',
          runId: context.runId,
          sessionId: context.sessionId,
          model: context.model,
          usage: completed.usage,
        });
      }
      if (!summaryText && completed.content) summaryText = completed.content;
      const summary = summaryText.trim();
      if (!summary) throw new Error('compaction failed: model returned empty summary');
      const summaryAudit = createCompactionSummaryAudit({ summary, prompt: this.compactionPrompt, model: context.model, ...(context.modelRef ? { modelRef: context.modelRef } : {}), userHistoryTokenCap: plan.userHistoryTokenCap });
      if (!summaryAudit.validation.valid) logger.warn(`[compact] summary validation warning session=${context.sessionId} run=${context.runId} ${formatCompactionSummaryWarning(summaryAudit.validation)}`);

      if (this.runStore?.clearResponseSessionStateBySession) {
        const cleared = await this.runStore.clearResponseSessionStateBySession(context.sessionId);
        if (cleared > 0) logger.info(`[compact] cleared ${cleared} response relay state(s) session=${context.sessionId}`);
      }
      await this.eventSink.append({
        type: 'compaction',
        runId: context.runId,
        sessionId: context.sessionId,
        summary,
        coveredEventCount: plan.coveredEventCount,
        ...(plan.rawTailStartEventId ? { cutoffEventId: plan.rawTailStartEventId } : {}),
        ...(options.inline ? { inline: true } : {}),
        checkpoint: {
          version: plan.version,
          trigger: options.trigger,
          ...(options.sourceRunId ? { sourceRunId: options.sourceRunId } : {}),
          ...(options.controlSourceRunIds?.length ? { controlSourceRunIds: options.controlSourceRunIds } : {}),
          targetTokens: plan.targetTokens,
          summaryBudgetTokens: plan.summaryBudgetTokens,
          summaryObservedTokens: estimateContextTokens(summary),
          rawTailBudgetTokens: plan.rawTailBudgetTokens,
          rawTailObservedTokens: plan.rawTailObservedTokens,
          fixedTokens: plan.fixedTokens,
          taskAnchors: plan.taskAnchors,
          ...(plan.memorySnapshot ? { memorySnapshot: plan.memorySnapshot } : {}),
          summaryAudit,
        },
      });

      logger.info(`[compact] checkpoint finished session=${context.sessionId} covered=${plan.coveredEventCount} `
        + `retained=${priorEvents.length - plan.coveredEventCount} cutoff=${plan.rawTailStartEventId ?? 'compaction'} inline=${options.inline} trigger=${options.trigger}`);
      const resultText = `✅ 上下文已压缩：${plan.coveredEventCount} 条较早事件已归纳，保留 ${priorEvents.length - plan.coveredEventCount} 条最近原始事件（完整记录仍可检索）。`;
      yield {
        type: 'compaction_end',
        compaction: { summary, coveredEventCount: plan.coveredEventCount },
      };
      return { status: 'compacted', numTurns: 1, resultText, ...(totalUsage ? { usage: totalUsage } : {}) };
    } catch (err) {
      if (context.signal?.aborted) {
        return { status: 'aborted', numTurns: 1, resultText: '', ...(totalUsage ? { usage: totalUsage } : {}) };
      }
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: 'error',
        numTurns: 1,
        resultText: summaryText,
        ...(totalUsage ? { usage: totalUsage } : {}),
        error: message,
      };
    }
  }

  private async recoverUnclosedToolCalls(
    replayState: RuntimeReplayState,
  ): Promise<{ blocking: true; message: string } | { blocking: false; recovered: number }> {
    let recovered = 0;
    for (const state of replayState.unclosedToolCalls) {
      const blocking = describeBlockingToolCall(state, this.zombieToolCallTimeoutMs);
      if (blocking) return { blocking: true, message: blocking };

      const content = buildSyntheticToolResultContent(state);
      await this.eventSink.append({
        type: 'tool_result',
        runId: state.runId,
        sessionId: state.sessionId,
        toolCallId: state.toolCallId,
        toolName: state.toolName,
        content,
        isError: true,
      });
      recovered += 1;
    }
    return { blocking: false, recovered };
  }

  private async assertNoOpenToolCallBatchesBeforeModel(sessionId: string): Promise<void> {
    const replayState = buildRuntimeReplayState(
      await this.eventStore.list(this.eventSink.requireTenantId(), sessionId, {
        excludeTypes: RUN_START_REPLAY_EXCLUDED_EVENT_TYPES,
        replayMode: 'bounded',
      }),
      await this.approvalStore.list(sessionId),
      sessionId,
    );
    const openBatch = replayState.toolCallBatches.find((batch) => batch.status !== 'closed');
    if (!openBatch) return;
    const unclosed = openBatch.unclosedToolCalls
      .map((state) => `${state.toolName}(${state.toolCallId})`)
      .join(', ');
    throw new Error(
      `cannot call model with unclosed tool call batch ${openBatch.batchId}: `
      + `${openBatch.status}${unclosed ? `; unclosed=${unclosed}` : ''}`,
    );
  }

  /** 默认串行；并发工具稳定回填，交互型工具串行挂起。 */
  private async *drainToolCalls(args: {
    calls: ModelToolCall[];
    descriptorsByName: Map<string, ToolDescriptor>;
    baseToolContext: ToolCallContext;
    context: RunContext;
    messages?: ModelChatMessage[];
    shouldYieldToUserInput?: () => Promise<boolean>;
  }): AsyncIterable<OutboundEvent> {
    const calls = args.calls;
    for (let index = 0; index < calls.length;) {
      const { end: segmentEnd, preparedCalls } = await collectParallelToolCallSegment({
        calls,
        start: index,
        descriptorsByName: args.descriptorsByName,
        context: args.context,
        toolPolicy: this.toolPolicy,
        refreshPolicyContext: (context) => refreshRunApprovalPolicy(this.runStore, context),
      });

      if (args.shouldYieldToUserInput && await args.shouldYieldToUserInput()) {
        for (const result of buildUserInterjectionSkippedToolResults(calls.slice(index))) yield* this.appendToolResult({ ...result, context: args.context, messages: args.messages });
        return;
      }

      if (preparedCalls.length >= 2) {
        const segment = calls.slice(index, segmentEnd);
        for (const call of segment) {
          yield { type: 'tool_start', toolId: call.id, toolName: call.name, runId: args.context.runId };
          yield { type: 'tool_input_delta', toolId: call.id, toolName: call.name, partialJson: call.arguments };
          yield { type: 'tool_end', toolId: call.id, toolName: call.name };
        }
        if (args.shouldYieldToUserInput && await args.shouldYieldToUserInput()) {
          for (const result of buildUserInterjectionSkippedToolResults(calls.slice(index))) yield* this.appendToolResult({ ...result, context: args.context, messages: args.messages });
          return;
        }
        // 第一项 invocation 是该并行段的 durable owner claim。它取得 claim 后先
        // 停在真正 invoke 之前，待其余调用启动再一起放行；重复 worker 会在第一项
        // 丢失 claim 并退出，因此不会出现双方各抢到一部分 invocation 的拆分批次。
        const ownerCall = segment[0]!;
        const ownerInvocationId = `${args.context.runId}:${ownerCall.id}`;
        const ownerContext = { ...args.context };
        let signalOwnerClaimed!: () => void;
        const ownerClaimed = new Promise<void>((resolve) => { signalOwnerClaimed = resolve; });
        let releaseOwner!: () => void;
        const waitForRelease = new Promise<void>((resolve) => { releaseOwner = resolve; });
        this.parallelInvocationGates.set(ownerContext, {
          onClaimed: signalOwnerClaimed,
          waitForRelease,
        });
        const ownerOutcome = this.executeToolCall(
          ownerCall,
          args.descriptorsByName,
          args.baseToolContext,
          ownerContext,
          preparedCalls[0],
        );
        try {
          await Promise.race([
            ownerClaimed,
            ownerOutcome.then(() => {
              throw new Error(`parallel owner invocation completed before claim: ${ownerInvocationId}`);
            }),
          ]);
          const remainingOutcomes = segment.slice(1).map((call, offset) => this.executeToolCall(
            call,
            args.descriptorsByName,
            args.baseToolContext,
            args.context,
            preparedCalls[offset + 1],
          ));
          releaseOwner();
          const outcomes = await Promise.all([ownerOutcome, ...remainingOutcomes]);
          for (let i = 0; i < segment.length; i += 1) {
            const outcome = outcomes[i]!;
            yield* this.appendToolResult({
              call: segment[i]!,
              content: outcome.result.content,
              ...(outcome.isError ? { isError: true } : {}), ...(outcome.result.modelImages?.length ? { modelImages: outcome.result.modelImages } : {}),
              ...(outcome.result.presentation ? { presentation: outcome.result.presentation } : {}),
              ...(outcome.result.metadata ? { metadata: outcome.result.metadata } : {}),
              context: args.context,
              messages: args.messages,
            });
          }
        } finally {
          releaseOwner();
          this.parallelInvocationGates.delete(ownerContext);
        }
        index = segmentEnd;
        continue;
      }

      const call = calls[index]!;
      const prepared = preparedCalls[0];
      if (prepared || await this.shouldEmitToolUseBeforeExecution(
        call,
        args.descriptorsByName,
        args.context,
      )) {
        yield { type: 'tool_start', toolId: call.id, toolName: call.name, runId: args.context.runId };
        yield { type: 'tool_input_delta', toolId: call.id, toolName: call.name, partialJson: call.arguments };
        yield { type: 'tool_end', toolId: call.id, toolName: call.name };
      }
      const outcome = await this.executeToolCall(
        call,
        args.descriptorsByName,
        args.baseToolContext,
        args.context,
        prepared, args.shouldYieldToUserInput,
      );
      yield* this.appendToolResult({
        call,
        content: outcome.result.content,
        ...(outcome.isError ? { isError: true } : {}), ...(outcome.result.modelImages?.length ? { modelImages: outcome.result.modelImages } : {}),
        ...(outcome.result.presentation ? { presentation: outcome.result.presentation } : {}),
        ...(outcome.result.metadata ? { metadata: outcome.result.metadata } : {}),
        context: args.context,
        messages: args.messages,
      });
      index += 1;
    }
    await args.shouldYieldToUserInput?.();
  }

  private async *drainRemainingToolCallBatch(args: {
    batch: RuntimeToolCallBatchState;
    skipToolCallIds: Set<string>;
    descriptorsByName: Map<string, ToolDescriptor>;
    baseToolContext: ToolCallContext;
    context: RunContext;
    shouldYieldToUserInput?: () => Promise<boolean>;
  }): AsyncIterable<OutboundEvent> {
    const calls = args.batch.toolCalls
      .filter((state) => !state.toolResult && !args.skipToolCallIds.has(state.toolCallId))
      .map((state) => state.call);
    yield* this.drainToolCalls({
      calls,
      descriptorsByName: args.descriptorsByName,
      baseToolContext: args.baseToolContext,
      context: args.context,
      shouldYieldToUserInput: args.shouldYieldToUserInput,
    });
  }

  private async shouldEmitToolUseBeforeExecution(
    call: ModelToolCall,
    descriptorsByName: Map<string, ToolDescriptor>,
    context: RunContext,
  ): Promise<boolean> {
    if (INTERACTIVE_TOOL_NAMES.has(call.name)) return false;
    const descriptor = descriptorsByName.get(call.name);
    if (!descriptor) return true;
    const parsed = tryParseToolInput(descriptor, parseToolArguments(call.arguments));
    if (!parsed.ok) return true;
    const policyContext = await refreshRunApprovalPolicy(this.runStore, context);
    const decision = await this.toolPolicy.decide(descriptor, parsed.input, policyContext);
    return decision.type !== 'requires_approval';
  }

  private async *appendToolResult(args: {
    call: ModelToolCall;
    content: string;
    isError?: boolean;
    context: RunContext;
    messages?: ModelChatMessage[];
    presentation?: ToolPresentation;
    metadata?: Record<string, unknown>; modelImages?: Extract<ModelChatMessage, { role: 'tool' }>['images'];
  }): AsyncIterable<OutboundEvent> {
    const projectedContent = projectToolResultContentForModel(args.content, args.call.id);
    yield {
      type: 'tool_result',
      toolId: args.call.id,
      toolName: args.call.name,
      toolResult: args.content,
      ...(args.isError ? { isError: true } : {}),
      ...(args.presentation ? { toolPresentation: args.presentation } : {}),
      ...(args.metadata ? { toolResultMetadata: args.metadata } : {}),
    };
    await this.eventSink.append({
      type: 'tool_result',
      runId: args.context.runId,
      sessionId: args.context.sessionId,
      toolCallId: args.call.id,
      toolName: args.call.name,
      content: args.content,
      ...(args.isError ? { isError: true } : {}), ...(args.modelImages?.length ? { modelImages: args.modelImages } : {}),
      ...(args.presentation ? { presentation: args.presentation } : {}),
      ...(args.metadata ? { metadata: args.metadata } : {}),
    });
    // 模型面刻意不带 presentation：它是给人看的第二通道，混进 messages
    // 会平白消耗上下文，也会让模型误以为摘要是它自己写的
    args.messages?.push({
      role: 'tool',
      tool_call_id: args.call.id,
      content: projectedContent, ...(args.modelImages?.length ? { images: args.modelImages } : {}),
    });
  }

  async *resumeApproval(input: ResumeApprovalInput, context: RunContext): AsyncIterable<OutboundEvent> {
    context = withDurableRunCancellation(context, this.runStore);
    this.activeTenantId = requireEventTenantId(context);
    const approval = await this.approvalStore.get(input.approvalId);
    if (!approval) {
      yield { type: 'error', error: `approval not found: ${input.approvalId}` };
      return;
    }

    const priorEvents = await this.eventStore.list(requireEventTenantId(context), approval.sessionId, { replayMode: 'bounded' });
    const approvals = await this.approvalStore.list(approval.sessionId);
    const replayState = buildRuntimeReplayState(priorEvents, approvals, approval.sessionId);
    const toolCallState = replayState.toolCallsById.get(approval.toolCallId);
    if (toolCallState?.toolResult) {
      yield { type: 'error', error: `approval already has tool result: ${approval.id}` };
      return;
    }

    if (approval.status !== 'pending') {
      yield { type: 'error', error: `approval is already resolved: ${approval.id}` };
      return;
    }

    const pendingState = replayState.pendingApprovals.find((state) => state.approval?.id === approval.id);
    if (!pendingState) {
      yield { type: 'error', error: `pending approval not found in runtime replay state: ${approval.id}` };
      return;
    }
    const pendingBatch = replayState.toolCallBatchByToolCallId.get(approval.toolCallId);
    if (!pendingBatch) {
      yield { type: 'error', error: `pending approval batch not found in runtime replay state: ${approval.id}` };
      return;
    }

    const resumeContext: RunContext = {
      ...context,
      runId: this.runtimeIsolationRequirement?.runId ?? approval.runId,
      sessionId: approval.sessionId,
    };
    const workspace = this.workspaceProvider.resolve(resumeContext.channelContext, {
      cwd: resumeContext.cwd,
      sessionId: resumeContext.sessionId,
      topLevelSessionId: resumeContext.topLevelSessionId,
      workspaceId: resumeContext.workspaceId,
      sandboxScopeId: resumeContext.sandboxScopeId,
      mountSubPath: resumeContext.mountSubPath, sandboxResources: resumeContext.sandboxResources,
      executionTarget: approval.executionTarget ?? pendingState.approvalRequest?.executionTarget ?? resumeContext.executionTarget,
      sandboxPolicy: resumeContext.sandboxPolicy,
    });
    const baseToolContext: ToolCallContext = {
      channelContext: resumeContext.channelContext,
      workspace,
      env: resumeContext.env,
      sessionId: resumeContext.sessionId,
      runId: resumeContext.runId,
      ...(this.runtimeIsolationRequirement ? { runtimeIsolationRequirement: this.runtimeIsolationRequirement } : {}),
      hooks: resumeContext.hooks,
      signal: resumeContext.signal,
    };
    const descriptors = this.toolRuntime.list(baseToolContext);
    const { tools, descriptorsByName } = await this.prepareSessionTools(descriptors, priorEvents, resumeContext);
    const callableDescriptorsByName = this.callableDescriptorsForEvents(descriptorsByName, priorEvents);
    const descriptor = callableDescriptorsByName.get(approval.toolName);
    const call: ModelToolCall = {
      id: pendingState.call.id,
      name: pendingState.call.name,
      arguments: pendingState.call.arguments,
      ...(pendingState.call.namespace ? { namespace: pendingState.call.namespace } : {}),
    };
    let outcome: ToolExecutionOutcome;
    try {
      outcome = await this.resolveApprovalDecision({
        approval,
        response: input.response,
        call,
        descriptor,
        input: approval.input,
        baseToolContext,
        context: resumeContext,
      });
    } catch (err) {
      if (err instanceof RunLeaseLostError) return;
      if (err instanceof ToolInvocationClaimLostError) {
        const failure = await handleInvocationClaimLoss(
          err, resumeContext, this.runStore, (event) => this.eventSink.append(event), 'approval_resume',
        );
        if (failure) yield failure;
        return;
      }
      throw err;
    }

    yield* this.appendToolResult({
      call,
      content: outcome.result.content,
      ...(outcome.isError ? { isError: true } : {}), ...(outcome.result.modelImages?.length ? { modelImages: outcome.result.modelImages } : {}),
      ...(outcome.result.presentation ? { presentation: outcome.result.presentation } : {}),
      ...(outcome.result.metadata ? { metadata: outcome.result.metadata } : {}),
      context: resumeContext,
    });

    try {
      yield* this.drainRemainingToolCallBatch({
        batch: pendingBatch,
        skipToolCallIds: new Set([call.id]),
        descriptorsByName: callableDescriptorsByName,
        baseToolContext,
        context: resumeContext,
        shouldYieldToUserInput: () => hasQueuedUserInputAtToolBoundary({
          context: resumeContext,
          disabled: false,
          warn: (message) => logger.warn(message),
        }),
      });
    } catch (err) {
      if (err instanceof RunLeaseLostError) return;
      if (err instanceof ToolInvocationClaimLostError) {
        const failure = await handleInvocationClaimLoss(
          err, resumeContext, this.runStore, (event) => this.eventSink.append(event), 'approval_resume',
        );
        if (failure) yield failure;
        return;
      }
      if (err instanceof ApprovalPendingWithoutInteractionHook) return;
      if (err instanceof InteractionPendingWithoutInteractionHook) {
        yield toOutboundInteractionEvent(err.event);
        return;
      }
      throw err;
    }

    const replayEvents = await this.eventStore.list(requireEventTenantId(context), approval.sessionId, { replayMode: 'bounded' });
    const contextProjection = buildContextProjection(replayEvents, {
      sessionId: approval.sessionId,
      runId: resumeContext.runId,
      policy: this.contextPolicy,
    });
    const messages: ModelChatMessage[] = [
      { role: 'system', content: input.instructions },
      ...this.filterLoadedToolMessages(contextProjection.messages, tools),
    ];
    if (contextProjection.summaryEvent) await this.eventSink.append(contextProjection.summaryEvent);

    logger.info(`[resume-approval] start session=${resumeContext.sessionId} model=${resumeContext.model}`);
    yield* this.continueModelTurns({
      messages,
      tools,
      descriptorsByName,
      baseToolContext,
      context: resumeContext,
      maxTurns: input.maxTurns,
      instructions: input.instructions,
      priorEvents: replayEvents,
    });
  }

  async *resumeInteraction(input: ResumeInteractionInput, context: RunContext): AsyncIterable<OutboundEvent> {
    context = withDurableRunCancellation(context, this.runStore);
    this.activeTenantId = requireEventTenantId(context);
    const priorEvents = await this.eventStore.list(requireEventTenantId(context), context.sessionId, { replayMode: 'bounded' });
    const request = [...priorEvents].reverse().find((event): event is Extract<PlatformEvent, { type: 'interaction_requested' }> => (
      event.type === 'interaction_requested'
      && event.sessionId === context.sessionId
      && event.interactionId === input.interactionId
      && event.interactionType === 'ask_user'
    ));
    if (!request) {
      yield { type: 'error', error: `interaction not found: ${input.interactionId}` };
      return;
    }
    if (!request.toolCallId) {
      yield { type: 'error', error: `interaction missing toolCallId: ${input.interactionId}` };
      return;
    }
    const resolved = priorEvents.some((event) => (
      event.type === 'interaction_resolved'
      && event.sessionId === context.sessionId
      && event.interactionId === input.interactionId
    ));
    if (!resolved) {
      yield { type: 'error', error: `interaction is not resolved: ${input.interactionId}` };
      return;
    }

    const replayState = buildRuntimeReplayState(
      priorEvents,
      await this.approvalStore.list(context.sessionId),
      context.sessionId,
    );
    const pendingState = replayState.toolCallsById.get(request.toolCallId);
    if (!pendingState) {
      yield { type: 'error', error: `pending tool call not found for interaction: ${input.interactionId}` };
      return;
    }
    if (pendingState.toolResult) {
      yield { type: 'error', error: `interaction already has tool result: ${input.interactionId}` };
      return;
    }
    if (pendingState.toolName !== 'AskUserQuestion') {
      yield { type: 'error', error: `interaction is not AskUserQuestion: ${input.interactionId}` };
      return;
    }
    const pendingBatch = replayState.toolCallBatchByToolCallId.get(request.toolCallId);
    if (!pendingBatch) {
      yield { type: 'error', error: `pending interaction batch not found in runtime replay state: ${input.interactionId}` };
      return;
    }

    const workspace = this.workspaceProvider.resolve(context.channelContext, {
      cwd: context.cwd,
      sessionId: context.sessionId,
      topLevelSessionId: context.topLevelSessionId,
      workspaceId: context.workspaceId,
      sandboxScopeId: context.sandboxScopeId,
      mountSubPath: context.mountSubPath, sandboxResources: context.sandboxResources,
      executionTarget: context.executionTarget,
      sandboxPolicy: context.sandboxPolicy,
    });
    const baseToolContext: ToolCallContext = {
      channelContext: context.channelContext,
      workspace,
      env: context.env,
      sessionId: context.sessionId,
      runId: context.runId,
      ...(context.memoryMaintenanceMode ? { memoryMaintenanceMode: context.memoryMaintenanceMode } : {}),
      ...(this.runtimeIsolationRequirement ? { runtimeIsolationRequirement: this.runtimeIsolationRequirement } : {}),
      hooks: context.hooks,
      signal: context.signal,
    };
    const descriptors = this.toolRuntime.list(baseToolContext);
    const { tools, descriptorsByName } = await this.prepareSessionTools(descriptors, priorEvents, context);
    const callableDescriptorsByName = this.callableDescriptorsForEvents(descriptorsByName, priorEvents);
    const call = pendingState.call;
    const resultContent = formatAskUserQuestionResult(input.response);

    if (request.invocationId) {
      await this.toolInvocationStore?.complete(request.invocationId, 'completed').catch(() => undefined);
      await this.eventSink.append({
        type: 'tool_invocation_completed',
        runId: context.runId,
        sessionId: context.sessionId,
        invocationId: request.invocationId,
        toolCallId: call.id,
        toolName: call.name,
        status: 'success',
        durationMs: 0,
      });
    }
    yield* this.appendToolResult({
      call,
      content: resultContent,
      context,
    });

    try {
      yield* this.drainRemainingToolCallBatch({
        batch: pendingBatch,
        skipToolCallIds: new Set([call.id]),
        descriptorsByName: callableDescriptorsByName,
        baseToolContext,
        context,
        shouldYieldToUserInput: () => hasQueuedUserInputAtToolBoundary({
          context,
          disabled: false,
          warn: (message) => logger.warn(message),
        }),
      });
    } catch (err) {
      if (err instanceof RunLeaseLostError) return;
      if (err instanceof ToolInvocationClaimLostError) {
        const failure = await handleInvocationClaimLoss(
          err, context, this.runStore, (event) => this.eventSink.append(event), 'interaction_resume',
        );
        if (failure) yield failure;
        return;
      }
      if (err instanceof ApprovalPendingWithoutInteractionHook) return;
      if (err instanceof InteractionPendingWithoutInteractionHook) {
        yield toOutboundInteractionEvent(err.event);
        return;
      }
      throw err;
    }

    const replayEvents = await this.eventStore.list(requireEventTenantId(context), context.sessionId, { replayMode: 'bounded' });
    const contextProjection = buildContextProjection(replayEvents, {
      sessionId: context.sessionId,
      runId: context.runId,
      policy: this.contextPolicy,
    });
    const messages: ModelChatMessage[] = [
      { role: 'system', content: input.instructions },
      ...this.filterLoadedToolMessages(contextProjection.messages, tools),
    ];
    if (contextProjection.summaryEvent) await this.eventSink.append(contextProjection.summaryEvent);

    logger.info(`[resume-interaction] start session=${context.sessionId} model=${context.model}`);
    yield* this.continueModelTurns({
      messages,
      tools,
      descriptorsByName,
      baseToolContext,
      context,
      maxTurns: input.maxTurns,
      instructions: input.instructions,
      priorEvents: replayEvents,
    });
  }

  private async executeToolCall(
    call: ModelToolCall,
    descriptorsByName: Map<string, ToolDescriptor>,
    baseToolContext: ToolCallContext,
    context: RunContext,
    prepared?: PreparedParallelToolCall, shouldYieldToUserInput?: () => Promise<boolean>,
  ): Promise<ToolExecutionOutcome> {
    const descriptor = prepared?.descriptor ?? descriptorsByName.get(call.name);
    const rawInput = prepared?.input ?? parseToolArguments(call.arguments);
    if (!descriptor) {
      // D4 + G1：工具名不在当前 turn 的 tools[] 白名单内（descriptorsByName 来自当前 turn descriptors）。
      // 错误措辞标准化避免 deepseek 字面执行"try different approach"陷入循环。
      return {
        call,
        input: rawInput,
        result: { content: standardizeToolError(unavailableToolMessage(call.name)) },
        isError: true,
      };
    }
    if (this.mcpLoadingMode !== 'eager' && descriptor.mcp) {
      const expectedNamespace = buildMcpNamespaceName(descriptor.mcp.serverName);
      if (call.namespace !== expectedNamespace) {
        return {
          call,
          descriptor,
          input: rawInput,
          result: {
            content: standardizeToolError(
              `MCP namespace mismatch: ${call.name}（期望 ${expectedNamespace}，实际 ${call.namespace ?? '未提供'}）`,
            ),
          },
          isError: true,
        };
      }
    }

    if (call.name === 'WebFetch' && this.webFetchSynthesisReason) {
      return {
        call,
        descriptor,
        input: rawInput,
        result: {
          content: standardizeToolError(
            `${this.webFetchSynthesisReason}；本次调用未出网，请基于已有材料收束回答`,
          ),
        },
        isError: true,
      };
    }

    // 审批、风险分档、展示与执行必须使用同一份 prepare + schema 后的参数。
    const parsed = tryParseToolInput(descriptor, rawInput);
    if (!parsed.ok) {
      return {
        call,
        descriptor,
        input: rawInput,
        result: { content: standardizeToolError(parsed.error) },
        isError: true,
      };
    }
    const input = parsed.input;

    if (!prepared) {
      const policyContext = await refreshRunApprovalPolicy(this.runStore, context);
      const decision = await this.toolPolicy.decide(descriptor, input, policyContext);
      if (decision.type === 'requires_approval') {
        const approval = await this.approvalStore.create({
          sessionId: context.sessionId,
          runId: context.runId,
          toolCallId: call.id,
          toolId: descriptor.id,
          toolName: descriptor.name,
          displayName: descriptor.displayName,
          executionTarget: baseToolContext.workspace.executionTarget,
          input,
        });

        if (!context.hooks?.onInteraction) {
          throw new ApprovalPendingWithoutInteractionHook(approval.id);
        }

        let response;
        try {
          response = await context.hooks.onInteraction({
            type: 'permission_request',
            interactionId: approval.id,
            sessionId: context.sessionId,
            runId: context.runId,
            toolCallId: call.id,
            invocationId: `${context.runId}:${call.id}`,
            toolId: descriptor.id,
            toolName: descriptor.name,
            displayName: descriptor.displayName,
            toolInput: input && typeof input === 'object' ? input as Record<string, unknown> : { value: input },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await this.approvalStore.resolvePending(approval.id, 'rejected', message);
          return {
            call,
            descriptor,
            input,
            result: { content: standardizeToolError(`tool error: ${message}`) },
            isError: true,
          };
        }

        return this.resolveApprovalDecision({
          approval,
          response,
          call,
          descriptor,
          input,
          baseToolContext,
          context,
        });
      }
    }
    const skipped = await skipToolCallForQueuedUserInput({ shouldYield: shouldYieldToUserInput, call, descriptor, input });
    if (skipped) return skipped;
    try {
      const result = await this.invokeAuthorizedTool({
        call,
        descriptor,
        input,
        authorization: prepared?.authorization ?? { approved: true, source: 'policy_auto' },
        baseToolContext,
        context,
      });
      return { call, descriptor, input, result };
    } catch (err) {
      if (err instanceof WebFetchCircuitOpenError) {
        this.forceWebFetchSynthesis(err.reason, context);
      }
      if (
        err instanceof InteractionPendingWithoutInteractionHook
        || err instanceof ToolInvocationClaimLostError
        || err instanceof RunLeaseLostError
      ) throw err;
      // 失败也保留摘要与结构化事实；approval-resume 分支同样执行该契约。
      const presentation = buildFailurePresentation(call.name, input, err, resolveRunTenantId(context));
      const metadata = err instanceof ToolExecutionError ? err.resultMetadata : undefined;
      return {
        call,
        descriptor,
        input,
        result: {
          content: standardizeToolError(`tool error: ${err instanceof Error ? err.message : String(err)}`),
          ...(presentation ? { presentation } : {}),
          ...(metadata ? { metadata } : {}),
        },
        isError: true,
      };
    }
  }

  private async resolveApprovalDecision(args: {
    approval: ApprovalRecord;
    response: InteractionResponse;
    call: ModelToolCall;
    descriptor?: ToolDescriptor;
    input: unknown;
    baseToolContext: ToolCallContext;
    context: RunContext;
  }): Promise<ToolExecutionOutcome> {
    const allow = args.response.allow === true;
    const resolvedApproval = await this.approvalStore.resolvePending(
      args.approval.id,
      allow ? 'approved' : 'rejected',
      args.response.message,
    );
    if (!resolvedApproval) {
      throw new ApprovalAlreadyResolvedError(args.approval.id);
    }

    if (!allow) {
      return {
        call: args.call,
        descriptor: args.descriptor,
        input: args.input,
        result: { content: standardizeToolError(`tool error: ${args.response.message || 'User denied permission'}`) },
        isError: true,
      };
    }

    if (!args.descriptor) {
      return {
        call: args.call,
        input: args.input,
        result: { content: standardizeToolError(unavailableToolMessage(args.call.name)) },
        isError: true,
      };
    }

    try {
      const result = await this.invokeAuthorizedTool({
        call: args.call,
        descriptor: args.descriptor,
        input: args.input,
        authorization: { approved: true, approvalId: args.approval.id, source: 'human_approval' },
        baseToolContext: args.baseToolContext,
        context: args.context,
      });
      return { call: args.call, descriptor: args.descriptor, input: args.input, result };
    } catch (err) {
      if (err instanceof ToolInvocationClaimLostError || err instanceof RunLeaseLostError) throw err;
      // 失败也要有摘要：优先用错误自带的（provider 按真实 metadata 产出），
      // 否则退回入参侧规则并强制标 warn。客户看到「读取 差旅.md · 有异常」
      // 远好过一行「已执行，有异常」。
      const presentation = buildFailurePresentation(args.call.name, args.input, err, resolveRunTenantId(args.context));
      const metadata = err instanceof ToolExecutionError ? err.resultMetadata : undefined;
      return {
        call: args.call,
        descriptor: args.descriptor,
        input: args.input,
        result: {
          content: standardizeToolError(`tool error: ${err instanceof Error ? err.message : String(err)}`),
          ...(presentation ? { presentation } : {}),
          ...(metadata ? { metadata } : {}),
        },
        isError: true,
      };
    }
  }
  private async invokeAuthorizedTool(args: {
    call: ModelToolCall;
    descriptor: ToolDescriptor;
    input: unknown;
    authorization: ToolAuthorization;
    baseToolContext: ToolCallContext;
    context: RunContext;
  }): Promise<ToolResult> {
    const startedAt = Date.now();
    const invocationId = `${args.context.runId}:${args.call.id}`;
    const executionAudit = createExecutionAuditRecorder();
    const streamBatcher = new StreamEventBatcher(this.eventStore, this.streamEventBatch, requireEventTenantId(args.context));
    const streamSummary = new ToolStreamSummaryBuilder();
    const hooks = args.baseToolContext.hooks?.onInteraction || args.descriptor.name !== 'AskUserQuestion'
      ? args.baseToolContext.hooks
      : {
          ...(args.baseToolContext.hooks ?? {}),
          onInteraction: async (event: InteractionEvent): Promise<InteractionResponse> => {
            await this.eventSink.append({
              type: 'interaction_requested',
              runId: args.context.runId,
              sessionId: args.context.sessionId,
              toolCallId: event.toolCallId ?? args.call.id,
              invocationId: event.invocationId ?? `${args.context.runId}:${args.call.id}`,
              interactionId: event.interactionId,
              interactionType: event.type,
              userId: args.context.channelContext.user?.id ?? args.context.channelContext.sessionOwner?.id,
              toolId: event.toolId,
              toolName: event.toolName,
              displayName: event.displayName,
              questions: event.questions,
              toolInput: event.toolInput,
            });
            throw new InteractionPendingWithoutInteractionHook(event);
          },
        };
    const toolContext: ToolCallContext = {
      ...args.baseToolContext,
      sessionId: args.context.sessionId,
      runId: args.context.runId,
      toolCallId: args.call.id,
      invocationId,
      hooks,
      executionAudit,
      onStreamChunk: async (chunk) => {
        streamSummary.observe(chunk);
        if (chunk.type === 'output') {
          await streamBatcher.push({
            type: 'tool_output_delta',
            runId: args.context.runId,
            sessionId: args.context.sessionId,
            invocationId,
            toolCallId: args.call.id,
            channel: chunk.channel,
            content: chunk.content,
          });
        } else if (chunk.type === 'progress') {
          await streamBatcher.push({
            type: 'tool_progress',
            runId: args.context.runId,
            sessionId: args.context.sessionId,
            invocationId,
            toolCallId: args.call.id,
            content: chunk.message,
          });
        }
      },
    };
    const autoHandId = await this.autoSelectTenantHandId(args.context.sessionId, args.context.runId, args.baseToolContext.workspace.executionTarget);
    const effectiveHandId = autoHandId;
    toolContext.correlation = createInvocationCorrelation({ sessionId: args.context.sessionId, runId: args.context.runId, toolCallId: args.call.id, invocationId, ...(effectiveHandId ? { handId: effectiveHandId } : {}) });
    const skillName = resolveInvokedSkillName(args.descriptor.id, args.input);
    const invocation = await this.toolInvocationStore?.start({
      invocationId,
      runId: args.context.runId,
      sessionId: args.context.sessionId,
      toolCallId: args.call.id,
      toolName: args.descriptor.name,
      executionTarget: args.baseToolContext.workspace.executionTarget,
      tenantId: resolveRunTenantId(args.context),
      metadata: {
        toolId: args.descriptor.id,
        toolInputDigest: canonicalToolInputDigest(args.input),
        ...(skillName ? { skillName } : {}),
        ...(effectiveHandId ? { handId: effectiveHandId } : {}),
        ...(autoHandId ? { autoRoutedHandId: autoHandId } : {}),
        executionTarget: args.baseToolContext.workspace.executionTarget,
        defaultHandId: `${args.context.sessionId}:${args.baseToolContext.workspace.executionTarget}`,
        workspaceId: args.baseToolContext.workspace.id,
        ...(args.baseToolContext.workspace.mountSubPath ? { mountSubPath: args.baseToolContext.workspace.mountSubPath } : {}),
        ...(args.baseToolContext.workspace.sandboxScopeId ? { sandboxScopeId: args.baseToolContext.workspace.sandboxScopeId } : {}),
        ...(args.context.workerId ? { workerId: args.context.workerId } : {}),
      },
    });
    let invocationAlreadyTerminal = Boolean(invocation && invocation.status !== 'running');
    let cancelledBeforeInvoke = false;
    try {
      let blockedBeforeInvoke = invocationAlreadyTerminal;
      let cancellation = invocation?.cancelRequestedAt ? invocation : undefined;
      // Pg start 已原子登记 durable outbox；即时事件仅由本次 requestCancelOnce 的唯一创建者发布。
      let shouldAppendCancelEvent = false;
      let terminalRunStatus: string | undefined;
      if (!cancellation && this.runStore) {
        const run = await this.runStore.get(args.context.runId);
        if (!run) throw new Error(`authoritative run not found: ${args.context.runId}`);
        if (['completed', 'failed', 'cancelled', 'orphaned'].includes(run.status)) {
          terminalRunStatus = run.status;
          blockedBeforeInvoke = true;
        }
        if (run.status === 'cancelled') {
          const completedBeforeCancellation = invocation?.completedAt
            && run.cancelledAt
            && new Date(invocation.completedAt).getTime() < new Date(run.cancelledAt).getTime();
          if (!completedBeforeCancellation) {
            const requested = await this.toolInvocationStore?.requestCancelOnce(
              invocationId,
              'run_already_cancelled_before_tool_start',
              { cancelRecovery: 'late_start' },
            );
            cancellation = requested?.record;
            shouldAppendCancelEvent = requested?.created === true;
            cancelledBeforeInvoke = true;
          }
        }
      }
      if (cancellation) {
        cancelledBeforeInvoke = true;
        blockedBeforeInvoke = true;
      }
      if (blockedBeforeInvoke) {
        if (cancellation && shouldAppendCancelEvent) {
          await this.eventSink.append({
            type: 'tool_invocation_cancel_requested',
            runId: args.context.runId,
            sessionId: args.context.sessionId,
            invocationId,
            toolCallId: args.call.id,
            toolName: args.descriptor.name,
            reason: cancellation.cancelReason ?? 'run_already_cancelled_before_tool_start',
            metadata: cancellation.metadata,
          });
        }
        const reason = cancelledBeforeInvoke
          ? 'run is already cancelled'
          : terminalRunStatus
            ? `run is already terminal status=${terminalRunStatus}`
            : 'invocation is already terminal';
        throw new Error(`tool invocation blocked because ${reason}: ${invocationId}`);
      }
      const invokeTool = async () => {
        const parallelGate = this.parallelInvocationGates.get(args.context);
        if (parallelGate) {
          parallelGate.onClaimed();
          await parallelGate.waitForRelease;
        }
        const attemptCorrelation = createExecutionAttempt(toolContext.correlation!);
        await this.eventSink.append({
          type: 'tool_invocation_started',
          runId: args.context.runId,
          sessionId: args.context.sessionId,
          invocationId,
          toolCallId: args.call.id,
          toolName: args.descriptor.name,
          executionTarget: args.baseToolContext.workspace.executionTarget, attemptId: attemptCorrelation.attemptId,
        });
        return runWithInvocationCorrelation(attemptCorrelation, () => this.toolRuntime.invoke(
          { toolId: args.descriptor.id, input: args.input, authorization: args.authorization },
          { ...toolContext, correlation: attemptCorrelation },
        ));
      };
      const guarded = this.toolInvocationStore
        ? await this.toolInvocationStore.invokeWithActiveRunGate(
          args.context.runId,
          invocationId,
          invokeTool,
          this.runStore
            ? () => readRunLeaseState(this.runStore!, args.context.runId)
            : undefined,
          args.context.workerId,
        )
        : undefined;
      if (guarded && !guarded.invoked) {
        if (guarded.reason === 'run_lease_lost') {
          throw new RunLeaseLostError(args.context.runId, args.context.workerId, guarded.runWorkerId);
        }
        terminalRunStatus = guarded.runStatus;
        invocationAlreadyTerminal = guarded.reason === 'invocation_terminal' || guarded.reason === 'invocation_claimed';
        cancelledBeforeInvoke = guarded.reason === 'cancel_requested' || guarded.runStatus === 'cancelled';
        if (guarded.reason === 'invocation_claimed') {
          throw new ToolInvocationClaimLostError(invocationId, resolveClaimedWorkerId(guarded.invocation));
        }
        const reason = cancelledBeforeInvoke
          ? 'run is already cancelled'
          : guarded.reason === 'run_terminal' && guarded.runStatus
            ? `run is already terminal status=${guarded.runStatus}`
            : guarded.reason === 'run_missing'
              ? 'authoritative run not found'
              : 'invocation is already terminal';
        throw new Error(`tool invocation blocked because ${reason}: ${invocationId}`);
      }
      const result = guarded?.invoked ? guarded.result : await invokeTool();
      await streamBatcher.flush();
      await this.toolInvocationStore?.complete(invocationId, 'completed').catch(() => undefined);
      await this.eventSink.append({
        type: 'tool_invocation_completed',
        runId: args.context.runId,
        sessionId: args.context.sessionId,
        invocationId,
        toolCallId: args.call.id,
        toolName: args.descriptor.name,
        status: 'success',
        durationMs: Date.now() - startedAt,
      });
      await this.appendToolStreamSummary(streamSummary, {
        runId: args.context.runId,
        sessionId: args.context.sessionId,
        invocationId,
        toolCallId: args.call.id,
        toolName: args.descriptor.name,
        status: 'success',
      }).catch(() => undefined);
      await this.eventSink.append({
        type: 'tool_audit',
        runId: args.context.runId,
        sessionId: args.context.sessionId,
        // PR 10：从 run 级 tenantId 透传，落到 jsonl + DuckDB tool_audit.tenant_id
        tenantId: resolveRunTenantId(args.context),
        toolCallId: args.call.id,
        toolId: args.descriptor.id,
        toolName: args.descriptor.name,
        ...(skillName ? { skillName } : {}),
        risk: args.descriptor.risk,
        ...(args.authorization.approvalId ? { approvalId: args.authorization.approvalId } : {}),
        authorization: args.authorization,
        executionTarget: args.baseToolContext.workspace.executionTarget,
        status: 'success',
        durationMs: Date.now() - startedAt,
        ...(executionAudit.records.length ? { executionInvocations: executionAudit.records } : {}),
      });
      return result;
    } catch (err) {
      await streamBatcher.flush().catch(() => undefined);
      if (
        err instanceof RunLeaseLostError
        || err instanceof InteractionPendingWithoutInteractionHook
        || invocationAlreadyTerminal
      ) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      const invocationCancelled = cancelledBeforeInvoke || args.context.signal?.aborted;
      const completionStatus = invocationCancelled ? 'cancelled' : 'failed';
      await this.toolInvocationStore?.complete(invocationId, completionStatus, message).catch(() => undefined);
      await this.eventSink.append({
        type: 'tool_invocation_completed',
        runId: args.context.runId,
        sessionId: args.context.sessionId,
        invocationId,
        toolCallId: args.call.id,
        toolName: args.descriptor.name,
        status: invocationCancelled ? 'cancelled' : 'error',
        durationMs: Date.now() - startedAt,
        error: message,
      });
      await this.appendToolStreamSummary(streamSummary, {
        runId: args.context.runId,
        sessionId: args.context.sessionId,
        invocationId,
        toolCallId: args.call.id,
        toolName: args.descriptor.name,
        status: invocationCancelled ? 'cancelled' : 'error',
      }).catch(() => undefined);
      await this.eventSink.append({
        type: 'tool_audit',
        runId: args.context.runId,
        sessionId: args.context.sessionId,
        // PR 10：error 分支 tenantId 同 success 分支同一来源
        tenantId: resolveRunTenantId(args.context),
        toolCallId: args.call.id,
        toolId: args.descriptor.id,
        toolName: args.descriptor.name,
        ...(skillName ? { skillName } : {}),
        risk: args.descriptor.risk,
        ...(args.authorization.approvalId ? { approvalId: args.authorization.approvalId } : {}),
        authorization: args.authorization,
        executionTarget: args.baseToolContext.workspace.executionTarget,
        status: 'error',
        durationMs: Date.now() - startedAt,
        ...(executionAudit.records.length ? { executionInvocations: executionAudit.records } : {}),
        error: message,
      });
      if (args.baseToolContext.workspace.executionTarget === 'server-remote') {
        await this.eventSink.append({
          type: 'hand_failure',
          runId: args.context.runId,
          sessionId: args.context.sessionId,
          workspaceId: args.baseToolContext.workspace.id,
          toolName: args.descriptor.name,
          error: message,
          classifiedAs: classifyHandFailure(message),
        });
      }
      throw err;
    }
  }
  private async appendToolStreamSummary(
    builder: ToolStreamSummaryBuilder,
    args: {
      runId: string;
      sessionId: string;
      invocationId: string;
      toolCallId: string;
      toolName: string;
      status: 'success' | 'error' | 'cancelled';
    },
  ): Promise<void> {
    const event = builder.build(args);
    if (event) {
      await this.eventSink.append(event);
    }
  }

  private async *continueModelTurns(args: {
    messages: ModelChatMessage[];
    tools: ReturnType<typeof toModelToolDefinition>[];
    descriptorsByName: Map<string, ToolDescriptor>;
    baseToolContext: ToolCallContext;
    context: RunContext;
    maxTurns: number;
    instructions: string;
    priorEvents: PlatformEvent[];
  }): AsyncIterable<OutboundEvent> {
    let textStarted = false;
    let thinkingStarted = false;
    let totalUsage: ModelUsage | undefined;
    let finalText = '';
    let turn = 0;
    let turnLimit = args.maxTurns;
    const successfulCompletion = createSuccessfulCompletionController((message) => logger.warn(message));
    let thinkingOnlyContinuationUsed = false;
    let pendingTurnText = '';
    let currentUserMessageIndex = 0;
    for (let index = args.messages.length - 1; index >= 0; index -= 1) {
      if (args.messages[index]?.role === 'user') {
        currentUserMessageIndex = index;
        break;
      }
    }
    const steeringInterjections = new SteeringInterjectionCoordinator({
      context: args.context,
      messages: args.messages,
      priorEvents: args.priorEvents,
      currentUserMessageIndex,
      runStore: this.runStore,
      eventStore: this.eventStore,
      tenantId: requireEventTenantId(args.context),
      transcriptProjection: this.transcriptProjection,
      append: (event) => this.eventSink.append(event),
      warn: (message) => logger.warn(message),
    });
    const drainQueuedInterjections = async () => {
      try {
        const interjections = await steeringInterjections.drain();
        currentUserMessageIndex = steeringInterjections.currentUserMessageIndex;
        return interjections;
      } catch (error) {
        if (args.context.signal?.aborted) throw error;
        logger.warn(
          `[resume] steering drain failed (degraded): run=${args.context.runId} error=${error instanceof Error ? error.message : String(error)}`,
        );
        return [];
      }
    };
    const restoredDraftState = await this.loadReplaceableDraftState(args.context);
    let restoredDraftRecoveryUsed = false;
    if (restoredDraftState) {
      const draftStartedAt = Date.parse(restoredDraftState.startedAt);
      const canonicalCommitted = args.priorEvents.some((event) => (
        (event.type === 'assistant_message' || event.type === 'assistant_tool_calls')
        && event.runId === args.context.runId
        && Date.parse(event.timestamp) >= draftStartedAt
      ));
      yield canonicalCommitted
        ? { type: 'draft_commit', draftId: restoredDraftState.draftId }
        : { type: 'draft_reset', draftId: restoredDraftState.draftId };
      restoredDraftRecoveryUsed = !canonicalCommitted;
      await this.persistReplaceableDraftState(args.context, null);
    }
    let contextUsageTracker = new RuntimeContextUsageTracker(
      args.context.model,
      args.priorEvents,
      args.context.modelRef,
    );
    let autoCompactionSuppressed = false;
    const previousContextModel = contextUsageTracker.resetActiveContextIfModelChanged(args.context.model);
    if (previousContextModel) {
      logger.info(
        `[context-usage] reset active chain after model switch session=${args.context.sessionId} `
        + `run=${args.context.runId} previousModel=${previousContextModel} currentModel=${args.context.model}`,
      );
    }

    // RFC v1 P0.4：resume 路径同样接力 Responses API session state。
    let contextRewindRecoveryUsed = args.priorEvents.some((event) => (
      event.type === 'context_rewind' && event.runId === args.context.runId
    ));
    if (contextRewindRecoveryUsed) clearProviderContinuations(args.messages);
    const usesStoredResponseState = !args.context.disableResponseRelay
      && this.modelAdapter.capabilities?.responseState !== 'stateless';
    if (contextRewindRecoveryUsed) await this.clearResponseRelayState(args.context.sessionId, 'resume wake');
    let currentResponseId = usesStoredResponseState && !contextRewindRecoveryUsed
      ? await this.loadInitialResponseId(
        args.context.sessionId,
        args.context.model,
        args.context.profileConfigDigest,
      )
      : undefined;

    try {
      for (turn = 1; turn <= turnLimit; turn++) {
        if (args.context.drainHandoff?.requested) {
          logger.info(
            `[resume] safe drain handoff session=${args.context.sessionId} run=${args.context.runId} afterTurns=${turn - 1}`,
          );
          return;
        }
        const boundaryInterjections = await drainQueuedInterjections();
        if (boundaryInterjections.length > 0) yield await steeringInterjections.announce(boundaryInterjections);
        if (args.context.drainHandoff?.requested) return;
        args.context.replaceableDraftRetryUsed = turn === 1 && restoredDraftRecoveryUsed;
        let completed: Extract<ModelEvent, { type: 'completed' }> | null = null;
        let turnContextUsage: OutboundEvent['contextUsage'] | null = null;
        let turnText = '';
        let turnThinking = '';
        const turnFinalTextStart = finalText.length;
        const draftId = supportsReplaceableDrafts(args.context.channelContext) ? randomUUID() : undefined;
        const draftStartedAt = new Date().toISOString();
        let draftStatePersisted = false;
        const ensureDraftStatePersisted = async () => {
          if (!draftId || draftStatePersisted) return;
          await this.persistReplaceableDraftState(args.context, {
            draftId,
            recoveryUsed: args.context.replaceableDraftRetryUsed === true,
            startedAt: draftStartedAt,
          });
          draftStatePersisted = true;
        };
        // RawAgentLoop 不逐 token 落 assistant_stream_event；多进程传输层仅写有界聚合批次。UI 的"思考 Xs"
        // 时长改由 assistant_thinking 聚合行的 durationMs 携带。
        let turnThinkingMs = 0;
        let thinkingSegmentStartedAt: number | undefined;
        pendingTurnText = '';

        await this.assertNoOpenToolCallBatchesBeforeModel(args.context.sessionId);
        await args.context.authorizeModelTurn?.();
        const preflight = governModelRequestMessages(
          args.messages,
          args.context.model,
          currentUserMessageIndex,
          contextUsageTracker.currentContextTokens,
          args.context.modelRef,
        );
        if (preflight.shouldCompactBeforeRequest) {
          let checkpointSucceeded = false;
          if (args.context.evaluateAutoCompaction && !autoCompactionSuppressed) {
            const checkpointEvents = await this.eventStore.list(requireEventTenantId(args.context), args.context.sessionId, {
              excludeTypes: RUN_START_REPLAY_EXCLUDED_EVENT_TYPES,
              replayMode: 'bounded',
            });
            const evaluation = args.context.evaluateAutoCompaction(checkpointEvents, 'context_governor');
            if (evaluation.shouldCompact) {
              const outcome = yield* this.compactHistory(
                { instructions: args.instructions },
                args.context,
                checkpointEvents,
                {
                  inline: true,
                  trigger: 'threshold',
                  sourceRunId: args.context.runId,
                  baseFixedTokens: estimateContextTokens([args.instructions, args.tools]),
                },
              );
              if (outcome.usage) totalUsage = mergeUsage(totalUsage, outcome.usage);
              if (outcome.status === 'aborted') {
                const reason = args.context.signal?.reason;
                throw reason instanceof Error ? reason : new Error(String(reason ?? 'run aborted'));
              }
              if (outcome.status === 'compacted') {
                const compactedEvents = await this.eventStore.list(requireEventTenantId(args.context), args.context.sessionId, {
                  excludeTypes: RUN_START_REPLAY_EXCLUDED_EVENT_TYPES,
                  replayMode: 'bounded',
                });
                const compactedProjection = buildContextProjection(compactedEvents, {
                  sessionId: args.context.sessionId,
                  runId: args.context.runId,
                  policy: this.contextPolicy,
                });
                args.messages.splice(
                  0,
                  args.messages.length,
                  { role: 'system', content: args.instructions },
                  ...this.filterLoadedToolMessages(compactedProjection.messages, args.tools),
                );
                currentUserMessageIndex = findLastUserMessageIndex(args.messages);
                contextUsageTracker = new RuntimeContextUsageTracker(
                  args.context.model,
                  compactedEvents,
                  args.context.modelRef,
                );
                currentResponseId = undefined;
                this.clearForcedSynthesis();
                checkpointSucceeded = true;
                try {
                  await this.runStore?.patchMetadata?.(args.context.runId, {
                    contextPressure: null,
                    autoCompactedAt: new Date().toISOString(),
                  });
                } catch (err) {
                  logger.warn(
                    `[auto-compact] clear resume context pressure failed session=${args.context.sessionId} `
                    + `run=${args.context.runId}: ${err instanceof Error ? err.message : String(err)}`,
                  );
                }
              } else {
                autoCompactionSuppressed = true;
                if (outcome.status === 'error') {
                  logger.warn(
                    `[auto-compact] resume checkpoint failed; continuing session=${args.context.sessionId} `
                    + `run=${args.context.runId}: ${outcome.error ?? 'unknown error'}`,
                  );
                  yield {
                    type: 'compaction_end',
                    compaction: {
                      skipped: true,
                      note: '自动压缩失败，已继续当前会话。',
                      coveredEventCount: 0,
                    },
                  };
                }
              }
            } else if (!evaluation.shouldCompact) {
              autoCompactionSuppressed = true;
            }
          }
          if (!checkpointSucceeded) {
            autoCompactionSuppressed = true;
            if (isEmergencyContextPressure(
              preflight.triggerTokens,
              args.context.model,
              args.context.modelRef,
            )) {
              this.forceSynthesis(
                `上下文 ${preflight.triggerTokens} tokens 已逼近模型硬窗口；自动 checkpoint 未能建立，进入紧急收束`,
                args.context,
                CONTEXT_SYNTHESIS_PROMPT,
                true,
              );
              currentResponseId = undefined;
            } else {
              logger.warn(
                `[auto-compact] soft checkpoint unavailable during resume; continuing with normal tools `
                + `session=${args.context.sessionId} run=${args.context.runId} `
                + `tokens=${preflight.triggerTokens}/${preflight.thresholdTokens}`,
              );
            }
          }
        }
        const forceSynthesis = this.prepareForcedSynthesis(args.messages);
        const requestTools = forceSynthesis && this.forcedSynthesisAllowsSessionRecovery
          ? args.tools.filter((tool) => SESSION_CONTEXT_RECOVERY_TOOL_NAMES.has(tool.name))
          : args.tools;
        const allowSessionRecovery = forceSynthesis
          && this.forcedSynthesisAllowsSessionRecovery
          && requestTools.length > 0;
        const requestHistory = args.messages.filter((message) => message.role !== 'system');
        const currentUserMessage = requestHistory.at(-1);
        const contextSnapshot = buildContextBreakdownSnapshot({
          instructions: args.instructions,
          historyMessages: requestHistory.slice(0, -1),
          currentUserContent: currentUserMessage?.role === 'user' ? currentUserMessage.content : '',
          tools: requestTools,
          descriptorsByName: args.descriptorsByName,
        });
        let modelStreamError: unknown;
        const modelEvents = captureModelStreamError(
          this.modelAdapter.stream({
            model: args.context.model,
            // Adapter 可能为诊断/重试保留 request 引用；传快照，避免本轮结束后的上下文追加反向污染已发送请求。
            messages: [...args.messages],
            tools: requestTools,
            signal: args.context.signal,
            ...(forceSynthesis && !allowSessionRecovery ? { toolChoice: 'none' as const } : {}),
            ...(currentResponseId ? { previousResponseId: currentResponseId } : {}),
          }, this.withModelRequestDiagnostics(args.context)),
          (error) => { modelStreamError = error; },
        );
        for await (const event of modelEvents) {
          if (event.type === 'thinking_delta') {
            if (!thinkingStarted) {
              thinkingStarted = true;
              thinkingSegmentStartedAt = Date.now();
              await ensureDraftStatePersisted();
              yield { type: 'thinking_start', ...(draftId ? { draftId } : {}) };
            }
            turnThinking += event.content;
            yield { type: 'thinking_delta', content: event.content };
          } else if (event.type === 'text_delta') {
            if (thinkingStarted) {
              thinkingStarted = false;
              if (thinkingSegmentStartedAt !== undefined) {
                turnThinkingMs += Date.now() - thinkingSegmentStartedAt;
                thinkingSegmentStartedAt = undefined;
              }
              yield { type: 'thinking_end' };
            }
            if (!textStarted) {
              textStarted = true;
              await ensureDraftStatePersisted();
              yield { type: 'text_start', ...(draftId ? { draftId } : {}) };
            }
            turnText += event.content;
            pendingTurnText += event.content;
            finalText += event.content;
            yield { type: 'text_delta', content: event.content };
          } else if (event.type === 'draft_reset') {
            thinkingStarted = false;
            textStarted = false;
            thinkingSegmentStartedAt = undefined;
            turnThinkingMs = 0;
            turnThinking = '';
            turnText = '';
            pendingTurnText = '';
            finalText = finalText.slice(0, turnFinalTextStart);
            if (draftId) {
              args.context.replaceableDraftRetryUsed = true;
              await this.persistReplaceableDraftState(args.context, {
                draftId,
                recoveryUsed: true,
                startedAt: draftStartedAt,
              });
              yield { type: 'draft_reset', draftId, attempt: event.attempt };
            }
          } else {
            completed = event;
          }
        }
        if (thinkingStarted) {
          thinkingStarted = false;
          if (thinkingSegmentStartedAt !== undefined) {
            turnThinkingMs += Date.now() - thinkingSegmentStartedAt;
            thinkingSegmentStartedAt = undefined;
          }
          yield { type: 'thinking_end' };
        }

        if (completed?.usage) totalUsage = mergeUsage(totalUsage, completed.usage);
        const blockedFailure = getInvalidPromptRequestBlockedFailure(modelStreamError ?? completed);
        if (
          blockedFailure
          && !contextRewindRecoveryUsed
          && !turnText
          && !turnThinking
          && !pendingTurnText
        ) {
          const recovery = await this.buildInvalidPromptRecovery({
            failure: blockedFailure,
            context: args.context,
            instructions: args.instructions,
            tools: args.tools,
          });
          if (recovery) {
            contextRewindRecoveryUsed = true;
            args.messages.splice(0, args.messages.length, ...recovery.messages);
            currentUserMessageIndex = findLastUserMessageIndex(args.messages);
            currentResponseId = undefined;
            contextUsageTracker = new RuntimeContextUsageTracker(
              args.context.model,
              recovery.replayEvents,
              args.context.modelRef,
            );
            this.clearForcedSynthesis();
            turn -= 1;
            continue;
          }
        }
        if (modelStreamError) throw modelStreamError;
        if (!completed) throw new Error('model stream completed without completion event');
        assertSuccessfulModelTerminal(completed);
        const projectedContextTokens = completed.usage
          ? contextUsageTracker.previewCurrentContextTokens(
              args.context.model,
              completed.usage,
              completed.responseMode,
              completed.responseChained,
            )
          : undefined;
        const calibratedBreakdown = calibrateContextBreakdown(
          contextSnapshot.breakdown,
          completed.usage,
          projectedContextTokens,
        );
        if (completed.usage) {
          turnContextUsage = contextUsageTracker.record(
            args.context.model,
            completed.usage,
            completed.responseMode,
            completed.responseChained,
            {
              breakdown: calibratedBreakdown,
              memoryFiles: calibratedBreakdown.memoryFiles ?? contextSnapshot.memoryFiles,
              mcpTools: calibratedBreakdown.mcpTools ?? contextSnapshot.mcpTools,
            },
          );
        }
        if (turnThinking) {
          await this.eventSink.append({
            type: 'assistant_thinking',
            runId: args.context.runId,
            sessionId: args.context.sessionId,
            content: turnThinking,
            streamed: true,
            durationMs: turnThinkingMs,
          });
        }

        // RFC v1 P0.4：resume 路径同样持久化 last_response_id 等。
        if (usesStoredResponseState && completed.responseStateReset) {
          currentResponseId = undefined;
          await this.clearResponseSessionStateForRepair(args.context.runId, args.context.sessionId);
        } else if (usesStoredResponseState && completed.responseId) {
          currentResponseId = completed.responseId;
          await this.persistResponseSessionState(
            args.context.runId,
            completed,
            args.context.model,
            args.context.profileConfigDigest,
          );
        }
        await this.persistLoadedMcpTools(completed, args.tools, args.messages, args.context);

        if (completed.toolCalls.length === 0) {
          if (completed.content && completed.content !== turnText) {
            if (!textStarted) {
              textStarted = true;
              await ensureDraftStatePersisted();
              yield { type: 'text_start', ...(draftId ? { draftId } : {}) };
            }
            finalText += completed.content;
            yield { type: 'text_delta', content: completed.content };
          }
          const assistantContent = completed.content || turnText;
          if (!assistantContent) {
            await this.appendSemanticFailureUsage(args.context, completed.usage, 'semantic_empty_turn');
            if (turnThinking && !thinkingOnlyContinuationUsed) {
              thinkingOnlyContinuationUsed = true;
              args.messages.push({ role: 'user', content: THINKING_ONLY_CONTINUATION_PROMPT });
              if (draftId) {
                await this.persistReplaceableDraftState(args.context, null);
                yield { type: 'draft_commit', draftId };
              }
              if (turnContextUsage) yield { type: 'context_usage', contextUsage: turnContextUsage };
              logger.warn(`[resume] thinking-only empty turn recovered session=${args.context.sessionId} turn=${turn}`);
              continue;
            }
            throw new Error(
              `model returned empty turn (no content, no tool_calls, finish_reason=${
                completed.finishReason ?? 'unknown'
              }${turnThinking ? ', thinking-only' : ''})`,
            );
          }
          await this.eventSink.append({
            type: 'assistant_message',
            runId: args.context.runId,
            sessionId: args.context.sessionId,
            content: assistantContent,
            model: args.context.model,
            ...(completed.usage ? { usage: completed.usage } : {}),
            ...(completed.responseChained !== undefined ? { responseChained: completed.responseChained } : {}),
            ...(completed.responseMode ? { responseMode: completed.responseMode } : {}),
            ...(completed.modelRequestAttemptCount !== undefined
              ? { modelRequestAttemptCount: completed.modelRequestAttemptCount }
              : {}),
            ...(completed.promptCacheKey ? { promptCacheKey: completed.promptCacheKey } : {}),
            ...(completed.requestInputPrefixHash
              ? { requestInputPrefixHash: completed.requestInputPrefixHash }
              : {}),
            ...(completed.requestInstructionsHash
              ? { requestInstructionsHash: completed.requestInstructionsHash }
              : {}),
            ...(completed.requestToolsHash ? { requestToolsHash: completed.requestToolsHash } : {}),
            ...(completed.requestHistoryHash ? { requestHistoryHash: completed.requestHistoryHash } : {}),
            ...(completed.cacheEligible !== undefined ? { cacheEligible: completed.cacheEligible } : {}),
            ...(completed.requestBodyBytes !== undefined ? { requestBodyBytes: completed.requestBodyBytes } : {}),
            ...(completed.wireMode ? { wireMode: completed.wireMode } : {}),
            ...(completed.wireRequestBodyBytes !== undefined
              ? { wireRequestBodyBytes: completed.wireRequestBodyBytes }
              : {}),
            ...(completed.wireFallbackReason ? { wireFallbackReason: completed.wireFallbackReason } : {}),
            ...(completed.providerContinuation
              ? { providerContinuation: completed.providerContinuation }
              : {}),
            ...(completed.providerContinuationReset
              ? { providerContinuationReset: true }
              : {}),
            contextBreakdown: calibratedBreakdown,
            ...(textStarted ? { streamed: true } : {}),
          });
          pendingTurnText = '';
          if (textStarted) {
            yield { type: 'text_end' };
          }
          if (draftId) {
            await this.persistReplaceableDraftState(args.context, null);
            yield { type: 'draft_commit', draftId };
          }
          if (turnContextUsage) yield { type: 'context_usage', contextUsage: turnContextUsage };
          if (completed.providerContinuationReset) clearProviderContinuations(args.messages);
          args.messages.push({
            role: 'assistant',
            content: assistantContent,
            ...(completed.providerContinuation
              ? { provider_continuation: completed.providerContinuation }
              : {}),
          });
          let queuedInterjections = await drainQueuedInterjections();
          if (args.context.drainHandoff?.requested) {
            if (queuedInterjections.length > 0) yield await steeringInterjections.announce(queuedInterjections);
            return;
          }
          if (queuedInterjections.length > 0) {
            yield await steeringInterjections.announce(queuedInterjections);
            currentResponseId = undefined;
            textStarted = false;
            if (turn >= turnLimit) turnLimit = turn + args.maxTurns;
            continue;
          }
          if (await successfulCompletion.check(args.context, args.messages, assistantContent)) {
            currentResponseId = undefined;
            textStarted = false;
            if (turn >= turnLimit) turnLimit += 1;
            continue;
          }
          try {
            if (this.runStore?.trySealSteeringInputWindow) {
              const sealed = await this.runStore.trySealSteeringInputWindow(args.context.runId);
              if (!sealed) queuedInterjections = await drainQueuedInterjections();
            }
          } catch (error) {
            if (args.context.signal?.aborted) throw error;
            steeringInterjections.requestRecoveryHandoff('steering_seal_failed');
            logger.warn(
              `[resume] steering seal failed; handing off run=${args.context.runId}: ${error instanceof Error ? error.message : String(error)}`,
            );
            return;
          }
          if (args.context.drainHandoff?.requested) {
            if (queuedInterjections.length > 0) yield await steeringInterjections.announce(queuedInterjections);
            return;
          }
          if (queuedInterjections.length > 0) {
            yield await steeringInterjections.announce(queuedInterjections);
            currentResponseId = undefined;
            textStarted = false;
            if (turn >= turnLimit) turnLimit = turn + args.maxTurns;
            continue;
          }
          await finishSuccessfulRun({
            context: args.context, numTurns: turn, totalUsage, finalText,
            append: (event) => this.eventSink.append(event),
            log: () => logger.info(`[resume] finished session=${args.context.sessionId} turns=${turn}`),
          });
          yield { type: 'done' };
          return;
        }

        successfulCompletion.reset();
        if (completed.content && completed.content !== turnText) {
          if (!textStarted) {
            textStarted = true;
            await ensureDraftStatePersisted();
            yield { type: 'text_start', ...(draftId ? { draftId } : {}) };
          }
          finalText += completed.content;
          yield { type: 'text_delta', content: completed.content };
        }
        const toolCallContentStreamed = textStarted;
        if (textStarted) {
          textStarted = false;
          yield { type: 'text_end' };
        }

        await this.eventSink.append({
          type: 'assistant_tool_calls',
          runId: args.context.runId,
          sessionId: args.context.sessionId,
          content: completed.content || turnText,
          model: args.context.model,
          ...(completed.usage ? { usage: completed.usage } : {}),
          ...(completed.responseChained !== undefined ? { responseChained: completed.responseChained } : {}),
          ...(completed.responseMode ? { responseMode: completed.responseMode } : {}),
          ...(completed.modelRequestAttemptCount !== undefined
            ? { modelRequestAttemptCount: completed.modelRequestAttemptCount }
            : {}),
          ...(completed.promptCacheKey ? { promptCacheKey: completed.promptCacheKey } : {}),
          ...(completed.requestInputPrefixHash
            ? { requestInputPrefixHash: completed.requestInputPrefixHash }
            : {}),
          ...(completed.requestInstructionsHash
            ? { requestInstructionsHash: completed.requestInstructionsHash }
            : {}),
          ...(completed.requestToolsHash ? { requestToolsHash: completed.requestToolsHash } : {}),
          ...(completed.requestHistoryHash ? { requestHistoryHash: completed.requestHistoryHash } : {}),
          ...(completed.cacheEligible !== undefined ? { cacheEligible: completed.cacheEligible } : {}),
          ...(completed.requestBodyBytes !== undefined ? { requestBodyBytes: completed.requestBodyBytes } : {}),
          ...(completed.wireMode ? { wireMode: completed.wireMode } : {}),
          ...(completed.wireRequestBodyBytes !== undefined
            ? { wireRequestBodyBytes: completed.wireRequestBodyBytes }
            : {}),
          ...(completed.wireFallbackReason ? { wireFallbackReason: completed.wireFallbackReason } : {}),
          ...(completed.providerContinuation
            ? { providerContinuation: completed.providerContinuation }
            : {}),
          ...(completed.providerContinuationReset
            ? { providerContinuationReset: true }
            : {}),
          contextBreakdown: calibratedBreakdown,
          ...(toolCallContentStreamed ? { streamed: true } : {}),
          toolCalls: completed.toolCalls,
        });
        pendingTurnText = '';
        if (draftId) {
          await this.persistReplaceableDraftState(args.context, null);
          yield { type: 'draft_commit', draftId };
        }
        if (turnContextUsage) yield { type: 'context_usage', contextUsage: turnContextUsage };
        if (completed.providerContinuationReset) clearProviderContinuations(args.messages);
        args.messages.push({
          role: 'assistant',
          content: completed.content || turnText || null,
          tool_calls: completed.toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.arguments },
            ...(call.namespace ? { namespace: call.namespace } : {}),
          })),
          ...(completed.providerContinuation
            ? { provider_continuation: completed.providerContinuation }
            : {}),
        });

        let yieldedToUserInput = false;
        yield* this.drainToolCalls({
          calls: completed.toolCalls,
          descriptorsByName: this.callableDescriptorsForMessages(args.descriptorsByName, args.messages),
          baseToolContext: args.baseToolContext,
          context: args.context,
          messages: args.messages,
          shouldYieldToUserInput: async () => (yieldedToUserInput = await hasQueuedUserInputAtToolBoundary({
            context: args.context,
            disabled: steeringInterjections.absorptionDisabled,
            warn: (message) => logger.warn(message),
          })),
        });
        const toolBoundaryInterjections = await drainQueuedInterjections();
        if (toolBoundaryInterjections.length > 0) {
          yield await steeringInterjections.announce(toolBoundaryInterjections);
        }
        if (args.context.drainHandoff?.requested) return;
        if ((yieldedToUserInput || toolBoundaryInterjections.length > 0) && turn >= turnLimit) {
          turnLimit = turn + args.maxTurns;
        }
      }

      if (textStarted) {
        textStarted = false;
        yield { type: 'text_end' };
      }
      throw new Error(`raw agent loop exceeded maxTurns=${turnLimit}`);
    } catch (err) {
      if (err instanceof RunLeaseLostError) {
        if (thinkingStarted) yield { type: 'thinking_end' };
        if (textStarted) yield { type: 'text_end' };
        return;
      }
      if (err instanceof ToolInvocationClaimLostError) {
        const failure = await handleInvocationClaimLoss(
          err, args.context, this.runStore, (event) => this.eventSink.append(event), 'resume',
        );
        if (failure) yield failure;
        else {
          if (thinkingStarted) yield { type: 'thinking_end' };
          if (textStarted) yield { type: 'text_end' };
        }
        return;
      }
      if (err instanceof ApprovalPendingWithoutInteractionHook) {
        if (thinkingStarted) yield { type: 'thinking_end' };
        if (textStarted) {
          textStarted = false;
          yield { type: 'text_end' };
        }
        return;
      }
      if (err instanceof InteractionPendingWithoutInteractionHook) {
        if (thinkingStarted) yield { type: 'thinking_end' };
        if (textStarted) {
          textStarted = false;
          yield { type: 'text_end' };
        }
        yield toOutboundInteractionEvent(err.event);
        return;
      }
      if (thinkingStarted) yield { type: 'thinking_end' };
      if (textStarted) {
        textStarted = false;
        yield { type: 'text_end' };
      }
      const { diagnosticMessage, message, surfacedMessage, preservedTurnText, failureProtocol } = describeRuntimeFailure(err, pendingTurnText, INVALID_PROMPT_CUSTOMER_ERROR);
      const modelUsage = buildModelUsage(args.context.model, totalUsage);
      if (preservedTurnText) {
        await this.eventSink.append({
          type: 'assistant_message',
          runId: args.context.runId,
          sessionId: args.context.sessionId,
          content: preservedTurnText,
          model: args.context.model,
          streamed: true,
          incomplete: true,
        });
      }
      if (isForcedDrainHandoff(args.context)) {
        logger.warn(
          `[resume] drain deadline forced safe handoff session=${args.context.sessionId} run=${args.context.runId} turn=${turn}`,
        );
        return;
      }
      await this.eventSink.append({
        type: 'run_finished',
        runId: args.context.runId,
        sessionId: args.context.sessionId,
        subtype: 'error',
        numTurns: turn,
        ...(modelUsage ? { modelUsage } : {}),
        error: surfacedMessage,
        ...(failureProtocol ?? {}),
      });
      await args.context.hooks?.onResult?.({
        subtype: 'error',
        numTurns: turn,
        resultText: mergeRuntimeFailureResultText(finalText, preservedTurnText),
        ...(modelUsage ? { modelUsage } : {}),
        ...(failureProtocol ?? {}),
      });
      logger.error(
        `[resume] failed session=${args.context.sessionId} turns=${turn}: ${diagnosticMessage}`
        + `${message !== diagnosticMessage ? ` (client=${message})` : ''}`,
      );
      yield { type: 'error', error: surfacedMessage, ...(failureProtocol ? { runId: args.context.runId, ...failureProtocol } : {}) };
    }
  }

  private async clearResponseRelayState(sessionId: string, source: string): Promise<void> {
    if (!this.runStore?.clearResponseSessionStateBySession) return;
    try {
      const cleared = await this.runStore.clearResponseSessionStateBySession(sessionId);
      logger.info(`[responses-chain] ${source} cleared ${cleared} relay state(s) session=${sessionId}`);
    } catch (error) {
      logger.warn(
        `[responses-chain] ${source} failed to clear relay state session=${sessionId}: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async buildInvalidPromptRecovery(args: {
    failure: InvalidPromptRequestBlockedFailure;
    context: RunContext;
    instructions: string;
    tools: ReturnType<typeof toModelToolDefinition>[];
  }): Promise<{ messages: ModelChatMessage[]; replayEvents: PlatformEvent[] } | null> {
    const allEvents = await this.eventStore.list(requireEventTenantId(args.context), args.context.sessionId, { replayMode: 'bounded' });
    if (allEvents.some((event) => event.type === 'context_rewind' && event.runId === args.context.runId)) {
      return null;
    }
    const projection = buildContextProjection(allEvents, {
      sessionId: args.context.sessionId,
      runId: args.context.runId,
      policy: this.contextPolicy,
    });
    const unit = findLastCompleteToolInteractionUnit(projection.selectedEvents, allEvents);
    if (!unit) return null;

    const createdAt = new Date().toISOString();
    await this.eventSink.appendBatch([
      {
        type: 'context_rewind',
        runId: args.context.runId,
        sessionId: args.context.sessionId,
        reason: 'invalid_prompt_request_blocked',
        message: '自动回退上一工具交互并继续',
        sourceModelRequestId: args.failure.modelRequestId,
        sourceAttemptId: args.failure.attemptId,
        excludedEventIds: unit.excludedEventIds,
        excludedToolCallIds: unit.excludedToolCallIds,
        excludedStartSequence: unit.excludedStartSequence,
        excludedEndSequence: unit.excludedEndSequence,
        createdAt,
        recoveryAttempt: 1,
      },
      {
        type: 'user_message',
        runId: args.context.runId,
        sessionId: args.context.sessionId,
        content: INVALID_PROMPT_RECOVERY_INPUT,
        modelContent: INVALID_PROMPT_RECOVERY_INPUT,
        systemGenerated: true,
        recoveryKind: 'invalid_prompt_rewind',
        hiddenFromUserTranscript: true,
      },
    ]);
    await this.clearResponseRelayState(args.context.sessionId, 'context rewind');

    const replayEvents = await this.eventStore.list(requireEventTenantId(args.context), args.context.sessionId, {
      excludeTypes: RUN_START_REPLAY_EXCLUDED_EVENT_TYPES,
      replayMode: 'bounded',
    });
    const replayProjection = buildContextProjection(replayEvents, {
      sessionId: args.context.sessionId,
      runId: args.context.runId,
      policy: this.contextPolicy,
    });
    const messages: ModelChatMessage[] = [
      { role: 'system', content: args.instructions },
      ...this.filterLoadedToolMessages(replayProjection.messages, args.tools),
    ];
    clearProviderContinuations(messages);
    logger.warn(
      `[run] 自动回退上一工具交互并继续 session=${args.context.sessionId} run=${args.context.runId} `
      + `sequence=${unit.excludedStartSequence}-${unit.excludedEndSequence} `
      + `toolCalls=${unit.excludedToolCallIds.join(',')}`,
    );
    return { messages, replayEvents };
  }
}
