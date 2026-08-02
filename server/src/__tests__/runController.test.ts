import { afterEach, describe, expect, it } from 'vitest';

import type { RuntimeDrainHandoffState } from '../agent/types.js';
import { runtimeRunController } from '../runtime/runController.js';

const runIds: string[] = [];
afterEach(() => {
  for (const runId of runIds.splice(0)) runtimeRunController.unregister(runId);
});

describe('runtimeRunController', () => {
  it('requests cooperative drain handoff without aborting foreground runs', () => {
    const controller = new AbortController();
    const durable = new AbortController();
    const drainHandoff: RuntimeDrainHandoffState = { requested: false };
    runtimeRunController.register('handoff-run', controller, { drainHandoff });
    runtimeRunController.register('handoff-background-run', durable, {
      abortOnDrain: false,
      drainHandoff: { requested: false },
    });

    try {
      expect(runtimeRunController.requestAllForDrain('server_drain_handoff')).toBe(1);
      expect(drainHandoff).toMatchObject({
        requested: true,
        reason: 'server_drain_handoff',
      });
      expect(drainHandoff.requestedAt).toEqual(expect.any(String));
      expect(controller.signal.aborted).toBe(false);
      expect(durable.signal.aborted).toBe(false);
      expect(runtimeRunController.requestAllForDrain('duplicate')).toBe(0);
    } finally {
      runtimeRunController.unregister('handoff-run');
      runtimeRunController.unregister('handoff-background-run');
    }
  });

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
