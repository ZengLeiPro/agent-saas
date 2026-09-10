import type { AcsOrchestratorConfig } from './config.js';
import type { Kubectl } from './kubectl.js';
import type { OwnershipJournal } from './ownershipJournal.js';
import { ownershipIsTerminal, type OwnershipRecord } from './ownershipState.js';
import type { SandboxManager } from './sandboxManager.js';
import { queryRemoteAttemptEvidence } from './remoteAttemptClient.js';
import { establishInvocationCompletionFence } from './invocationCompletionRecovery.js';
import type { OwnedOperations } from './ownedOperations.js';

/** Reconciles only exact signed receipts; an unavailable pod or receipt retains the journal owner. */
export async function reconcileRemoteOwnership(input: {
  config: AcsOrchestratorConfig;
  kubectl: Kubectl;
  journal: OwnershipJournal;
  sandboxManager: SandboxManager;
  operations: OwnedOperations;
  logger: { info(message: string): void; warn(message: string): void };
}): Promise<{ checked: number; reconciled: number }> {
  const records = await input.journal.read();
  const candidates = records.filter(
    (record) => !ownershipIsTerminal(record) && Boolean(record.remoteFence),
  );
  let reconciled = 0;
  for (const record of candidates) {
    try {
      if (await reconcileRecord(input, record)) reconciled += 1;
    } catch (error) {
      input.logger.warn(`remote_ownership_reconciliation_deferred operation=${record.operationId}`);
    }
  }
  return { checked: candidates.length, reconciled };
}

async function reconcileRecord(
  input: Parameters<typeof reconcileRemoteOwnership>[0],
  record: OwnershipRecord,
): Promise<boolean> {
  const fence = record.remoteFence!;
  const evidence = await queryRemoteAttemptEvidence({
    config: input.config,
    kubectl: input.kubectl,
    sandboxName: record.scope.sandboxName,
    fence,
    action: 'status',
  }).catch(() => null);
  if (
    !evidence ||
    !['stopped', 'not_started', 'background_owned'].includes(evidence.receipt.resource)
  )
    return false;
  const receipt = evidence.receipt;
  const resource = receipt.resource as 'stopped' | 'not_started' | 'background_owned';
  if (resource === 'background_owned' && receipt.background?.kind === 'shell') {
    await input.sandboxManager.setBackgroundShellProtection(
      record.scope.sandboxName,
      receipt.background.protectedUntil,
      fence.sandboxUid,
      undefined,
      record.attemptId,
    );
  }
  const local = input.operations.get(record.operationId);
  if (local) {
    await local.complete(
      record.outcome === 'pending' ? 'failed' : record.outcome,
      {
        kind: resource === 'background_owned' ? 'background_inventory' : 'remote_receipt',
        attemptId: record.attemptId,
        sandboxUid: fence.sandboxUid,
        receipt: evidence.envelope,
      },
      resource,
    );
  } else {
    await input.journal.update(
      {
        ...record,
        revision: record.revision + 1,
        resource,
        outcome: record.outcome === 'pending' ? 'failed' : record.outcome,
        phase: resource,
        phaseDeadlineAt: undefined,
        reasonCode: undefined,
        updatedAt: new Date(receipt.observedAtMs).toISOString(),
      },
      record.revision,
    );
  }
  try {
    if (resource === 'stopped' || resource === 'not_started') {
      const completedAt = new Date(receipt.observedAtMs);
      await establishInvocationCompletionFence(
        input.config,
        input.sandboxManager,
        record.scope.sandboxName,
        record.attemptId,
        fence.sandboxUid,
        completedAt,
      );
      await input.sandboxManager.completeInvocation(
        record.scope.sandboxName,
        record.attemptId,
        completedAt,
        fence.sandboxUid,
      );
    } else {
      await input.sandboxManager.setActiveInvocationLease(
        record.scope.sandboxName,
        record.attemptId,
        undefined,
        fence.sandboxUid,
      );
    }
  } catch {
    input.logger.warn(`remote_ownership_lease_cleanup_deferred operation=${record.operationId}`);
  }
  input.logger.info(
    `remote_ownership_reconciled operation=${record.operationId} resource=${resource}`,
  );
  return true;
}
