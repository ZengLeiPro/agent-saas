import { randomUUID } from 'node:crypto';
import type { ModelEvent, ModelRequest, RunContext } from '../types.js';
import { resolveModelOutputTransactionMode } from '../modelOutputTransaction.js';
import { ResponsesStreamGuardError } from './responsesStreamBudget.js';

export interface ResponsesRecoveryScope {
  modelRequestId: string;
  recovered: boolean;
  lastAttempt: number;
}

export function canRecoverResponsesGuard(
  error: unknown,
  request: ModelRequest,
  context: RunContext,
  scope: ResponsesRecoveryScope,
  delivered: boolean,
): boolean {
  return (
    error instanceof ResponsesStreamGuardError &&
    error.recoverySafe &&
    !scope.recovered &&
    !(request.signal ?? context.signal)?.aborted &&
    (!delivered ||
      resolveModelOutputTransactionMode(context.channelContext) !== 'irreversible_stream')
  );
}

/** 只重放本次模型请求；此前 messages 和完整工具结果不改。 */
export async function* withResponsesGuardRecovery(
  request: ModelRequest,
  context: RunContext,
  execute: (scope: ResponsesRecoveryScope) => AsyncIterable<ModelEvent>,
): AsyncIterable<ModelEvent> {
  const scope = { modelRequestId: randomUUID(), recovered: false, lastAttempt: 0 };
  const mode = resolveModelOutputTransactionMode(context.channelContext);
  for (;;) {
    let delivered = false;
    try {
      for await (const event of execute(scope)) {
        if (event.type === 'completed' && (request.signal ?? context.signal)?.aborted) {
          throw (
            (request.signal ?? context.signal)!.reason ?? new DOMException('Aborted', 'AbortError')
          );
        }
        if (event.type !== 'draft_reset') delivered = true;
        yield event;
      }
      return;
    } catch (error) {
      if (!canRecoverResponsesGuard(error, request, context, scope, delivered)) throw error;
      scope.recovered = true;
      if (delivered && mode === 'replaceable_draft')
        yield { type: 'draft_reset', attempt: scope.lastAttempt };
      if ((request.signal ?? context.signal)?.aborted) throw error;
    }
  }
}
