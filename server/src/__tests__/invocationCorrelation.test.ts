import { describe, expect, it, vi } from 'vitest';

import { createLogger } from '../utils/logger.js';
import {
  createExecutionAttempt,
  createInvocationCorrelation,
  getInvocationCorrelation,
  iterateWithInvocationCorrelation,
  runWithInvocationCorrelation,
} from '../runtime/invocationCorrelation.js';

describe('invocation correlation runtime', () => {
  it('keeps logical invocation stable while real attempts are distinct', () => {
    const logical = createInvocationCorrelation({
      sessionId: 'session-1',
      runId: 'run-1',
      toolCallId: 'call-1',
      invocationId: 'run-1:call-1',
    });
    const first = createExecutionAttempt(logical);
    const retry = createExecutionAttempt(logical);
    expect(first.invocationId).toBe(logical.invocationId);
    expect(retry.invocationId).toBe(logical.invocationId);
    expect(first.attemptId).not.toBe(retry.attemptId);
  });

  it('binds stream pulls to correlation and forwards early iterator cleanup', async () => {
    const seen: Array<string | undefined> = [];
    let cleaned = false;
    async function* source() {
      try {
        seen.push(getInvocationCorrelation()?.attemptId);
        yield 'chunk';
      } finally {
        cleaned = true;
        seen.push(getInvocationCorrelation()?.attemptId);
      }
    }
    const stream = iterateWithInvocationCorrelation({ version: 1, attemptId: 'attempt-stream' }, source());
    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: 'chunk' });
    await iterator.return?.();
    expect(seen).toEqual(['attempt-stream', 'attempt-stream']);
    expect(cleaned).toBe(true);
  });

  it('logs only allowlisted correlation ids and ignores injected sensitive fields', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const logger = createLogger('Correlation', { colorEnabled: false });
    runWithInvocationCorrelation({
      version: 1,
      invocationId: 'run-1:call-1',
      attemptId: 'attempt-1',
      token: 'secret-token',
      toolInput: '/private/customer.txt',
    } as never, () => logger.info('provider started'));
    const output = String(spy.mock.calls[0]?.[0]);
    expect(output).toContain('invocationId=run-1:call-1');
    expect(output).toContain('attemptId=attempt-1');
    expect(output).not.toContain('secret-token');
    expect(output).not.toContain('/private/customer.txt');
    spy.mockRestore();
  });
});
