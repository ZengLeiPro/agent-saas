import type { AcsOrchestratorConfig } from './config.js';
import { sandboxResourcePreconditions, type SandboxDeletionPreconditions } from './sandboxDeletion.js';
import { managedSandboxFromResource } from './sandboxInventoryReader.js';
import { isActiveInvocationLeaseProtected } from './sandboxLifecyclePolicy.js';
import { SandboxMutationPreconditionError } from './sandboxLifecycleMutations.js';
import { isBackgroundShellProtected, type ManagedSandbox, type SandboxStatus } from './sandboxState.js';

export async function pauseSandboxWhenIdle(input: {
  name: string;
  config: AcsOrchestratorConfig;
  isBusy(): boolean;
  isEnsuring(): boolean;
  getStatus(): Promise<SandboxStatus | null>;
  canPause(latest: ManagedSandbox): boolean;
  pause(preconditions: SandboxDeletionPreconditions): Promise<void>;
}): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (input.isBusy() || input.isEnsuring()) return false;
    const status = await input.getStatus();
    if (!status) return false;
    const raw = status.raw ?? {};
    const metadata = raw.metadata && typeof raw.metadata === 'object' ? raw.metadata as Record<string, unknown> : {};
    const latest = managedSandboxFromResource(input.config, {
      ...raw,
      metadata: { ...metadata, name: input.name },
      status: { ...(raw.status && typeof raw.status === 'object' ? raw.status as Record<string, unknown> : {}), phase: status.phase },
    });
    const nowMs = Date.now();
    const preconditions = sandboxResourcePreconditions(status);
    if (!preconditions || isActiveInvocationLeaseProtected(latest, nowMs)
      || isBackgroundShellProtected(latest, nowMs) || input.isBusy() || input.isEnsuring()
      || !input.canPause(latest)) return false;
    try {
      await input.pause(preconditions);
      return true;
    } catch (err) {
      if (!(err instanceof SandboxMutationPreconditionError)) throw err;
    }
  }
  return false;
}
