import { vi } from 'vitest';

import { SANDBOX_NETWORK_CLEANUP_FINALIZER } from './sandboxDeletion.js';
import { SandboxManager } from './sandboxManager.js';

/** Rebuilds a persisted final read, including transient broken-state evidence. */
export function mockCurrentSandboxStatusReads(manager: SandboxManager): void {
  const getStatus = manager.getStatus.bind(manager);
  vi.spyOn(manager, 'getStatus').mockImplementation(async (name) => {
    const sandbox = (await manager.listManagedSandboxes()).find((entry) => entry.name === name);
    if (!sandbox) return await getStatus(name);
    const workloadClass = sandbox.workloadClass ?? 'unknown';
    return {
      phase: sandbox.phase ?? 'Unknown',
      raw: {
        metadata: {
          name, uid: `uid-${name}`, resourceVersion: '1',
          finalizers: [SANDBOX_NETWORK_CLEANUP_FINALIZER],
          labels: { 'agent-saas.kaiyan.net/workload-class': workloadClass },
          annotations: {
            ...(sandbox.createdAt ? { 'agent-saas.kaiyan.net/created-at': sandbox.createdAt } : {}),
            ...(sandbox.lastActiveAt ? { 'agent-saas.kaiyan.net/last-active-at': sandbox.lastActiveAt } : {}),
            'agent-saas.kaiyan.net/workload-descriptor': JSON.stringify({ class: workloadClass }),
          },
        },
        ...(sandbox.brokenReason === 'requested_running'
          ? { spec: { paused: false } }
          : sandbox.brokenReason === 'image_changed' ? { spec: { paused: true } } : {}),
        status: {
          phase: sandbox.phase ?? 'Unknown',
          ...(sandbox.brokenReason === 'image_changed' || sandbox.brokenReason === 'requested_running' ? {
            conditions: [{
              type: 'SandboxPaused', status: 'False',
              reason: sandbox.brokenReason === 'image_changed' ? 'ImageChanged' : 'RequestedRunning',
              ...(sandbox.pausedConditionChangedAt
                ? { lastTransitionTime: sandbox.pausedConditionChangedAt } : {}),
            }],
          } : {}),
        },
      },
    };
  });
}

export function isRawSandboxDelete(args: string[], name: string): boolean {
  return args[0] === 'delete' && Boolean(args[1]?.includes(`/sandboxes/${name}`));
}
