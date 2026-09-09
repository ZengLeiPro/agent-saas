import type { AgentRunHooks, SandboxWorkloadWireDescriptor } from './types.js';
import type { ExecutionAuditRecorder, ExecutionTargetKind } from './toolRuntime.js';
import type { RuntimeIsolationRequirement } from '../runtime/runtimeIsolationEvidence.js';
import type { OrgAgentWorkerTaskAuthority } from '../runtime/orgAgentWorkerCapability.js';
import type { OrgAgentWorkerTaskLineage } from '../runtime/orgAgentTaskWorkspace.js';
import type { ChannelContext } from '../types/index.js';

/** Logical and local workspace identity resolved by the trusted runtime. */
export interface WorkspaceRef {
  id?: string;
  root: string;
  userId?: string;
  username?: string;
  tenantId?: string;
  sessionId?: string;
  topLevelSessionId?: string;
  sandboxScopeId?: string;
  mountSubPath?: string;
  sharedReadOnlySubPath?: string;
  workload?: SandboxWorkloadWireDescriptor;
  sharedReadOnlyRoot?: string;
  sandboxResources?: { cpu: string; memoryMb: number };
  executionTarget: ExecutionTargetKind;
  sandboxPolicy?: { denyRead: string[] };
}

export interface ToolCallContext {
  channelContext: ChannelContext;
  workspace: WorkspaceRef;
  env?: Record<string, string>;
  sessionId?: string;
  runId?: string;
  automationFence?: {
    automationId: string;
    incarnationId: string;
    generation: number;
    specVersion: number;
    executionId: string;
    runId: string;
    rootSessionId?: string;
    rootRunId?: string;
  };
  memoryMaintenanceMode?: 'consolidation';
  runtimeIsolationRequirement?: RuntimeIsolationRequirement;
  orgAgentTaskLineage?: OrgAgentWorkerTaskLineage;
  orgAgentTaskAuthority?: OrgAgentWorkerTaskAuthority;
  executionRole?: 'worker';
  runtimeIsolationAttested?: boolean;
  toolCallId?: string;
  invocationId?: string;
  correlation?: import('@agent/shared').CorrelationContext;
  onStreamChunk?: (
    chunk: import('../runtime/handProtocol.js').ToolInvocationStreamChunk,
  ) => Promise<void> | void;
  hooks?: AgentRunHooks;
  signal?: AbortSignal;
  executionAudit?: ExecutionAuditRecorder;
}
