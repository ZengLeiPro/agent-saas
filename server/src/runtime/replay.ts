import type { ApprovalRecord, PlatformEvent, ModelToolCall } from './types.js';
import { buildApprovalRecordsFromEvents } from './approvalStore.js';

export type RuntimeToolCallStatus =
  | 'pending_approval'
  | 'approved_pending_execution'
  | 'rejected_pending_result'
  | 'completed'
  | 'unresolved';

export interface RuntimeToolCallState {
  sessionId: string;
  runId: string;
  batchId: string;
  toolCallId: string;
  toolName: string;
  call: ModelToolCall;
  assistantEvent: Extract<PlatformEvent, { type: 'assistant_tool_calls' }>;
  approvalRequest?: Extract<PlatformEvent, { type: 'approval_requested' }>;
  approvalResolution?: Extract<PlatformEvent, { type: 'approval_resolved' }>;
  approval?: ApprovalRecord;
  toolResult?: Extract<PlatformEvent, { type: 'tool_result' }>;
  interactionRequest?: Extract<PlatformEvent, { type: 'interaction_requested' }>;
  interactionResolution?: Extract<PlatformEvent, { type: 'interaction_resolved' }>;
  invocationStarted?: Extract<PlatformEvent, { type: 'tool_invocation_started' }>;
  invocationCompleted?: Extract<PlatformEvent, { type: 'tool_invocation_completed' }>;
  cancelRequested?: Extract<PlatformEvent, { type: 'run_cancel_requested' }>;
  status: RuntimeToolCallStatus;
}

export type RuntimeToolCallBatchStatus =
  | 'closed'
  | 'pending_approval'
  | 'waiting_user'
  | 'running'
  | 'open';

export interface RuntimeToolCallBatchState {
  batchId: string;
  sessionId: string;
  runId: string;
  assistantEvent: Extract<PlatformEvent, { type: 'assistant_tool_calls' }>;
  toolCalls: RuntimeToolCallState[];
  unclosedToolCalls: RuntimeToolCallState[];
  pendingApprovals: RuntimeToolCallState[];
  pendingInteractions: RuntimeToolCallState[];
  status: RuntimeToolCallBatchStatus;
}

export interface RuntimeReplayState {
  sessionId: string;
  events: PlatformEvent[];
  toolCalls: RuntimeToolCallState[];
  toolCallsById: Map<string, RuntimeToolCallState>;
  toolCallBatches: RuntimeToolCallBatchState[];
  toolCallBatchesById: Map<string, RuntimeToolCallBatchState>;
  toolCallBatchByToolCallId: Map<string, RuntimeToolCallBatchState>;
  pendingApprovals: RuntimeToolCallState[];
  unclosedToolCalls: RuntimeToolCallState[];
  lastRunFinished?: Extract<PlatformEvent, { type: 'run_finished' }>;
}

