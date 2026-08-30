import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import {
  CORRELATION_CONTEXT_VERSION,
  parseCorrelationContext,
  type CorrelationContext,
} from '@agent/shared';

const invocationCorrelationStorage = new AsyncLocalStorage<CorrelationContext>();

export function createInvocationCorrelation(input: Omit<CorrelationContext, 'version' | 'attemptId'>): CorrelationContext {
  const parsed = parseCorrelationContext({ version: CORRELATION_CONTEXT_VERSION, ...input });
  if (!parsed.ok || !parsed.value) throw new Error(parsed.ok ? 'correlation context 缺失' : parsed.error);
  return parsed.value;
}

export function createExecutionAttempt(context: CorrelationContext): CorrelationContext {
  return { ...context, attemptId: `attempt-${randomUUID()}` };
}

export function getInvocationCorrelation(): CorrelationContext | undefined {
  return invocationCorrelationStorage.getStore();
}

export function runWithInvocationCorrelation<T>(context: CorrelationContext | undefined, callback: () => T): T {
  if (!context) return callback();
  return invocationCorrelationStorage.run(context, callback);
}

export async function* iterateWithInvocationCorrelation<T>(
  context: CorrelationContext | undefined,
  source: AsyncIterable<T>,
): AsyncIterable<T> {
  const iterator = source[Symbol.asyncIterator]();
  let completed = false;
  try {
    while (true) {
      const next = await runWithInvocationCorrelation(context, () => iterator.next());
      if (next.done) {
        completed = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!completed && iterator.return) {
      await runWithInvocationCorrelation(context, () => iterator.return!());
    }
  }
}
