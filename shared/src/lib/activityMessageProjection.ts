import type { MessageItem, MessageAttachmentDisplay, SubagentStatus } from '../types/message';
import type { ToolPresentation } from './toolPresentation';
import type { ToolResultMetadata } from './toolResultMetadata';

export type ProjectionDomain = 'message' | 'tool' | 'subagent' | 'moderation';
export type ProjectionActivityStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout';
export type ModerationOutcome = 'allowed' | 'blocked' | 'flagged';

interface ProjectionEventBase {
  eventId: string;
  domain: ProjectionDomain;
  runId: string;
  sequence?: number;
}

export type ActivityMessageProjectionEvent =
  | (ProjectionEventBase & {
      domain: 'message'; kind: 'user_message'; messageId: string; content: string;
      timestamp?: number; clientMsgId?: string; attachments?: MessageAttachmentDisplay[];
    })
  | (ProjectionEventBase & {
      domain: 'message'; kind: 'assistant_block_start';
      messageId: string; blockId: string; blockType: 'text' | 'thinking'; draftId?: string;
    })
  | (ProjectionEventBase & {
      domain: 'message'; kind: 'assistant_block_end';
      messageId: string; blockId: string; blockType: 'text' | 'thinking';
    })
  | (ProjectionEventBase & {
      domain: 'message'; kind: 'assistant_block_delta'; messageId: string; blockId: string;
      blockType: 'text' | 'thinking'; delta: string; guardrailEventId?: string;
    })
  | (ProjectionEventBase & {
      domain: 'message'; kind: 'assistant_block_snapshot'; messageId: string; blockId: string;
      blockType: 'text' | 'thinking'; content: string; status: 'running' | 'completed';
      draftId?: string; guardrailEventId?: string; timestamp?: number;
    })
  | (ProjectionEventBase & {
      domain: 'tool'; kind: 'tool_activity'; messageId: string; blockId: string; toolCallId: string;
      toolName: string; status: Exclude<ProjectionActivityStatus, 'timeout'>; toolInput?: string;
      result?: string; resultReady?: boolean; invocationId?: string; durationMs?: number;
      error?: string; presentation?: ToolPresentation; toolMetadata?: ToolResultMetadata;
    })
  | (ProjectionEventBase & {
      domain: 'subagent'; kind: 'subagent_activity'; messageId: string; blockId: string;
      toolCallId: string; subagentId: string; agentType: string; status: ProjectionActivityStatus;
      childSessionId?: string; childRunId?: string; model?: string; durationMs?: number;
      totalTokens?: number; toolUseCount?: number; turnCount?: number; errorMessage?: string;
      resultPreview?: string;
    })
  | (ProjectionEventBase & {
      domain: 'moderation'; kind: 'moderation_outcome'; outcome: ModerationOutcome;
      moderationId: string; messageId: string; blockId?: string; reasonCode?: string;
    })
  | (ProjectionEventBase & {
      domain: 'message'; kind: 'snapshot'; snapshotId: string; mode: 'partial' | 'full';
      messageId?: string; events: Exclude<ActivityMessageProjectionEvent, { kind: 'snapshot' }>[];
    });

interface UserProjection { eventId: string; messageId: string; runId: string; content: string; timestamp?: number; clientMsgId?: string; attachments?: MessageAttachmentDisplay[] }
interface AssistantBlockProjection { eventId: string; messageId: string; runId: string; blockId: string; blockType: 'text' | 'thinking'; content: string; status: 'running' | 'completed'; draftId?: string; guardrailEventId?: string; timestamp?: number; baseContent?: string; deltas?: Readonly<Record<string, { delta: string; sequence?: number }>> }
interface ToolProjection extends Omit<Extract<ActivityMessageProjectionEvent, { kind: 'tool_activity' }>, 'kind' | 'domain'> {}
interface SubagentProjection extends Omit<Extract<ActivityMessageProjectionEvent, { kind: 'subagent_activity' }>, 'kind' | 'domain'> {}
export interface ModerationProjection { eventId: string; moderationId: string; runId: string; messageId: string; blockId?: string; outcome: ModerationOutcome; reasonCode?: string }

