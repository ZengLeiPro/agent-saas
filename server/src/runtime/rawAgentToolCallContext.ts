import type { ToolCallContext, WorkspaceRef } from '../agent/toolRuntime.js';
import type { RuntimeIsolationRequirement } from './runtimeIsolationEvidence.js';
import type { RunContext } from './types.js';

export function buildRawAgentToolCallContext(
  context: RunContext,
  workspace: WorkspaceRef,
  runtimeIsolationRequirement?: RuntimeIsolationRequirement,
): ToolCallContext {
  return {
    channelContext: context.channelContext,
    workspace,
    env: context.env,
    sessionId: context.sessionId,
    runId: context.runId,
    ...(context.automationFence ? { automationFence: context.automationFence } : {}),
    ...(context.memoryMaintenanceMode
      ? { memoryMaintenanceMode: context.memoryMaintenanceMode }
      : {}),
    ...(runtimeIsolationRequirement ? { runtimeIsolationRequirement } : {}),
    ...(context.orgAgentTaskLineage ? { orgAgentTaskLineage: context.orgAgentTaskLineage } : {}),
    ...(context.orgAgentTaskAuthority
      ? { orgAgentTaskAuthority: context.orgAgentTaskAuthority }
      : {}),
    ...(context.executionRole === 'worker'
      ? {
          executionRole: 'worker' as const,
          runtimeIsolationAttested: context.runtimeIsolationAttested === true,
        }
      : {}),
    hooks: context.hooks,
    signal: context.signal,
  };
}
