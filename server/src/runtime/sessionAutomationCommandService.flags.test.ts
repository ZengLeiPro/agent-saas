import { describe, expect, it, vi } from 'vitest';
import { SessionAutomationCommandService } from './sessionAutomationCommandService.js';
import { resolveSessionAutomationFlags, type PartialSessionAutomationFeatureFlags } from './sessionAutomationFlags.js';

function staticSource(flags: PartialSessionAutomationFeatureFlags) {
  return { read: () => resolveSessionAutomationFlags(flags) };
}

const identity = { tenantId: 'tenant-1', sessionId: 'session-1', ownerUserId: 'user-1' };
const snapshot = {
  tenantId: identity.tenantId, sessionId: identity.sessionId, ownerUserId: identity.ownerUserId,
  automationId: 'automation-1', incarnationId: 'incarnation-1', controlVersion: 1,
  status: 'active', phase: 'running', generation: 1, specVersion: 1,
  spec: { kind: 'loop', mode: 'adaptive', prompt: 'work' },
};

describe('SessionAutomationCommandService live kill-switch controls', () => {
  it('allows clear to close existing work when execution and general control are disabled', async () => {
    const store = {
      tx: vi.fn(async (fn: (c: object) => unknown) => fn({})),
      findCommand: vi.fn(async () => undefined),
      getLockedForOwner: vi.fn(async () => snapshot),
      control: vi.fn(async () => ({ ...snapshot, status: 'cancelling', phase: 'draining' })),
      recordCommand: vi.fn(async () => 'cursor-1'),
      publish: vi.fn(),
    };
    const service = new SessionAutomationCommandService(store as never, staticSource({
      controlEnabled: false, executionEnabled: false, fixedLoopEnabled: false,
      adaptiveLoopEnabled: false, goalEnabled: false, evaluatorEnforced: false,
    }), { authorize: vi.fn(async () => undefined) });

    const result = await service.control(identity, snapshot.automationId, {
      clientMessageId: 'clear-1', action: 'clear', expectedControlVersion: 1,
      expectedIncarnationId: snapshot.incarnationId,
    });
    expect(result.snapshot).toMatchObject({ status: 'cancelling', phase: 'draining' });
    expect(store.control).toHaveBeenCalledWith({}, snapshot, 'clear');
  });

  it.each(['completing', 'cancelling', 'reconcile_required'] as const)('rejects replace while %s without creating a generation or wakeup', async status => {
    const draining = { ...snapshot, status, phase: 'draining' };
    const store = {
      tx: vi.fn(async (fn: (c: object) => unknown) => fn({})), findCommand: vi.fn(async () => undefined),
      getLiveForOwner: vi.fn(async () => draining), replace: vi.fn(), create: vi.fn(), recordCommand: vi.fn(), publish: vi.fn(),
    };
    const service = new SessionAutomationCommandService(store as never, staticSource({
      controlEnabled: true, executionEnabled: true, fixedLoopEnabled: true,
      adaptiveLoopEnabled: true, goalEnabled: true, evaluatorEnforced: true,
    }), { authorize: vi.fn(async () => undefined) });

    await expect(service.command(identity, { clientMessageId: `replace-${status}`, command: '/loop replace -- work' }))
      .rejects.toMatchObject({ code: 'AUTOMATION_DRAINING' });
    expect(store.replace).not.toHaveBeenCalled();
    expect(store.create).not.toHaveBeenCalled();
  });

  it('reads the source for every command and restores create after false-to-true', async () => {
    const store = {
      tx: vi.fn(async (fn: (c: object) => unknown) => fn({})),
      findCommand: vi.fn(async () => undefined),
      getLiveForOwner: vi.fn(async () => undefined),
      create: vi.fn(async () => snapshot),
      recordCommand: vi.fn(async () => 'cursor-1'),
      publish: vi.fn(),
    };
    let executionEnabled = false;
    const read = vi.fn(() => resolveSessionAutomationFlags({
      controlEnabled: true, executionEnabled, fixedLoopEnabled: true,
      adaptiveLoopEnabled: true, goalEnabled: true, evaluatorEnforced: true,
    }));
    const service = new SessionAutomationCommandService(
      store as never,
      { read },
      { authorize: vi.fn(async () => undefined) },
    );
    const input = { clientMessageId: 'create-1', command: '/loop -- work' };

    await expect(service.command(identity, input))
      .rejects.toMatchObject({ code: 'EXECUTION_DISABLED' });
    expect(store.tx).not.toHaveBeenCalled();

    executionEnabled = true;
    await expect(service.command(identity, input))
      .resolves.toMatchObject({ result: 'created' });
    expect(read).toHaveBeenCalledTimes(3);
    expect(store.create).toHaveBeenCalledWith({}, identity, expect.objectContaining({ mode: 'adaptive' }), expect.any(Date), expect.any(Function));
  });

  it('blocks create, edit, and run while the execution kill switch is disabled', async () => {
    const store = { tx: vi.fn() };
    const service = new SessionAutomationCommandService(
      store as never,
      staticSource({ controlEnabled: true, executionEnabled: false }),
      { authorize: vi.fn(async () => undefined) },
    );

    await expect(service.command(identity, { clientMessageId: 'create-1', command: '/loop -- work' }))
      .rejects.toMatchObject({ code: 'EXECUTION_DISABLED' });
    await expect(service.command(identity, { clientMessageId: 'run-1', command: '/loop run' }))
      .rejects.toMatchObject({ code: 'EXECUTION_DISABLED' });
    await expect(service.edit(identity, snapshot.automationId, {
      clientMessageId: 'edit-1', payload: { prompt: 'new work' }, expectedControlVersion: 1,
      expectedIncarnationId: snapshot.incarnationId,
    })).rejects.toMatchObject({ code: 'EXECUTION_DISABLED' });
    expect(store.tx).not.toHaveBeenCalled();
  });

  it('includes sessionId in canonical control digests so the same clientMessageId cannot replay across sessions', async () => {
    const digests: string[] = [];
    const store = {
      tx: vi.fn(async (fn: (c: object) => unknown) => fn({})),
      findCommand: vi.fn(async (_c: object, _id: object, _messageId: string, digest: string) => { digests.push(digest); return undefined; }),
      getLockedForOwner: vi.fn(async (_c: object, id: typeof identity) => ({ ...snapshot, sessionId: id.sessionId })),
      control: vi.fn(async (_c: object, current: typeof snapshot) => current),
      recordCommand: vi.fn(async () => 'cursor-1'),
      publish: vi.fn(),
    };
    const service = new SessionAutomationCommandService(store as never, staticSource({
      controlEnabled: true, executionEnabled: true, adaptiveLoopEnabled: true,
    }), { authorize: vi.fn(async () => undefined) });
    const input = { clientMessageId: 'shared-message', action: 'pause' as const, expectedControlVersion: 1, expectedIncarnationId: snapshot.incarnationId };

    await service.control(identity, snapshot.automationId, input);
    await service.control({ ...identity, sessionId: 'session-2' }, snapshot.automationId, input);

    expect(digests).toHaveLength(2);
    expect(digests[0]).not.toBe(digests[1]);
  });

  it('accepts a budget-only edit, preserves unspecified dimensions, and clamps tenant credits', async () => {
    const current = { ...snapshot, spec: { kind: 'goal', mode: 'goal', condition: 'ship', budget: { maxTurns: 20, maxTokens: 250000, maxCredits: 4 } } };
    const store = { tx: vi.fn(async (fn: (c: object) => unknown) => fn({})), findCommand: vi.fn(async () => undefined),
      getLockedForOwner: vi.fn(async () => current), replace: vi.fn(async (_c: object, _current: object, spec: object) => ({ ...current, spec })),
      recordCommand: vi.fn(async () => 'cursor-1'), publish: vi.fn() };
    const service = new SessionAutomationCommandService(store as never, staticSource({ controlEnabled: true, executionEnabled: true, goalEnabled: true, evaluatorEnforced: true }), { authorize: vi.fn(async () => ({ maxCredits: 5 })) });
    await expect(service.edit(identity, snapshot.automationId, { clientMessageId: 'budget-edit', payload: { budget: { maxTurns: 30, maxCredits: 9 } }, expectedControlVersion: 1, expectedIncarnationId: snapshot.incarnationId })).resolves.toMatchObject({ snapshot: { spec: { budget: { maxTurns: 30, maxTokens: 250000, maxCredits: 5 } } } });
  });

  it('rejects edit immediately after clear enters drain', async () => {
    const draining = { ...snapshot, status: 'cancelling', phase: 'draining', controlVersion: 2 };
    const store = {
      tx: vi.fn(async (fn: (c: object) => unknown) => fn({})), findCommand: vi.fn(async () => undefined),
      getLockedForOwner: vi.fn(async () => draining), replace: vi.fn(), recordCommand: vi.fn(), publish: vi.fn(),
    };
    const service = new SessionAutomationCommandService(store as never, staticSource({
      controlEnabled: true, executionEnabled: true, fixedLoopEnabled: true,
      adaptiveLoopEnabled: true, goalEnabled: true, evaluatorEnforced: true,
    }), { authorize: vi.fn(async () => undefined) });

    await expect(service.edit(identity, snapshot.automationId, {
      clientMessageId: 'edit-draining', payload: { prompt: 'new work' }, expectedControlVersion: 2,
      expectedIncarnationId: snapshot.incarnationId,
    })).rejects.toMatchObject({ code: 'AUTOMATION_DRAINING' });
    expect(store.replace).not.toHaveBeenCalled();
  });

  it.each([
    ['create', '/loop -- work', undefined],
    ['replace', '/loop replace -- work', snapshot],
    ['resume', '/loop resume', snapshot],
    ['run', '/loop run', snapshot],
  ] as const)('rechecks %s after authorization at the final transaction write boundary', async (_action, command, live) => {
    let executionEnabled = true;
    const store = {
      tx: vi.fn(async (fn: (c: object) => unknown) => fn({})), findCommand: vi.fn(async () => undefined),
      getLiveForOwner: vi.fn(async () => live), create: vi.fn(async () => snapshot),
      replace: vi.fn(async () => snapshot), control: vi.fn(async () => snapshot), recordCommand: vi.fn(), publish: vi.fn(),
    };
    const service = new SessionAutomationCommandService(store as never, { read: () => resolveSessionAutomationFlags({
      controlEnabled: true, executionEnabled, fixedLoopEnabled: true, adaptiveLoopEnabled: true,
      goalEnabled: true, evaluatorEnforced: true,
    }) }, { authorize: vi.fn(async () => { executionEnabled = false; }) });

    await expect(service.command(identity, { clientMessageId: `boundary-${_action}`, command }))
      .rejects.toMatchObject({ code: 'EXECUTION_DISABLED' });
    expect(store.create).not.toHaveBeenCalled();
    expect(store.replace).not.toHaveBeenCalled();
    expect(store.control).not.toHaveBeenCalled();
  });

  it('applies the tenant credit cap as a default and clamps explicit overrides', async () => {
    const createdSpecs: Array<{budget:{maxCredits?:number}}> = [];
    const store = {
      tx: vi.fn(async (fn: (c: object) => unknown) => fn({})), findCommand: vi.fn(async () => undefined),
      getLiveForOwner: vi.fn(async () => undefined),
      create: vi.fn(async (_c: object, _id: object, spec: {budget:{maxCredits?:number}}) => {
        createdSpecs.push(spec); return { ...snapshot, spec };
      }), recordCommand: vi.fn(async () => 'cursor-1'), publish: vi.fn(),
    };
    const service = new SessionAutomationCommandService(store as never, staticSource({
      controlEnabled: true, executionEnabled: true, adaptiveLoopEnabled: true,
    }), { authorize: vi.fn(async () => ({ maxCredits: 5 })) });
    await service.command(identity, { clientMessageId: 'cap-default', command: '/loop -- work' });
    await service.command(identity, { clientMessageId: 'cap-clamp', command: '/loop --max-credits 10 -- work' });
    expect(createdSpecs.map(spec => spec.budget.maxCredits)).toEqual([5, 5]);
  });

  it('rechecks after the locked row wait and permits a fresh true after true-to-false-to-true', async () => {
    let executionEnabled = true;
    const transitions: boolean[] = [];
    const store = {
      tx: vi.fn(async (fn: (c: object) => unknown) => fn({})), findCommand: vi.fn(async () => undefined),
      getLiveForOwner: vi.fn(async () => {
        executionEnabled = false; transitions.push(executionEnabled);
        executionEnabled = true; transitions.push(executionEnabled);
        return undefined;
      }),
      create: vi.fn(async () => snapshot), recordCommand: vi.fn(async () => 'cursor-1'), publish: vi.fn(),
    };
    const service = new SessionAutomationCommandService(store as never, { read: () => resolveSessionAutomationFlags({
      controlEnabled: true, executionEnabled, adaptiveLoopEnabled: true,
    }) }, { authorize: vi.fn(async () => undefined) });

    await expect(service.command(identity, { clientMessageId: 'toggle-create', command: '/loop -- work' }))
      .resolves.toMatchObject({ result: 'created' });
    expect(transitions).toEqual([false, true]);
    expect(store.create).toHaveBeenCalledTimes(1);
  });

});
