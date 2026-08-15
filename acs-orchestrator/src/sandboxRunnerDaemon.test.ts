import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { runSandboxRunnerDaemon } from './sandboxRunnerDaemon.js';
import type { RunnerDaemonResponse } from './runnerDaemonProtocol.js';

describe('sandbox runner daemon', () => {
  it('keeps one process alive and multiplexes invocation output', async () => {
    const stdin = new PassThrough();
    const responses: RunnerDaemonResponse[] = [];
    const execute = vi.fn(async (_input, _signal, emit) => {
      emit({ kind: 'final', response: { status: 'success', content: 'ok' } });
    });
    const running = runSandboxRunnerDaemon({
      stdin,
      runnerId: 'runner-test',
      heartbeatIntervalMs: 60_000,
      write: (response) => responses.push(response),
      execute,
    });

    stdin.write(`${JSON.stringify({
      kind: 'invoke',
      invocationKey: 'inv-1',
      input: { toolName: 'Read', input: {}, workspace: { root: '/workspace' } },
    })}\n`);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(responses).toContainEqual(expect.objectContaining({
      kind: 'invocation_output',
      invocationKey: 'inv-1',
    })));
    stdin.end();
    await running;

    expect(responses[0]).toMatchObject({ kind: 'daemon_ready', runnerId: 'runner-test' });
  });

  it('cancels one invocation without terminating the daemon', async () => {
    const stdin = new PassThrough();
    const responses: RunnerDaemonResponse[] = [];
    const execute = vi.fn(async (input, signal, emit) => {
      if (input.invocationId === 'slow') {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        emit({ kind: 'final', response: { status: 'error', error: 'cancelled' } });
        return;
      }
      emit({ kind: 'final', response: { status: 'success', content: 'still alive' } });
    });
    const running = runSandboxRunnerDaemon({
      stdin,
      runnerId: 'runner-cancel-test',
      heartbeatIntervalMs: 60_000,
      write: (response) => responses.push(response),
      execute,
    });

    stdin.write(`${JSON.stringify({
      kind: 'invoke', invocationKey: 'inv-slow',
      input: { toolName: 'Shell', input: {}, invocationId: 'slow', workspace: { root: '/workspace' } },
    })}\n`);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    stdin.write(`${JSON.stringify({ kind: 'cancel', invocationKey: 'inv-slow' })}\n`);
    await vi.waitFor(() => expect(responses).toContainEqual(expect.objectContaining({
      kind: 'invocation_output', invocationKey: 'inv-slow',
    })));
    stdin.write(`${JSON.stringify({
      kind: 'invoke', invocationKey: 'inv-next',
      input: { toolName: 'Read', input: {}, invocationId: 'next', workspace: { root: '/workspace' } },
    })}\n`);
    await vi.waitFor(() => expect(responses).toContainEqual(expect.objectContaining({
      kind: 'invocation_output', invocationKey: 'inv-next',
    })));
    stdin.end();
    await running;
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
