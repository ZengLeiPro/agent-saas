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
    expect(read).toHaveBeenCalledTimes(2);
    expect(store.create).toHaveBeenCalledWith({}, identity, expect.objectContaining({ mode: 'adaptive' }), expect.any(Date));
  });

  it('blocks create, edit, and run while execution is disabled', async () => {
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
});
