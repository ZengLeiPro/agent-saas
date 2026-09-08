import { describe, expect, it, vi } from 'vitest';
import { HttpTransport } from '../runtime/httpTransport.js';
import type { ToolInvocationRequest } from '../runtime/handProtocol.js';
import type { WorkspaceRef } from '../agent/toolRuntime.js';
const SAMPLE_WORKSPACE: WorkspaceRef = {
  id: 'session-test',
  root: '/tmp/http-drain-test',
  userId: 'u1',
  username: 'test',
  sessionId: 'session-test',
  executionTarget: 'server-remote',
};
function buildRequest(extra: Partial<ToolInvocationRequest> = {}): ToolInvocationRequest {
  return {
    toolName: 'Write',
    input: { path: 'test.txt', content: 'once' },
    context: { workspace: SAMPLE_WORKSPACE },
    ...extra,
  };
}
describe('HttpTransport deployment drain', () => {
  it('waits beyond normal connect retries and execution timeout only with proof execution never started', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const fetchImpl = vi.fn(async () => {
        calls++;
        if (calls <= 6)
          return new Response('draining', {
            status: 503,
            headers: {
              'retry-after': '1',
              'x-acs-error-code': 'ACS_DEPLOYMENT_DRAINING',
              'x-acs-execution-started': 'false',
            },
          });
        return new Response(JSON.stringify({ status: 'success', content: 'once' }));
      }) as unknown as typeof fetch;
      const transport = new HttpTransport({
        baseUrl: 'http://h',
        authToken: 'secret-token-12345',
        fetchImpl,
        invokeTimeoutMs: 100,
        connectRetryBackoffMs: [],
        deploymentDrainWaitMs: 10_000,
      });
      const response = transport.invoke(buildRequest());
      await vi.advanceTimersByTimeAsync(6_001);
      expect((await response).status).toBe('success');
      expect(calls).toBe(7);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds a proven pre-execution drain and lets its caller cancel without dispatching work', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        async () =>
          new Response('draining', {
            status: 503,
            headers: {
              'retry-after': '1',
              'x-acs-error-code': 'ACS_DEPLOYMENT_DRAINING',
              'x-acs-execution-started': 'false',
            },
          }),
      ) as unknown as typeof fetch;
      const transport = new HttpTransport({
        baseUrl: 'http://h',
        authToken: 'secret-token-12345',
        fetchImpl,
        invokeTimeoutMs: 100,
        deploymentDrainWaitMs: 2_000,
      });
      const waiting = transport.invoke(buildRequest());
      await vi.advanceTimersByTimeAsync(2_001);
      expect((await waiting).status).toBe('error');
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      const controller = new AbortController();
      const cancelled = transport.invoke(
        buildRequest({ context: { workspace: SAMPLE_WORKSPACE, signal: controller.signal } }),
      );
      await vi.advanceTimersByTimeAsync(1);
      controller.abort();
      expect((await cancelled).metadata?.aborted).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never replays an ambiguous request reset or drain without a no-execution proof', async () => {
    for (const result of ['reset', 'missing-proof']) {
      const fetchImpl = vi.fn(async () => {
        if (result === 'reset')
          throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
        return new Response('draining', {
          status: 503,
          headers: { 'x-acs-error-code': 'ACS_DEPLOYMENT_DRAINING' },
        });
      }) as unknown as typeof fetch;
      const transport = new HttpTransport({
        baseUrl: 'http://h',
        authToken: 'secret-token-12345',
        fetchImpl,
        connectRetryBackoffMs: [1, 1],
      });
      expect((await transport.invoke(buildRequest())).status).toBe('error');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });
});
