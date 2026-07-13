import type {
  InteractionEvent,
  InteractionResponse,
} from '../agent/types.js';
import type {
  AgentLoop,
  ApprovalStore,
  ApprovalRecord,
  EventStore,
  ModelAdapter,
  ModelChatMessage,
  ModelEvent,
  ModelToolCall,
  ModelUsage,
  RunContext,
  RunInput,
  ToolExecutionOutcome,
  ToolPolicy,
  PlatformEvent,
  PlatformEventInput,
} from './types.js';
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
import { buildChatMessagesFromEvents, LegacyTranscriptProjection } from './legacyTranscriptProjection.js';
import { buildContextProjection, type ContextReconstructionPolicy } from './contextProjection.js';
import { RuntimeContextUsageTracker } from './contextUsage.js';
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
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { WebFetchCircuitOpenError } from '../agent/webToolProvider.js';

/**
 * RawAgentLoop 自身原本完全依赖 EventStore 留痕,不打 logger 日志。
 * 但 enqueue-only 异步路径绕过 dispatch wrapper,导致 server.log 里完全
 * 看不到会话执行痕迹。补几条关键节点日志（start / finished / failed）,
 * 让运维 grep sessionId 时至少能看到会话边界与失败原因;sessionId 由
 * rawRuntimeRunDispatch 的 enterSessionContext 自动注入到 trace 前缀。
 */
const logger = createLogger('RawAgentLoop');
const INTERACTIVE_TOOL_NAMES = new Set(['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode']);
const RUN_START_REPLAY_EXCLUDED_EVENT_TYPES = [
  'tool_output_delta',
  'tool_progress',
  'assistant_stream_event',
] satisfies PlatformEvent['type'][];
const WEB_FETCH_SYNTHESIS_PROMPT = [
  '[平台收束指令]',
  'WebFetch 已因持续高失败率熔断。停止继续扩散 URL，也不要再调用其他工具。',
  '请立即基于当前上下文中已经取得的材料完成任务；明确区分已核实事实、证据不足项与未完成项。',
].join('\n');

function resolveRunTenantId(context: RunContext): string {
  return context.tenantId
    ?? context.channelContext.sessionOwner?.tenantId
    ?? context.channelContext.user?.tenantId
    ?? DEFAULT_TENANT_ID;
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
   * 会话的正常 system prompt。压缩调用刻意与正常对话轮保持完全同构
   * （同 system、同工具定义、同接力语义），只把末尾 user 换成压缩请求——
   * 这样请求前缀与上一正常轮一致，能命中 provider 的 prompt cache；
   * Responses 接力模型更是只发一条增量 user，input 趋近于零。
   * 若改成独立压缩器 system prompt，会从第 1 个 token 起打断缓存前缀，
   * 让全会话最大的一次 input 付全价。
   */
  instructions: string;
}

/**
 * /compact 真实现（2026-07-03）的压缩请求。作为普通 user message 追加在
 * 会话末尾（见 CompactInput.instructions 注释：请求形态必须与正常轮同构）。
 */
