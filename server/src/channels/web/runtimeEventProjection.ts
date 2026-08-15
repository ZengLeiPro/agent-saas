import { isDedicatedWebTool } from './displayFilter.js';
import type { PlatformEvent } from '../../runtime/types.js';

interface RuntimeStreamBlockProjectionState {
  seen: boolean;
  open: boolean;
  /** 实际收到的 durable stream batch 拼接结果。 */
  content: string;
  /** 已投影给客户端的内容；终态补差可能暂时领先于 content。 */
  projectedContent: string;
  draftId?: string;
}

export interface RuntimeStreamProjectionState {
  text: RuntimeStreamBlockProjectionState;
  thinking: RuntimeStreamBlockProjectionState;
}

function createRuntimeStreamProjectionState(): RuntimeStreamProjectionState {
  return {
    text: { seen: false, open: false, content: '', projectedContent: '' },
    thinking: { seen: false, open: false, content: '', projectedContent: '' },
  };
}

function getOrCreateRuntimeStreamProjectionState(
  states: Map<string, RuntimeStreamProjectionState> | undefined,
  runId: string,
): RuntimeStreamProjectionState | undefined {
  if (!states) return undefined;
  const current = states.get(runId);
  if (current) return current;
  const created = createRuntimeStreamProjectionState();
  states.set(runId, created);
  return created;
}

function projectCompleteRuntimeBlock(
  blockType: 'thinking' | 'text',
  content: string,
  runId?: string,
): object[] {
  return [
    { type: 'block_start', blockType, ...(runId ? { runId } : {}) },
    { type: blockType === 'text' ? 'text' : 'thinking', content },
    { type: 'block_end', blockType },
  ];
}

function reconcileRuntimeStreamAggregate(
  blockType: 'thinking' | 'text',
  content: string,
  state: RuntimeStreamBlockProjectionState,
  runId?: string,
): object[] {
  const deltaType = blockType === 'text' ? 'text' : 'thinking';
  if (content.startsWith(state.content) && content.startsWith(state.projectedContent)) {
    const suffix = content.slice(state.projectedContent.length);
    state.projectedContent = content;
    if (!suffix) return [];
    return state.open
      ? [{ type: deltaType, content: suffix }]
      : projectCompleteRuntimeBlock(blockType, suffix, runId);
  }

  const events: object[] = [];
  if (state.draftId) {
    events.push({ type: 'draft_reset', draftId: state.draftId });
  }
  if (state.open) {
    events.push(
      { type: 'block_start', blockType, ...(runId ? { runId } : {}), ...(state.draftId ? { draftId: state.draftId } : {}) },
      { type: deltaType, content },
    );
  } else {
    events.push(...projectCompleteRuntimeBlock(blockType, content, runId));
  }
  state.projectedContent = content;
  return events;
}

