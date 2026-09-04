import type { ToolCallContext } from '../../agent/toolRuntime.js';
import type { RunRecord } from '../runStore.js';
import type { RuntimeSessionRecord } from '../sessionCatalog.js';
import { deriveChildAutomationFence } from '../subagent/subagentRunner.js';
import type { RunContext } from '../types.js';
import type { BackgroundAgentTaskMetadata } from './backgroundTaskMetadata.js';

export function deriveBackgroundTaskAutomationFence(
  parentFence: ToolCallContext['automationFence'],
  taskId: string,
  parent: { sessionId: string; runId: string },
): ToolCallContext['automationFence'] {
  return deriveChildAutomationFence(parentFence, taskId, parent);
}

export function buildBackgroundTaskAutomationContext(
  record: RunRecord,
  metadata: BackgroundAgentTaskMetadata,
): Pick<RunContext, 'tenantId' | 'sessionId' | 'runId' | 'automationFence'> | undefined {
  if (!metadata.automationFence) return undefined;
  if (metadata.automationFence.runId !== record.runId) {
    throw new Error(`background task automation fence mismatch for run ${record.runId}`);
  }
  return {
    tenantId: record.tenantId,
    sessionId: record.sessionId,
    runId: record.runId,
    automationFence: metadata.automationFence,
  };
}

export function buildBackgroundTaskParentContext(input: {
  record: RunRecord;
  metadata: BackgroundAgentTaskMetadata;
  taskSession: RuntimeSessionRecord;
  channelContext: ToolCallContext['channelContext'];
  env: ToolCallContext['env'];
  runtimeIsolationRequirement: ToolCallContext['runtimeIsolationRequirement'];
  signal: AbortSignal;
}): ToolCallContext {
  const { record, metadata, taskSession } = input;
  return {
    channelContext: input.channelContext,
    env: input.env,
    workspace: {
      id: metadata.workspaceId,
      root: metadata.cwd,
      userId: taskSession.userId,
      username: taskSession.username,
      tenantId: taskSession.tenantId,
      sessionId: record.sessionId,
      // Preserve the top-level sandbox group across the background task's intermediate sub-session.
      topLevelSessionId: metadata.topLevelSessionId ?? metadata.parentSessionId,
      executionTarget: record.executionTarget ?? taskSession.executionTarget ?? 'server-container',
      ...(metadata.mountSubPath ? { mountSubPath: metadata.mountSubPath } : {}),
      ...(metadata.sharedReadOnlySubPath ? { sharedReadOnlySubPath: metadata.sharedReadOnlySubPath } : {}),
      ...(metadata.sandboxScopeId ? { sandboxScopeId: metadata.sandboxScopeId } : {}),
      ...(metadata.sandboxResources ? { sandboxResources: metadata.sandboxResources } : {}),
      ...(metadata.workload ? { workload: metadata.workload } : {}),
      ...(metadata.sandboxPolicy ? { sandboxPolicy: metadata.sandboxPolicy } : {}),
    },
    sessionId: record.sessionId,
    runId: record.runId,
    toolCallId: metadata.parentToolCallId,
    ...(input.runtimeIsolationRequirement ? { runtimeIsolationRequirement: input.runtimeIsolationRequirement } : {}),
    ...(metadata.automationFence ? { automationFence: metadata.automationFence } : {}),
    signal: input.signal,
  };
}
