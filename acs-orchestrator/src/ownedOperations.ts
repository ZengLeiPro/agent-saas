import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { OwnershipJournal } from './ownershipJournal.js';
import {
  OWNERSHIP_LIMITS, OwnershipBlockedError, OwnershipUnavailableError, ownershipIsTerminal, scopesOverlap,
  type OperationKind, type OperationOutcome, type OwnershipRecord, type ResourceOwnership, type WritableScope,
} from './ownershipState.js';
import { waitForOwned, OWNED_WAIT_BUDGETS, OwnedWaitEndedError } from './ownedWait.js';

export interface OperationProof {
  kind: 'never_dispatched' | 'remote_receipt' | 'background_inventory';
  attemptId: string;
  sandboxUid?: string;
}

export class OwnedOperation {
  readonly controller = new AbortController();
  readonly startedMonotonic = performance.now();
  waiters = 0;
  dispatched = false;
  durable = false;
  private transition: Promise<unknown> = Promise.resolve();

  constructor(readonly registry: OwnedOperations, public record: OwnershipRecord) {}

  async phase<T>(name: string, work: () => Promise<T>, timeoutMs: number, options: { ignoreCancellation?: boolean } = {}): Promise<T> {
    await this.update({ phase: name, phaseDeadlineAt: new Date(Date.now() + timeoutMs).toISOString() });
    const pending = work();
    try {
      return await waitForOwned(pending, {
        phase: name, timeoutMs, signal: options.ignoreCancellation ? undefined : this.controller.signal,
      });
    } catch (error) {
      if (error instanceof OwnedWaitEndedError) {
        // The underlying work is still observed by waitForOwned and is not
        // evicted from its leader map. A late completion does not clear this owner.
        await this.unknown(error.code).catch(() => undefined);
      }
      throw error;
    }
  }

  async dispatch(sandboxUid: string): Promise<void> {
    if (this.controller.signal.aborted) throw new OwnedWaitEndedError('wait_cancelled', 'dispatch');
    await this.update({ resource: 'running', sandboxUid, phase: 'dispatch' });
    this.dispatched = true;
  }

  async unknown(reasonCode: string): Promise<void> {
    const outcome = this.record.outcome === 'pending' ? 'failed' : this.record.outcome;
    // Set the local blocker synchronously even if persistence itself is unavailable.
    this.record = { ...this.record, resource: 'unknown', outcome, reasonCode };
    await this.update({ resource: 'unknown', outcome, reasonCode });
  }

  async complete(outcome: Exclude<OperationOutcome, 'pending'>, proof: OperationProof, resource: 'stopped' | 'not_started' | 'background_owned' = 'stopped'): Promise<void> {
    if (proof.attemptId !== this.record.attemptId
      || (this.record.sandboxUid && proof.sandboxUid !== this.record.sandboxUid)
      || (proof.kind === 'never_dispatched' && this.dispatched)
      || (resource === 'background_owned' && proof.kind !== 'background_inventory')) {
      throw new OwnershipBlockedError(this.record.operationId);
    }
    // Outcome is immutable once the caller has settled; late receipts only repair
    // ownership. Background handoff is durable only after this CAS succeeds.
    const settledOutcome = this.record.outcome === 'pending' ? outcome : this.record.outcome;
    await this.update({ resource, outcome: settledOutcome, phase: resource, phaseDeadlineAt: undefined });
    this.registry.compact();
  }

  requestCancel(): { requested: boolean; resource: ResourceOwnership } {
    if (ownershipIsTerminal(this.record)) return { requested: false, resource: this.record.resource };
    this.controller.abort();
    if (this.record.outcome === 'pending') this.record.outcome = 'cancelled';
    void this.update({ resource: 'stop_requested', outcome: this.record.outcome, reasonCode: 'cancel_requested' })
      .catch(() => { this.record.resource = 'unknown'; });
    return { requested: true, resource: this.record.resource };
  }

  async wait<T>(work: Promise<T>, signal?: AbortSignal, timeoutMs?: number): Promise<T> {
    this.waiters += 1;
    try { return await waitForOwned(work, { phase: 'caller_wait', signal, timeoutMs }); }
    finally { this.waiters -= 1; }
  }

  async update(patch: Partial<Pick<OwnershipRecord, 'resource' | 'outcome' | 'phase' | 'phaseDeadlineAt' | 'sandboxUid' | 'reasonCode'>>): Promise<void> {
    const task = this.transition.then(async () => {
      const previous = this.record;
      const next: OwnershipRecord = { ...previous, ...patch, revision: previous.revision + 1, updatedAt: new Date().toISOString() };
      if (this.registry.journal) {
        try {
          this.record = await this.registry.journal.update(next, previous.revision);
          this.durable = true;
        } catch (error) {
          this.durable = false;
          this.record = { ...previous, resource: 'unknown', reasonCode: 'persistence_unknown' };
          throw error;
        }
      } else {
        this.record = next;
      }
    });
    this.transition = task.catch(() => undefined);
    await waitForOwned(task, { phase: 'ownership_persist', timeoutMs: OWNED_WAIT_BUDGETS.persistenceMs });
  }
}

