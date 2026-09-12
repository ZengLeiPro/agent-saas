import type { RunStore } from '../runStore.js';
import type { RunSubagentParams } from '../subagent/subagentRunnerTypes.js';

export function buildBackgroundDeferredMessageLoader(input: {
  runStore?: RunStore;
  taskRunId: string;
  agentId?: string;
  tenantId?: string;
}): Pick<RunSubagentParams, 'loadDeferredMessages'> {
  const { runStore, taskRunId, agentId, tenantId } = input;
  if (!runStore?.drainSubagentDeferredMessages || !agentId || !tenantId) return {};
  return {
    loadDeferredMessages: (identity) =>
      runStore.drainSubagentDeferredMessages!({
        taskRunId,
        childRunId: identity.childRunId,
        agentId,
        tenantId,
      }),
  };
}
