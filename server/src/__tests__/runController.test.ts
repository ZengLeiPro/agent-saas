import { afterEach, describe, expect, it } from 'vitest';

import { runtimeRunController } from '../runtime/runController.js';

const runIds: string[] = [];
afterEach(() => {
  for (const runId of runIds.splice(0)) runtimeRunController.unregister(runId);
});

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

  it('aborts every registered background or raw run owned by one immutable user only', () => {
    const aliceAgent = new AbortController();
    const aliceCommand = new AbortController();
    const bobAgent = new AbortController();
    runtimeRunController.register('alice-agent', aliceAgent, { userId: 'user-alice' });
    runtimeRunController.register('alice-command', aliceCommand, { userId: 'user-alice' });
    runtimeRunController.register('bob-agent', bobAgent, { userId: 'user-bob' });
    runIds.push('alice-agent', 'alice-command', 'bob-agent');

    expect(runtimeRunController.abortByUser('user-alice', 'user access revoked')).toBe(2);
    expect(aliceAgent.signal.aborted).toBe(true);
    expect(aliceCommand.signal.aborted).toBe(true);
    expect(bobAgent.signal.aborted).toBe(false);
  });
});
