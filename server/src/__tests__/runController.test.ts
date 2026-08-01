import { describe, expect, it } from 'vitest';

import { runtimeRunController } from '../runtime/runController.js';

describe('runtimeRunController', () => {
  it('aborts every drain-interruptible run once, preserves reason, and leaves durable background work alone', () => {
    const first = new AbortController();
    const second = new AbortController();
    const durable = new AbortController();
    runtimeRunController.register('drain-run-1', first);
    runtimeRunController.register('drain-run-2', second);
    runtimeRunController.register('durable-background-run', durable, { abortOnDrain: false });

    try {
      expect(runtimeRunController.abortAllForDrain('server_drain_deadline')).toBe(2);
      expect(first.signal.aborted).toBe(true);
      expect(second.signal.aborted).toBe(true);
      expect(durable.signal.aborted).toBe(false);
      expect(first.signal.reason).toMatchObject({ message: 'server_drain_deadline' });
      expect(second.signal.reason).toMatchObject({ message: 'server_drain_deadline' });
      expect(runtimeRunController.abortAllForDrain('duplicate')).toBe(0);
    } finally {
      runtimeRunController.unregister('drain-run-1');
      runtimeRunController.unregister('drain-run-2');
      runtimeRunController.unregister('durable-background-run');
    }
  });
});
