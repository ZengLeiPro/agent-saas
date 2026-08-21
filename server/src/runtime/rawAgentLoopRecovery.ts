import { buildRuntimeReplayState, type RuntimeToolCallState } from './replay.js';
import type { PlatformEvent } from './types.js';

/**
 * 父会话是只读事实源，隐藏审查不得替它执行或持久化崩溃恢复。对已结束但仍缺
 * tool_result 的批次，只在本次内存投影中补合成失败结果，保持 provider 请求合法。
 */
export function closeUnfinishedReplayToolCalls(events: PlatformEvent[], sessionId: string): PlatformEvent[] {
  const replay = buildRuntimeReplayState(events, [], sessionId);
  if (replay.unclosedToolCalls.length === 0) return events;
  const unclosedByBatch = new Map<string, typeof replay.unclosedToolCalls>();
  for (const state of replay.unclosedToolCalls) {
    const list = unclosedByBatch.get(state.batchId) ?? [];
    list.push(state);
    unclosedByBatch.set(state.batchId, list);
  }
  const closed: PlatformEvent[] = [];
  for (const event of events) {
    closed.push(event);
    if (event.type !== 'assistant_tool_calls') continue;
    for (const state of unclosedByBatch.get(event.id) ?? []) {
      closed.push({
        id: `memory-review-unclosed-${state.toolCallId}`,
        timestamp: event.timestamp,
        type: 'tool_result',
        runId: event.runId,
        sessionId,
        toolCallId: state.toolCallId,
        toolName: state.toolName,
        content: '父会话结束前该工具调用未形成完整结果；记忆审查不会代为执行。',
        isError: true,
      });
    }
  }
  return closed;
}

export function describeBlockingToolCall(
  state: RuntimeToolCallState,
  zombieToolCallTimeoutMs: number,
): string | undefined {
  const approvalStatus = state.approval?.status ?? state.approvalResolution?.decision;
  if (approvalStatus === 'pending') {
    const approvalId = state.approval?.id ?? state.approvalRequest?.approvalId;
    return `当前会话正在等待工具审批，请先处理 approval ${approvalId ?? state.toolCallId} for ${state.toolName}`;
  }
  if (state.interactionRequest?.interactionType === 'ask_user' && !state.interactionResolution) {
    return `当前会话正在等待你回答上一个工具问题，请先处理 interaction ${state.interactionRequest.interactionId} for ${state.toolName}`;
  }
  if (state.invocationStarted && !state.invocationCompleted && !state.cancelRequested) {
    const startedAtMs = Date.parse(state.invocationStarted.timestamp);
    const ageMs = Number.isFinite(startedAtMs) ? Date.now() - startedAtMs : 0;
    if (ageMs >= zombieToolCallTimeoutMs) return undefined;
    return `当前会话存在仍在执行或等待恢复的工具调用，请稍后重试 ${state.toolName} (${state.toolCallId})`;
  }
  return undefined;
}

export function buildSyntheticToolResultContent(state: RuntimeToolCallState): string {
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
