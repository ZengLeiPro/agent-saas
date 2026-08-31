import type { AcsOrchestratorConfig } from './config.js';
import {
  SandboxDeletionPreconditionError,
  type SandboxDeletionPreconditions,
} from './sandboxDeletion.js';
import {
  readSandboxMutationGate,
  SandboxDestructiveMutationBlockedError,
} from './sandboxMutationGate.js';
import type { ManagedSandbox, SandboxStatus } from './sandboxState.js';

export async function deleteSandboxWhenIdle(input: {
  name: string;
  config: AcsOrchestratorConfig;
  isBusy(): boolean;
  isEnsuring(): boolean;
  getStatus(): Promise<SandboxStatus | null>;
  canDelete?: (latest: ManagedSandbox) => boolean;
  expectedPreconditions?: SandboxDeletionPreconditions;
  delete(preconditions: SandboxDeletionPreconditions): Promise<string[]>;
}): Promise<string[] | null> {
  try {
    const gate = await readSandboxMutationGate({
      name: input.name,
      config: input.config,
      isBusy: input.isBusy,
      isEnsuring: input.isEnsuring,
      getStatus: input.getStatus,
      expectedPreconditions: input.expectedPreconditions,
      canMutate: input.canDelete,
    });
    if (!gate) return [];
    return await input.delete(gate.preconditions);
  } catch (err) {
    if (err instanceof SandboxDeletionPreconditionError
      || err instanceof SandboxDestructiveMutationBlockedError) return null;
    throw err;
  }
}
