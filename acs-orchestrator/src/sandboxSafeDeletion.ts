import type { AcsOrchestratorConfig } from './config.js';
import { managedSandboxFromResource } from './sandboxInventoryReader.js';
import {
  SandboxDeletionPreconditionError, sandboxResourcePreconditions, type SandboxDeletionPreconditions,
} from './sandboxDeletion.js';
import { isActiveInvocationLeaseProtected } from './sandboxLifecyclePolicy.js';
import { isBackgroundShellProtected, type ManagedSandbox, type SandboxStatus } from './sandboxState.js';

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
  if (input.isBusy() || input.isEnsuring()) return null;
  const status = await input.getStatus();
  if (!status) return [];
  const raw = status.raw ?? {};
  const metadata = raw.metadata && typeof raw.metadata === 'object' ? raw.metadata as Record<string, unknown> : {};
  const latest = managedSandboxFromResource(input.config, {
    ...raw,
    metadata: { ...metadata, name: input.name },
    status: { ...(raw.status && typeof raw.status === 'object' ? raw.status as Record<string, unknown> : {}), phase: status.phase },
  });
  const nowMs = Date.now();
  const preconditions = sandboxResourcePreconditions(status);
  if (!preconditions || (input.expectedPreconditions && !samePreconditions(preconditions, input.expectedPreconditions))
    || isActiveInvocationLeaseProtected(latest, nowMs) || isBackgroundShellProtected(latest, nowMs)
    || input.isBusy() || input.isEnsuring() || (input.canDelete && !input.canDelete(latest))) return null;
  try {
    return await input.delete(preconditions);
  } catch (err) {
    if (err instanceof SandboxDeletionPreconditionError) return null;
    throw err;
  }
}

function samePreconditions(
  actual: SandboxDeletionPreconditions,
  expected: SandboxDeletionPreconditions,
): boolean {
  return actual.uid === expected.uid && actual.resourceVersion === expected.resourceVersion;
}