export interface ActivityMessageProjectionState {
  seenEventIds: ReadonlySet<string>;
  order: readonly string[];
  users: Readonly<Record<string, UserProjection>>;
  assistantBlocks: Readonly<Record<string, AssistantBlockProjection>>;
  tools: Readonly<Record<string, ToolProjection>>;
  subagents: Readonly<Record<string, SubagentProjection>>;
  moderation: Readonly<Record<string, ModerationProjection>>;
}

export function createActivityMessageProjectionState(): ActivityMessageProjectionState {
  return { seenEventIds: new Set(), order: [], users: {}, assistantBlocks: {}, tools: {}, subagents: {}, moderation: {} };
}

const identity = {
  user: (runId: string, messageId: string) => `user:${runId}:${messageId}`,
  block: (runId: string, blockId: string) => `block:${runId}:${blockId}`,
  tool: (runId: string, toolCallId: string) => `tool:${runId}:${toolCallId}`,
  subagent: (runId: string, subagentId: string) => `subagent:${runId}:${subagentId}`,
};

const terminal = (status: ProjectionActivityStatus) => status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'timeout';
const mergeStatus = <T extends ProjectionActivityStatus>(current: T | undefined, incoming: T): T => current && terminal(current) && !terminal(incoming) ? current : incoming;

function appendOrder(order: readonly string[], key: string): readonly string[] { return order.includes(key) ? order : [...order, key]; }