export function projectRuntimePlatformEvent(
  event: PlatformEvent,
  options: {
    clientMsgId?: string;
    /**
     * true = 展开 streamed 聚合行（assistant_thinking/message/tool_calls 的正文）。
     * 没有 durable stream batch 的旧数据整块展开；有 batch 时用 streamStates
     * 对完整聚合行做前缀补差，兼顾 live、断线回放与中继尾段丢失兜底。
     */
    expandStreamed?: boolean;
    streamStates?: Map<string, RuntimeStreamProjectionState>;
  } = {},
): { events: object[]; terminal?: boolean; sessionStatus?: 'completed' | 'failed' | 'cancelled'; terminalError?: string } {
  const streamState = 'runId' in event && event.runId
    ? options.streamStates?.get(event.runId)
    : undefined;
  switch (event.type) {
    case 'tool_output_delta':
      return {
        events: [{
          type: 'tool_execution',
          phase: 'progress',
          toolId: event.toolCallId,
          content: event.content,
          channel: event.channel,
          invocationId: event.invocationId,
        }],
      };
    case 'tool_progress':
      return {
        events: [{
          type: 'tool_execution',
          phase: 'progress',
          toolId: event.toolCallId,
          content: event.content,
          invocationId: event.invocationId,
        }],
      };
    case 'user_message':
      // 队列消息在真正取得执行权时才进入时间线。带 clientMsgId 的普通 queue 与带
      // interjectionSourceRunId 的显式插话都必须投影；客户端按 clientMsgId 幂等去重。
      if (!event.clientMsgId && !event.interjectionSourceRunId) return { events: [] };
      return {
        events: [{
          type: 'user_message',
          sessionId: event.sessionId,
          content: event.content,
          ...(event.attachments?.length ? {
            attachments: event.attachments.map((attachment) => ({
              name: attachment.originalName,
              isImage: attachment.isImage,
              relativePath: attachment.relativePath,
            })),
          } : {}),
          timestamp: Date.parse(event.timestamp) || Date.now(),
          sourceRunId: event.interjectionSourceRunId,
          ...(event.clientMsgId ? { client_msg_id: event.clientMsgId } : {}),
        }],
      };
    case 'interjection_applied':
      // 跨进程「插话已吸收」通知（2026-08-04 BUG-2 修复）：前端据此清队列区/outbox。
      return {
        events: [{
          type: 'interjection_applied',
          sessionId: event.sessionId,
          sourceRunIds: event.sourceRunIds,
          clientMsgIds: event.clientMsgIds,
        }],
      };
    case 'tool_invocation_started':
      // 拥有独立卡片的工具由 ask_user / permission_request / subagent 侧通道驱动，
      // 不该再走通用 tool_execution 通道，否则前端会叠加第二条工具骨架。
      // live 通道 onToolStart 已用 shouldSendWebBlock 过滤,这里补上 replay/
      // durable/跨进程 NOTIFY 路径的兜底,与 displayFilter.ts 语义对齐。
      if (isDedicatedWebTool(event.toolName)) return { events: [] };
      return {
        events: [{
          type: 'tool_execution',
          phase: 'started',
          toolId: event.toolCallId,
          toolName: event.toolName,
          invocationId: event.invocationId,
        }],
      };
    case 'tool_invocation_completed':
      if (isDedicatedWebTool(event.toolName)) return { events: [] };
      return {
        events: [{
          type: 'tool_execution',
          phase: 'completed',
          toolId: event.toolCallId,
          toolName: event.toolName,
          invocationId: event.invocationId,
          status: event.status,
          durationMs: event.durationMs,
          ...(event.error ? { error: event.error } : {}),
        }],
      };
    case 'tool_result': {
      if (isDedicatedWebTool(event.toolName)) return { events: [] };
      const events: object[] = [{
        type: 'tool_result',
        toolId: event.toolCallId,
        toolName: event.toolName,
        content: event.content,
        result: event.content,
        isError: event.isError,
        // durable replay 与 live 路径同规则：重连/接管的观看者同样即时拿到摘要与执行事实
        ...(event.presentation ? { presentation: event.presentation } : {}),
        ...(event.metadata ? { metadata: event.metadata } : {}),
      }];
      return { events };
    }
    case 'approval_requested':
      return {
        events: [{
          type: 'permission_request',
          interactionId: event.approvalId,
          toolId: event.toolId,
          toolName: event.toolName,
          displayName: event.displayName,
          toolInput: event.input && typeof event.input === 'object'
            ? event.input as Record<string, unknown>
            : { value: event.input },
        }],
      };
    case 'assistant_stream_event': {
      if (event.phase === 'reset') {
        const state = getOrCreateRuntimeStreamProjectionState(options.streamStates, event.runId);
        if (state) {
          state.text = { seen: false, open: false, content: '', projectedContent: '' };
          state.thinking = { seen: false, open: false, content: '', projectedContent: '' };
        }
        return event.draftId
          ? { events: [{ type: 'draft_reset', draftId: event.draftId, ...(event.attempt !== undefined ? { attempt: event.attempt } : {}) }] }
          : { events: [] };
      }
      if (event.phase === 'commit') {
        return event.draftId
          ? { events: [{ type: 'draft_commit', draftId: event.draftId }] }
          : { events: [] };
      }
      if (!event.blockType) return { events: [] };
      const state = getOrCreateRuntimeStreamProjectionState(options.streamStates, event.runId);
      const block = state?.[event.blockType];
      if (event.phase === 'start') {
        if (block) {
          block.seen = true;
          block.open = true;
          block.content = '';
          block.projectedContent = '';
          if (event.draftId) block.draftId = event.draftId;
          else delete block.draftId;
        }
        return {
          events: [{
            type: 'block_start',
            blockType: event.blockType,
            ...(event.draftId ? { draftId: event.draftId } : {}),
          }],
        };
      }
      if (event.phase === 'delta') {
        const content = event.content ?? '';
        if (!content) return { events: [] };
        const events: object[] = [];
        if (block && !block.seen) {
          block.seen = true;
          block.open = true;
          events.push({ type: 'block_start', blockType: event.blockType });
        }
        if (!block) {
          events.push({ type: event.blockType === 'text' ? 'text' : 'thinking', content });
          return { events };
        }
        block.content += content;
        // assistant_message 可能先于 text_end relay 入库：终态补出的尾段会让
        // projectedContent 暂时领先。迟到的 batch 若仍是其前缀，必须静默去重。
        if (block.projectedContent.startsWith(block.content)) return { events };
        const projectedDelta = block.content.startsWith(block.projectedContent)
          ? block.content.slice(block.projectedContent.length)
          : content;
        block.projectedContent = block.content.startsWith(block.projectedContent)
          ? block.content
          : block.projectedContent + content;
        if (projectedDelta) {
          events.push({ type: event.blockType === 'text' ? 'text' : 'thinking', content: projectedDelta });
        }
        return { events };
      }
      if (block) block.open = false;
      return { events: [{ type: 'block_end', blockType: event.blockType }] };
    }
    case 'assistant_thinking':
      if (event.streamed && !options.expandStreamed) return { events: [] };
      if (!event.content) return { events: [] };
      return event.streamed && streamState?.thinking.seen
        ? { events: reconcileRuntimeStreamAggregate('thinking', event.content, streamState.thinking) }
        : { events: projectCompleteRuntimeBlock('thinking', event.content) };
    case 'assistant_message':
      if (event.streamed && !options.expandStreamed) return { events: [] };
      if (!event.content) return { events: [] };
      return event.streamed && streamState?.text.seen
        ? { events: reconcileRuntimeStreamAggregate('text', event.content, streamState.text, event.runId) }
        : { events: projectCompleteRuntimeBlock('text', event.content, event.runId) };
    case 'assistant_tool_calls': {
      const events: object[] = [];
      if (event.content && (!event.streamed || options.expandStreamed)) {
        events.push(...(
          event.streamed && streamState?.text.seen
            ? reconcileRuntimeStreamAggregate('text', event.content, streamState.text, event.runId)
            : projectCompleteRuntimeBlock('text', event.content, event.runId)
        ));
      }
      for (const call of event.toolCalls) {
        // 拥有独立卡片的工具不产生通用 tool_use 骨架，避免双条并存。
        if (isDedicatedWebTool(call.name)) continue;
        events.push(
          { type: 'block_start', blockType: 'tool_use', toolId: call.id, toolName: call.name },
          { type: 'tool_input', toolId: call.id, toolName: call.name, content: call.arguments },
          { type: 'block_end', blockType: 'tool_use', toolName: call.name },
        );
      }
      return { events };
    }
    case 'subagent_started':
      // 子 agent 工具（2026-07-06）：live 与 replay 共用本投影（durable 事件是
      // SubagentBlock 唯一数据源，无同进程直推路径需要防重）。agentType 字段
      // 填 description——前端 SubagentBlock 直接渲染该字段，任务概述比裸类型名
      // （general/explore）对用户友好；toolId 用父 run 的 Agent 工具 callId 锚定。
      return {
        events: [{
          type: 'subagent_start',
          toolId: event.toolCallId,
          agentType: event.description || event.agentType,
          childSessionId: event.childSessionId,
          childRunId: event.childRunId,
          model: event.model,
        }],
      };
    case 'subagent_finished':
      return {
        events: [{
          type: 'subagent_end',
          toolId: event.toolCallId,
          agentType: event.description || event.agentType,
          status: event.status,
          childSessionId: event.childSessionId,
          childRunId: event.childRunId,
          model: event.model,
          durationMs: event.durationMs,
          totalTokens: event.totalTokens,
          toolUseCount: event.toolUseCount,
          turnCount: event.turnCount,
          errorMessage: event.errorMessage,
          resultPreview: event.resultPreview,
        }],
      };
    case 'compaction':
      // /compact v2：durable replay / 跨进程 NOTIFY 路径把压缩点投影为分界线状态事件
      // （同进程直推路径由 handleRuntimeOutboundEvent 的 compaction_end case 覆盖）
      return {
        events: [{
          type: 'compaction_status',
          phase: 'completed',
          compaction: { summary: event.summary, coveredEventCount: event.coveredEventCount },
        }],
      };
    case 'run_state_changed':
      if (event.status === 'completed' || event.status === 'failed' || event.status === 'cancelled') {
        // cancelled 是用户主动停止等正常终态，不得投影为 done.error。
        // 否则客户端会把本轮用户消息标记为发送失败，并显示红色错误卡。
        const terminalError = event.status === 'failed' ? event.reason ?? event.status : undefined;
        return {
          events: [
            {
              type: 'session_status',
              sessionId: event.sessionId,
              status: event.status,
              runId: event.runId,
              ...(event.reason ? { reason: event.reason } : {}),
            },
            {
              type: 'done',
              sessionId: event.sessionId,
              runId: event.runId,
              ...(options.clientMsgId ? { client_msg_id: options.clientMsgId } : {}),
              ...(event.status === 'completed' ? { finalOutput: true } : {}),
              ...(terminalError ? { error: terminalError } : {}),
            },
          ],
          terminal: true,
          sessionStatus: event.status,
          ...(terminalError ? { terminalError } : {}),
        };
      }
      // 非终态：PR #26 的核心增强 —— 把 running/queued/waiting_* 等 lifecycle
      // 早早推给前端,让 active 状态判定不再只能等 idle/busy 粗粒度信号。
      return {
        events: [{
          type: 'session_status',
          sessionId: event.sessionId,
          status: event.status,
          runId: event.runId,
          ...(event.reason ? { reason: event.reason } : {}),
        }],
      };
    case 'run_finished': {
      // 双保险 fallback：正常路径下 RunStoreBackedEventStore.afterAppend 会派生
      // run_state_changed{failed,reason},由上面的 case 投影 done.error/session_status.failed。
      // 这里直接识别 run_finished{subtype:'error'} 是为防 runStore 链路缺失/异常时,
      // 失败信号仍能到前端。publishRuntimePlatformEvent 用 runId 做 terminal 跨事件去重,
      // 避免与 run_state_changed 双触发。
      // success / interrupted 由 run_state_changed 处理,这里 noop。
      if (event.subtype === 'error') {
        const terminalError = event.error ?? 'error';
        return {
          events: [{
            type: 'done',
            sessionId: event.sessionId,
            runId: event.runId,
            ...(options.clientMsgId ? { client_msg_id: options.clientMsgId } : {}),
            error: terminalError,
          }],
          terminal: true,
          sessionStatus: 'failed',
          terminalError,
        };
      }
      return { events: [] };
    }
    default:
      return { events: [] };
  }
}

export function isDurableCursorAtOrBefore(cursor: string, target: string): boolean {
  try {
    return BigInt(cursor) <= BigInt(target);
  } catch {
    return cursor === target;
  }
}

export function getDurableEventCursor(event: PlatformEvent): string | undefined {
  const sequence = (event as PlatformEvent & { sequence?: unknown }).sequence;
  if (typeof sequence === 'number' && Number.isFinite(sequence)) return String(sequence);
  if (typeof sequence === 'string' && sequence.trim()) return sequence;
  return event.id;
}
