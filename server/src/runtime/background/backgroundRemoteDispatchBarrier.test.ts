import { describe, expect, it, vi } from 'vitest';

import { assertBackgroundRemoteDispatchBarrier } from './backgroundRemoteDispatchBarrier.js';

const identity = { childSessionId: 'child-session', childRunId: 'child-run' };

describe('background remote dispatch final barrier', () => {
  it('rejects an already-aborted non-automation task before markStatus/dispatch', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    const markStatus = vi.fn();
    const activate = vi.fn(async () => undefined);
    await expect(assertBackgroundRemoteDispatchBarrier(
      { markStatus } as never, 'background-run', controller.signal, identity, activate,
    )).rejects.toThrow('cancelled');
    expect(markStatus).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
  });

  it('rejects a terminal/failed markStatus race before activation and dispatch', async () => {
    const markStatus = vi.fn(async () => null);
    const activate = vi.fn(async () => undefined);
    await expect(assertBackgroundRemoteDispatchBarrier(
      { markStatus } as never, 'background-run', new AbortController().signal, identity, activate,
    )).rejects.toThrow('lost running authority');
    expect(markStatus).toHaveBeenCalledOnce();
    expect(activate).not.toHaveBeenCalled();
  });

  it('rechecks abort after markStatus before the final automation barrier', async () => {
    const controller = new AbortController();
    const markStatus = vi.fn(async () => {
      controller.abort(new Error('cancelled after status'));
      return { status: 'running' };
    });
    const activate = vi.fn(async () => undefined);
    await expect(assertBackgroundRemoteDispatchBarrier(
      { markStatus } as never, 'background-run', controller.signal, identity, activate,
    )).rejects.toThrow('cancelled after status');
    expect(activate).not.toHaveBeenCalled();
  });
});
