import { vi } from 'vitest';

import { SANDBOX_NETWORK_CLEANUP_FINALIZER } from './sandboxDeletion.js';
import { SandboxManager } from './sandboxManager.js';

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
        status: { phase: sandbox.phase ?? 'Unknown' },
      },
    };
  });
}

export function isRawSandboxDelete(args: string[], name: string): boolean {
  return args[0] === 'delete' && Boolean(args[1]?.includes(`/sandboxes/${name}`));
}
