import type { AcsOrchestratorConfig } from './config.js';
import type { SandboxDeletionPreconditions } from './sandboxDeletion.js';
import { SandboxMutationPreconditionError } from './sandboxLifecycleMutations.js';
import {
  readSandboxMutationGate,
  SandboxDestructiveMutationBlockedError,
} from './sandboxMutationGate.js';
import type { ManagedSandbox, SandboxStatus } from './sandboxState.js';

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
    try {
      const gate = await readSandboxMutationGate({
        name: input.name,
        config: input.config,
        isBusy: input.isBusy,
        isEnsuring: input.isEnsuring,
        getStatus: input.getStatus,
        canMutate: input.canPause,
      });
      if (!gate) return false;
      await input.pause(gate.preconditions);
      return true;
    } catch (err) {
      if (err instanceof SandboxDestructiveMutationBlockedError) return false;
      if (!(err instanceof SandboxMutationPreconditionError)) throw err;
    }
  }
  return false;
}
