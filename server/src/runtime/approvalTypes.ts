import type { ExecutionTargetKind, ToolDescriptor, ToolResult } from '../agent/toolRuntime.js';
import type { ModelToolCall, RunContext } from './types.js';

export type ApprovalDecision = 'approved' | 'rejected' | 'timeout';

export interface ApprovalRequest {
  sessionId: string;
  runId: string;
  toolCallId: string;
  toolId: string;
  toolName: string;
  displayName?: string;
  executionTarget?: ExecutionTargetKind;
  input: unknown;
}

export interface ApprovalRecord extends ApprovalRequest {
  id: string;
  status: 'pending' | ApprovalDecision;
  createdAt: string;
  resolvedAt?: string;
  message?: string;
}

export interface ApprovalStore {
  create(request: ApprovalRequest): Promise<ApprovalRecord>;
  resolve(id: string, decision: ApprovalDecision, message?: string): Promise<void>;
  resolvePending(id: string, decision: ApprovalDecision, message?: string): Promise<ApprovalRecord | null>;
  get(id: string): Promise<ApprovalRecord | null>;
  list(sessionId?: string): Promise<ApprovalRecord[]>;
  listPending(sessionId?: string): Promise<ApprovalRecord[]>;
}

export type ToolPolicyDecision =
  | { type: 'allow' }
  | { type: 'requires_approval'; reason: string };

export interface ToolPolicy {
  decide(descriptor: ToolDescriptor, input: unknown, context: RunContext): Promise<ToolPolicyDecision>;
}

export interface AuthorizedToolCall {
  toolId: string;
  input: unknown;
}

export interface ToolExecutionOutcome {
  call: ModelToolCall;
  descriptor?: ToolDescriptor;
  input: unknown;
  result: ToolResult;
  isError?: boolean;
}