export function reduceActivityMessageProjection(
  state: ActivityMessageProjectionState,
  event: ActivityMessageProjectionEvent,
): ActivityMessageProjectionState {
  if (!event.eventId || state.seenEventIds.has(event.eventId)) return state;
  let next: ActivityMessageProjectionState = { ...state, seenEventIds: new Set([...state.seenEventIds, event.eventId]) };
  if (event.kind === 'snapshot') {
    let snapshotAnchorIndex: number | undefined;
    // Full snapshots are authoritative only for the explicitly named message. An unscoped
    // sparse legacy snapshot is deliberately treated as partial (fail closed: never erase).
    if (event.mode === 'full' && event.messageId) {
      snapshotAnchorIndex = next.order.findIndex((key) => {
        const value = next.users[key] ?? next.assistantBlocks[key] ?? next.tools[key] ?? next.subagents[key];
        return value?.messageId === event.messageId;
      });
      if (snapshotAnchorIndex < 0) snapshotAnchorIndex = undefined;
      const keep = (value: { messageId: string }) => value.messageId !== event.messageId;
      const replayableSeen = new Set(next.seenEventIds);
      for (const item of event.events) replayableSeen.delete(item.eventId);
      next = {
        ...next,
        seenEventIds: replayableSeen,
        users: Object.fromEntries(Object.entries(next.users).filter(([, value]) => keep(value))),
        assistantBlocks: Object.fromEntries(Object.entries(next.assistantBlocks).filter(([, value]) => keep(value))),
        tools: Object.fromEntries(Object.entries(next.tools).filter(([, value]) => keep(value))),
        subagents: Object.fromEntries(Object.entries(next.subagents).filter(([, value]) => keep(value))),
        order: next.order.filter((key) => {
          const value = next.users[key] ?? next.assistantBlocks[key] ?? next.tools[key] ?? next.subagents[key];
          return !value || value.messageId !== event.messageId;
        }),
      };
    }
    const reduced = event.events.reduce(reduceActivityMessageProjection, next);
    if (snapshotAnchorIndex === undefined || !event.messageId) return reduced;
    const targetKeys = reduced.order.filter((key) => {
      const value = reduced.users[key] ?? reduced.assistantBlocks[key] ?? reduced.tools[key] ?? reduced.subagents[key];
      return value?.messageId === event.messageId;
    });
    if (targetKeys.length === 0) return reduced;
    const targetSet = new Set(targetKeys);
    const stableOrder = reduced.order.filter((key) => !targetSet.has(key));
    stableOrder.splice(Math.min(snapshotAnchorIndex, stableOrder.length), 0, ...targetKeys);
    return { ...reduced, order: stableOrder };
  }
  if (event.kind === 'user_message') {
    const key = identity.user(event.runId, event.messageId);
    const current = next.users[key];
    return { ...next, order: appendOrder(next.order, key), users: { ...next.users, [key]: { ...current, ...event } } };
  }
  if (event.kind === 'assistant_block_start' || event.kind === 'assistant_block_end' || event.kind === 'assistant_block_delta' || event.kind === 'assistant_block_snapshot') {
    const key = identity.block(event.runId, event.blockId);
    const current = next.assistantBlocks[key];
    if (event.kind === 'assistant_block_delta') {
      if (!current) return next; // Delta must never drift to a neighbouring positional block.
      const deltas = {
        ...(current.deltas ?? {}),
        [event.eventId]: { delta: event.delta, ...(event.sequence !== undefined ? { sequence: event.sequence } : {}) },
      };
      const entries = Object.entries(deltas);
      const hasSequence = entries.some(([, value]) => value.sequence !== undefined);
      if (hasSequence) {
        entries.sort(([leftId, left], [rightId, right]) =>
          (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER)
          || leftId.localeCompare(rightId));
      }
      const baseContent = current.baseContent ?? current.content;
      const updated = { ...current, baseContent, deltas, content: baseContent + entries.map(([, value]) => value.delta).join(''), ...(event.guardrailEventId ? { guardrailEventId: event.guardrailEventId } : {}) };
      return { ...next, assistantBlocks: { ...next.assistantBlocks, [key]: updated } };
    }
    if (event.kind === 'assistant_block_start') {
      if (current?.status === 'completed') return next;
      const value: AssistantBlockProjection = { eventId: event.eventId, messageId: event.messageId, runId: event.runId, blockId: event.blockId, blockType: event.blockType, content: current?.content ?? '', baseContent: current?.baseContent ?? current?.content ?? '', deltas: current?.deltas ?? {}, status: 'running', ...(event.draftId ? { draftId: event.draftId } : {}) };
      return { ...next, order: appendOrder(next.order, key), assistantBlocks: { ...next.assistantBlocks, [key]: value } };
    }
    if (event.kind === 'assistant_block_end') {
      if (!current) return next;
      return { ...next, assistantBlocks: { ...next.assistantBlocks, [key]: { ...current, status: 'completed' } } };
    }
    const status = current?.status === 'completed' ? 'completed' : event.status;
    const value: AssistantBlockProjection = { ...current, eventId: event.eventId, messageId: event.messageId, runId: event.runId, blockId: event.blockId, blockType: event.blockType, content: event.content, baseContent: event.content, deltas: {}, status, ...(event.draftId ? { draftId: event.draftId } : {}), ...(event.guardrailEventId ? { guardrailEventId: event.guardrailEventId } : {}), ...(event.timestamp !== undefined ? { timestamp: event.timestamp } : {}) };
    return { ...next, order: appendOrder(next.order, key), assistantBlocks: { ...next.assistantBlocks, [key]: value } };
  }
  if (event.kind === 'tool_activity') {
    const key = identity.tool(event.runId, event.toolCallId);
    const current = next.tools[key];
    const value = { ...current, ...event, status: mergeStatus(current?.status, event.status) } as ToolProjection;
    return { ...next, order: appendOrder(next.order, key), tools: { ...next.tools, [key]: value } };
  }
  if (event.kind === 'subagent_activity') {
    const key = identity.subagent(event.runId, event.subagentId);
    const current = next.subagents[key];
    const value = { ...current, ...event, status: mergeStatus(current?.status, event.status) } as SubagentProjection;
    return { ...next, order: appendOrder(next.order, key), subagents: { ...next.subagents, [key]: value } };
  }
  const value: ModerationProjection = { eventId: event.eventId, moderationId: event.moderationId, runId: event.runId, messageId: event.messageId, ...(event.blockId ? { blockId: event.blockId } : {}), outcome: event.outcome, ...(event.reasonCode ? { reasonCode: event.reasonCode } : {}) };
  return { ...next, moderation: { ...next.moderation, [event.moderationId]: value } };
}