export function buildRuntimeReplayState(
  events: PlatformEvent[],
  approvals: ApprovalRecord[] = [],
  sessionId = events.find((event) => 'sessionId' in event)?.sessionId ?? '',
): RuntimeReplayState {
  const toolCallsById = new Map<string, RuntimeToolCallState>();
  const derivedApprovals = mergeApprovals(
    buildApprovalRecordsFromEvents(events, sessionId),
    approvals,
  );
  const approvalsById = new Map(derivedApprovals.map((approval) => [approval.id, approval]));
  const approvalsByToolCallId = new Map(derivedApprovals.map((approval) => [approval.toolCallId, approval]));
  const approvalRequestsByToolCallId = new Map<string, Extract<PlatformEvent, { type: 'approval_requested' }>>();
  const approvalResolutionsById = new Map<string, Extract<PlatformEvent, { type: 'approval_resolved' }>>();
  const toolResultsByCallId = new Map<string, Extract<PlatformEvent, { type: 'tool_result' }>>();
  const interactionRequestsByToolCallId = new Map<string, Extract<PlatformEvent, { type: 'interaction_requested' }>>();
  const interactionResolutionsById = new Map<string, Extract<PlatformEvent, { type: 'interaction_resolved' }>>();
  const invocationStartedByToolCallId = new Map<string, Extract<PlatformEvent, { type: 'tool_invocation_started' }>>();
  const invocationCompletedByToolCallId = new Map<string, Extract<PlatformEvent, { type: 'tool_invocation_completed' }>>();
  const cancelRequestedByRunId = new Map<string, Extract<PlatformEvent, { type: 'run_cancel_requested' }>>();
  let lastRunFinished: Extract<PlatformEvent, { type: 'run_finished' }> | undefined;

  for (const event of events) {
    if (sessionId && 'sessionId' in event && event.sessionId !== sessionId) continue;
    if (event.type === 'assistant_tool_calls') {
      for (const call of event.toolCalls) {
        toolCallsById.set(call.id, {
          sessionId: event.sessionId,
          runId: event.runId,
          batchId: event.id,
          toolCallId: call.id,
          toolName: call.name,
          call,
          assistantEvent: event,
          status: 'unresolved',
        });
      }
    } else if (event.type === 'approval_requested') {
      approvalRequestsByToolCallId.set(event.toolCallId, event);
    } else if (event.type === 'approval_resolved') {
      approvalResolutionsById.set(event.approvalId, event);
    } else if (event.type === 'tool_result') {
      toolResultsByCallId.set(event.toolCallId, event);
    } else if (event.type === 'interaction_requested' && event.toolCallId) {
      interactionRequestsByToolCallId.set(event.toolCallId, event);
    } else if (event.type === 'interaction_resolved') {
      interactionResolutionsById.set(event.interactionId, event);
    } else if (event.type === 'tool_invocation_started') {
      invocationStartedByToolCallId.set(event.toolCallId, event);
    } else if (event.type === 'tool_invocation_completed') {
      invocationCompletedByToolCallId.set(event.toolCallId, event);
    } else if (event.type === 'run_cancel_requested' && event.runId) {
      cancelRequestedByRunId.set(event.runId, event);
    } else if (event.type === 'run_finished') {
      lastRunFinished = event;
    }
  }

  for (const [toolCallId, state] of toolCallsById) {
    const approvalRequest = approvalRequestsByToolCallId.get(toolCallId);
    const approval = approvalRequest
      ? approvalsById.get(approvalRequest.approvalId)
      : approvalsByToolCallId.get(toolCallId);
    const approvalResolution = approval
      ? approvalResolutionsById.get(approval.id)
      : approvalRequest
        ? approvalResolutionsById.get(approvalRequest.approvalId)
        : undefined;
    const toolResult = toolResultsByCallId.get(toolCallId);
    const interactionRequest = interactionRequestsByToolCallId.get(toolCallId);

    state.approvalRequest = approvalRequest;
    state.approval = approval;
    state.approvalResolution = approvalResolution;
    state.toolResult = toolResult;
    state.interactionRequest = interactionRequest;
    state.interactionResolution = interactionRequest
      ? interactionResolutionsById.get(interactionRequest.interactionId)
      : undefined;
    state.invocationStarted = invocationStartedByToolCallId.get(toolCallId);
    state.invocationCompleted = invocationCompletedByToolCallId.get(toolCallId);
    state.cancelRequested = cancelRequestedByRunId.get(state.runId);
    state.status = resolveToolCallStatus({ approval, approvalResolution, toolResult });
  }

  const toolCalls = [...toolCallsById.values()];
  const toolCallBatchesById = new Map<string, RuntimeToolCallBatchState>();
  const toolCallBatchByToolCallId = new Map<string, RuntimeToolCallBatchState>();
  for (const state of toolCalls) {
    let batch = toolCallBatchesById.get(state.batchId);
    if (!batch) {
      batch = {
        batchId: state.batchId,
        sessionId: state.sessionId,
        runId: state.runId,
        assistantEvent: state.assistantEvent,
        toolCalls: [],
        unclosedToolCalls: [],
        pendingApprovals: [],
        pendingInteractions: [],
        status: 'open',
      };
      toolCallBatchesById.set(state.batchId, batch);
    }
    batch.toolCalls.push(state);
    toolCallBatchByToolCallId.set(state.toolCallId, batch);
  }
  for (const batch of toolCallBatchesById.values()) {
    batch.unclosedToolCalls = batch.toolCalls.filter((state) => !state.toolResult);
    batch.pendingApprovals = batch.toolCalls.filter((state) => state.status === 'pending_approval');
    batch.pendingInteractions = batch.toolCalls.filter((state) => (
      state.interactionRequest
      && state.interactionRequest.interactionType === 'ask_user'
      && !state.interactionResolution
    ));
    batch.status = resolveToolCallBatchStatus(batch);
  }
  const toolCallBatches = [...toolCallBatchesById.values()];
  return {
    sessionId,
    events,
    toolCalls,
    toolCallsById,
    toolCallBatches,
    toolCallBatchesById,
    toolCallBatchByToolCallId,
    pendingApprovals: toolCalls.filter((state) => state.status === 'pending_approval'),
    unclosedToolCalls: toolCalls.filter((state) => !state.toolResult),
    ...(lastRunFinished ? { lastRunFinished } : {}),
  };
}

function mergeApprovals(derived: ApprovalRecord[], explicit: ApprovalRecord[]): ApprovalRecord[] {
  const merged = new Map<string, ApprovalRecord>();
  for (const approval of derived) merged.set(approval.id, approval);
  for (const approval of explicit) merged.set(approval.id, approval);
  return [...merged.values()];
}

function resolveToolCallStatus(args: {
  approval?: ApprovalRecord;
  approvalResolution?: Extract<PlatformEvent, { type: 'approval_resolved' }>;
  toolResult?: Extract<PlatformEvent, { type: 'tool_result' }>;
}): RuntimeToolCallStatus {
  if (args.toolResult) return 'completed';
  const decision = args.approval?.status ?? args.approvalResolution?.decision;
  if (decision === 'pending') return 'pending_approval';
  if (decision === 'approved') return 'approved_pending_execution';
  if (decision === 'rejected' || decision === 'timeout') return 'rejected_pending_result';
  return 'unresolved';
}

function resolveToolCallBatchStatus(batch: RuntimeToolCallBatchState): RuntimeToolCallBatchStatus {
  if (batch.unclosedToolCalls.length === 0) return 'closed';
  if (batch.pendingApprovals.length > 0) return 'pending_approval';
  if (batch.pendingInteractions.length > 0) return 'waiting_user';
  if (batch.unclosedToolCalls.some((state) => state.invocationStarted && !state.invocationCompleted)) return 'running';
  return 'open';
}
