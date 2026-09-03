import { describe, expect, it, vi } from 'vitest';

import { reconcileInvocationRestartRecovery } from './invocationRestartRecovery.js';
import type { SandboxManager, SandboxRef } from './sandboxManager.js';
import type { ActiveInvocationLeaseSnapshot } from './sandboxLifecyclePolicy.js';
import { baseConfig, noopLogger } from './sandboxManagerTestFixtures.js';

const ref: SandboxRef = {
  name: 'as-restart-recovery', workspaceId: 'ws-restart', sessionId: 'session-restart',
  sandboxScopeId: 'scope-restart', mountSubPath: 'ws-restart',
};

function lease(input: Partial<ActiveInvocationLeaseSnapshot> = {}): ActiveInvocationLeaseSnapshot {
  return {
    annotationKey: 'agent-saas.kaiyan.net/active-invocation-test',
    raw: '{}', invocationKey: 'lease-restart', until: '2026-09-02T00:00:00.000Z',
    state: 'background_pending', malformed: false, ...input,
  };
}

describe('persisted invocation restart recovery and strict fail-closed sweep', () => {
  it('inventories an expired background_pending lease and protects a live worker before completion', async () => {
    const events: string[] = [];
    const setBackgroundShellProtection = vi.fn(async () => { events.push('protect'); return 'uid-1'; });
    const setActiveInvocationLease = vi.fn(async () => { events.push('completion_pending'); return 'uid-1'; });
    const completeInvocation = vi.fn(async () => { events.push('complete'); return 'uid-1'; });
    const manager = {
      listManagedSandboxes: vi.fn(async () => [{
        ...ref, uid: 'uid-1', activeInvocationLeases: [lease()],
      }]),
      ref: () => ref,
      setBackgroundShellProtection,
      setActiveInvocationLease,
      completeInvocation,
      clearMalformedInvocationLeases: vi.fn(async () => 0),
    } as unknown as SandboxManager;
    const inventory = vi.fn(async () => {
      events.push('inventory');
      return { activeTaskIds: ['shell-live'], protectedUntil: '2026-09-04T00:00:00.000Z' };
    });

    await expect(reconcileInvocationRestartRecovery({
      config: baseConfig(), sandboxManager: manager, logger: noopLogger, inventory,
      reconcilePersistedProtection: vi.fn(async () => undefined),
      now: new Date('2026-09-02T01:00:00.000Z'),
    })).resolves.toEqual({ checked: 1, failed: 0 });

    expect(events).toEqual(['inventory', 'protect', 'completion_pending', 'complete']);
    expect(setBackgroundShellProtection).toHaveBeenCalledWith(
      ref.name, '2026-09-04T00:00:00.000Z', 'uid-1', undefined, 'lease-restart',
    );
    expect(setActiveInvocationLease).toHaveBeenCalledWith(
      ref.name, 'lease-restart', expect.any(String), 'uid-1', undefined,
      'completion_pending', '2026-09-02T01:00:00.000Z',
    );
  });

  it('takes completion activity time only after strict inventory returns', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-02T02:00:00.000Z'));
      const setActiveInvocationLease = vi.fn(async () => 'uid-1');
      const manager = {
        listManagedSandboxes: vi.fn(async () => [{
          ...ref, uid: 'uid-1', activeInvocationLeases: [lease({
            state: 'executing', until: '2026-09-02T01:00:00.000Z',
          })],
        }]),
        ref: () => ref, setActiveInvocationLease,
        completeInvocation: vi.fn(async () => 'uid-1'),
        clearMalformedInvocationLeases: vi.fn(async () => 0),
      } as unknown as SandboxManager;

      await reconcileInvocationRestartRecovery({
        config: baseConfig(), sandboxManager: manager, logger: noopLogger,
        inventory: vi.fn(async () => {
          vi.setSystemTime(new Date('2026-09-02T03:00:00.000Z'));
          return { activeTaskIds: [] };
        }),
        reconcilePersistedProtection: vi.fn(async () => undefined),
      });

      expect(setActiveInvocationLease).toHaveBeenCalledWith(
        ref.name, 'lease-restart', expect.any(String), 'uid-1', undefined,
        'completion_pending', '2026-09-02T03:00:00.000Z',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the lease when live-worker protection expires during persistence', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-02T02:00:00.000Z'));
      const setActiveInvocationLease = vi.fn();
      const completeInvocation = vi.fn();
      const manager = {
        listManagedSandboxes: vi.fn(async () => [{
          ...ref, uid: 'uid-1', activeInvocationLeases: [lease({
            state: 'executing', until: '2026-09-02T01:00:00.000Z',
          })],
        }]),
        ref: () => ref,
        setBackgroundShellProtection: vi.fn(async () => {
          vi.setSystemTime(new Date('2026-09-02T02:00:07.000Z'));
          return 'uid-1';
        }),
        setActiveInvocationLease, completeInvocation,
        clearMalformedInvocationLeases: vi.fn(async () => 0),
      } as unknown as SandboxManager;

      await expect(reconcileInvocationRestartRecovery({
        config: baseConfig(), sandboxManager: manager, logger: noopLogger,
        inventory: vi.fn(async () => ({
          activeTaskIds: ['shell-live'], protectedUntil: '2026-09-02T02:00:06.000Z',
        })),
        reconcilePersistedProtection: vi.fn(async () => undefined),
      })).resolves.toEqual({ checked: 1, failed: 1 });
      expect(setActiveInvocationLease).not.toHaveBeenCalled();
      expect(completeInvocation).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the exact persisted completedAt again on the second restart', async () => {
    const completedAt = '2026-09-02T03:04:05.678Z';
    const completeInvocation = vi.fn()
      .mockRejectedValueOnce(new Error('apiserver unavailable'))
      .mockResolvedValueOnce('uid-1');
    const manager = {
      listManagedSandboxes: vi.fn(async () => [{
        ...ref, uid: 'uid-1', activeInvocationLeases: [lease({
          state: 'completion_pending', completedAt, until: '2026-09-02T00:00:00.000Z',
        })],
      }]),
      completeInvocation,
      clearMalformedInvocationLeases: vi.fn(async () => 0),
    } as unknown as SandboxManager;
    const input = {
      config: baseConfig(), sandboxManager: manager, logger: noopLogger,
      inventory: vi.fn(), reconcilePersistedProtection: vi.fn(async () => undefined),
      now: new Date('2026-09-03T00:00:00.000Z'),
    };

    await expect(reconcileInvocationRestartRecovery(input)).resolves.toEqual({ checked: 1, failed: 1 });
    await expect(reconcileInvocationRestartRecovery(input)).resolves.toEqual({ checked: 1, failed: 0 });
    expect(completeInvocation).toHaveBeenCalledTimes(2);
    expect(completeInvocation.mock.calls.map((call) => (call[2] as Date).toISOString()))
      .toEqual([completedAt, completedAt]);
    expect(input.inventory).not.toHaveBeenCalled();
  });

  it('keeps an unexpired background_pending lease while strict inventory is still empty', async () => {
    const completeInvocation = vi.fn();
    const manager = {
      listManagedSandboxes: vi.fn(async () => [{
        ...ref, uid: 'uid-1', activeInvocationLeases: [lease({ until: '2026-09-02T02:00:00.000Z' })],
      }]),
      ref: () => ref,
      setBackgroundShellProtection: vi.fn(), setActiveInvocationLease: vi.fn(),
      completeInvocation, clearMalformedInvocationLeases: vi.fn(async () => 0),
    } as unknown as SandboxManager;

    await expect(reconcileInvocationRestartRecovery({
      config: baseConfig(), sandboxManager: manager, logger: noopLogger,
      inventory: vi.fn(async () => ({ activeTaskIds: [] })),
      reconcilePersistedProtection: vi.fn(async () => undefined),
      now: new Date('2026-09-02T01:00:00.000Z'),
    })).resolves.toEqual({ checked: 1, failed: 0 });
    expect(completeInvocation).not.toHaveBeenCalled();
  });

  it('does not sweep a malformed lease when strict inventory fails', async () => {
    const clearMalformedInvocationLeases = vi.fn();
    const touch = vi.fn();
    const manager = {
      listManagedSandboxes: vi.fn(async () => [{
        ...ref, uid: 'uid-1', activeInvocationLeases: [lease({
          invocationKey: undefined, until: undefined, state: 'unknown', malformed: true,
        })],
      }]),
      ref: () => ref, clearMalformedInvocationLeases, touch,
    } as unknown as SandboxManager;

    await expect(reconcileInvocationRestartRecovery({
      config: baseConfig(), sandboxManager: manager, logger: noopLogger,
      inventory: vi.fn(async () => { throw new Error('inventory unavailable'); }),
      reconcilePersistedProtection: vi.fn(async () => undefined),
      now: new Date('2026-09-02T01:00:00.000Z'),
    })).resolves.toEqual({ checked: 1, failed: 1 });
    expect(touch).not.toHaveBeenCalled();
    expect(clearMalformedInvocationLeases).not.toHaveBeenCalled();
  });

  it('touches before clearing a malformed lease after strict inventory proves no worker', async () => {
    const events: string[] = [];
    const manager = {
      listManagedSandboxes: vi.fn(async () => [{
        ...ref, uid: 'uid-1', activeInvocationLeases: [lease({
          invocationKey: undefined, until: undefined, state: 'unknown', malformed: true,
        })],
      }]),
      ref: () => ref,
      touch: vi.fn(async () => { events.push('touch'); }),
      clearMalformedInvocationLeases: vi.fn(async () => { events.push('clear'); return 1; }),
    } as unknown as SandboxManager;

    await expect(reconcileInvocationRestartRecovery({
      config: baseConfig(), sandboxManager: manager, logger: noopLogger,
      inventory: vi.fn(async () => { events.push('inventory'); return { activeTaskIds: [] }; }),
      reconcilePersistedProtection: vi.fn(async () => undefined),
      now: new Date('2026-09-02T01:00:00.000Z'),
    })).resolves.toEqual({ checked: 1, failed: 0 });
    expect(events).toEqual(['inventory', 'touch', 'clear']);
  });
});
