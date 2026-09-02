import type { ToolDescriptor } from '../agent/toolRuntime.js';
import type { ToolExecutionOutcome } from './approvalTypes.js';
import type { ModelToolCall, RunContext } from './types.js';

export async function hasQueuedUserInputAtToolBoundary(args: {
  context: RunContext;
  disabled: boolean;
  warn: (message: string) => void;
}): Promise<boolean> {
  if (args.context.signal?.aborted || args.disabled) return false;
  try {
    return (await args.context.loadQueuedInterjections?.() ?? []).length > 0;
  } catch (error) {
    args.warn(
      `[run] steering boundary check failed before tool (degraded): run=${args.context.runId} error=${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

export function buildUserInterjectionSkippedToolResults(calls: ModelToolCall[]): Array<{
  call: ModelToolCall;
  content: string;
  metadata: { skipped: true; reason: 'user_interjection' };
}> {
  return calls.map((call) => ({
    call,
    content: JSON.stringify({
      status: 'skipped',
      reason: 'user_interjection',
      message: '用户发送了新的补充消息，后续工具调用未执行。',
    }),
    metadata: { skipped: true, reason: 'user_interjection' },
  }));
}

export async function skipToolCallForQueuedUserInput(args: {
  shouldYield?: () => Promise<boolean>;
  call: ModelToolCall;
  descriptor: ToolDescriptor;
  input: unknown;
}): Promise<ToolExecutionOutcome | undefined> {
  if (!args.shouldYield || !await args.shouldYield()) return undefined;
  const skipped = buildUserInterjectionSkippedToolResults([args.call])[0]!;
  return {
    call: args.call,
    descriptor: args.descriptor,
    input: args.input,
    result: { content: skipped.content, metadata: skipped.metadata },
  };
}
