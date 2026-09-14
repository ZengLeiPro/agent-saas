import type { AcsOrchestratorConfig } from './config.js';
import type { Kubectl } from './kubectl.js';
import type { KubeApi } from './kubeApi.js';
import type { OwnershipJournal } from './ownershipJournal.js';
import { ownershipIsTerminal, type OwnershipRecord, type ResourceOwnership } from './ownershipState.js';
import type { SandboxManager } from './sandboxManager.js';
import { queryRemoteAttemptEvidence } from './remoteAttemptClient.js';
import { establishInvocationCompletionFence } from './invocationCompletionRecovery.js';
import type { OwnedOperations } from './ownedOperations.js';
import { observeSandboxAbsence } from './sandboxAbsence.js';

const RETAIN_LOG_INTERVAL_MS = 5 * 60_000;
const lastRetainLogAt = new Map<string, number>();
const SANDBOX_ABSENT_RESOURCES: ResourceOwnership[] = ['running', 'unknown', 'stop_requested'];

function eligibleForSandboxAbsent(record: OwnershipRecord): boolean {
  return Boolean(record.remoteFence)
    && Boolean(record.sandboxUid)
    && Boolean(record.dispatchedAt)
    && Number.isFinite(Date.parse(record.dispatchedAt!))
    && SANDBOX_ABSENT_RESOURCES.includes(record.resource)
    && !ownershipIsTerminal(record);
}

export interface RemoteOwnershipExecutor {
  forgetUnresolvedInvocationsForSandboxUid(uid: string, attemptId?: string): void;
}

/** Reconciles only exact signed receipts; an unavailable pod or receipt retains the journal owner. */
export async function reconcileRemoteOwnership(input: {
  config: AcsOrchestratorConfig;
  kubectl: Kubectl;
  kubeApi?: KubeApi | null;
  journal: OwnershipJournal;
  sandboxManager: SandboxManager;
  operations: OwnedOperations;
  executor?: RemoteOwnershipExecutor;
  logger: { info(message: string): void; warn(message: string): void };
  sleep?: (ms: number) => Promise<void>;
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

function retain(input: Parameters<typeof reconcileRemoteOwnership>[0], record: OwnershipRecord, reason: string): false {
  const now = Date.now();
  const previous = lastRetainLogAt.get(record.operationId) ?? 0;
  if (now - previous >= RETAIN_LOG_INTERVAL_MS) {
    lastRetainLogAt.set(record.operationId, now);
    input.logger.info(`remote_ownership_retained operation=${record.operationId} reason=${reason}`);
  }
  return false;
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
  if (evidence && ['stopped', 'not_started', 'background_owned'].includes(evidence.receipt.resource)) {
    return settleReceipt(input, record, evidence);
  }

  if (!eligibleForSandboxAbsent(record)) {
    return retain(input, record, record.resource === 'background_owned' ? 'background_owned'
      : !record.sandboxUid ? 'missing_sandbox_uid'
      : !record.dispatchedAt ? 'missing_dispatched_at'
      : `resource_${record.resource}`);
  }

  const expectedUid = record.sandboxUid!;
  const absence = await observeSandboxAbsence({
    kubeApi: input.kubeApi ?? null,
    kubectl: input.kubectl,
    config: input.config,
    sandboxName: record.scope.sandboxName,
    expectedUid,
    ...(input.sleep ? { sleep: input.sleep } : {}),
  });
  if (absence.kind !== 'absent') {
    return retain(input, record, absence.kind === 'present' ? 'sandbox_present' : absence.reason);
  }

  const latest = input.operations.get(record.operationId)?.record
    ?? (await input.journal.read()).find((item) => item.operationId === record.operationId);
  if (!latest || !eligibleForSandboxAbsent(latest) || latest.sandboxUid !== record.sandboxUid) {
    return retain(input, record, 'state_changed');
  }
  if (Date.parse(absence.observedAt) < Date.parse(latest.dispatchedAt!)) {
    return retain(input, record, 'observed_before_dispatch');
  }

  const local = input.operations.get(record.operationId);
  if (local) {
    await local.complete(
      record.outcome === 'pending' ? 'failed' : record.outcome === 'cancelled' ? 'cancelled' : 'failed',
      {
        kind: 'sandbox_absent',
        attemptId: record.attemptId,
        sandboxUid: expectedUid,
        observedAt: absence.observedAt,
      },
      'stopped',
    );
  } else {
    await input.journal.update(
      {
        ...latest,
        revision: latest.revision + 1,
        resource: 'stopped',
        outcome: latest.outcome === 'pending' ? 'failed' : latest.outcome,
        phase: 'stopped',
        phaseDeadlineAt: undefined,
        reasonCode: 'sandbox_absent',
        updatedAt: absence.observedAt,
      },
      latest.revision,
    );
  }
  if (record.sandboxUid) {
    input.executor?.forgetUnresolvedInvocationsForSandboxUid(record.sandboxUid, record.attemptId);
  }
  lastRetainLogAt.delete(record.operationId);
  input.logger.info(
    `remote_ownership_reconciled operation=${record.operationId} resource=stopped proof=sandbox_absent`,
  );
  return true;
}

async function settleReceipt(
  input: Parameters<typeof reconcileRemoteOwnership>[0],
  record: OwnershipRecord,
  evidence: NonNullable<Awaited<ReturnType<typeof queryRemoteAttemptEvidence>>>,
): Promise<boolean> {
  const fence = record.remoteFence!;
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
