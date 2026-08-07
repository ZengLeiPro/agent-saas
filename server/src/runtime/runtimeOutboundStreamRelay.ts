import type { OutboundEvent } from '../types/index.js';
import type { EventStore, PlatformEventInput } from './types.js';

type StreamDeltaType = 'thinking_delta' | 'text_delta';

interface RelayRunContext {
  runId: string;
  sessionId: string;
  tenantId?: string;
}

interface RelayState extends RelayRunContext {
  pendingType?: StreamDeltaType;
  pendingContent: string;
  timer?: ReturnType<typeof setTimeout>;
  appendChain: Promise<void>;
}

interface RelayLogger {
  warn(message: string): void;
}

const DEFAULT_FLUSH_INTERVAL_MS = 100;
const DEFAULT_MAX_BATCH_CHARS = 256;

/**
 * 把 Runtime Worker 进程内的正文/思考 OutboundEvent 转成有界批次的 durable stream event。
 *
 * PG EventStore 的 NOTIFY/cursor 负责跨进程 live delivery 与断线补拉；最终
 * assistant_message/assistant_thinking 仍是完整事实，用于中继失败时的终态补差。
 */
export class RuntimeOutboundStreamRelay {
  private readonly states = new Map<string, RelayState>();

  constructor(
    private readonly eventStore: EventStore,
    private readonly options: {
      flushIntervalMs?: number;
      maxBatchChars?: number;
      logger?: RelayLogger;
    } = {},
  ) {}

  async publish(event: OutboundEvent, context: RelayRunContext): Promise<void> {
    if (!isStreamRelayEvent(event)) return;
    const state = this.getState(context);

    if (event.type === 'thinking_delta' || event.type === 'text_delta') {
      const content = event.content ?? '';
      if (!content) return;
      if (state.pendingType && state.pendingType !== event.type) {
        await this.flushState(state);
      }
      state.pendingType = event.type;
      state.pendingContent += content;
      if (state.pendingContent.length >= (this.options.maxBatchChars ?? DEFAULT_MAX_BATCH_CHARS)) {
        await this.flushState(state);
      } else {
        this.scheduleFlush(state);
      }
      return;
    }

    await this.flushState(state);
    const platformEvent = toPlatformStreamEvent(event, context);
    if (platformEvent) await this.enqueueAppend(state, platformEvent);

    if (event.type === 'done' || event.type === 'error') {
      if (state.timer) clearTimeout(state.timer);
      this.states.delete(context.runId);
    }
  }

  async flushAll(): Promise<void> {
    const states = [...this.states.values()];
    await Promise.all(states.map(async (state) => {
      await this.flushState(state);
      await state.appendChain;
      if (state.timer) clearTimeout(state.timer);
      this.states.delete(state.runId);
    }));
  }

  private getState(context: RelayRunContext): RelayState {
    const current = this.states.get(context.runId);
    if (current) return current;
    const created: RelayState = {
      ...context,
      pendingContent: '',
      appendChain: Promise.resolve(),
    };
    this.states.set(context.runId, created);
    return created;
  }

  private scheduleFlush(state: RelayState): void {
    if (state.timer) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void this.flushState(state);
    }, this.options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);
    state.timer.unref?.();
  }

  private async flushState(state: RelayState): Promise<void> {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    const type = state.pendingType;
    const content = state.pendingContent;
    state.pendingType = undefined;
    state.pendingContent = '';
    if (!type || !content) return;
    await this.enqueueAppend(state, {
      type: 'assistant_stream_event',
      runId: state.runId,
      sessionId: state.sessionId,
      blockType: type === 'text_delta' ? 'text' : 'thinking',
      phase: 'delta',
      content,
    });
  }

  private async enqueueAppend(state: RelayState, event: PlatformEventInput): Promise<void> {
    const append = state.appendChain.then(async () => {
      await this.eventStore.append(event, state.tenantId ? { tenantId: state.tenantId } : undefined);
    });
    state.appendChain = append.catch((error) => {
      this.options.logger?.warn(
        `Runtime outbound stream relay append failed: run=${state.runId} type=${event.type} error=${error instanceof Error ? error.message : String(error)}`,
      );
    });
    await state.appendChain;
  }
}

function isStreamRelayEvent(event: OutboundEvent): boolean {
  return event.type === 'thinking_start'
    || event.type === 'thinking_delta'
    || event.type === 'thinking_end'
    || event.type === 'text_start'
    || event.type === 'text_delta'
    || event.type === 'text_end'
    || event.type === 'draft_reset'
    || event.type === 'draft_commit'
    || event.type === 'done'
    || event.type === 'error';
}

function toPlatformStreamEvent(
  event: OutboundEvent,
  context: RelayRunContext,
): PlatformEventInput | undefined {
  const base = { runId: context.runId, sessionId: context.sessionId };
  switch (event.type) {
    case 'thinking_start':
      return { ...base, type: 'assistant_stream_event', blockType: 'thinking', phase: 'start', ...(event.draftId ? { draftId: event.draftId } : {}) };
    case 'thinking_end':
      return { ...base, type: 'assistant_stream_event', blockType: 'thinking', phase: 'end' };
    case 'text_start':
      return { ...base, type: 'assistant_stream_event', blockType: 'text', phase: 'start', ...(event.draftId ? { draftId: event.draftId } : {}) };
    case 'text_end':
      return { ...base, type: 'assistant_stream_event', blockType: 'text', phase: 'end' };
    case 'draft_reset':
      return event.draftId
        ? { ...base, type: 'assistant_stream_event', phase: 'reset', draftId: event.draftId, ...(event.attempt !== undefined ? { attempt: event.attempt } : {}) }
        : undefined;
    case 'draft_commit':
      return event.draftId
        ? { ...base, type: 'assistant_stream_event', phase: 'commit', draftId: event.draftId }
        : undefined;
    default:
      return undefined;
  }
}
