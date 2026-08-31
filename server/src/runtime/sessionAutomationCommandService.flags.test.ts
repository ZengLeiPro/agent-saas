import { describe, expect, it, vi } from 'vitest';
import { SessionAutomationCommandService } from './sessionAutomationCommandService.js';

const identity = { tenantId: 'tenant-1', sessionId: 'session-1', ownerUserId: 'user-1' };
const snapshot = {
  tenantId: identity.tenantId, sessionId: identity.sessionId, ownerUserId: identity.ownerUserId,
  automationId: 'automation-1', incarnationId: 'incarnation-1', controlVersion: 1,
  status: 'active', phase: 'running', generation: 1, specVersion: 1,
  spec: { kind: 'loop', mode: 'adaptive', prompt: 'work' },
};

describe('SessionAutomationCommandService kill-switch controls', () => {
  it('allows clear to close existing work when execution and general control are disabled', async () => {
    const store = {
      tx: vi.fn(async (fn: (c: object) => unknown) => fn({})),
      findCommand: vi.fn(async () => undefined),
      getLockedForOwner: vi.fn(async () => snapshot),
      control: vi.fn(async () => ({ ...snapshot, status: 'cancelling', phase: 'draining' })),
      recordCommand: vi.fn(async () => 'cursor-1'),
      publish: vi.fn(),
    };
    const service = new SessionAutomationCommandService(store as never, {
      controlEnabled: false, executionEnabled: false, fixedLoopEnabled: false,
      adaptiveLoopEnabled: false, goalEnabled: false, evaluatorEnforced: false,
    }, { authorize: vi.fn(async () => undefined) });

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
    const service = new SessionAutomationCommandService(store as never, {
      controlEnabled: true, executionEnabled: true, fixedLoopEnabled: true,
      adaptiveLoopEnabled: true, goalEnabled: true, evaluatorEnforced: true,
    }, { authorize: vi.fn(async () => undefined) });

    await expect(service.command(identity, { clientMessageId: `replace-${status}`, command: '/loop replace -- work' }))
      .rejects.toMatchObject({ code: 'AUTOMATION_DRAINING' });
    expect(store.replace).not.toHaveBeenCalled();
    expect(store.create).not.toHaveBeenCalled();
  });

  it('rejects edit immediately after clear enters drain', async () => {
    const draining = { ...snapshot, status: 'cancelling', phase: 'draining', controlVersion: 2 };
    const store = {
      tx: vi.fn(async (fn: (c: object) => unknown) => fn({})), findCommand: vi.fn(async () => undefined),
      getLockedForOwner: vi.fn(async () => draining), replace: vi.fn(), recordCommand: vi.fn(), publish: vi.fn(),
    };
    const service = new SessionAutomationCommandService(store as never, {
      controlEnabled: true, executionEnabled: true, fixedLoopEnabled: true,
      adaptiveLoopEnabled: true, goalEnabled: true, evaluatorEnforced: true,
    }, { authorize: vi.fn(async () => undefined) });

    await expect(service.edit(identity, snapshot.automationId, {
      clientMessageId: 'edit-draining', payload: { prompt: 'new work' }, expectedControlVersion: 2,
      expectedIncarnationId: snapshot.incarnationId,
    })).rejects.toMatchObject({ code: 'AUTOMATION_DRAINING' });
    expect(store.replace).not.toHaveBeenCalled();
  });
});
