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
  type PlatformEventInput,
} from './types.js';
import { canonicalToolInputDigest } from './canonicalToolInput.js';
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
import { DefaultToolPolicy } from './toolPolicy.js';
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
import {
  getModelAutoCompactThreshold,
  getModelContextWindow,
} from '../data/usage/pricing.js';
import { projectToolResultContentForModel } from './replayEventBounds.js';
import {
  buildRuntimeReplayState,
  type RuntimeReplayState,
  type RuntimeToolCallBatchState,
  type RuntimeToolCallState,
} from './replay.js';
import type { ToolInvocationStore } from './toolInvocationStore.js';
import { pickSoleReadyTenantHandId, type HandStore } from './handStore.js';
import type { RunStore } from './runStore.js';
import { createLogger } from '../utils/logger.js';
import { resolveRunTenantId, withDurableRunCancellation } from './runContextGovernance.js';
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
  formatAskUserQuestionResult,
  formatMemoryContext,
  getInvalidPromptRequestBlockedFailure,
  isForcedDrainHandoff,
  isInvalidPromptRequestBlocked,
  isParallelSafeToolCall,
  mergeUsage,
  parseToolArguments,
  resolveZombieToolCallTimeoutMs,
  toModelToolDefinition,
  toOutboundInteractionEvent,
  unavailableToolMessage,
  type InvalidPromptRequestBlockedFailure,
} from './rawAgentLoopHelpers.js';

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
interface ReplaceableDraftRunState {
  draftId: string;
  recoveryUsed: boolean;
  startedAt: string;
}

function parseReplaceableDraftRunState(value: unknown): ReplaceableDraftRunState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  if (
    typeof state.draftId !== 'string'
    || !state.draftId
    || typeof state.startedAt !== 'string'
    || !Number.isFinite(Date.parse(state.startedAt))
  ) return null;
  return {
    draftId: state.draftId,
    recoveryUsed: state.recoveryUsed === true,
    startedAt: state.startedAt,
  };
}

function resolveInvokedSkillName(toolId: string, input: unknown): string | undefined {
  if (toolId !== 'Skill' || !input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const skill = (input as Record<string, unknown>).skill;
  return typeof skill === 'string' && skill.trim() ? skill.trim() : undefined;
}

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
  /**
   * B2: 让 RawAgentLoop 在记录 invocation start 时能查 session 内可用 hand。
   * 当 session 内只有一个 ready tenant-remote hand 时，自动把该 handId 注入
   * invocation metadata（cancel delivery / 审计可见）。普通工具入参不接受 handId。
   */
  handStore?: HandStore;
  /**
   * RFC v1 P0.4：跨 turn / 跨 run 持久化 Responses API session state（last_response_id 等）。
   * 不传则不做接力，所有请求都走全量 input（行为退化为不使用 Responses API 接力）。
   */
  runStore?: RunStore;
  /** 已由显式 model capability 解析出的 MCP 加载方式；缺省保持 eager 零回归。 */
  mcpLoadingMode?: EffectiveMcpLoadingMode;
  streamEventBatch?: StreamEventBatchOptions;
  /**
   * 把「invocationStarted 但既无 completed 也无 cancel_requested」的工具调用判定
   * 为 zombie 的年龄阈值（毫秒）。tool_invocation_started 写入超过此阈值且无任何
   * 后续事件时，replay 视为 SIGKILL/crash 残留，让 recoverUnclosedToolCalls 的
   * 合成 tool_result 默认分支收尾，避免会话被永久卡在「请稍后重试」。
   *
   * 默认 600_000（10 分钟），可通过 env `AGENT_SAAS_ZOMBIE_TOOL_CALL_TIMEOUT_MS` 覆盖。
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

interface ContextPressureState {
  reason: 'context_governor';
  detectedAt: string;
  triggerTokens: number;
  thresholdTokens: number;
  droppedMessages: number;
}

interface CompactionOutcome {
  status: 'compacted' | 'skipped' | 'aborted' | 'error';
  numTurns: number;
  resultText: string;
  usage?: ModelUsage;
  error?: string;
}

interface CompactionOptions {
  inline: boolean;
  trigger: 'manual' | 'threshold';
  sourceRunId?: string;
  controlSourceRunIds?: string[];
  baseFixedTokens?: number;
}

function isEmergencyContextPressure(
  triggerTokens: number,
  model: string,
  modelRef?: string,
): boolean {
  const contextWindow = getModelContextWindow(model, modelRef);
  if (!contextWindow) return true;
  return triggerTokens >= Math.floor(contextWindow * CONTEXT_EMERGENCY_THRESHOLD_RATIO);
}

function parseContextPressureState(value: unknown): ContextPressureState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  if (
    state.reason !== 'context_governor'
    || typeof state.detectedAt !== 'string'
    || typeof state.triggerTokens !== 'number'
    || typeof state.thresholdTokens !== 'number'
    || typeof state.droppedMessages !== 'number'
  ) return null;
  return state as unknown as ContextPressureState;
}

/**
 * /compact 真实现（2026-07-03）的压缩请求。作为普通 user message 追加在
 * 待压缩段末尾。
 */
const COMPACTION_REQUEST_PROMPT = [
  '请暂停当前任务。现在需要对上面提供的会话前缀执行上下文压缩，整理成可恢复的上下文检查点；平台会另外保留当前任务锚点、全部用户消息轨迹和最近完整执行尾部。',
  '要求：',
  '- 只总结当前请求中提供的历史前缀；不要推测平台另行保留的原始尾部。',
  '- 保留：任务目标与当前状态；重要事实与数据（数字/文件路径/命令/URL/代码要点）；已完成工作及产出位置；未完成事项与精确下一步；用户偏好与约束。',
  '- 对已经发生的外部副作用（写文件、提交、发送、创建/修改外部对象等）记录对象、ID、回执和结果，明确禁止重复执行。',
  '- 丢弃：寒暄、重复内容、已被纠正的中间尝试细节、冗长工具原始输出（只留结论与检索标识）。',
  '- 无需逐字复述用户消息，平台会在摘要旁保留确定性用户消息轨迹。',
  '- 固定使用以下 Markdown 章节：当前任务与约束、已完成工作、外部副作用与回执、当前代码/文件/测试状态、未完成事项、下一步动作、历史检索引用；没有内容写“无”。',
  '- 使用中文；不要调用任何工具；只输出摘要正文，不要添加解释、开场白或结尾语。',
].join('\n');

/**
 * 失败残留防御：/compact 的 user_message 落库时 modelContent 用这段说明文本。
 * 压缩成功时该事件被 compaction 切分点盖掉，永远不进模型；压缩失败时它会随
 * full_replay 残留在后续上下文里——说明文本确保模型不会把裸 "/compact" 当聊天即兴处理。
 */
const COMPACT_COMMAND_MODEL_CONTENT = '[系统命令] 用户请求压缩会话上下文（/compact）。这是平台指令，无需回应此消息本身。';

const THINKING_ONLY_CONTINUATION_PROMPT = [
  'Your previous assistant turn produced hidden reasoning only, with no user-visible content and no tool call.',
  'Continue now from that reasoning. You must either call the next appropriate tool or provide the final user-visible answer.',
  'Do not repeat hidden reasoning.',
].join('\n');

/** 压缩段（保留窗口之前）投影后少于这个消息数不值得压缩，直接回复无需压缩 */
const MIN_COMPACTABLE_MESSAGES = 4;

function findLastUserMessageIndex(messages: ModelChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return i;
  }
  return -1;
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


export interface StreamEventBatchOptions {
  /** Flush once this many stream events are buffered. */
  maxEvents?: number;
  /** Flush once buffered stream content reaches this many UTF-8 bytes. */
  maxBytes?: number;
  /** Flush buffered chunks after this delay so slow streams still reach durable storage. */
  flushIntervalMs?: number;
}

export class StreamEventBatcher {
  private readonly buffer: PlatformEventInput[] = [];
  private bufferedBytes = 0;
  private timer: NodeJS.Timeout | undefined;
  private flushing: Promise<void> = Promise.resolve();

  constructor(
    private readonly eventStore: EventStore,
    private readonly options: Required<StreamEventBatchOptions>,
  ) {}

  async push(event: PlatformEventInput): Promise<void> {
    this.buffer.push(event);
    this.bufferedBytes += 'content' in event && typeof event.content === 'string' ? Buffer.byteLength(event.content, 'utf8') : 0;
    if (this.buffer.length >= this.options.maxEvents || this.bufferedBytes >= this.options.maxBytes) {
      await this.flush();
      return;
    }
    this.scheduleFlush();
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.buffer.length === 0) {
      await this.flushing;
      return;
    }
    const events = this.buffer.splice(0, this.buffer.length);
    this.bufferedBytes = 0;
    this.flushing = this.flushing.then(async () => {
      if (this.eventStore.appendBatch) {
        await this.eventStore.appendBatch(events);
      } else {
        for (const event of events) await this.eventStore.append(event);
      }
    });
    await this.flushing;
  }

  private scheduleFlush(): void {
    if (this.timer || this.options.flushIntervalMs <= 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.options.flushIntervalMs);
    this.timer.unref?.();
  }
}

