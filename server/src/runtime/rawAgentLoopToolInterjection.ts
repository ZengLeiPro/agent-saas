import type { ToolDescriptor } from '../agent/toolRuntime.js';
import type { ToolExecutionOutcome } from './approvalTypes.js';
import type { ModelToolCall } from './types.js';

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