const COMPACTION_REQUEST_PROMPT = [
  '请暂停当前任务。现在需要对本会话到目前为止的对话历史做一次上下文压缩：请生成一份忠实、信息密集的摘要，它将替代原始历史用于后续对话。',
  '要求：',
  '- 保留：任务目标与当前状态；重要事实与数据（数字/文件路径/命令/URL/代码要点）；已完成的工作及其产出位置；未完成的任务与下一步；用户明确表达的偏好与约束。',
  '- 丢弃：寒暄、重复内容、已被纠正的中间尝试细节、冗长的工具原始输出（只留结论）。',
  '- 无需逐字复述用户消息（系统会在摘要旁另行保留用户消息原文摘录），聚焦工作过程、结论与产出。',
  '- 用 Markdown 分节输出，使用中文。',
  '- 不要调用任何工具；只输出摘要正文，不要添加解释、开场白或结尾语。',
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

/** 压缩时保留最近 N 轮真实用户交互的原文（不被摘要替代） */
const RETAIN_RECENT_USER_TURNS = 2;

/**
 * 计算压缩切分点：倒数第 RETAIN_RECENT_USER_TURNS 条真实用户消息的事件下标。
 * 该下标之前的事件进入压缩段，之后（含该条用户消息）保留原文。
 * 真实用户消息 = user_message 且 modelContent 不是系统命令替身（[系统命令] 前缀）。
 * 真实交互不足 N 轮时返回 0（无可压缩段）。
 */
function findCompactionCutoffIndex(events: { type: string; modelContent?: string }[]): number {
  let seen = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type !== 'user_message') continue;
    if (event.modelContent?.startsWith('[系统命令]')) continue;
    seen++;
    if (seen >= RETAIN_RECENT_USER_TURNS) return i;
  }
  return 0;
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
  private readonly streamEventBatch: Required<StreamEventBatchOptions>;
  private readonly zombieToolCallTimeoutMs: number;
  private webFetchSynthesisReason?: string;
  private webFetchSynthesisPromptAppended = false;

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
    this.streamEventBatch = {
      maxEvents: options.streamEventBatch?.maxEvents ?? 25,
      maxBytes: options.streamEventBatch?.maxBytes ?? 32 * 1024,
      flushIntervalMs: options.streamEventBatch?.flushIntervalMs ?? 100,
    };
    this.zombieToolCallTimeoutMs = resolveZombieToolCallTimeoutMs(options.zombieToolCallTimeoutMs);
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
  private async loadInitialResponseId(sessionId: string, model: string): Promise<string | undefined> {
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
  ): Promise<void> {
    if (!this.runStore?.updateResponseSessionState || !completed.responseId) return;
    try {
      await this.runStore.updateResponseSessionState(runId, {
        lastResponseId: completed.responseId,
        lastResponseModel: model,
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

  private forceWebFetchSynthesis(reason: string, context: RunContext): void {
    if (this.webFetchSynthesisReason) return;
    this.webFetchSynthesisReason = reason;
    logger.warn(`[web-fetch-circuit] force synthesis session=${context.sessionId} run=${context.runId}: ${reason}`);
  }

  private prepareForcedSynthesis(messages: ModelChatMessage[]): boolean {
    if (!this.webFetchSynthesisReason) return false;
    if (!this.webFetchSynthesisPromptAppended) {
      messages.push({ role: 'user', content: `${WEB_FETCH_SYNTHESIS_PROMPT}\n原因：${this.webFetchSynthesisReason}` });
      this.webFetchSynthesisPromptAppended = true;
    }
    return true;
  }

  async *run(input: RunInput, context: RunContext): AsyncIterable<OutboundEvent> {
    const workspace = this.workspaceProvider.resolve(context.channelContext, {
      cwd: context.cwd,
      sessionId: context.sessionId,
      workspaceId: context.workspaceId,
      sandboxScopeId: context.sandboxScopeId,
      mountSubPath: context.mountSubPath,
      executionTarget: context.executionTarget,
      sandboxPolicy: context.sandboxPolicy,
    });
    const baseToolContext: ToolCallContext = {
      channelContext: context.channelContext,
      workspace,
      sessionId: context.sessionId,
      runId: context.runId,
      hooks: context.hooks,
      signal: context.signal,
    };
    const descriptors = this.toolRuntime.list(baseToolContext);
    const descriptorsByName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));
    const tools = descriptors.map(toModelToolDefinition);
    const priorEvents = await this.eventStore.list(context.sessionId, {
      excludeTypes: RUN_START_REPLAY_EXCLUDED_EVENT_TYPES,
    });
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
      })
      : priorEvents;
    const contextUsageTracker = new RuntimeContextUsageTracker(context.model, recoveredEvents);
    const contextProjection = buildContextProjection(recoveredEvents, {
      sessionId: context.sessionId,
      runId: context.runId,
      policy: this.contextPolicy,
    });
    const memoryMessage = input.memoryContext
      ? [{ role: 'user' as const, content: formatMemoryContext(input.memoryContext) }]
      : [];
    const messages: ModelChatMessage[] = [
      { role: 'system', content: input.instructions },
      ...memoryMessage,
      ...contextProjection.messages,
      { role: 'user', content: input.prompt },
    ];

    if (contextProjection.summaryEvent) await this.append(contextProjection.summaryEvent);
    if (input.memoryContext) {
      await this.append({
        type: 'memory_context',
        runId: context.runId,
        sessionId: context.sessionId,
        content: formatMemoryContext(input.memoryContext),
      });
    }
    await this.append({ type: 'run_started', runId: context.runId, sessionId: context.sessionId, model: context.model, channel: context.channelContext.channel });
    logger.info(`[run] start session=${context.sessionId} model=${context.model} channel=${context.channelContext.channel}`);
    if (input.recordUserMessage !== false) {
      await this.append({
        type: 'user_message',
        runId: context.runId,
        sessionId: context.sessionId,
        content: input.message.content,
        modelContent: input.prompt,
      });
    }

    let textStarted = false;
    let thinkingStarted = false;
    let totalUsage: ModelUsage | undefined;
    let finalText = '';
    let turn = 0;
    let thinkingOnlyContinuationUsed = false;

    // RFC v1 P0.4：跨 run 接力 Responses API session state。
    // 启动时查上一已完成 run 的 last_response_id（72h 内未过期），赋给本 run。
    // ChatCompletionsAdapter 收到 previousResponseId 会抛错 — 所以 runStore 只在
    // 模型走 protocol="responses" 时才有意义；dispatcher 已按 protocol 路由 adapter。
    let currentResponseId = await this.loadInitialResponseId(context.sessionId, context.model);

    try {
      for (turn = 1; turn <= input.maxTurns; turn++) {
        let completed: Extract<ModelEvent, { type: 'completed' }> | null = null;
        let turnContextUsage: OutboundEvent['contextUsage'] | null = null;
        let turnText = '';
        let turnThinking = '';
        // 2026-07-03 起 assistant_stream_event delta 不再落库；UI 的"思考 Xs"
        // 时长改由 assistant_thinking 聚合行的 durationMs 携带。
        let turnThinkingMs = 0;
        let thinkingSegmentStartedAt: number | undefined;

        await this.assertNoOpenToolCallBatchesBeforeModel(context.sessionId);
        const forceSynthesis = this.prepareForcedSynthesis(messages);
        for await (const event of this.modelAdapter.stream({
          model: context.model,
          messages,
          tools,
          signal: context.signal,
          ...(forceSynthesis ? { toolChoice: 'none' as const } : {}),
          ...(currentResponseId ? { previousResponseId: currentResponseId } : {}),
        }, context)) {
          if (event.type === 'thinking_delta') {
            if (!thinkingStarted) {
              thinkingStarted = true;
              thinkingSegmentStartedAt = Date.now();
              yield { type: 'thinking_start' };
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
              yield { type: 'text_start' };
            }
            turnText += event.content;
            finalText += event.content;
            yield { type: 'text_delta', content: event.content };
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

        if (!completed) throw new Error('model stream completed without completion event');
        if (completed.usage) {
          totalUsage = mergeUsage(totalUsage, completed.usage);
          turnContextUsage = contextUsageTracker.record(context.model, completed.usage, completed.responseChained);
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
        if (completed.responseId) {
          currentResponseId = completed.responseId;
          await this.persistResponseSessionState(context.runId, completed, context.model);
        }

        if (completed.toolCalls.length === 0) {
          if (completed.finishReason === 'length' || completed.finishReason === 'content_filter') {
            throw new Error(
              `model output truncated: finish_reason=${completed.finishReason} (可能丢失了 tool_call,不应作为正常结束)`,
            );
          }
          if (completed.content && completed.content !== turnText) {
            if (!textStarted) {
              textStarted = true;
              yield { type: 'text_start' };
            }
            finalText += completed.content;
            yield { type: 'text_delta', content: completed.content };
          }
          const assistantContent = completed.content || turnText;
          if (!assistantContent) {
            if (turnThinking && !thinkingOnlyContinuationUsed) {
              thinkingOnlyContinuationUsed = true;
              messages.push({ role: 'user', content: THINKING_ONLY_CONTINUATION_PROMPT });
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
            ...(textStarted ? { streamed: true } : {}),
          });
          if (textStarted) {
            yield { type: 'text_end' };
          }
          if (turnContextUsage) yield { type: 'context_usage', contextUsage: turnContextUsage };
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
            yield { type: 'text_start' };
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
          ...(toolCallContentStreamed ? { streamed: true } : {}),
          toolCalls: completed.toolCalls,
        });
        if (turnContextUsage) yield { type: 'context_usage', contextUsage: turnContextUsage };
        messages.push({
          role: 'assistant',
          content: completed.content || turnText || null,
          tool_calls: completed.toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.arguments },
          })),
        });

        yield* this.drainToolCalls({
          calls: completed.toolCalls,
          descriptorsByName,
          baseToolContext,
          context,
          messages,
        });
      }

      if (textStarted) {
        textStarted = false;
        yield { type: 'text_end' };
      }
      throw new Error(`raw agent loop exceeded maxTurns=${input.maxTurns}`);
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
      const message = err instanceof Error ? err.message : String(err);
      const modelUsage = buildModelUsage(context.model, totalUsage);
      await this.append({
        type: 'run_finished',
        runId: context.runId,
        sessionId: context.sessionId,
        subtype: 'error',
        numTurns: turn,
        ...(modelUsage ? { modelUsage } : {}),
        error: message,
      });
      await context.hooks?.onResult?.({
        subtype: 'error',
        numTurns: turn,
        resultText: finalText,
        ...(modelUsage ? { modelUsage } : {}),
      });
      logger.error(`[run] failed session=${context.sessionId} turns=${turn}: ${message}`);
      yield { type: 'error', error: message };
    }
  }

  /**
   * /compact 真实现（2026-07-03；v2 黑箱化 + 保留窗口 + 用户消息轨迹）：
   * 把「最近 RETAIN_RECENT_USER_TURNS 轮之前」的会话历史压缩成摘要。
   *
   * 事件落库顺序（顺序即语义，不可调换）：
   *   run_started → user_message('/compact') → [清 Responses 接力链]
   *   → compaction(带 cutoffEventId) → run_finished
   * v2 起摘要不再落 assistant_message（摘要只存 compaction.summary，transcript
   * 渲染为压缩分界线；钉钉等文本通道由 onResult resultText 收到简短确认）。
   * 清接力链放在 compaction 之前：若清空失败则压缩整体宣告失败，不会出现
   * 「投影已压缩但远端 response chain 仍带全量历史」的半生效状态。
   *
   * 对外事件流是黑箱：只发 compaction_start / compaction_end，不流式播放
   * 模型的 thinking/text——压缩过程对用户不可见，摘要经 compaction_end 与
   * transcript line 下发（前端 debugMode 决定是否提供展开查看）。
   */
  async *compact(input: CompactInput, context: RunContext): AsyncIterable<OutboundEvent> {
    const priorEvents = await this.eventStore.list(context.sessionId, {
      excludeTypes: RUN_START_REPLAY_EXCLUDED_EVENT_TYPES,
    });
    const projection = buildContextProjection(priorEvents, {
      sessionId: context.sessionId,
      runId: context.runId,
      policy: this.contextPolicy,
    });
    await this.append({
      type: 'run_started',
      runId: context.runId,
      sessionId: context.sessionId,
      model: context.model,
      channel: context.channelContext.channel,
    });
    logger.info(`[compact] start session=${context.sessionId} model=${context.model} events=${priorEvents.length}`);
    await this.append({
      type: 'user_message',
      runId: context.runId,
      sessionId: context.sessionId,
      content: input.message.content,
      modelContent: COMPACT_COMMAND_MODEL_CONTENT,
    });
    yield { type: 'compaction_start' };

    // 切分点：倒数第 RETAIN_RECENT_USER_TURNS 条真实用户消息之前进入压缩段。
    // 门槛按「压缩段」投影消息数判定——保留窗口内的消息本来就不会被压缩。
    const cutIdx = findCompactionCutoffIndex(priorEvents);
    const compressedMessages = buildChatMessagesFromEvents(priorEvents.slice(0, cutIdx));
    if (cutIdx <= 0 || compressedMessages.length < MIN_COMPACTABLE_MESSAGES) {
      const note = '当前会话历史很短，无需压缩。';
      yield { type: 'compaction_end', compaction: { skipped: true, note, coveredEventCount: 0 } };
      await this.append({
        type: 'run_finished',
        runId: context.runId,
        sessionId: context.sessionId,
        subtype: 'success',
        numTurns: 0,
      });
      await context.hooks?.onResult?.({ subtype: 'success', numTurns: 0, resultText: note });
      yield { type: 'done' };
      return;
    }

    let totalUsage: ModelUsage | undefined;
    let summaryText = '';
    try {
      // 与正常轮完全同构的请求（缓存前缀友好，见 CompactInput.instructions 注释）：
      // 同 system prompt、同工具定义（toolChoice='none' 禁止实际调用）、同接力语义。
      const workspace = this.workspaceProvider.resolve(context.channelContext, {
        cwd: context.cwd,
        sessionId: context.sessionId,
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
      const previousResponseId = await this.loadInitialResponseId(context.sessionId, context.model);
      const requestMessages: ModelChatMessage[] = [
        { role: 'system', content: input.instructions },
        ...projection.messages,
        { role: 'user', content: COMPACTION_REQUEST_PROMPT },
      ];
      let completed: Extract<ModelEvent, { type: 'completed' }> | null = null;
      // 黑箱消费：thinking 丢弃、text 静默累积，不向外 yield 流式内容
      for await (const event of this.modelAdapter.stream({
        model: context.model,
        messages: requestMessages,
        tools,
        toolChoice: 'none',
        signal: context.signal,
        ...(previousResponseId ? { previousResponseId } : {}),
      }, context)) {
        if (event.type === 'text_delta') {
          summaryText += event.content;
        } else if (event.type !== 'thinking_delta') {
          completed = event;
        }
      }
      if (completed?.usage) totalUsage = mergeUsage(totalUsage, completed.usage);
      if (!summaryText && completed?.content) {
        summaryText = completed.content;
      }
      if (!summaryText.trim()) {
        throw new Error('compaction failed: model returned empty summary');
      }

      // 被摘要覆盖的事件 = 切分点（保留窗口起点）之前的全部事件
      const coveredEventCount = cutIdx;
      const cutoffEventId = priorEvents[cutIdx]!.id;

      // 清空 Responses API 接力链（见方法头注释：必须在 compaction 落库之前）
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
        coveredEventCount,
        cutoffEventId,
      });

      const modelUsage = buildModelUsage(context.model, totalUsage);
      await this.append({
        type: 'run_finished',
        runId: context.runId,
        sessionId: context.sessionId,
        subtype: 'success',
        numTurns: 1,
        ...(modelUsage ? { modelUsage } : {}),
      });
      logger.info(`[compact] finished session=${context.sessionId} covered=${coveredEventCount} cutoff=${cutoffEventId} summaryChars=${summaryText.length}`);
      const resultText = `✅ 上下文已压缩：${coveredEventCount} 条较早历史事件已被摘要替代，最近 ${RETAIN_RECENT_USER_TURNS} 轮对话原文保留（完整记录仍可检索）。`;
      yield {
        type: 'compaction_end',
        compaction: { summary: summaryText.trim(), coveredEventCount },
      };
      await context.hooks?.onResult?.({
        subtype: 'success',
        numTurns: 1,
        resultText,
        ...(modelUsage ? { modelUsage } : {}),
      });
      yield { type: 'done' };
    } catch (err) {
      const modelUsage = buildModelUsage(context.model, totalUsage);
      // 被抢占（用户新消息 abort 自动压缩）：静默收尾，不报错——压缩是可推迟的
      // 维护动作，abort 无残留（compaction 事件只在成功收尾时落库）。
      if (context.signal?.aborted) {
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
        logger.info(`[compact] preempted/aborted session=${context.sessionId}`);
        yield { type: 'done' };
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
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
        resultText: summaryText,
        ...(modelUsage ? { modelUsage } : {}),
      });
      logger.error(`[compact] failed session=${context.sessionId}: ${message}`);
      yield { type: 'error', error: `上下文压缩失败: ${message}` };
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
   * 执行一个 batch 的工具调用。默认严格串行；唯一例外是**连续 ≥2 个 Agent 工具调用**
   * 组成的段做并行 fan-out（子 agent P1，2026-07-06）：
   *   - 仅限 Agent：它 risk:'safe' + approvalMode:'never'，policy 恒 allow——审批挂起
   *     是通过抛异常中止本 generator 实现的，任何可能触发审批/交互的工具进 Promise.all
   *     都会让并发兄弟变成孤儿，因此并行窗只对免审批的 Agent 开放。
   *   - 顺序契约不变：tool_use 块先按原 toolCalls 顺序全部 yield，执行完成后
   *     tool_result 三件套（yield + eventStore append + messages.push）仍按原顺序逐个
   *     进行——模型协议要求 tool_result 顺序稳定。并发期间 durable 的
   *     tool_invocation_* 事件会交错落库，replay/recovery 按 toolCallId 建 Map
   *     （runtime/replay.ts）不依赖跨 call 顺序，已核实安全。
   *   - 并发额度由 subagentLimits 的 per-run 信号量（4）在 runner 内排队，本层不限流。
   *   - abort：父 signal 经 ToolCallContext 传导给每个并发子 agent，级联取消。
   * 单个 Agent 调用（段长 1）仍走下方串行分支，行为与既有路径逐字节一致。
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
        && isParallelSafeAgentCall(calls[segmentEnd]!, args.descriptorsByName)
      ) {
        segmentEnd += 1;
      }

      if (segmentEnd - index >= 2) {
        const segment = calls.slice(index, segmentEnd);
        for (const call of segment) {
          // Agent 是 safe 工具，policy 恒 allow → shouldEmit 恒 true；仍走同一判定
          // 入口保持与串行分支的行为对称。
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
  }): AsyncIterable<OutboundEvent> {
    yield {
      type: 'tool_result',
      toolId: args.call.id,
      toolName: args.call.name,
      toolResult: args.content,
      ...(args.isError ? { isError: true } : {}),
    };
    await this.append({
      type: 'tool_result',
      runId: args.context.runId,
      sessionId: args.context.sessionId,
      toolCallId: args.call.id,
      toolName: args.call.name,
      content: args.content,
      ...(args.isError ? { isError: true } : {}),
    });
    args.messages?.push({
      role: 'tool',
      tool_call_id: args.call.id,
      content: args.content,
    });
  }

  async *resumeApproval(input: ResumeApprovalInput, context: RunContext): AsyncIterable<OutboundEvent> {
    const approval = await this.approvalStore.get(input.approvalId);
    if (!approval) {
      yield { type: 'error', error: `approval not found: ${input.approvalId}` };
      return;
    }

    const priorEvents = await this.eventStore.list(approval.sessionId);
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
      workspaceId: resumeContext.workspaceId,
      sandboxScopeId: resumeContext.sandboxScopeId,
      mountSubPath: resumeContext.mountSubPath,
      executionTarget: approval.executionTarget ?? pendingState.approvalRequest?.executionTarget ?? resumeContext.executionTarget,
      sandboxPolicy: resumeContext.sandboxPolicy,
    });
    const baseToolContext: ToolCallContext = {
      channelContext: resumeContext.channelContext,
      workspace,
      sessionId: resumeContext.sessionId,
      runId: resumeContext.runId,
      hooks: resumeContext.hooks,
      signal: resumeContext.signal,
    };
    const descriptors = this.toolRuntime.list(baseToolContext);
    const descriptorsByName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));
    const tools = descriptors.map(toModelToolDefinition);
    const descriptor = descriptorsByName.get(approval.toolName);
    const call: ModelToolCall = {
      id: pendingState.call.id,
      name: pendingState.call.name,
      arguments: pendingState.call.arguments,
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
      context: resumeContext,
    });

    try {
      yield* this.drainRemainingToolCallBatch({
        batch: pendingBatch,
        skipToolCallIds: new Set([call.id]),
        descriptorsByName,
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

    const replayEvents = await this.eventStore.list(approval.sessionId);
    const contextProjection = buildContextProjection(replayEvents, {
      sessionId: approval.sessionId,
      runId: resumeContext.runId,
      policy: this.contextPolicy,
    });
    const messages: ModelChatMessage[] = [
      { role: 'system', content: input.instructions },
      ...contextProjection.messages,
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
      priorEvents: replayEvents,
    });
  }

  async *resumeInteraction(input: ResumeInteractionInput, context: RunContext): AsyncIterable<OutboundEvent> {
    const priorEvents = await this.eventStore.list(context.sessionId);
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
      workspaceId: context.workspaceId,
      sandboxScopeId: context.sandboxScopeId,
      mountSubPath: context.mountSubPath,
      executionTarget: context.executionTarget,
      sandboxPolicy: context.sandboxPolicy,
    });
    const baseToolContext: ToolCallContext = {
      channelContext: context.channelContext,
      workspace,
      sessionId: context.sessionId,
      runId: context.runId,
      hooks: context.hooks,
      signal: context.signal,
    };
    const descriptors = this.toolRuntime.list(baseToolContext);
    const descriptorsByName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));
    const tools = descriptors.map(toModelToolDefinition);
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
        descriptorsByName,
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

    const replayEvents = await this.eventStore.list(context.sessionId);
    const contextProjection = buildContextProjection(replayEvents, {
      sessionId: context.sessionId,
      runId: context.runId,
      policy: this.contextPolicy,
    });
    const messages: ModelChatMessage[] = [
      { role: 'system', content: input.instructions },
      ...contextProjection.messages,
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
      priorEvents: replayEvents,
    });
  }

  private async refreshApprovalPolicy(context: RunContext): Promise<RunContext> {
    if (!this.runStore) return context;
    try {
      const run = await this.runStore.get(context.runId);
      const approvalPolicy = run?.metadata?.approvalPolicy;
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
        result: { content: standardizeToolError(`tool not found: ${call.name}（不在本轮可用工具集中）`) },
        isError: true,
      };
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
      return {
        call,
        descriptor,
        input,
        result: { content: standardizeToolError(`tool error: ${err instanceof Error ? err.message : String(err)}`) },
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
        result: { content: standardizeToolError(`tool not found: ${args.call.name}（不在本轮可用工具集中）`) },
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
      return {
        call: args.call,
        descriptor: args.descriptor,
        input: args.input,
        result: { content: standardizeToolError(`tool error: ${err instanceof Error ? err.message : String(err)}`) },
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
    await this.toolInvocationStore?.start({
      invocationId,
      runId: args.context.runId,
      sessionId: args.context.sessionId,
      toolCallId: args.call.id,
      toolName: args.descriptor.name,
      executionTarget: args.baseToolContext.workspace.executionTarget,
      tenantId: resolveRunTenantId(args.context),
      metadata: {
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
    priorEvents: PlatformEvent[];
  }): AsyncIterable<OutboundEvent> {
    let textStarted = false;
    let thinkingStarted = false;
    let totalUsage: ModelUsage | undefined;
    let finalText = '';
    let turn = 0;
    let thinkingOnlyContinuationUsed = false;
    const contextUsageTracker = new RuntimeContextUsageTracker(args.context.model, args.priorEvents);

    // RFC v1 P0.4：resume 路径同样接力 Responses API session state。
    let currentResponseId = await this.loadInitialResponseId(args.context.sessionId, args.context.model);

    try {
      for (turn = 1; turn <= args.maxTurns; turn++) {
        let completed: Extract<ModelEvent, { type: 'completed' }> | null = null;
        let turnContextUsage: OutboundEvent['contextUsage'] | null = null;
        let turnText = '';
        let turnThinking = '';
        // 2026-07-03 起 assistant_stream_event delta 不再落库；UI 的"思考 Xs"
        // 时长改由 assistant_thinking 聚合行的 durationMs 携带。
        let turnThinkingMs = 0;
        let thinkingSegmentStartedAt: number | undefined;

        await this.assertNoOpenToolCallBatchesBeforeModel(args.context.sessionId);
        const forceSynthesis = this.prepareForcedSynthesis(args.messages);
        for await (const event of this.modelAdapter.stream({
          model: args.context.model,
          messages: args.messages,
          tools: args.tools,
          signal: args.context.signal,
          ...(forceSynthesis ? { toolChoice: 'none' as const } : {}),
          ...(currentResponseId ? { previousResponseId: currentResponseId } : {}),
        }, args.context)) {
          if (event.type === 'thinking_delta') {
            if (!thinkingStarted) {
              thinkingStarted = true;
              thinkingSegmentStartedAt = Date.now();
              yield { type: 'thinking_start' };
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
              yield { type: 'text_start' };
            }
            turnText += event.content;
            finalText += event.content;
            yield { type: 'text_delta', content: event.content };
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

        if (!completed) throw new Error('model stream completed without completion event');
        if (completed.usage) {
          totalUsage = mergeUsage(totalUsage, completed.usage);
          turnContextUsage = contextUsageTracker.record(args.context.model, completed.usage, completed.responseChained);
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
        if (completed.responseId) {
          currentResponseId = completed.responseId;
          await this.persistResponseSessionState(args.context.runId, completed, args.context.model);
        }

        if (completed.toolCalls.length === 0) {
          if (completed.finishReason === 'length' || completed.finishReason === 'content_filter') {
            throw new Error(
              `model output truncated: finish_reason=${completed.finishReason} (可能丢失了 tool_call,不应作为正常结束)`,
            );
          }
          if (completed.content && completed.content !== turnText) {
            if (!textStarted) {
              textStarted = true;
              yield { type: 'text_start' };
            }
            finalText += completed.content;
            yield { type: 'text_delta', content: completed.content };
          }
          const assistantContent = completed.content || turnText;
          if (!assistantContent) {
            if (turnThinking && !thinkingOnlyContinuationUsed) {
              thinkingOnlyContinuationUsed = true;
              args.messages.push({ role: 'user', content: THINKING_ONLY_CONTINUATION_PROMPT });
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
            ...(textStarted ? { streamed: true } : {}),
          });
          if (textStarted) {
            yield { type: 'text_end' };
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
            yield { type: 'text_start' };
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
          ...(toolCallContentStreamed ? { streamed: true } : {}),
          toolCalls: completed.toolCalls,
        });
        if (turnContextUsage) yield { type: 'context_usage', contextUsage: turnContextUsage };
        args.messages.push({
          role: 'assistant',
          content: completed.content || turnText || null,
          tool_calls: completed.toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.arguments },
          })),
        });

        yield* this.drainToolCalls({
          calls: completed.toolCalls,
          descriptorsByName: args.descriptorsByName,
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
      const message = err instanceof Error ? err.message : String(err);
      const modelUsage = buildModelUsage(args.context.model, totalUsage);
      await this.append({
        type: 'run_finished',
        runId: args.context.runId,
        sessionId: args.context.sessionId,
        subtype: 'error',
        numTurns: turn,
        ...(modelUsage ? { modelUsage } : {}),
        error: message,
      });
      await args.context.hooks?.onResult?.({
        subtype: 'error',
        numTurns: turn,
        resultText: finalText,
        ...(modelUsage ? { modelUsage } : {}),
      });
      logger.error(`[resume] failed session=${args.context.sessionId} turns=${turn}: ${message}`);
      yield { type: 'error', error: message };
    }
  }

  private async append(event: Parameters<EventStore['append']>[0]): Promise<void> {
    const stored = await this.eventStore.append(event);
    await this.transcriptProjection.project(stored);
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

/**
 * 并行窗准入判定（子 agent P1）：只有名为 Agent 且 risk:'safe'、免审批的工具才可并行。
 * 三重条件而非只看名字——防未来有人注册同名高危工具时静默进入并行路径。
 */
function isParallelSafeAgentCall(
  call: ModelToolCall,
  descriptorsByName: Map<string, ToolDescriptor>,
): boolean {
  const descriptor = descriptorsByName.get(call.name);
  return !!descriptor
    && descriptor.name === 'Agent'
    && descriptor.risk === 'safe'
    && descriptor.approvalMode === 'never';
}

function toOutboundInteractionEvent(event: InteractionEvent): OutboundEvent {
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

function toModelToolDefinition(descriptor: ToolDescriptor) {
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
  };
}

function parseToolArguments(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    return { __raw: raw, __parseError: err instanceof Error ? err.message : String(err) };
  }
}

function formatAskUserQuestionResult(response: InteractionResponse): string {
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

function formatMemoryContext(memoryContext: string): string {
  return `<memory-context>\n[长期记忆]\n${memoryContext}\n</memory-context>`;
}

function mergeUsage(a: ModelUsage | undefined, b: ModelUsage): ModelUsage {
  return {
    inputTokens: (a?.inputTokens ?? 0) + (b.inputTokens ?? 0),
    outputTokens: (a?.outputTokens ?? 0) + (b.outputTokens ?? 0),
    cacheReadInputTokens: (a?.cacheReadInputTokens ?? 0) + (b.cacheReadInputTokens ?? 0),
    cacheCreationInputTokens: (a?.cacheCreationInputTokens ?? 0) + (b.cacheCreationInputTokens ?? 0),
    apiRequestCount: (a?.apiRequestCount ?? 0) + (b.apiRequestCount ?? 1),
  };
}

function buildModelUsage(model: string, usage: ModelUsage | undefined) {
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


const DEFAULT_ZOMBIE_TOOL_CALL_TIMEOUT_MS = 600_000;

/**
 * 优先级：constructor option > env > 默认 600s。仅接受 >=0 的有限数字，否则回退默认。
 * 06-24 引入：与 describeBlockingToolCall 的 zombie 判定配合，应对 SIGKILL 残留。
 */
function resolveZombieToolCallTimeoutMs(optionValue?: number): number {
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

function classifyHandFailure(message: string): 'auth' | 'timeout' | 'network' | 'unhealthy' | 'unknown' {
  const lower = message.toLowerCase();
  if (lower.includes('鉴权') || lower.includes('unauthorized') || lower.includes('forbidden') || lower.includes('401') || lower.includes('403')) return 'auth';
  if (lower.includes('超时') || lower.includes('timeout') || lower.includes('timed out')) return 'timeout';
  if (lower.includes('fetch') || lower.includes('econn') || lower.includes('network') || lower.includes('http')) return 'network';
  if (lower.includes('health') || lower.includes('unhealthy')) return 'unhealthy';
  return 'unknown';
}
