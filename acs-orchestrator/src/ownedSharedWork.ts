import { randomUUID } from 'node:crypto';
import type { OwnedOperation, OwnedOperations } from './ownedOperations.js';
import { OwnershipBlockedError, ownershipIsTerminal, type OperationKind, type WritableScope } from './ownershipState.js';
import { waitForOwned, OWNED_WAIT_BUDGETS } from './ownedWait.js';

interface Leader<T> {
  fingerprint: string;
  operation?: OwnedOperation;
  task: Promise<T>;
}

/** Singleflight owners are independent of every caller's cancellation/deadline. */
export class OwnedSharedWork<T> {
  private readonly leaders = new Map<string, Leader<T>>();

  constructor(private readonly operations: OwnedOperations) {}

  async run(input: {
    key: string;
    fingerprint: string;
    kind: OperationKind;
    scope: WritableScope;
    work(operation: OwnedOperation): Promise<T>;
    signal?: AbortSignal;
    timeoutMs?: number;
    /** Independent owner budget; a short-lived HTTP waiter cannot shorten it. */
    ownerTimeoutMs?: number;
  }): Promise<T> {
    for (;;) {
      const existing = this.leaders.get(input.key);
      if (existing) {
        if (existing.operation && existing.operation.record.resource === 'unknown') {
          throw new OwnershipBlockedError(existing.operation.record.operationId);
        }
        let result: T;
        try {
          result = await waitForOwned(existing.task, {
            phase: 'shared_follower', signal: input.signal,
            timeoutMs: input.timeoutMs ?? OWNED_WAIT_BUDGETS.ensureMs,
          });
        } catch (error) {
          // Incompatible callers do not turn an unresolved failed owner into a retry.
          if (existing.fingerprint !== input.fingerprint && existing.operation
            && !ownershipIsTerminal(existing.operation.record)) {
            throw new OwnershipBlockedError(existing.operation.record.operationId);
          }
          throw error;
        }
        if (existing.fingerprint === input.fingerprint) return result;
        if (!existing.operation || !ownershipIsTerminal(existing.operation.record)) {
          throw new OwnershipBlockedError(existing.operation?.record.operationId);
        }
        continue;
      }
      if (input.signal?.aborted) input.signal.throwIfAborted();
      const leader = { fingerprint: input.fingerprint } as Leader<T>;
      // Publish synchronously, before reserve's first await, so followers cannot
      // accidentally become a second provisioning leader in the same process.
      leader.task = Promise.resolve().then(async () => {
        const operation = await this.operations.begin({
          kind: input.kind, scope: input.scope,
          invocationId: `${input.kind}:${input.key}`,
          attemptId: `${input.kind}:${randomUUID()}`,
        });
        leader.operation = operation;
        try {
          const result = await this.operations.context.run(operation, () =>
            operation.phase(input.kind, () => input.work(operation), input.ownerTimeoutMs ?? input.timeoutMs ?? OWNED_WAIT_BUDGETS.ensureMs));
          if (operation.record.resource === 'unknown') throw new OwnershipBlockedError(operation.record.operationId);
          await operation.complete('success', {
            kind: 'remote_receipt', attemptId: operation.record.attemptId, sandboxUid: operation.record.sandboxUid,
          });
          return result;
        } catch (error) {
          // A failed ensure/provision can have made remote changes even without a
          // tool dispatch. It stays owned until explicit evidence reconciles it.
          await operation.unknown('shared_work_unconfirmed').catch(() => undefined);
          throw error;
        }
      });
      this.leaders.set(input.key, leader);
      void leader.task.finally(() => {
        if (leader.operation && ownershipIsTerminal(leader.operation.record)
          && this.leaders.get(input.key) === leader) this.leaders.delete(input.key);
      }).catch(() => undefined);
      return await waitForOwned(leader.task, {
        phase: 'shared_caller', signal: input.signal,
        timeoutMs: input.timeoutMs ?? OWNED_WAIT_BUDGETS.ensureMs,
      });
    }
  }
}
