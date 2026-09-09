import { describe, expect, it, vi } from 'vitest';
import {
  activeInvocationLeaseAnnotationKey, activeInvocationLeaseSnapshots,
  expiredActiveInvocationLeaseAnnotationKeys, malformedActiveInvocationLeaseAnnotationKeys,
} from './sandboxLifecyclePolicy.js';
import { reconcileInvocationRestartRecovery } from './invocationRestartRecovery.js';
import type { AcsOrchestratorConfig } from './config.js';
import type { SandboxManager, SandboxRef } from './sandboxManager.js';

const ref: SandboxRef = {
  name: 'as-test', workspaceId: 'ws-test', sessionId: 'session-test',
  sandboxScopeId: 'scope-test', mountSubPath: 'workspaces/test',
};

describe('ACS actual ownership-reader regressions', () => {
  it('R26 never TTL-sweeps a future or unrecognised ownership state', () => {
    const key = activeInvocationLeaseAnnotationKey('old-attempt');
    const annotations = {
      [key]: JSON.stringify({ invocationKey: 'old-attempt', until: '2000-01-01T00:00:00Z', state: 'remote_unknown' }),
    };
    expect(expiredActiveInvocationLeaseAnnotationKeys(annotations, Date.now())).toEqual([]);
    expect(malformedActiveInvocationLeaseAnnotationKeys(annotations, Date.now())).toEqual([]);
  });

  it('R10 R26 empty background inventory cannot prove an expired foreground writer stopped', async () => {
    const key = activeInvocationLeaseAnnotationKey('foreground-attempt');
    const leases = activeInvocationLeaseSnapshots({
      [key]: JSON.stringify({ invocationKey: 'foreground-attempt', until: '2000-01-01T00:00:00Z', state: 'executing' }),
    });
    const completeInvocation = vi.fn(async () => 'uid-1');
    const setActiveInvocationLease = vi.fn(async () => 'uid-1');
    const manager = {
      listManagedSandboxes: vi.fn(async () => [{ ...ref, uid: 'uid-1', activeInvocationLeases: leases }]),
      ref: () => ref, completeInvocation, setActiveInvocationLease,
      setBackgroundShellProtection: vi.fn(async () => 'uid-1'),
      clearMalformedInvocationLeases: vi.fn(async () => 0),
      touch: vi.fn(async () => undefined),
    } as unknown as SandboxManager;
    await reconcileInvocationRestartRecovery({
      config: { execTimeoutMs: 100, sandboxWaitTimeoutMs: 100 } as AcsOrchestratorConfig,
      sandboxManager: manager,
      logger: { info: vi.fn(), warn: vi.fn() },
      inventory: vi.fn(async () => ({ activeTaskIds: [] })),
      reconcilePersistedProtection: vi.fn(async () => undefined),
      now: new Date('2026-09-09T00:00:00Z'),
    });
    expect(completeInvocation).not.toHaveBeenCalled();
    expect(setActiveInvocationLease).not.toHaveBeenCalledWith(
      ref.name, 'foreground-attempt', expect.any(String), 'uid-1', undefined, 'completion_pending', expect.any(String),
    );
  });
});
