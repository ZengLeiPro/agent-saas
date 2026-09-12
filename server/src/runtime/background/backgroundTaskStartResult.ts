import type { BackgroundAgentRequest, BackgroundTaskStartResult } from './backgroundTaskRuntime.js';
import type { SubagentExecutionOptions } from '../subagent/subagentExecutionOptions.js';

export function buildBackgroundTaskStartResult(input: {
  taskId: string;
  shortTaskId: string;
  request: BackgroundAgentRequest;
  model: string;
  agentId: string;
  executionOptions: SubagentExecutionOptions;
}): BackgroundTaskStartResult {
  return {
    taskId: input.taskId,
    shortTaskId: input.shortTaskId,
    status: 'pending',
    description: input.request.description,
    model: input.model,
    ...(input.executionOptions.resolvedModelRef
      ? { modelRef: input.executionOptions.resolvedModelRef }
      : {}),
    ...(input.executionOptions.resolvedEffort
      ? { effort: input.executionOptions.resolvedEffort }
      : {}),
    agentId: input.agentId,
    delivery: 'accepted',
  };
}
