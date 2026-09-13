import { describe, expect, it } from 'vitest';
import { RuntimeDrainState } from './runtimeDrainState.js';

describe('runtime drain outcome', () => {
  it('does not normalize a rejected quiesce into successful retirement', async () => {
    const drain = new RuntimeDrainState();
    const errors: unknown[] = [];
    await drain.quiesce(
      async () => {
        throw new Error('private detail');
      },
      (error) => errors.push(error),
    );
    expect(errors).toHaveLength(1);
    expect(drain.runtimeQuiesced).toBe(false);
    expect(drain.complete(0, 0)).toBe(false);
    expect(drain.snapshot()).toMatchObject({
      drainState: 'failed',
      reason: 'runtime_quiesce_failed',
    });
    expect(JSON.stringify(drain.snapshot())).not.toContain('private detail');
  });
  it('requires quiescence and both stream and upload counts to reach zero', async () => {
    const drain = new RuntimeDrainState();
    expect(drain.complete(0, 0)).toBe(false);
    await drain.quiesce(
      async () => {},
      () => {},
    );
    expect(drain.complete(1, 0)).toBe(false);
    expect(drain.complete(0, 1)).toBe(false);
    expect(drain.complete(0, 0, 1)).toBe(false);
    expect(drain.complete(0, 0)).toBe(true);
    expect(drain.snapshot().drainState).toBe('completed');
    drain.fail('shutdown_cleanup_failed');
    expect(drain.snapshot()).toMatchObject({
      drainState: 'completed',
      runtimeQuiesced: true,
      cleanupStatus: 'failed',
      cleanupReason: 'shutdown_cleanup_failed',
    });
    expect(drain.runtimeQuiesced).toBe(true);
  });
  it('does not turn late quiescence or cleanup failure into normal completion', async () => {
    let resolve!: () => void;
    const drain = new RuntimeDrainState();
    const pending = drain.quiesce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
      () => {},
    );
    drain.timeout();
    resolve();
    await pending;
    expect(drain.complete(0, 0)).toBe(false);
    expect(drain.runtimeQuiesced).toBe(false);
    expect(drain.snapshot().drainState).toBe('timed_out');
    drain.fail('shutdown_cleanup_failed');
    expect(drain.snapshot().drainState).toBe('failed');
  });
  it('ignores timeout after the drain already completed', async () => {
    const drain = new RuntimeDrainState();
    await drain.quiesce(async () => {}, () => {});
    expect(drain.complete(0, 0)).toBe(true);
    drain.timeout();
    expect(drain.snapshot().drainState).toBe('completed');
    expect(drain.runtimeQuiesced).toBe(true);
  });
});