export function selectModerationForTarget(state: ActivityMessageProjectionState, messageId: string, blockId?: string): ModerationProjection | undefined {
  return Object.values(state.moderation).find((item) => item.messageId === messageId && (item.blockId === undefined || item.blockId === blockId));
}

export function selectProjectedMessages(state: ActivityMessageProjectionState): MessageItem[] {
  const result: MessageItem[] = [];
  for (const key of state.order) {
    const user = state.users[key];
    if (user) {
      const moderation = selectModerationForTarget(state, user.messageId);
      result.push({ id: user.messageId, type: 'user', content: user.content, status: 'sent', ...(user.timestamp !== undefined ? { timestamp: user.timestamp } : {}), ...(user.clientMsgId ? { clientMsgId: user.clientMsgId } : {}), ...(user.attachments ? { attachments: user.attachments } : {}), ...(moderation ? { moderation } : {}) });
      continue;
    }
    const block = state.assistantBlocks[key];
    if (block) {
      const moderation = selectModerationForTarget(state, block.messageId, block.blockId);
      result.push(block.blockType === 'text'
        ? { id: block.blockId, type: 'text', content: block.content, runId: block.runId, streaming: block.status === 'running', ...(block.draftId ? { draftId: block.draftId } : {}), ...(block.guardrailEventId ? { guardrailEventId: block.guardrailEventId } : {}), ...(block.timestamp !== undefined ? { timestamp: block.timestamp } : {}), ...(moderation ? { moderation } : {}) }
        : { id: block.blockId, type: 'thinking', content: block.content, streaming: block.status === 'running', ...(block.draftId ? { draftId: block.draftId } : {}) });
      continue;
    }
    const tool = state.tools[key];
    if (tool) {
      result.push({ id: tool.blockId, type: 'tool_use', toolName: tool.toolName, toolInput: tool.toolInput ?? '', toolId: tool.toolCallId, runId: tool.runId, streaming: false, executionStatus: tool.status, ...(tool.result !== undefined ? { result: tool.result } : {}), ...(tool.resultReady !== undefined ? { resultReady: tool.resultReady } : {}), ...(tool.invocationId ? { invocationId: tool.invocationId } : {}), ...(tool.durationMs !== undefined ? { durationMs: tool.durationMs } : {}), ...(tool.error ? { error: tool.error } : {}), ...(tool.presentation ? { presentation: tool.presentation } : {}), ...(tool.toolMetadata ? { toolMetadata: tool.toolMetadata } : {}) });
      continue;
    }
    const subagent = state.subagents[key];
    if (subagent) {
      result.push({ id: subagent.blockId, type: 'subagent', toolId: subagent.toolCallId, agentType: subagent.agentType, status: subagent.status as SubagentStatus, ...(subagent.childSessionId ? { childSessionId: subagent.childSessionId } : {}), ...(subagent.childRunId ? { childRunId: subagent.childRunId } : {}), ...(subagent.model ? { model: subagent.model } : {}), ...(subagent.durationMs !== undefined ? { durationMs: subagent.durationMs } : {}), ...(subagent.totalTokens !== undefined ? { totalTokens: subagent.totalTokens } : {}), ...(subagent.toolUseCount !== undefined ? { toolUseCount: subagent.toolUseCount } : {}), ...(subagent.turnCount !== undefined ? { turnCount: subagent.turnCount } : {}), ...(subagent.errorMessage ? { errorMessage: subagent.errorMessage } : {}), ...(subagent.resultPreview ? { resultPreview: subagent.resultPreview } : {}) });
    }
  }
  return result;
}
