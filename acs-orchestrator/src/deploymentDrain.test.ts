import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeploymentDrain } from './deploymentDrain.js';

afterEach(() => vi.useRealTimers());

function fixture() {
  vi.useFakeTimers();
  let inflight = 1;
  const publish = vi.fn();
  const admission = vi.fn();
  const exit = vi.fn();
  const errors = vi.fn();
  const drain = new DeploymentDrain({
    pid: 123,
    inflight: () => inflight,
    deadlineMs: () => 5_000,
    publish,
    setAdmission: admission,
    exit,
    onError: errors,
  });
  return {
    drain,
    publish,
    admission,
    exit,
    errors,
    finish: () => {
      inflight = 0;
    },
  };
}

describe('deployment drain does not sacrifice accepted execution', () => {
  it('keeps accepted work alive at the deadline and restores admission', () => {
    const f = fixture();
    f.drain.begin();
    vi.advanceTimersByTime(5_000);
    expect(f.exit).not.toHaveBeenCalled();
    expect(f.drain.snapshot()).toMatchObject({ pid: 123, state: 'timed_out', inflight: 1 });
    expect(f.admission.mock.calls).toEqual([[true], [false]]);
  });
  it('publishes the PID-bound zero-inflight terminal proof before exiting', () => {
    const f = fixture();
    f.drain.begin();
    f.finish();
    vi.advanceTimersByTime(1_000);
    expect(f.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ protocolVersion: 1, pid: 123, state: 'completed', inflight: 0 }),
    );
    expect(f.exit).toHaveBeenCalledOnce();
    expect(f.publish.mock.invocationCallOrder.at(-1)!).toBeLessThan(
      f.exit.mock.invocationCallOrder[0]!,
    );
  });
  it('cancels a failed or interrupted deployment without terminating work', () => {
    const f = fixture();
    f.drain.begin();
    f.drain.cancel();
    vi.advanceTimersByTime(20_000);
    expect(f.exit).not.toHaveBeenCalled();
    expect(f.drain.snapshot().state).toBe('cancelled');
    expect(f.admission).toHaveBeenLastCalledWith(false);
  });
  it('does not exit or stop admission when its proof cannot be persisted', () => {
    const f = fixture();
    f.publish.mockImplementation(() => {
      throw new Error('disk full');
    });
    f.drain.begin();
    expect(f.admission).not.toHaveBeenCalled();
    expect(f.exit).not.toHaveBeenCalled();
    expect(f.drain.snapshot().state).toBe('idle');
    expect(f.errors).toHaveBeenCalledOnce();
  });
});
