import type { ToolDescriptor } from '../agent/toolRuntime.js';
import { standardizeToolError } from './agentPlanDefense.js';
import type { ModelToolCall, ToolExecutionOutcome } from './types.js';

export function toolExecutionError(input: {
  call: ModelToolCall;
  descriptor?: ToolDescriptor;
  parsedInput: unknown;
  message: string;
}): ToolExecutionOutcome {
  return {
    call: input.call,
    ...(input.descriptor ? { descriptor: input.descriptor } : {}),
    input: input.parsedInput,
    result: { content: standardizeToolError(input.message) },
    isError: true,
  };
}
