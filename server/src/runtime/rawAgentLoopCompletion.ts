import type { ModelChatMessage, ModelUsage, PlatformEventInput, RunContext } from './types.js';
import { buildModelUsage } from './rawAgentLoopHelpers.js';

const MAX_SUCCESS_COMPLETION_CONTINUATIONS = 3;

export interface SuccessfulCompletionController {
  check(context: RunContext, messages: ModelChatMessage[], assistantContent: string): Promise<boolean>;
  reset(): void;
}

export function createSuccessfulCompletionController(
  warn: (message: string) => void,
): SuccessfulCompletionController {
  let continuationCount = 0;
  return {
    async check(context, messages, assistantContent) {
      const decision = await context.checkSuccessfulCompletion?.();
      if (!decision || decision.action === 'allow') return false;
      if (decision.action === 'reject') throw new Error(decision.error);
      if (continuationCount >= MAX_SUCCESS_COMPLETION_CONTINUATIONS) {
        throw new Error(
          `run success completion protocol remained unresolved after ${MAX_SUCCESS_COMPLETION_CONTINUATIONS} continuation turns`,
        );
      }
      const lastMessage = messages.at(-1);
      if (lastMessage?.role !== 'assistant' || lastMessage.content !== assistantContent) {
        messages.push({ role: 'assistant', content: assistantContent });
      }
      messages.push({ role: 'system', content: decision.prompt });
      continuationCount += 1;
      warn(`[run] successful completion deferred run=${context.runId} continuation=${continuationCount}`);
      return true;
    },
    reset() {
      continuationCount = 0;
    },
  };
}

export async function finishSuccessfulRun(args: {
  context: RunContext;
  numTurns: number;
  totalUsage: ModelUsage | undefined;
  finalText: string;
  append: (event: PlatformEventInput) => Promise<void>;
  log: () => void;
}): Promise<void> {
  const modelUsage = buildModelUsage(args.context.model, args.totalUsage);
  await args.append({
    type: 'run_finished',
    runId: args.context.runId,
    sessionId: args.context.sessionId,
    subtype: 'success',
    numTurns: args.numTurns,
    ...(modelUsage ? { modelUsage } : {}),
  });
  args.log();
  await args.context.hooks?.onResult?.({
    subtype: 'success',
    numTurns: args.numTurns,
    resultText: args.finalText,
    ...(modelUsage ? { modelUsage } : {}),
  });
}