const STREAM_SUMMARY_TAIL_CHARS = 8 * 1024;
const STREAM_SUMMARY_PROGRESS_LIMIT = 20;

export class ToolStreamSummaryBuilder {
  private stdoutTail = '';
  private stderrTail = '';
  private readonly progressTail: string[] = [];
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private outputChunks = 0;
  private progressCount = 0;
  private truncated = false;

  observe(chunk: import('./handProtocol.js').ToolInvocationStreamChunk): void {
    if (chunk.type === 'output') {
      this.outputChunks += 1;
      const bytes = Buffer.byteLength(chunk.content, 'utf8');
      if (chunk.channel === 'stderr') {
        this.stderrBytes += bytes;
        this.stderrTail = this.appendTail(this.stderrTail, chunk.content);
      } else {
        this.stdoutBytes += bytes;
        this.stdoutTail = this.appendTail(this.stdoutTail, chunk.content);
      }
      return;
    }
    if (chunk.type === 'progress') {
      this.progressCount += 1;
      this.progressTail.push(chunk.message);
      if (this.progressTail.length > STREAM_SUMMARY_PROGRESS_LIMIT) {
        this.progressTail.splice(0, this.progressTail.length - STREAM_SUMMARY_PROGRESS_LIMIT);
        this.truncated = true;
      }
    }
  }

  build(args: {
    runId: string;
    sessionId: string;
    invocationId: string;
    toolCallId: string;
    toolName: string;
    status: 'success' | 'error' | 'cancelled';
  }): PlatformEventInput | undefined {
    if (this.outputChunks === 0 && this.progressCount === 0) return undefined;
    return {
      type: 'tool_stream_summary',
      runId: args.runId,
      sessionId: args.sessionId,
      invocationId: args.invocationId,
      toolCallId: args.toolCallId,
      toolName: args.toolName,
      status: args.status,
      stdoutBytes: this.stdoutBytes,
      stderrBytes: this.stderrBytes,
      outputChunks: this.outputChunks,
      progressCount: this.progressCount,
      truncated: this.truncated,
      ...(this.stdoutTail ? { stdoutTail: this.stdoutTail } : {}),
      ...(this.stderrTail ? { stderrTail: this.stderrTail } : {}),
      ...(this.progressTail.length ? { progressTail: [...this.progressTail] } : {}),
    };
  }

  private appendTail(current: string, next: string): string {
    const combined = `${current}${next}`;
    if (combined.length <= STREAM_SUMMARY_TAIL_CHARS) return combined;
    this.truncated = true;
    return combined.slice(combined.length - STREAM_SUMMARY_TAIL_CHARS);
  }
}

export class RawAgentLoop implements AgentLoop {
  private readonly modelAdapter: ModelAdapter;
  private readonly eventStore: EventStore;
  private readonly approvalStore: ApprovalStore;
  private readonly transcriptProjection: LegacyTranscriptProjection;
  private readonly toolRuntime: ToolRuntime;
  private readonly workspaceProvider: WorkspaceProvider;
  private readonly toolPolicy: ToolPolicy;
  private readonly contextPolicy?: ContextReconstructionPolicy;
  private readonly toolInvocationStore?: ToolInvocationStore;
  private readonly handStore?: HandStore;
  private readonly runStore?: RunStore;
  private readonly mcpLoadingMode: EffectiveMcpLoadingMode;
  private readonly streamEventBatch: Required<StreamEventBatchOptions>;
  private readonly zombieToolCallTimeoutMs: number;
  private webFetchSynthesisReason?: string;
  private forcedSynthesisReason?: string;
  private forcedSynthesisPrompt = CONTEXT_SYNTHESIS_PROMPT;
  private forcedSynthesisPromptAppended = false;
  private forcedSynthesisAllowsSessionRecovery = false;

