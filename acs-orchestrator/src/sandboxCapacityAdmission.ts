import type { CapacityReservations } from './capacityReservations.js';
import {
  enforceSandboxCapacity,
  usageForRef,
} from './sandboxCapacity.js';
import type { AcsOrchestratorConfig } from './config.js';
import { isBackgroundShellProtected, type ManagedSandbox } from './sandboxState.js';
import { isActiveInvocationLeaseProtected } from './sandboxLifecyclePolicy.js';
import type { SandboxRef } from './sandboxManagerTypes.js';

export async function reserveSandboxCapacity(input: {
  ref: SandboxRef;
  config: AcsOrchestratorConfig;
  reservations: CapacityReservations;
  busySandboxNames?: Set<string>;
  skipCapacityManagement?: boolean;
  listSandboxes: () => Promise<ManagedSandbox[]>;
  isBusy: (name: string, busySandboxNames?: Set<string>) => boolean;
  evict: (name: string) => Promise<void>;
  warn: (message: string) => void;
}): Promise<void> {
  if (
    input.config.maxRunningSandboxes <= 0
    && input.config.maxAllocatedCpuMillicores <= 0
    && input.config.maxAllocatedMemoryMib <= 0
  ) return;
  const desiredUsage = usageForRef(input.ref, input.config);
  await input.reservations.reserve(input.ref.name, desiredUsage, async () => {
    const sandboxes = await input.listSandboxes();
    const existingNames = new Set(sandboxes.map((sandbox) => sandbox.name));
    const result = await enforceSandboxCapacity({
      sandboxes,
      currentName: input.ref.name,
      desiredUsage,
      pendingUsage: input.reservations.pendingUsage(existingNames, input.ref.name),
      config: input.config,
      allowEviction: input.config.lifecycleEnabled && input.skipCapacityManagement !== true,
      canEvict: (sandbox) => !input.isBusy(sandbox.name, input.busySandboxNames)
        && !isActiveInvocationLeaseProtected(sandbox, Date.now())
        && !isBackgroundShellProtected(sandbox, Date.now()),
      evict: async (sandbox) => {
        if (input.isBusy(sandbox.name, input.busySandboxNames)
          || isActiveInvocationLeaseProtected(sandbox, Date.now())
          || isBackgroundShellProtected(sandbox, Date.now())) return false;
        await input.evict(sandbox.name);
        return true;
      },
    });
    if (result.evicted.length) input.warn(
      `sandbox_capacity_evicted current=${input.ref.name} count=${result.evicted.length} names=${result.evicted.join(',')}`,
    );
  });
}
