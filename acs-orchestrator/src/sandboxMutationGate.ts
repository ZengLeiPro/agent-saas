import type { AcsOrchestratorConfig } from './config.js';
import {
  sandboxResourcePreconditions,
  type SandboxDeletionPreconditions,
} from './sandboxDeletion.js';
import { managedSandboxFromResource } from './sandboxInventoryReader.js';
import { isActiveInvocationLeaseProtected } from './sandboxLifecyclePolicy.js';
import {
  isBackgroundShellProtected,
  type ManagedSandbox,
  type SandboxStatus,
} from './sandboxState.js';

export class SandboxDestructiveMutationBlockedError extends Error {
  readonly statusCode = 409;
}

export interface SandboxMutationGateResult {
  status: SandboxStatus;
  sandbox: ManagedSandbox;
  preconditions: SandboxDeletionPreconditions;
}

/**
 * Final, persisted gate for every destructive Sandbox mutation.
 *
 * The returned UID/resourceVersion must be used by the mutation itself. A lease or
 * background-protection write after this read then changes resourceVersion and makes
 * the mutation conflict instead of racing through on process-local state.
 */
export async function readSandboxMutationGate(input: {
  name: string;
  config: AcsOrchestratorConfig;
  getStatus(): Promise<SandboxStatus | null>;
  isBusy(): boolean;
  isEnsuring?: () => boolean;
  expectedPreconditions?: SandboxDeletionPreconditions;
  canMutate?: (sandbox: ManagedSandbox) => boolean;
  nowMs?: number;
}): Promise<SandboxMutationGateResult | undefined> {
  if (input.isBusy() || input.isEnsuring?.()) throw blocked(input.name, 'process-local activity');
  const status = await input.getStatus();
  if (!status) return undefined;
  const raw = status.raw ?? {};
  const metadata = raw.metadata && typeof raw.metadata === 'object'
    ? raw.metadata as Record<string, unknown>
    : {};
  const sandbox = managedSandboxFromResource(input.config, {
    ...raw,
    metadata: { ...metadata, name: input.name },
    status: {
      ...(raw.status && typeof raw.status === 'object' ? raw.status as Record<string, unknown> : {}),
      phase: status.phase,
    },
  });
  const preconditions = sandboxResourcePreconditions(status);
  if (!preconditions) throw blocked(input.name, 'missing UID/resourceVersion');
  if (input.expectedPreconditions && !samePreconditions(preconditions, input.expectedPreconditions)) {
    throw blocked(input.name, 'resourceVersion changed');
  }
  const nowMs = input.nowMs ?? Date.now();
  if (isActiveInvocationLeaseProtected(sandbox, nowMs)) {
    throw blocked(input.name, 'active invocation lease');
  }
  if (isBackgroundShellProtected(sandbox, nowMs)) {
    throw blocked(input.name, 'background shell protection');
  }
  if (input.isBusy() || input.isEnsuring?.()) throw blocked(input.name, 'process-local activity');
  if (input.canMutate && !input.canMutate(sandbox)) throw blocked(input.name, 'mutation predicate changed');
  return { status, sandbox, preconditions };
}

function samePreconditions(
  actual: SandboxDeletionPreconditions,
  expected: SandboxDeletionPreconditions,
): boolean {
  return actual.uid === expected.uid && actual.resourceVersion === expected.resourceVersion;
}

function blocked(name: string, reason: string): SandboxDestructiveMutationBlockedError {
  return new SandboxDestructiveMutationBlockedError(
    `ACS Sandbox ${name} destructive mutation blocked: ${reason}`,
  );
}
