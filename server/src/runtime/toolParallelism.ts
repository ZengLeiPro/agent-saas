import type {
  ToolAuthorization,
  ToolDescriptor,
} from '../agent/toolRuntime.js';
import { isParallelSafeToolCall, parseToolArguments } from './rawAgentLoopHelpers.js';
import type {
  ModelToolCall,
  RunContext,
  ToolPolicy,
} from './types.js';

const MAX_PARALLEL_SHELL_CALLS = 4;

export interface PreparedParallelToolCall {
  descriptor: ToolDescriptor;
  input: unknown;
  authorization: ToolAuthorization;
}

export async function collectParallelToolCallSegment(args: {
  calls: ModelToolCall[];
  start: number;
  descriptorsByName: Map<string, ToolDescriptor>;
  context: RunContext;
  toolPolicy: ToolPolicy;
  refreshPolicyContext(context: RunContext): Promise<RunContext>;
}): Promise<{ end: number; preparedCalls: PreparedParallelToolCall[] }> {
  let end = args.start;
  let shellCalls = 0;
  const preparedCalls: PreparedParallelToolCall[] = [];
  while (end < args.calls.length) {
    const prepared = await prepareParallelToolCall(args.calls[end]!, args);
    if (!prepared) break;
    if (prepared.descriptor.name === 'Shell') {
      if (shellCalls >= MAX_PARALLEL_SHELL_CALLS) break;
      shellCalls += 1;
    }
    preparedCalls.push(prepared);
    end += 1;
  }
  return { end, preparedCalls };
}

async function prepareParallelToolCall(
  call: ModelToolCall,
  args: {
    descriptorsByName: Map<string, ToolDescriptor>;
    context: RunContext;
    toolPolicy: ToolPolicy;
    refreshPolicyContext(context: RunContext): Promise<RunContext>;
  },
): Promise<PreparedParallelToolCall | undefined> {
  const descriptor = args.descriptorsByName.get(call.name);
  if (!descriptor) return undefined;
  const input = parseToolArguments(call.arguments);
  let dynamicallyEligible = false;
  try {
    dynamicallyEligible = descriptor.resolveConcurrency?.(input) === 'parallel';
  } catch {
    dynamicallyEligible = false;
  }
  if (!dynamicallyEligible && !isParallelSafeToolCall(call, args.descriptorsByName)) return undefined;

  const policyContext = await args.refreshPolicyContext(args.context);
  const decision = await args.toolPolicy.decide(descriptor, input, policyContext);
  if (decision.type !== 'allow') return undefined;
  return {
    descriptor,
    input,
    authorization: { approved: true, source: 'policy_auto' },
  };
}
