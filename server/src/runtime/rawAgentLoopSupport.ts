import { getModelContextWindow } from '../data/usage/pricing.js';
import { estimateContextTokens } from './contextBreakdown.js';
import {
  buildBoundedInitialCompactionMessages,
  planContinuousCheckpointInput,
  type ContextCheckpointPlan,
} from './contextCheckpoint.js';
import { buildContextProjection, type ContextReconstructionPolicy } from './contextProjection.js';
import type { ToolInvocationStreamChunk } from './handProtocol.js';
import type {
  EventStore,
  ModelChatMessage,
  ModelUsage,
  PlatformEvent,
  PlatformEventInput,
} from './types.js';

export interface ReplaceableDraftRunState {
  draftId: string;
  recoveryUsed: boolean;
  startedAt: string;
}

export function parseReplaceableDraftRunState(value: unknown): ReplaceableDraftRunState | null {
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

export function resolveInvokedSkillName(toolId: string, input: unknown): string | undefined {
  if (toolId !== 'Skill' || !input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const skill = (input as Record<string, unknown>).skill;
  return typeof skill === 'string' && skill.trim() ? skill.trim() : undefined;
}

export interface ContextPressureState {
  reason: 'context_governor';
  detectedAt: string;
  triggerTokens: number;
  thresholdTokens: number;
  droppedMessages: number;
}

export interface CompactionOutcome {
  status: 'compacted' | 'skipped' | 'aborted' | 'error';
  numTurns: number;
  resultText: string;
  usage?: ModelUsage;
  error?: string;
}

export interface CompactionOptions {
  inline: boolean;
  trigger: 'manual' | 'threshold';
  sourceRunId?: string;
  controlSourceRunIds?: string[];
  baseFixedTokens?: number;
}

export function prepareCompactionInputMessages(input: {
  compressedEvents: PlatformEvent[];
  plan: ContextCheckpointPlan;
  contextWindow: number;
  fixedRequestTokens: number;
  sessionId: string;
  runId: string;
  policy?: ContextReconstructionPolicy;
}): { messages: ModelChatMessage[]; projectedMessageCount: number } {
  const hasPriorCheckpoint = input.compressedEvents.some((event) => event.type === 'compaction');
  const sourceInputBudget = Math.max(
    0,
    input.contextWindow - input.fixedRequestTokens - input.plan.summaryBudgetTokens - 1_024,
  );
  const continuousInput = planContinuousCheckpointInput(
    input.compressedEvents,
    Math.max(0, sourceInputBudget - (hasPriorCheckpoint ? input.plan.userHistoryTokenCap : 0)),
  );
  const projection = buildContextProjection(input.compressedEvents, {
    sessionId: input.sessionId,
    runId: input.runId,
    policy: input.policy,
    excludeMemoryContext: true,
    checkpointUserHistoryTokenCap: input.plan.userHistoryTokenCap,
    checkpointSummaryTokenCap: continuousInput.summaryTokenCap,
    checkpointRetainedStartIndex: continuousInput.retainedStartIndex,
    collapseCheckpointRawTail: true,
  });
  return {
    messages: !hasPriorCheckpoint && estimateContextTokens(projection.messages) > sourceInputBudget
      ? buildBoundedInitialCompactionMessages(projection.selectedEvents, sourceInputBudget)
      : projection.messages,
    projectedMessageCount: projection.messages.length,
  };
}

const CONTEXT_EMERGENCY_THRESHOLD_RATIO = 0.95;

export function isEmergencyContextPressure(
  triggerTokens: number,
  model: string,
  modelRef?: string,
): boolean {
  const contextWindow = getModelContextWindow(model, modelRef);
  return !contextWindow || triggerTokens >= Math.floor(contextWindow * CONTEXT_EMERGENCY_THRESHOLD_RATIO);
}

export function parseContextPressureState(value: unknown): ContextPressureState | null {
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

/** 防止压缩失败后裸 /compact 被当成普通聊天消息。 */
export const COMPACT_COMMAND_MODEL_CONTENT = '[系统命令] 用户请求压缩会话上下文（/compact）。这是平台指令，无需回应此消息本身。';

export const THINKING_ONLY_CONTINUATION_PROMPT = [
  'Your previous assistant turn produced hidden reasoning only, with no user-visible content and no tool call.',
  'Continue now from that reasoning. You must either call the next appropriate tool or provide the final user-visible answer.',
  'Do not repeat hidden reasoning.',
].join('\n');

/** 压缩段投影后少于这个消息数不值得手动压缩。 */
export const MIN_COMPACTABLE_MESSAGES = 4;

export function findLastUserMessageIndex(messages: ModelChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return i;
  }
  return -1;
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
    private readonly tenantId: string,
  ) {}

  async push(event: PlatformEventInput): Promise<void> {
    this.buffer.push(event);
    this.bufferedBytes += 'content' in event && typeof event.content === 'string'
      ? Buffer.byteLength(event.content, 'utf8')
      : 0;
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
      if (!this.tenantId) throw new Error('StreamEventBatcher tenant context is missing');
      const ctx = { tenantId: this.tenantId };
      if (this.eventStore.appendBatch) {
        await this.eventStore.appendBatch(events, ctx);
      } else {
        for (const event of events) await this.eventStore.append(event, ctx);
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

  observe(chunk: ToolInvocationStreamChunk): void {
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