  constructor(options: RawAgentLoopOptions) {
    this.modelAdapter = options.modelAdapter;
    this.eventStore = options.eventStore;
    this.approvalStore = options.approvalStore;
    this.transcriptProjection = options.transcriptProjection;
    this.toolRuntime = options.toolRuntime ?? new PlatformToolRuntime();
    this.workspaceProvider = options.workspaceProvider ?? new LocalWorkspaceProvider();
    this.toolPolicy = options.toolPolicy ?? new DefaultToolPolicy();
    this.contextPolicy = options.contextPolicy;
    this.toolInvocationStore = options.toolInvocationStore;
    this.handStore = options.handStore;
    this.runStore = options.runStore;
    this.mcpLoadingMode = options.mcpLoadingMode ?? 'eager';
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
    await this.append({
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
            await this.append({
              type: 'model_request_started',
              runId: context.runId,
              sessionId: context.sessionId,
              diagnostic,
            });
          } else if (diagnostic.type === 'checkpoint') {
            await this.append({
              type: 'model_request_checkpoint',
              runId: context.runId,
              sessionId: context.sessionId,
              diagnostic,
            });
          } else {
            await this.append({
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

  /**
   * B2: 自动选择 session 内"唯一" ready 的 tenant-remote hand 写入 invocation
   * metadata。HandStore 缺失 / 无 sessionId / list 异常时静默返回 undefined
   * —— 自动路由是优化路径，绝不阻断主流程。判定规则由 pickSoleReadyTenantHandId
   * 提供，确保与 WorkspaceToolProvider 的 transport 路由共用同一份决策。
   */
  private async autoSelectTenantHandId(sessionId?: string): Promise<string | undefined> {
    if (!this.handStore || !sessionId) return undefined;
    try {
      const hands = await this.handStore.listBySession(sessionId);
      return pickSoleReadyTenantHandId(hands);
    } catch {
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
    if (!context.channelContext.replaceableDrafts || !this.runStore) return null;
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
    if (!context.channelContext.replaceableDrafts || !this.runStore?.patchMetadata) return;
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
      await this.append({
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
      await this.append({
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
    const workspace = this.workspaceProvider.resolve(context.channelContext, {
      cwd: context.cwd,
      sessionId: context.sessionId,
      topLevelSessionId: context.topLevelSessionId,
      workspaceId: context.workspaceId,
      sandboxScopeId: context.sandboxScopeId,
      mountSubPath: context.mountSubPath,
      executionTarget: context.executionTarget,
      sandboxPolicy: context.sandboxPolicy,
    });
    const baseToolContext: ToolCallContext = {
      channelContext: context.channelContext,
      workspace,
      env: context.env,
      sessionId: context.sessionId,
      runId: context.runId,
      hooks: context.hooks,
      signal: context.signal,
    };
    const descriptors = this.toolRuntime.list(baseToolContext);
    const priorEvents = await this.eventStore.list(context.sessionId, {
      excludeTypes: RUN_START_REPLAY_EXCLUDED_EVENT_TYPES,
      replayMode: 'bounded',
    });
    const { tools, descriptorsByName } = await this.prepareSessionTools(descriptors, priorEvents, context);
    const replayState = buildRuntimeReplayState(
      priorEvents,
      await this.approvalStore.list(context.sessionId),
      context.sessionId,
    );
    const recovery = await this.recoverUnclosedToolCalls(replayState);
    if (recovery.blocking) {
      yield { type: 'error', error: recovery.message };
      return;
    }
    const recoveredEvents = recovery.recovered > 0
      ? await this.eventStore.list(context.sessionId, {
        excludeTypes: RUN_START_REPLAY_EXCLUDED_EVENT_TYPES,
        replayMode: 'bounded',
      })
      : priorEvents;
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
      sessionId: context.sessionId,
      runId: context.runId,
      policy: this.contextPolicy,
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
    const manualCheckpointSourceRunIds = new Set<string>();
    const durableInterjectionSourceRunIds = new Set(
      recoveredEvents
        .filter((event): event is Extract<PlatformEvent, { type: 'user_message' }> => (
          event.type === 'user_message' && typeof event.interjectionSourceRunId === 'string'
        ))
        .map((event) => event.interjectionSourceRunId!),
    );
    // recoveredEvents 已进入 contextProjection；新 append 的消息只有结算成功后才加入
    // 当前内存 messages，避免 reserve/apply 失败时仍被模型看到。
    const modelContextInterjectionSourceRunIds = new Set(durableInterjectionSourceRunIds);
    let steeringAbsorptionDisabled = false;
    const requestSteeringRecoveryHandoff = (reason: string) => {
      steeringAbsorptionDisabled = true;
      if (!context.drainHandoff) return;
      context.drainHandoff.requested = true;
      context.drainHandoff.reason = reason;
      context.drainHandoff.requestedAt = new Date().toISOString();
    };
    const drainQueuedInterjections = async () => {
      if (context.signal?.aborted || steeringAbsorptionDisabled) return [];
      const queued = await context.loadQueuedInterjections?.() ?? [];
      if (queued.length === 0) return [];
      // 附件解析/图像理解可能是秒级慢路径；所有权必须在 durable append 和模型请求前取得。
      if (context.signal?.aborted) return [];
      const requestedSourceRunIds = queued.map((interjection) => interjection.sourceRunId);
      let reservedInterjections = queued;
      try {
        const reservedSourceRunIds = await this.runStore?.reserveSteeringInputs?.(
          context.runId,
          requestedSourceRunIds,
        ) ?? requestedSourceRunIds;
        const reservedSourceRunIdSet = new Set(reservedSourceRunIds);
        reservedInterjections = queued.filter((interjection) => (
          reservedSourceRunIdSet.has(interjection.sourceRunId)
        ));
        if (reservedInterjections.length !== queued.length) {
          const missing = queued
            .filter((interjection) => !reservedSourceRunIdSet.has(interjection.sourceRunId))
            .map((interjection) => interjection.sourceRunId);
          logger.warn(`[run] steering reserve partial: run=${context.runId} unreserved=${missing.join(',')}`);
        }
      } catch (error) {
        if (context.signal?.aborted) throw error;
        requestSteeringRecoveryHandoff('steering_reserve_failed');
        logger.warn(
          `[run] steering reserve failed; handing off target run=${context.runId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return [];
      }
      if (reservedInterjections.length === 0 || context.signal?.aborted) return [];

      for (const interjection of reservedInterjections) {
        if (isCompactCommand(interjection.message.content)) {
          manualCheckpointSourceRunIds.add(interjection.sourceRunId);
          continue;
        }
        if (durableInterjectionSourceRunIds.has(interjection.sourceRunId)) continue;
        const userMessageEvent = await this.eventStore.append({
          type: 'user_message',
          runId: context.runId,
          sessionId: context.sessionId,
          content: interjection.message.content,
          modelContent: interjection.prompt,
          ...(interjection.attachments?.length ? { attachments: interjection.attachments } : {}),
          ...(interjection.visionAnalysis ? { visionAnalysis: interjection.visionAnalysis } : {}),
          interjectionSourceRunId: interjection.sourceRunId,
          ...(interjection.clientMsgId ? { clientMsgId: interjection.clientMsgId } : {}),
        }).catch((error) => {
          requestSteeringRecoveryHandoff('steering_reserved_event_append_failed');
          throw error;
        });
        durableInterjectionSourceRunIds.add(interjection.sourceRunId);
        try {
          await this.transcriptProjection.project(userMessageEvent);
        } catch (error) {
          logger.warn(
            `[run] interjection transcript project failed (degraded): run=${context.runId} source=${interjection.sourceRunId} error=${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      let appliedInterjections = reservedInterjections;
      try {
        const appliedSourceRunIds = await this.runStore?.markSteeringInputsApplied?.(
          context.runId,
          reservedInterjections.map((interjection) => interjection.sourceRunId),
        ) ?? reservedInterjections.map((interjection) => interjection.sourceRunId);
        const appliedSourceRunIdSet = new Set(appliedSourceRunIds);
        appliedInterjections = reservedInterjections.filter((interjection) => (
          appliedSourceRunIdSet.has(interjection.sourceRunId)
        ));
        if (appliedInterjections.length !== reservedInterjections.length) {
          requestSteeringRecoveryHandoff('steering_reserved_apply_partial');
          const missing = reservedInterjections
            .filter((interjection) => !appliedSourceRunIdSet.has(interjection.sourceRunId))
            .map((interjection) => interjection.sourceRunId);
          logger.warn(
            `[run] steering apply partial; absorption disabled for run=${context.runId} unapplied=${missing.join(',')}`,
          );
        }
      } catch (error) {
        if (context.signal?.aborted) throw error;
        requestSteeringRecoveryHandoff('steering_reserved_apply_failed');
        logger.warn(
          `[run] steering apply failed; handing off target run=${context.runId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }

      for (const interjection of appliedInterjections) {
        if (
          manualCheckpointSourceRunIds.has(interjection.sourceRunId)
          || modelContextInterjectionSourceRunIds.has(interjection.sourceRunId)
        ) continue;
        messages.push({
          role: 'user',
          content: buildModelUserContent(
            interjection.prompt,
            interjection.attachments,
            interjection.visionAnalysis,
          ),
        });
        currentUserMessageIndex = messages.length - 1;
        modelContextInterjectionSourceRunIds.add(interjection.sourceRunId);
      }
      return appliedInterjections;
    };
    const announceAppliedInterjections = async (
      interjections: Awaited<ReturnType<typeof drainQueuedInterjections>>,
    ): Promise<OutboundEvent> => {
      const appliedPayload = {
        sourceRunIds: interjections.map((interjection) => interjection.sourceRunId),
        clientMsgIds: interjections.flatMap((interjection) => (
          interjection.clientMsgId ? [interjection.clientMsgId] : []
        )),
      };
      try {
        await this.append({
          type: 'interjection_applied',
          runId: context.runId,
          sessionId: context.sessionId,
          ...appliedPayload,
        });
      } catch (error) {
        logger.warn(
          `[run] durable interjection_applied append failed: run=${context.runId} error=${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return { type: 'interjection_applied', ...appliedPayload };
    };

    if (contextProjection.summaryEvent) await this.append(contextProjection.summaryEvent);
    if (input.memoryContext) {
      await this.append({
        type: 'memory_context',
        runId: context.runId,
        sessionId: context.sessionId,
        content: formatMemoryContext(input.memoryContext),
      });
    }
    await this.append({
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
      await this.append({
        type: 'user_message',
        runId: context.runId,
        sessionId: context.sessionId,
        content: input.message.content,
        modelContent: input.prompt,
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
    let thinkingOnlyContinuationUsed = false;
    let pendingTurnText = '';
    // safe boundary 在上一轮收尾/工具后完成 reserve+apply 时，把通知归属带到下一模型轮次。
    let carriedBoundaryInterjections: Awaited<ReturnType<typeof drainQueuedInterjections>> = [];

    // RFC v1 P0.4：跨 run 接力 Responses API session state。
    // 启动时查上一已完成 run 的 last_response_id（72h 内未过期），赋给本 run。
    // ChatCompletionsAdapter 收到 previousResponseId 会抛错 — 所以 runStore 只在
    // 模型走 protocol="responses" 时才有意义；dispatcher 已按 protocol 路由 adapter。
    const usesStoredResponseState = this.modelAdapter.capabilities?.responseState !== 'stateless';
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
        let inlineCompactionAttempted = false;
        const draftId = context.channelContext.replaceableDrafts ? randomUUID() : undefined;
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
          const checkpointEvents = await this.eventStore.list(context.sessionId, {
            excludeTypes: RUN_START_REPLAY_EXCLUDED_EVENT_TYPES,
            replayMode: 'bounded',
          });
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
                baseFixedTokens: estimateContextTokens([
                  input.instructions,
                  input.memoryContext,
                  tools,
                ]),
              },
            );
            if (outcome.usage) totalUsage = mergeUsage(totalUsage, outcome.usage);
            if (outcome.status === 'aborted') {
              const reason = context.signal?.reason;
              throw reason instanceof Error ? reason : new Error(String(reason ?? 'run aborted'));
            }
            if (outcome.status === 'compacted') {
              const compactedEvents = await this.eventStore.list(context.sessionId, {
                excludeTypes: RUN_START_REPLAY_EXCLUDED_EVENT_TYPES,
                replayMode: 'bounded',
              });
              const compactedProjection = buildContextProjection(compactedEvents, {
                sessionId: context.sessionId,
                runId: context.runId,
                policy: this.contextPolicy,
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
            const checkpointEvents = await this.eventStore.list(context.sessionId, {
              excludeTypes: RUN_START_REPLAY_EXCLUDED_EVENT_TYPES,
              replayMode: 'bounded',
            });
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
                  baseFixedTokens: estimateContextTokens([
                    input.instructions,
                    input.memoryContext,
                    tools,
                  ]),
                },
              );
              if (outcome.usage) totalUsage = mergeUsage(totalUsage, outcome.usage);
              if (outcome.status === 'aborted') {
                const reason = context.signal?.reason;
                throw reason instanceof Error ? reason : new Error(String(reason ?? 'run aborted'));
              }
              if (outcome.status === 'compacted') {
                const compactedEvents = await this.eventStore.list(context.sessionId, {
                  excludeTypes: RUN_START_REPLAY_EXCLUDED_EVENT_TYPES,
                  replayMode: 'bounded',
                });
                const compactedProjection = buildContextProjection(compactedEvents, {
                  sessionId: context.sessionId,
                  runId: context.runId,
                  policy: this.contextPolicy,
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
          await this.append({
            type: 'assistant_thinking',
            runId: context.runId,
            sessionId: context.sessionId,
            content: turnThinking,
            streamed: true,
            durationMs: turnThinkingMs,
          });
        }

        // RFC v1 P0.4：每轮持久化 Responses API session state。
        // currentResponseId 用于下一轮 turn 接力（同 run 内）；落库后跨 run 也能查回。
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
          await this.append({
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
            const compactionEvents = await this.eventStore.list(context.sessionId, {
              excludeTypes: RUN_START_REPLAY_EXCLUDED_EVENT_TYPES,
              replayMode: 'bounded',
            });
            const evaluation = context.evaluateAutoCompaction(
              compactionEvents,
              contextPressureForceReason,
            );
            if (evaluation.shouldCompact) {
              inlineCompactionAttempted = true;
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
                },
              );
              if (outcome.usage) totalUsage = mergeUsage(totalUsage, outcome.usage);
              if (outcome.status === 'aborted') {
                const reason = context.signal?.reason;
                throw reason instanceof Error ? reason : new Error(String(reason ?? 'run aborted'));
              }
              if (outcome.status === 'compacted') {
                const compactedEvents = await this.eventStore.list(context.sessionId, {
                  excludeTypes: RUN_START_REPLAY_EXCLUDED_EVENT_TYPES,
                  replayMode: 'bounded',
                });
                const compactedProjection = buildContextProjection(compactedEvents, {
                  sessionId: context.sessionId,
                  runId: context.runId,
                  policy: this.contextPolicy,
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
          if (turn < turnLimit || inlineCompactionAttempted) {
            // BUG-8 降级（2026-08-04）：drain/seal 的 PG 抖动不允许把已经答完的 run
            // 打成 failed——按「无插话」继续收尾；窗口留 open 时，目标终态后
            // NOT EXISTS 条件自动失效，排队插话回退为独立 run 执行，不丢消息。
            let queuedInterjections: Awaited<ReturnType<typeof drainQueuedInterjections>> = [];
            try {
              queuedInterjections = await drainQueuedInterjections();
              if (queuedInterjections.length === 0 && this.runStore?.trySealSteeringInputWindow) {
                const sealed = await this.runStore.trySealSteeringInputWindow(context.runId);
                if (!sealed) queuedInterjections = await drainQueuedInterjections();
              }
            } catch (error) {
              if (context.signal?.aborted) throw error;
              logger.warn(
                `[run] steering drain/seal failed at finish (degraded): run=${context.runId} error=${error instanceof Error ? error.message : String(error)}`,
              );
              queuedInterjections = [];
            }
            if (context.drainHandoff?.requested) {
              if (queuedInterjections.length > 0) {
                yield await announceAppliedInterjections(queuedInterjections);
              }
              return;
            }
            if (queuedInterjections.length > 0) {
              carriedBoundaryInterjections = queuedInterjections;
              // 压缩期间到达的消息必须仍是当前 run 的插话。即使原任务恰好耗尽
              // maxTurns，也为这批插话重新开放一份完整轮次预算，避免压缩尾阶段
              // 人为制造“上一 run 已停、下一 run 尚未开始”的断层。
              if (inlineCompactionAttempted && turn >= turnLimit) {
                turnLimit = turn + input.maxTurns;
              }
              continue;
            }
          } else if (this.runStore?.trySealSteeringInputWindow) {
            // D-4（2026-08-04）：最后一轮（turn === turnLimit 且未触发内联压缩）没有
            // 轮次预算再消费插话，立即封口让此后到达的插话马上回退为独立 run，
            // 而不是滞留到本 run 终态。seal 返回 false（已有 pending）时无预算可
            // 消费，留给终态回退路径处理。
            try {
              await this.runStore.trySealSteeringInputWindow(context.runId);
            } catch (error) {
              if (context.signal?.aborted) throw error;
              logger.warn(
                `[run] steering final-turn seal failed (degraded): run=${context.runId} error=${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
          const modelUsage = buildModelUsage(context.model, totalUsage);
          await this.append({
            type: 'run_finished',
            runId: context.runId,
            sessionId: context.sessionId,
            subtype: 'success',
            numTurns: turn,
            ...(modelUsage ? { modelUsage } : {}),
          });
          logger.info(`[run] finished session=${context.sessionId} turns=${turn}`);
          await context.hooks?.onResult?.({
            subtype: 'success',
            numTurns: turn,
            resultText: finalText,
            ...(modelUsage ? { modelUsage } : {}),
          });
          yield { type: 'done' };
          return;
        }

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

        await this.append({
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

        yield* this.drainToolCalls({
          calls: completed.toolCalls,
          descriptorsByName: this.callableDescriptorsForMessages(descriptorsByName, messages),
          baseToolContext,
          context,
          messages,
        });
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
      const diagnosticMessage = err instanceof Error ? err.message : String(err);
      const message = isInvalidPromptRequestBlocked(err)
        ? INVALID_PROMPT_CUSTOMER_ERROR
        : diagnosticMessage;
      const modelUsage = buildModelUsage(context.model, totalUsage);
      if (pendingTurnText) {
        await this.append({
          type: 'assistant_message',
          runId: context.runId,
          sessionId: context.sessionId,
          content: pendingTurnText,
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
      const surfacedMessage = pendingTurnText
        ? `${message}；已保留本次未完成正文，可发送“继续”接着完成。`
        : message;
      await this.append({
        type: 'run_finished',
        runId: context.runId,
        sessionId: context.sessionId,
        subtype: 'error',
        numTurns: turn,
        ...(modelUsage ? { modelUsage } : {}),
        error: surfacedMessage,
      });
      await context.hooks?.onResult?.({
        subtype: 'error',
        numTurns: turn,
        resultText: finalText,
        ...(modelUsage ? { modelUsage } : {}),
      });
      logger.error(
        `[run] failed session=${context.sessionId} turns=${turn}: ${diagnosticMessage}`
        + `${message !== diagnosticMessage ? ` (client=${message})` : ''}`,
      );
      yield { type: 'error', error: surfacedMessage };
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
    const priorEvents = await this.eventStore.list(context.sessionId, {
      excludeTypes: RUN_START_REPLAY_EXCLUDED_EVENT_TYPES,
      replayMode: 'bounded',
    });
    await this.append({
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
    await this.append({
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
      await this.append({
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
      await this.append({
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
    await this.append({
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
        mountSubPath: context.mountSubPath,
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
          sessionId: context.sessionId,
          runId: context.runId,
          policy: this.contextPolicy,
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
        baseFixedTokens: options.baseFixedTokens
          ?? estimateContextTokens([input.instructions, tools]),
        sourceRunId: options.sourceRunId,
      });
      const compressedProjection = buildContextProjection(
        priorEvents.slice(0, plan.rawTailStartIndex),
        {
          sessionId: context.sessionId,
          runId: context.runId,
          policy: this.contextPolicy,
        },
      );
      const compressedMessages = compressedProjection.messages;
      const minimumMessages = options.trigger === 'threshold' ? 1 : MIN_COMPACTABLE_MESSAGES;
      if (plan.coveredEventCount <= 0 || compressedMessages.length < minimumMessages) {
        const note = '当前会话历史很短，无需压缩。';
        yield { type: 'compaction_end', compaction: { skipped: true, note, coveredEventCount: 0 } };
        return { status: 'skipped', numTurns: 0, resultText: note };
      }

      const requestMessages: ModelChatMessage[] = [
        { role: 'system', content: input.instructions },
        ...compressedMessages,
        { role: 'user', content: COMPACTION_REQUEST_PROMPT },
      ];
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
        await this.append({
          type: 'compaction_usage',
          runId: context.runId,
          sessionId: context.sessionId,
          model: context.model,
          usage: completed.usage,
        });
      }
      if (!summaryText && completed.content) summaryText = completed.content;
      if (!summaryText.trim()) throw new Error('compaction failed: model returned empty summary');

      if (this.runStore?.clearResponseSessionStateBySession) {
        const cleared = await this.runStore.clearResponseSessionStateBySession(context.sessionId);
        if (cleared > 0) {
          logger.info(`[compact] cleared ${cleared} response relay state(s) session=${context.sessionId}`);
        }
      }
      await this.append({
        type: 'compaction',
        runId: context.runId,
        sessionId: context.sessionId,
        summary: summaryText.trim(),
        coveredEventCount: plan.coveredEventCount,
        ...(plan.rawTailStartEventId ? { cutoffEventId: plan.rawTailStartEventId } : {}),
        ...(options.inline ? { inline: true } : {}),
        checkpoint: {
          version: plan.version,
          trigger: options.trigger,
          ...(options.sourceRunId ? { sourceRunId: options.sourceRunId } : {}),
          ...(options.controlSourceRunIds?.length
            ? { controlSourceRunIds: options.controlSourceRunIds }
            : {}),
          targetTokens: plan.targetTokens,
          summaryBudgetTokens: plan.summaryBudgetTokens,
          summaryObservedTokens: estimateContextTokens(summaryText.trim()),
          rawTailBudgetTokens: plan.rawTailBudgetTokens,
          rawTailObservedTokens: plan.rawTailObservedTokens,
          fixedTokens: plan.fixedTokens,
          taskAnchors: plan.taskAnchors,
        },
      });

      logger.info(
        `[compact] checkpoint finished session=${context.sessionId} covered=${plan.coveredEventCount} `
        + `retained=${priorEvents.length - plan.coveredEventCount} `
        + `cutoff=${plan.rawTailStartEventId ?? 'compaction'} inline=${options.inline} trigger=${options.trigger}`,
      );
      const resultText = `✅ 上下文已压缩：${plan.coveredEventCount} 条较早事件已归纳，保留 ${priorEvents.length - plan.coveredEventCount} 条最近原始事件（完整记录仍可检索）。`;
      yield {
        type: 'compaction_end',
        compaction: { summary: summaryText.trim(), coveredEventCount: plan.coveredEventCount },
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
      const blocking = this.describeBlockingToolCall(state);
      if (blocking) return { blocking: true, message: blocking };

      const content = this.buildSyntheticToolResultContent(state);
      await this.append({
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

  private describeBlockingToolCall(state: RuntimeToolCallState): string | undefined {
    const approvalStatus = state.approval?.status ?? state.approvalResolution?.decision;
    if (approvalStatus === 'pending') {
      const approvalId = state.approval?.id ?? state.approvalRequest?.approvalId;
      return `当前会话正在等待工具审批，请先处理 approval ${approvalId ?? state.toolCallId} for ${state.toolName}`;
    }

    if (
      state.interactionRequest
      && state.interactionRequest.interactionType === 'ask_user'
      && !state.interactionResolution
    ) {
      return `当前会话正在等待你回答上一个工具问题，请先处理 interaction ${state.interactionRequest.interactionId} for ${state.toolName}`;
    }

    if (state.invocationStarted && !state.invocationCompleted && !state.cancelRequested) {
      // 06-24 修：tool_invocation_started 写入后若长时间没有任何后续事件
      //（completed / cancel_requested / 同 callId 的 chunk 等），多半是 server
      // SIGKILL/crash 残留——shell 子进程被 SIGKILL，没机会写收尾事件，也没人
      // 发 cancel。仍判 blocking 会让会话永久卡在「请稍后重试」（参见 06-24 凌晨
      // session 3cab86d1 事故）。超过 zombieToolCallTimeoutMs 视为 zombie，
      // 返回 undefined 让 recoverUnclosedToolCalls 走默认 synthetic 分支，
      // 合成 tool_result(isError, 'tool execution was interrupted before producing a result')。
      const startedAtMs = Date.parse(state.invocationStarted.timestamp);
      const ageMs = Number.isFinite(startedAtMs) ? Date.now() - startedAtMs : 0;
      if (ageMs >= this.zombieToolCallTimeoutMs) {
        return undefined;
      }
      return `当前会话存在仍在执行或等待恢复的工具调用，请稍后重试 ${state.toolName} (${state.toolCallId})`;
    }

    return undefined;
  }

  private buildSyntheticToolResultContent(state: RuntimeToolCallState): string {
    const approvalStatus = state.approval?.status ?? state.approvalResolution?.decision;
    if (approvalStatus === 'rejected' || approvalStatus === 'timeout') {
      return JSON.stringify({
        error: `tool execution was ${approvalStatus} before producing a result`,
        toolCallId: state.toolCallId,
        toolName: state.toolName,
        recoverable: false,
      });
    }

    if (state.invocationCompleted) {
      return JSON.stringify({
        error: state.invocationCompleted.error
          ?? `tool invocation completed with status=${state.invocationCompleted.status} but no tool_result was recorded`,
        toolCallId: state.toolCallId,
        toolName: state.toolName,
        invocationId: state.invocationCompleted.invocationId,
        status: state.invocationCompleted.status,
        recoverable: false,
      });
    }

    if (state.cancelRequested) {
      return JSON.stringify({
        error: `tool execution was cancelled before producing a result${state.cancelRequested.reason ? `: ${state.cancelRequested.reason}` : ''}`,
        toolCallId: state.toolCallId,
        toolName: state.toolName,
        recoverable: false,
      });
    }

    return JSON.stringify({
      error: 'tool execution was interrupted before producing a result',
      toolCallId: state.toolCallId,
      toolName: state.toolName,
      recoverable: false,
    });
  }

  private async assertNoOpenToolCallBatchesBeforeModel(sessionId: string): Promise<void> {
    const replayState = buildRuntimeReplayState(
      await this.eventStore.list(sessionId, {
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

  /**
   * 执行一个 batch 的工具调用。默认严格串行；连续 ≥2 个声明并发安全的工具调用
   * 组成一段并行 fan-out：
   *   - 审批挂起是通过抛异常中止本 generator 实现的，任何可能触发审批/交互的工具
   *     进入 Promise.all 都会让并发兄弟变成孤儿，因此并行窗只接受 descriptor
   *     显式 opt-in 且
   *     risk=safe、approvalMode=never 的工具；未声明工具（包括 MCP）默认串行。
   *   - 顺序契约不变：tool_use 块先按原 toolCalls 顺序全部 yield，执行完成后
   *     tool_result 三件套（yield + eventStore append + messages.push）仍按原顺序逐个
   *     进行——模型协议要求 tool_result 顺序稳定。并发期间 durable 的
   *     tool_invocation_* 事件会交错落库，replay/recovery 按 toolCallId 建 Map
   *     （runtime/replay.ts）不依赖跨 call 顺序，已核实安全。
   *   - Agent 的并发额度仍由 subagentLimits 信号量控制；其他 opt-in 工具由
   *     模型单批 toolCalls 数量自然限定，本层不另设重复限流。
   *   - abort：父 signal 经 ToolCallContext 传导给每个并发工具，级联取消。
   * 单个并发安全调用（段长 1）仍走下方串行分支，行为与既有路径一致。
   */
  private async *drainToolCalls(args: {
    calls: ModelToolCall[];
    descriptorsByName: Map<string, ToolDescriptor>;
    baseToolContext: ToolCallContext;
    context: RunContext;
    messages?: ModelChatMessage[];
  }): AsyncIterable<OutboundEvent> {
    const calls = args.calls;
    let index = 0;
    while (index < calls.length) {
      let segmentEnd = index;
      while (
        segmentEnd < calls.length
        && isParallelSafeToolCall(calls[segmentEnd]!, args.descriptorsByName)
      ) {
        segmentEnd += 1;
      }

      if (segmentEnd - index >= 2) {
        const segment = calls.slice(index, segmentEnd);
        for (const call of segment) {
          // 准入工具的 policy 恒 allow → shouldEmit 恒 true；仍走同一判定入口，
          // 保持与串行分支的行为对称。
          if (await this.shouldEmitToolUseBeforeExecution(call, args.descriptorsByName, args.context)) {
            yield { type: 'tool_start', toolId: call.id, toolName: call.name };
            yield { type: 'tool_input_delta', toolId: call.id, toolName: call.name, partialJson: call.arguments };
            yield { type: 'tool_end', toolId: call.id, toolName: call.name };
          }
        }
        const outcomes = await Promise.all(segment.map((call) => this.executeToolCall(
          call,
          args.descriptorsByName,
          args.baseToolContext,
          args.context,
        )));
        for (let i = 0; i < segment.length; i += 1) {
          const outcome = outcomes[i]!;
          yield* this.appendToolResult({
            call: segment[i]!,
            content: outcome.result.content,
            ...(outcome.isError ? { isError: true } : {}),
            ...(outcome.result.presentation ? { presentation: outcome.result.presentation } : {}),
            ...(outcome.result.metadata ? { metadata: outcome.result.metadata } : {}),
            context: args.context,
            messages: args.messages,
          });
        }
        index = segmentEnd;
        continue;
      }

      const call = calls[index]!;
      if (await this.shouldEmitToolUseBeforeExecution(
        call,
        args.descriptorsByName,
        args.context,
      )) {
        yield { type: 'tool_start', toolId: call.id, toolName: call.name };
        yield { type: 'tool_input_delta', toolId: call.id, toolName: call.name, partialJson: call.arguments };
        yield { type: 'tool_end', toolId: call.id, toolName: call.name };
      }
      const outcome = await this.executeToolCall(
        call,
        args.descriptorsByName,
        args.baseToolContext,
        args.context,
      );
      yield* this.appendToolResult({
        call,
        content: outcome.result.content,
        ...(outcome.isError ? { isError: true } : {}),
        ...(outcome.result.presentation ? { presentation: outcome.result.presentation } : {}),
        ...(outcome.result.metadata ? { metadata: outcome.result.metadata } : {}),
        context: args.context,
        messages: args.messages,
      });
      index += 1;
    }
  }

  private async *drainRemainingToolCallBatch(args: {
    batch: RuntimeToolCallBatchState;
    skipToolCallIds: Set<string>;
    descriptorsByName: Map<string, ToolDescriptor>;
    baseToolContext: ToolCallContext;
    context: RunContext;
  }): AsyncIterable<OutboundEvent> {
    const calls = args.batch.toolCalls
      .filter((state) => !state.toolResult && !args.skipToolCallIds.has(state.toolCallId))
      .map((state) => state.call);
    yield* this.drainToolCalls({
      calls,
      descriptorsByName: args.descriptorsByName,
      baseToolContext: args.baseToolContext,
      context: args.context,
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
    const input = parseToolArguments(call.arguments);
    const policyContext = await this.refreshApprovalPolicy(context);
    const decision = await this.toolPolicy.decide(descriptor, input, policyContext);
    return decision.type !== 'requires_approval';
  }

  private async *appendToolResult(args: {
    call: ModelToolCall;
    content: string;
    isError?: boolean;
    context: RunContext;
    messages?: ModelChatMessage[];
    presentation?: ToolPresentation;
    metadata?: Record<string, unknown>;
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
    await this.append({
      type: 'tool_result',
      runId: args.context.runId,
      sessionId: args.context.sessionId,
      toolCallId: args.call.id,
      toolName: args.call.name,
      content: args.content,
      ...(args.isError ? { isError: true } : {}),
      ...(args.presentation ? { presentation: args.presentation } : {}),
      ...(args.metadata ? { metadata: args.metadata } : {}),
    });
    // 模型面刻意不带 presentation：它是给人看的第二通道，混进 messages
    // 会平白消耗上下文，也会让模型误以为摘要是它自己写的
    args.messages?.push({
      role: 'tool',
      tool_call_id: args.call.id,
      content: projectedContent,
    });
  }

  async *resumeApproval(input: ResumeApprovalInput, context: RunContext): AsyncIterable<OutboundEvent> {
    context = withDurableRunCancellation(context, this.runStore);
    const approval = await this.approvalStore.get(input.approvalId);
    if (!approval) {
      yield { type: 'error', error: `approval not found: ${input.approvalId}` };
      return;
    }

    const priorEvents = await this.eventStore.list(approval.sessionId, { replayMode: 'bounded' });
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
      runId: approval.runId,
      sessionId: approval.sessionId,
    };
    const workspace = this.workspaceProvider.resolve(resumeContext.channelContext, {
      cwd: resumeContext.cwd,
      sessionId: resumeContext.sessionId,
      topLevelSessionId: resumeContext.topLevelSessionId,
      workspaceId: resumeContext.workspaceId,
      sandboxScopeId: resumeContext.sandboxScopeId,
      mountSubPath: resumeContext.mountSubPath,
      executionTarget: approval.executionTarget ?? pendingState.approvalRequest?.executionTarget ?? resumeContext.executionTarget,
      sandboxPolicy: resumeContext.sandboxPolicy,
    });
    const baseToolContext: ToolCallContext = {
      channelContext: resumeContext.channelContext,
      workspace,
      env: resumeContext.env,
      sessionId: resumeContext.sessionId,
      runId: resumeContext.runId,
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
    const outcome = await this.resolveApprovalDecision({
      approval,
      response: input.response,
      call,
      descriptor,
      input: approval.input,
      baseToolContext,
      context: resumeContext,
    });

    yield* this.appendToolResult({
      call,
      content: outcome.result.content,
      ...(outcome.isError ? { isError: true } : {}),
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
      });
    } catch (err) {
      if (err instanceof ApprovalPendingWithoutInteractionHook) return;
      if (err instanceof InteractionPendingWithoutInteractionHook) {
        yield toOutboundInteractionEvent(err.event);
        return;
      }
      throw err;
    }

    const replayEvents = await this.eventStore.list(approval.sessionId, { replayMode: 'bounded' });
    const contextProjection = buildContextProjection(replayEvents, {
      sessionId: approval.sessionId,
      runId: resumeContext.runId,
      policy: this.contextPolicy,
    });
    const messages: ModelChatMessage[] = [
      { role: 'system', content: input.instructions },
      ...this.filterLoadedToolMessages(contextProjection.messages, tools),
    ];
    if (contextProjection.summaryEvent) await this.append(contextProjection.summaryEvent);

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
    const priorEvents = await this.eventStore.list(context.sessionId, { replayMode: 'bounded' });
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
      mountSubPath: context.mountSubPath,
      executionTarget: context.executionTarget,
      sandboxPolicy: context.sandboxPolicy,
    });
    const baseToolContext: ToolCallContext = {
      channelContext: context.channelContext,
      workspace,
      env: context.env,
      sessionId: context.sessionId,
      runId: context.runId,
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
      await this.append({
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
      });
    } catch (err) {
      if (err instanceof ApprovalPendingWithoutInteractionHook) return;
      if (err instanceof InteractionPendingWithoutInteractionHook) {
        yield toOutboundInteractionEvent(err.event);
        return;
      }
      throw err;
    }

    const replayEvents = await this.eventStore.list(context.sessionId, { replayMode: 'bounded' });
    const contextProjection = buildContextProjection(replayEvents, {
      sessionId: context.sessionId,
      runId: context.runId,
      policy: this.contextPolicy,
    });
    const messages: ModelChatMessage[] = [
      { role: 'system', content: input.instructions },
      ...this.filterLoadedToolMessages(contextProjection.messages, tools),
    ];
    if (contextProjection.summaryEvent) await this.append(contextProjection.summaryEvent);

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

  private async refreshApprovalPolicy(context: RunContext): Promise<RunContext> {
    if (!this.runStore) return context;
    try {
      const run = await this.runStore.get(context.runId);
      // 存量/派生 run 可能没有 approvalPolicy metadata；此时保留 dispatch 已按账户
      // 偏好解析出的策略。metadata 显式写入 null 则表示运行中关闭授权，必须清空。
      if (!run || !Object.prototype.hasOwnProperty.call(run.metadata ?? {}, 'approvalPolicy')) {
        return context;
      }
      const approvalPolicy = run.metadata?.approvalPolicy;
      const autoApproveTools = Boolean(
        approvalPolicy
        && typeof approvalPolicy === 'object'
        && (
          (approvalPolicy as { autoApproveTools?: unknown }).autoApproveTools === true
          || (approvalPolicy as { autoApproveRunShell?: unknown }).autoApproveRunShell === true
        ),
      );
      return {
        ...context,
        approvalPolicy: autoApproveTools ? { autoApproveTools: true } : undefined,
      };
    } catch {
      return context;
    }
  }

  private async executeToolCall(
    call: ModelToolCall,
    descriptorsByName: Map<string, ToolDescriptor>,
    baseToolContext: ToolCallContext,
    context: RunContext,
  ): Promise<ToolExecutionOutcome> {
    const descriptor = descriptorsByName.get(call.name);
    const input = parseToolArguments(call.arguments);
    if (!descriptor) {
      // D4 + G1：工具名不在当前 turn 的 tools[] 白名单内（descriptorsByName 来自当前 turn descriptors）。
      // 错误措辞标准化避免 deepseek 字面执行"try different approach"陷入循环。
      return {
        call,
        input,
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
          input,
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
        input,
        result: {
          content: standardizeToolError(
            `${this.webFetchSynthesisReason}；本次调用未出网，请基于已有材料收束回答`,
          ),
        },
        isError: true,
      };
    }

    const policyContext = await this.refreshApprovalPolicy(context);
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
        await this.approvalStore.resolve(approval.id, 'rejected', message);
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

    try {
      const result = await this.invokeAuthorizedTool({
        call,
        descriptor,
        input,
        authorization: { approved: true, source: 'policy_auto' },
        baseToolContext,
        context,
      });
      return { call, descriptor, input, result };
    } catch (err) {
      if (err instanceof WebFetchCircuitOpenError) {
        this.forceWebFetchSynthesis(err.reason, context);
      }
      if (err instanceof InteractionPendingWithoutInteractionHook) throw err;
      // 失败也要有摘要与结构化事实。摘要在 toolRuntime 里已按截断前 metadata 造好
      // 并随 ToolExecutionError 带上来，这里只负责不把它丢掉——此前这一跳是
      // 全部失败调用（近 7 天 3,457 次）摘要覆盖率仅 0.2% 的唯一原因，
      // approval-resume 分支（见 resolveApprovalDecision）早已是这么接的。
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
    const streamBatcher = new StreamEventBatcher(this.eventStore, this.streamEventBatch);
    const streamSummary = new ToolStreamSummaryBuilder();
    const hooks = args.baseToolContext.hooks?.onInteraction || args.descriptor.name !== 'AskUserQuestion'
      ? args.baseToolContext.hooks
      : {
          ...(args.baseToolContext.hooks ?? {}),
          onInteraction: async (event: InteractionEvent): Promise<InteractionResponse> => {
            await this.append({
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
    // B2: effective handId 只由 harness/session 状态决定。普通 workspace 工具
    // 不接受模型传入的 handId；最终 effective handId 写入 invocation metadata
    // 让 cancel delivery / 审计可见。
    const autoHandId = await this.autoSelectTenantHandId(args.context.sessionId);
    const effectiveHandId = autoHandId;
    const skillName = resolveInvokedSkillName(args.descriptor.id, args.input);
    await this.toolInvocationStore?.start({
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
    }).catch(() => undefined);
    await this.append({
      type: 'tool_invocation_started',
      runId: args.context.runId,
      sessionId: args.context.sessionId,
      invocationId,
      toolCallId: args.call.id,
      toolName: args.descriptor.name,
      executionTarget: args.baseToolContext.workspace.executionTarget,
    });
    try {
      const result = await this.toolRuntime.invoke(
        { toolId: args.descriptor.id, input: args.input, authorization: args.authorization },
        toolContext,
      );
      await streamBatcher.flush();
      await this.toolInvocationStore?.complete(invocationId, 'completed').catch(() => undefined);
      await this.append({
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
      await this.append({
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
      if (err instanceof InteractionPendingWithoutInteractionHook) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      const completionStatus = args.context.signal?.aborted ? 'cancelled' : 'failed';
      await this.toolInvocationStore?.complete(invocationId, completionStatus, message).catch(() => undefined);
      await this.append({
        type: 'tool_invocation_completed',
        runId: args.context.runId,
        sessionId: args.context.sessionId,
        invocationId,
        toolCallId: args.call.id,
        toolName: args.descriptor.name,
        status: args.context.signal?.aborted ? 'cancelled' : 'error',
        durationMs: Date.now() - startedAt,
        error: message,
      });
      await this.appendToolStreamSummary(streamSummary, {
        runId: args.context.runId,
        sessionId: args.context.sessionId,
        invocationId,
        toolCallId: args.call.id,
        toolName: args.descriptor.name,
        status: args.context.signal?.aborted ? 'cancelled' : 'error',
      }).catch(() => undefined);
      await this.append({
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
        await this.append({
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
      await this.append(event);
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
    let thinkingOnlyContinuationUsed = false;
    let pendingTurnText = '';
    let currentUserMessageIndex = 0;
    for (let index = args.messages.length - 1; index >= 0; index -= 1) {
      if (args.messages[index]?.role === 'user') {
        currentUserMessageIndex = index;
        break;
      }
    }
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
    const usesStoredResponseState = this.modelAdapter.capabilities?.responseState !== 'stateless';
    if (contextRewindRecoveryUsed) await this.clearResponseRelayState(args.context.sessionId, 'resume wake');
    let currentResponseId = usesStoredResponseState && !contextRewindRecoveryUsed
      ? await this.loadInitialResponseId(
        args.context.sessionId,
        args.context.model,
        args.context.profileConfigDigest,
      )
      : undefined;

    try {
      for (turn = 1; turn <= args.maxTurns; turn++) {
        if (args.context.drainHandoff?.requested) {
          logger.info(
            `[resume] safe drain handoff session=${args.context.sessionId} run=${args.context.runId} afterTurns=${turn - 1}`,
          );
          return;
        }
        args.context.replaceableDraftRetryUsed = turn === 1 && restoredDraftRecoveryUsed;
        let completed: Extract<ModelEvent, { type: 'completed' }> | null = null;
        let turnContextUsage: OutboundEvent['contextUsage'] | null = null;
        let turnText = '';
        let turnThinking = '';
        const turnFinalTextStart = finalText.length;
        const draftId = args.context.channelContext.replaceableDrafts ? randomUUID() : undefined;
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
            const checkpointEvents = await this.eventStore.list(args.context.sessionId, {
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
                const compactedEvents = await this.eventStore.list(args.context.sessionId, {
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
          await this.append({
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
          await this.append({
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
          const modelUsage = buildModelUsage(args.context.model, totalUsage);
          await this.append({
            type: 'run_finished',
            runId: args.context.runId,
            sessionId: args.context.sessionId,
            subtype: 'success',
            numTurns: turn,
            ...(modelUsage ? { modelUsage } : {}),
          });
          logger.info(`[resume] finished session=${args.context.sessionId} turns=${turn}`);
          await args.context.hooks?.onResult?.({
            subtype: 'success',
            numTurns: turn,
            resultText: finalText,
            ...(modelUsage ? { modelUsage } : {}),
          });
          yield { type: 'done' };
          return;
        }

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

        await this.append({
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

        yield* this.drainToolCalls({
          calls: completed.toolCalls,
          descriptorsByName: this.callableDescriptorsForMessages(args.descriptorsByName, args.messages),
          baseToolContext: args.baseToolContext,
          context: args.context,
          messages: args.messages,
        });
      }

      if (textStarted) {
        textStarted = false;
        yield { type: 'text_end' };
      }
      throw new Error(`raw agent loop exceeded maxTurns=${args.maxTurns}`);
    } catch (err) {
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
      const diagnosticMessage = err instanceof Error ? err.message : String(err);
      const message = isInvalidPromptRequestBlocked(err)
        ? INVALID_PROMPT_CUSTOMER_ERROR
        : diagnosticMessage;
      const modelUsage = buildModelUsage(args.context.model, totalUsage);
      if (pendingTurnText) {
        await this.append({
          type: 'assistant_message',
          runId: args.context.runId,
          sessionId: args.context.sessionId,
          content: pendingTurnText,
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
      const surfacedMessage = pendingTurnText
        ? `${message}；已保留本次未完成正文，可发送“继续”接着完成。`
        : message;
      await this.append({
        type: 'run_finished',
        runId: args.context.runId,
        sessionId: args.context.sessionId,
        subtype: 'error',
        numTurns: turn,
        ...(modelUsage ? { modelUsage } : {}),
        error: surfacedMessage,
      });
      await args.context.hooks?.onResult?.({
        subtype: 'error',
        numTurns: turn,
        resultText: finalText,
        ...(modelUsage ? { modelUsage } : {}),
      });
      logger.error(
        `[resume] failed session=${args.context.sessionId} turns=${turn}: ${diagnosticMessage}`
        + `${message !== diagnosticMessage ? ` (client=${message})` : ''}`,
      );
      yield { type: 'error', error: surfacedMessage };
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
    const allEvents = await this.eventStore.list(args.context.sessionId, { replayMode: 'bounded' });
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
    await this.appendBatch([
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

    const replayEvents = await this.eventStore.list(args.context.sessionId, {
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

  private async appendBatch(events: PlatformEventInput[]): Promise<void> {
    let storedEvents: PlatformEvent[];
    if (this.eventStore.appendBatch) {
      storedEvents = await this.eventStore.appendBatch(events);
    } else {
      storedEvents = [];
      for (const event of events) storedEvents.push(await this.eventStore.append(event));
    }
    for (const stored of storedEvents) await this.transcriptProjection.project(stored);
  }

  private async append(event: Parameters<EventStore['append']>[0]): Promise<void> {
    const stored = await this.eventStore.append(event);
    await this.transcriptProjection.project(stored);
  }
}

async function* captureModelStreamError(
  stream: AsyncIterable<ModelEvent>,
  onError: (error: unknown) => void,
): AsyncGenerator<ModelEvent> {
  try {
    yield* stream;
  } catch (error) {
    onError(error);
  }
}

class ApprovalAlreadyResolvedError extends Error {
  constructor(approvalId: string) {
    super(`approval already resolved: ${approvalId}`);
    this.name = 'ApprovalAlreadyResolvedError';
  }
}

class ApprovalPendingWithoutInteractionHook extends Error {
  constructor(approvalId: string) {
    super(`approval pending without interaction hook: ${approvalId}`);
    this.name = 'ApprovalPendingWithoutInteractionHook';
  }
}

class InteractionPendingWithoutInteractionHook extends Error {
  constructor(readonly event: InteractionEvent) {
    super(`interaction pending without interaction hook: ${event.interactionId}`);
    this.name = 'InteractionPendingWithoutInteractionHook';
  }
}