/** Shared owners outlive HTTP waiters. Unknown work consumes capacity and drain. */
export class OwnedOperations {
  readonly ownerId = randomUUID();
  readonly context = new AsyncLocalStorage<OwnedOperation>();
  private readonly owners = new Map<string, OwnedOperation>();

  constructor(readonly journal?: OwnershipJournal) {}

  async begin(input: { kind: OperationKind; invocationId: string; attemptId: string; scope: WritableScope }): Promise<OwnedOperation> {
    this.compact();
    if (this.owners.size >= OWNERSHIP_LIMITS.records) throw new OwnershipUnavailableError('Local ownership capacity exhausted');
    const now = new Date().toISOString();
    const record: OwnershipRecord = {
      protocolVersion: 1, operationId: randomUUID(), attemptId: input.attemptId, invocationId: input.invocationId,
      ownerId: this.ownerId, revision: 0, kind: input.kind, scope: input.scope,
      resource: 'reserved', outcome: 'pending', phase: 'reserved', createdAt: now, updatedAt: now,
    };
    const conflict = (other: OwnershipRecord) => this.blocksAdmission(other, record.scope, record.invocationId, record.operationId);
    for (const owner of this.owners.values()) if (conflict(owner.record)) throw new OwnershipBlockedError(owner.record.operationId);
    const operation = new OwnedOperation(this, record);
    this.owners.set(record.operationId, operation);
    if (this.journal) {
      try {
        operation.record = await waitForOwned(this.journal.reserve(record, conflict), { phase: 'ownership_reserve', timeoutMs: OWNED_WAIT_BUDGETS.persistenceMs });
        operation.durable = true;
      } catch (error) {
        // A timed-out CAS may have committed. Never discard the corresponding local owner.
        operation.record.resource = 'unknown';
        operation.record.reasonCode = 'reservation_unknown';
        throw error;
      }
    }
    return operation;
  }

  blocksAdmission(record: OwnershipRecord, scope: WritableScope, invocationId?: string, ignoreOperationId?: string): boolean {
    if (record.operationId === ignoreOperationId || ownershipIsTerminal(record) || !scopesOverlap(record.scope, scope)) return false;
    if (record.resource === 'unknown' || record.resource === 'stop_requested') return true;
    if (record.resource === 'background_owned') return false;
    if (record.ownerId !== this.ownerId || !this.owners.has(record.operationId)) return true;
    return record.kind === 'provision' || record.kind === 'ensure' || (invocationId !== undefined && record.invocationId === invocationId);
  }

  isKnownLease(attemptId: string): boolean {
    return [...this.owners.values()].some(({ record }) => record.attemptId === attemptId
      && record.resource !== 'unknown' && record.resource !== 'stop_requested' && !ownershipIsTerminal(record));
  }

  current(): OwnedOperation | undefined { return this.context.getStore(); }
  get(operationId: string): OwnedOperation | undefined { return this.owners.get(operationId); }
  records(): OwnershipRecord[] { return [...this.owners.values()].map((owner) => structuredClone(owner.record)); }

  drainBlockers(): number {
    return [...this.owners.values()].filter((owner) => !ownershipIsTerminal(owner.record)
      && !(owner.record.resource === 'background_owned' && owner.durable)).length;
  }

  snapshot() {
    return [...this.owners.values()].map((owner) => ({
      operationId: owner.record.operationId, attemptId: owner.record.attemptId, invocationId: owner.record.invocationId,
      kind: owner.record.kind, phase: owner.record.phase, resource: owner.record.resource, outcome: owner.record.outcome,
      sandboxName: owner.record.scope.sandboxName, workspaceId: owner.record.scope.workspaceId,
      elapsedMs: Math.max(0, Math.floor(performance.now() - owner.startedMonotonic)),
      phaseDeadlineAt: owner.record.phaseDeadlineAt ?? null, waiters: owner.waiters,
      durable: owner.durable, reasonCode: owner.record.reasonCode ?? null,
    }));
  }

  compact(): void {
    const terminal = [...this.owners.entries()].filter(([, owner]) => ownershipIsTerminal(owner.record));
    for (const [id] of terminal.slice(0, Math.max(0, terminal.length - 16))) this.owners.delete(id);
  }
}
