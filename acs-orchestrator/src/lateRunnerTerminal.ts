import type { AcsOrchestratorConfig } from './config.js';
import { errorMessage } from './executorSupport.js';
import { establishInvocationCompletionFence } from './invocationCompletionRecovery.js';
import type { OwnedOperations } from './ownedOperations.js';
import type { SandboxRunnerFinalOutput, SandboxRunnerOutput } from './protocol.js';
import { remoteReceiptFromResponse, verifyOwnedResponse } from './remoteOwnership.js';
import type { SandboxManager, SandboxRef } from './sandboxManager.js';

interface LateInvocationEntry {
  releaseActive?: () => void;
}

export async function reconcileLateRunnerTerminal(input: {
  config: AcsOrchestratorConfig;
  sandboxManager: SandboxManager;
  operations?: OwnedOperations;
  ref: SandboxRef;
  attemptId: string;
  output: SandboxRunnerOutput | SandboxRunnerFinalOutput;
  findInvocation(): { key: string; entry: LateInvocationEntry } | undefined;
  forgetInvocation(key: string): void;
  recoverCompletion(completedAt: Date, sandboxUid: string, invocationId: string): void;
  recoverLeaseClear(sandboxUid: string, invocationId: string): void;
  logger: { warn(message: string): void };
}): Promise<void> {
  const response =
    input.output.kind === 'final'
      ? input.output.response
      : input.output.chunk.type === 'completed'
        ? input.output.chunk.response
        : undefined;
  const operation = input.operations?.findAttempt(input.attemptId);
  if (!operation || !response) return;
  const receipt = verifyOwnedResponse(input.config, operation.record, response);
  if (!receipt || !['stopped', 'not_started', 'background_owned'].includes(receipt.resource))
    return;
  const resource = receipt.resource as 'stopped' | 'not_started' | 'background_owned';
  const invocation = input.findInvocation();
  if (resource === 'background_owned' && receipt.background?.kind === 'shell') {
    await input.sandboxManager.setBackgroundShellProtection(
      input.ref.name,
      receipt.background.protectedUntil,
      receipt.fence.sandboxUid,
      undefined,
      input.attemptId,
    );
  }
  await operation.complete(
    response.status === 'success' ? 'success' : 'failed',
    {
      kind: resource === 'background_owned' ? 'background_inventory' : 'remote_receipt',
      attemptId: input.attemptId,
      sandboxUid: receipt.fence.sandboxUid,
      receipt: remoteReceiptFromResponse(response),
    },
    resource,
  );
  const completedAt = new Date(receipt.observedAtMs);
  try {
    if (resource === 'stopped' || resource === 'not_started') {
      await establishInvocationCompletionFence(
        input.config,
        input.sandboxManager,
        input.ref.name,
        input.attemptId,
        receipt.fence.sandboxUid,
        completedAt,
      );
      await input.sandboxManager.completeInvocation(
        input.ref.name,
        input.attemptId,
        completedAt,
        receipt.fence.sandboxUid,
      );
    } else {
      await input.sandboxManager.setActiveInvocationLease(
        input.ref.name,
        input.attemptId,
        undefined,
        receipt.fence.sandboxUid,
      );
    }
  } catch (error) {
    if (resource === 'stopped' || resource === 'not_started') {
      input.recoverCompletion(completedAt, receipt.fence.sandboxUid, operation.record.invocationId);
    } else {
      input.recoverLeaseClear(receipt.fence.sandboxUid, operation.record.invocationId);
    }
    input.logger.warn(
      `runner_late_terminal_lease_cleanup_deferred sandbox=${input.ref.name} attempt=${input.attemptId}: ${errorMessage(error)}`,
    );
  }
  if (invocation) input.forgetInvocation(invocation.key);
  invocation?.entry.releaseActive?.();
}
