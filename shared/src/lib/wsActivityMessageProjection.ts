import type { WsEvent } from '../types/ws';
import type { ActivityMessageProjectionEvent } from './activityMessageProjection';
import { normalizeToolPresentation } from './toolPresentation';
import { normalizeToolResultMetadata } from './toolResultMetadata';

/** Modern runtime/WS adapter. Sparse legacy frames return null and stay in the isolated adapter. */
export function adaptWsEventToActivityMessageProjection(data: WsEvent): ActivityMessageProjectionEvent | null {
  const meta = 'projection' in data ? data.projection : undefined;
  if (!meta?.eventId || !meta.runId || !meta.messageId) return null;
  const common = { eventId: meta.eventId, runId: meta.runId };
  if (data.type === 'user_message') {
    return { ...common, domain: 'message', kind: 'user_message', messageId: meta.messageId, content: data.content, timestamp: data.timestamp, ...(data.client_msg_id ? { clientMsgId: data.client_msg_id } : {}), ...(data.attachments ? { attachments: data.attachments } : {}) };
  }
  if ((data.type === 'block_start' || data.type === 'block_end') && (data.blockType === 'text' || data.blockType === 'thinking') && meta.blockId) {
    return { ...common, domain: 'message', kind: data.type === 'block_start' ? 'assistant_block_start' : 'assistant_block_end', messageId: meta.messageId, blockId: meta.blockId, blockType: data.blockType, ...(data.type === 'block_start' && data.draftId ? { draftId: data.draftId } : {}) };
  }
  if ((data.type === 'text' || data.type === 'thinking') && meta.blockId) {
    return { ...common, domain: 'message', kind: 'assistant_block_delta', messageId: meta.messageId, blockId: meta.blockId, blockType: data.type, delta: data.content, ...(data.type === 'text' && data.guardrailEventId ? { guardrailEventId: data.guardrailEventId } : {}) };
  }
  if ((data.type === 'tool_execution' || data.type === 'tool_result') && meta.blockId && meta.toolCallId) {
    if (data.type === 'tool_result') {
      return { ...common, domain: 'tool', kind: 'tool_activity', messageId: meta.messageId, blockId: meta.blockId, toolCallId: meta.toolCallId, toolName: data.toolName ?? 'unknown', status: data.isError ? 'failed' : 'completed', result: data.result ?? '', resultReady: true, ...(normalizeToolPresentation(data.presentation) ? { presentation: normalizeToolPresentation(data.presentation)! } : {}), ...(normalizeToolResultMetadata(data.metadata) ? { toolMetadata: normalizeToolResultMetadata(data.metadata)! } : {}) };
    }
    const status = data.phase === 'completed' ? (data.status === 'error' ? 'failed' : data.status === 'cancelled' ? 'cancelled' : 'completed') : 'running';
    return { ...common, domain: 'tool', kind: 'tool_activity', messageId: meta.messageId, blockId: meta.blockId, toolCallId: meta.toolCallId, toolName: data.toolName ?? 'unknown', status, ...(data.invocationId ? { invocationId: data.invocationId } : {}), ...(data.durationMs !== undefined ? { durationMs: data.durationMs } : {}), ...(data.error ? { error: data.error } : {}) };
  }
  if ((data.type === 'subagent_start' || data.type === 'subagent_end') && meta.blockId && meta.toolCallId && meta.subagentId) {
    return { ...common, domain: 'subagent', kind: 'subagent_activity', messageId: meta.messageId, blockId: meta.blockId, toolCallId: meta.toolCallId, subagentId: meta.subagentId, agentType: data.agentType ?? 'subagent', status: data.type === 'subagent_start' ? 'running' : (data.status ?? 'completed'), ...(data.childSessionId ? { childSessionId: data.childSessionId } : {}), ...(data.childRunId ? { childRunId: data.childRunId } : {}), ...(data.model ? { model: data.model } : {}), ...(data.type === 'subagent_end' && data.durationMs !== undefined ? { durationMs: data.durationMs } : {}), ...(data.type === 'subagent_end' && data.totalTokens !== undefined ? { totalTokens: data.totalTokens } : {}), ...(data.type === 'subagent_end' && data.toolUseCount !== undefined ? { toolUseCount: data.toolUseCount } : {}), ...(data.type === 'subagent_end' && data.turnCount !== undefined ? { turnCount: data.turnCount } : {}), ...(data.type === 'subagent_end' && data.errorMessage ? { errorMessage: data.errorMessage } : {}), ...(data.type === 'subagent_end' && data.resultPreview ? { resultPreview: data.resultPreview } : {}) };
  }
  if (data.type === 'moderation_outcome') {
    return { ...common, domain: 'moderation', kind: 'moderation_outcome', moderationId: data.moderationId, messageId: meta.messageId, ...(meta.blockId ? { blockId: meta.blockId } : {}), outcome: data.outcome, ...(data.reasonCode ? { reasonCode: data.reasonCode } : {}) };
  }
  return null;
}
