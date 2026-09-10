import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { OwnershipJournal } from './ownershipJournal.js';
import {
  OWNERSHIP_LIMITS, OwnershipBlockedError, OwnershipUnavailableError, ownershipIsTerminal, scopesOverlap,
  type OperationKind, type OperationOutcome, type OwnershipRecord, type ResourceOwnership, type WritableScope,
} from './ownershipState.js';
import { parseRemoteFence, parseRemoteReceipt, sameRemoteFence, type RemoteAttemptFence } from './remoteAttemptProtocol.js';
import { waitForOwned, OWNED_WAIT_BUDGETS, OwnedWaitEndedError } from './ownedWait.js';

export interface OperationProof {
  kind: 'never_dispatched' | 'remote_receipt' | 'background_inventory' | 'coordinator_settled';
  attemptId: string;
  sandboxUid?: string;
  /** Must authenticate against the fence reserved before the remote launch. */
  receipt?: unknown;
}

type StatePatch = Partial<Pick<OwnershipRecord,
  'resource' | 'outcome' | 'phase' | 'phaseDeadlineAt' | 'sandboxUid' | 'reasonCode' | 'remoteFence'>>;

export class OwnedOperation {
  readonly controller = new AbortController();
  readonly startedMonotonic = performance.now();
  waiters = 0;
  dispatched = false;
  durable = false;
  private transition: Promise<unknown> = Promise.resolve();
  private acknowledged: OwnershipRecord;
  private uncertain = false;
  private callerOutcome: OperationOutcome;

  constructor(readonly registry: OwnedOperations, public record: OwnershipRecord) {
    this.acknowledged = structuredClone(record);
    this.callerOutcome = record.outcome;
  }

  acceptReservation(record: OwnershipRecord): void {
    this.acknowledged = structuredClone(record);
    this.record = structuredClone(record);
    this.durable = true;
  }

  /** A later observation cannot erase a durably proved terminal resource. */
  markUncertain(reasonCode: string): void {
    if (ownershipIsTerminal(this.record) && this.durable) return;
    this.uncertain = true;
    this.durable = false;
    this.record = { ...this.record, resource: 'unknown', reasonCode };
  }

  async phase<T>(name: string, work: () => Promise<T>, timeoutMs: number, options: { ignoreCancellation?: boolean } = {}): Promise<T> {
    await this.update({ phase: name, phaseDeadlineAt: new Date(Date.now() + timeoutMs).toISOString() });
    if (!options.ignoreCancellation && this.controller.signal.aborted) throw new OwnedWaitEndedError('wait_cancelled', name);
    const pending = work();
    try {
      return await waitForOwned(pending, { phase: name, timeoutMs,
        signal: options.ignoreCancellation ? undefined : this.controller.signal });
    } catch (error) {
      if (error instanceof OwnedWaitEndedError) {
        // Observe the real owner promise after the caller detaches. Its timeout
        // is not permission to discard either local or durable ownership.
        this.markUncertain(error.code);
        await this.unknown(error.code).catch(() => undefined);
      }
      throw error;
    }
  }

  async bindRemoteFence(value: RemoteAttemptFence): Promise<void> {
    const fence = parseRemoteFence(value);
    if (!fence || fence.operationId !== this.record.operationId || fence.attemptId !== this.record.attemptId
      || fence.ownerId !== this.record.ownerId || this.dispatched || this.uncertain
      || (this.record.remoteFence && !sameRemoteFence(this.record.remoteFence, fence))) {
      throw new OwnershipBlockedError(this.record.operationId);
    }
    this.registry.receiptKey(fence);
    await this.update({ remoteFence: fence, sandboxUid: fence.sandboxUid, phase: 'remote_reserved' });
  }

  async dispatch(sandboxUid: string): Promise<void> {
    if (this.controller.signal.aborted) throw new OwnedWaitEndedError('wait_cancelled', 'dispatch');
    if (this.uncertain || (this.record.remoteFence && this.record.remoteFence.sandboxUid !== sandboxUid)) {
      throw new OwnershipBlockedError(this.record.operationId);
    }
    await this.update({ resource: 'running', sandboxUid, phase: 'dispatch' });
    if (this.controller.signal.aborted) throw new OwnedWaitEndedError('wait_cancelled', 'dispatch');
    this.dispatched = true;
  }

  async unknown(reasonCode: string): Promise<void> {
    if (ownershipIsTerminal(this.record) && this.durable) return;
    this.markUncertain(reasonCode);
    if (this.callerOutcome === 'pending') this.callerOutcome = this.controller.signal.aborted
      ? 'cancelled' : reasonCode === 'wait_timed_out' ? 'timed_out' : 'failed';
    await this.persist({ resource: 'unknown', outcome: this.callerOutcome, reasonCode });
  }

  async complete(outcome: Exclude<OperationOutcome, 'pending'>, proof: OperationProof,
    resource: 'stopped' | 'not_started' | 'background_owned' = 'stopped'): Promise<void> {
    if (proof.attemptId !== this.record.attemptId
      || (this.record.sandboxUid && proof.sandboxUid !== this.record.sandboxUid)) {
      throw new OwnershipBlockedError(this.record.operationId);
    }
    if (proof.kind === 'never_dispatched') {
      if (this.dispatched || this.uncertain || resource !== 'not_started') throw new OwnershipBlockedError(this.record.operationId);
    } else if (proof.kind === 'coordinator_settled') {
      if (this.dispatched || this.uncertain || this.record.remoteFence || resource !== 'stopped'
        || this.registry.hasUnresolvedChildren(this.record.operationId)) throw new OwnershipBlockedError(this.record.operationId);
    } else {
      const fence = this.record.remoteFence;
      let valid = false;
      try {
        const receipt = fence ? parseRemoteReceipt(proof.receipt, fence, this.registry.receiptKey(fence)) : null;
        valid = Boolean(receipt && receipt.resource === resource
          && (resource !== 'background_owned' || proof.kind === 'background_inventory'));
      } catch { /* An unavailable verifier is a blocker, not a successful stop. */ }
      if (!valid) throw new OwnershipBlockedError(this.record.operationId);
    }
    // Once settled, a caller outcome never changes. A late authenticated receipt
    // can still reconcile its resource without replaying or rerunning the task.
    if (this.callerOutcome === 'pending') this.callerOutcome = outcome;
    await this.persist({ resource, outcome: this.callerOutcome, phase: resource, phaseDeadlineAt: undefined }, true);
    this.registry.compact();
  }

  requestCancel(): { requested: boolean; resource: ResourceOwnership } {
    if (ownershipIsTerminal(this.record) || this.record.resource === 'background_owned') {
      return { requested: false, resource: this.record.resource };
    }
    if (this.controller.signal.aborted) return { requested: true, resource: this.record.resource };
    this.controller.abort();
    if (!this.uncertain) this.record = { ...this.record, resource: 'stop_requested' };
    void this.update({ resource: 'stop_requested', reasonCode: 'cancel_requested' })
      .catch(() => this.markUncertain('cancel_persistence_unknown'));
    return { requested: true, resource: this.record.resource };
  }

  async wait<T>(work: Promise<T>, signal?: AbortSignal, timeoutMs?: number): Promise<T> {
    this.waiters += 1;
    try { return await waitForOwned(work, { phase: 'caller_wait', signal, timeoutMs }); }
    finally { this.waiters -= 1; }
  }

  async update(patch: StatePatch): Promise<void> {
    if (patch.resource === 'stopped' || patch.resource === 'not_started' || patch.resource === 'background_owned') {
      throw new OwnershipBlockedError(this.record.operationId);
    }
    if (patch.remoteFence && (this.dispatched || (this.record.remoteFence && !sameRemoteFence(patch.remoteFence, this.record.remoteFence)))) {
      throw new OwnershipBlockedError(this.record.operationId);
    }
    await this.persist(patch);
  }

  private async persist(patch: StatePatch, proved = false): Promise<void> {
    let waitExpired = false;
    const task = this.transition.then(async () => {
      const previous = this.acknowledged;
      if (ownershipIsTerminal(previous) && !proved) return;
      const resource = this.uncertain && !proved ? 'unknown' : patch.resource ?? this.record.resource;
      const next: OwnershipRecord = { ...previous, ...patch, resource, outcome: this.callerOutcome,
        revision: previous.revision + 1, updatedAt: new Date().toISOString() };
      try {
        const committed = this.registry.journal ? await this.registry.journal.update(next, previous.revision) : next;
        this.acknowledged = structuredClone(committed);
        if (proved && !waitExpired) this.uncertain = false;
        this.record = this.uncertain
          ? { ...committed, resource: 'unknown', reasonCode: this.record.reasonCode ?? 'persistence_unknown' } : committed;
        this.durable = Boolean(this.registry.journal) && !waitExpired && !this.uncertain;
      } catch (error) {
        this.markUncertain('persistence_unknown');
        throw error;
      }
    });
    this.transition = task.catch(() => undefined);
    try { await waitForOwned(task, { phase: 'ownership_persist', timeoutMs: OWNED_WAIT_BUDGETS.persistenceMs }); }
    catch (error) {
      waitExpired = true;
      this.markUncertain('persistence_unknown');
      throw error;
    }
  }
}

/** Shared owners outlive HTTP waiters. Unknown work consumes capacity and drain. */
export class OwnedOperations {
  readonly ownerId = randomUUID();
  readonly context = new AsyncLocalStorage<OwnedOperation>();
  private readonly owners = new Map<string, OwnedOperation>();

  constructor(readonly journal?: OwnershipJournal,
    private readonly authority?: { receiptKey(fence: RemoteAttemptFence): string }) {}

  receiptKey(fence: RemoteAttemptFence): string {
    if (!this.authority) throw new OwnershipUnavailableError('Remote receipt verification is unavailable');
    return this.authority.receiptKey(fence);
  }

  async begin(input: { kind: OperationKind; invocationId: string; attemptId: string; scope: WritableScope;
    parentOperation?: OwnedOperation }): Promise<OwnedOperation> {
    this.compact();
    if (this.owners.size >= OWNERSHIP_LIMITS.records) throw new OwnershipUnavailableError('Local ownership capacity exhausted');
    const parent = input.parentOperation;
    if (parent && (this.owners.get(parent.record.operationId) !== parent || parent.controller.signal.aborted
      || ownershipIsTerminal(parent.record) || ['unknown', 'stop_requested', 'background_owned'].includes(parent.record.resource))) {
      throw new OwnershipBlockedError(parent.record.operationId);
    }
    const now = new Date().toISOString();
    const record: OwnershipRecord = {
      protocolVersion: 1, operationId: randomUUID(), attemptId: input.attemptId, invocationId: input.invocationId,
      ownerId: this.ownerId, revision: 0, kind: input.kind, scope: input.scope,
      resource: 'reserved', outcome: 'pending', phase: 'reserved', createdAt: now, updatedAt: now,
      ...(parent ? { parentOperationId: parent.record.operationId } : {}),
    };
    const conflict = (other: OwnershipRecord) => {
      if (parent && this.isAncestor(other.operationId, parent.record.operationId)
        && !['unknown', 'stop_requested'].includes(other.resource)) return false;
      return this.blocksAdmission(other, record.scope, record.invocationId, record.operationId);
    };
    for (const owner of this.owners.values()) if (conflict(owner.record)) throw new OwnershipBlockedError(owner.record.operationId);
    const operation = new OwnedOperation(this, record);
    this.owners.set(record.operationId, operation);
    if (this.journal) {
      try {
        const reserved = await waitForOwned(this.journal.reserve(record, conflict), {
          phase: 'ownership_reserve', timeoutMs: OWNED_WAIT_BUDGETS.persistenceMs,
        });
        operation.acceptReservation(reserved);
      } catch (error) {
        // A timed-out CAS may have committed. Never discard its local owner.
        operation.markUncertain('reservation_unknown');
        throw error;
      }
    }
    return operation;
  }

  private isAncestor(ancestorId: string, descendantId: string): boolean {
    const seen = new Set<string>();
    let id: string | undefined = descendantId;
    while (id && !seen.has(id)) {
      if (id === ancestorId) return true;
      seen.add(id);
      id = this.owners.get(id)?.record.parentOperationId;
    }
    return false;
  }

  hasUnresolvedChildren(operationId: string): boolean {
    const records = new Map((this.journal?.snapshot().records ?? []).map((record) => [record.operationId, record]));
    for (const owner of this.owners.values()) records.set(owner.record.operationId, owner.record);
    return [...records.values()].some((record) => record.parentOperationId === operationId
      && !ownershipIsTerminal(record) && !(record.resource === 'background_owned'
        && (this.owners.get(record.operationId)?.durable ?? true)));
  }

  blocksAdmission(record: OwnershipRecord, scope: WritableScope, invocationId?: string, ignoreOperationId?: string): boolean {
    if (record.operationId === ignoreOperationId || ownershipIsTerminal(record) || !scopesOverlap(record.scope, scope)) return false;
    if (record.resource === 'unknown' || record.resource === 'stop_requested') return true;
    if (record.resource === 'background_owned') return false;
    if (ignoreOperationId && record.ownerId === this.ownerId && this.isAncestor(record.operationId, ignoreOperationId)) return false;
    if (record.ownerId !== this.ownerId || !this.owners.has(record.operationId)) return true;
    return record.kind === 'provision' || record.kind === 'ensure' || (invocationId !== undefined && record.invocationId === invocationId);
  }

  isKnownLease(attemptId: string): boolean {
    return [...this.owners.values()].some(({ record }) => record.attemptId === attemptId
      && record.resource !== 'unknown' && record.resource !== 'stop_requested' && !ownershipIsTerminal(record));
  }

  current(): OwnedOperation | undefined { return this.context.getStore(); }
  get(operationId: string): OwnedOperation | undefined { return this.owners.get(operationId); }
  findAttempt(attemptId: string): OwnedOperation | undefined {
    return [...this.owners.values()].find((owner) => owner.record.attemptId === attemptId);
  }
  records(): OwnershipRecord[] { return [...this.owners.values()].map((owner) => structuredClone(owner.record)); }

  drainBlockers(): number {
    const local = [...this.owners.values()].filter((owner) => !ownershipIsTerminal(owner.record)
      && !(owner.record.resource === 'background_owned' && owner.durable)).length;
    if (!this.journal) return local;
    const persisted = this.journal.snapshot();
    if (!persisted.available) return local + 1;
    const foreign = persisted.records.filter((record) => !this.owners.has(record.operationId)
      && !ownershipIsTerminal(record) && record.resource !== 'background_owned').length;
    return local + foreign;
  }

  snapshot() {
    return [...this.owners.values()].map((owner) => ({
      operationId: owner.record.operationId, attemptId: owner.record.attemptId, invocationId: owner.record.invocationId,
      parentOperationId: owner.record.parentOperationId ?? null,
      kind: owner.record.kind, phase: owner.record.phase, resource: owner.record.resource, outcome: owner.record.outcome,
      sandboxName: owner.record.scope.sandboxName, workspaceId: owner.record.scope.workspaceId,
      elapsedMs: Math.max(0, Math.floor(performance.now() - owner.startedMonotonic)),
      phaseDeadlineAt: owner.record.phaseDeadlineAt ?? null, waiters: owner.waiters,
      durable: owner.durable, reasonCode: owner.record.reasonCode ?? null,
    }));
  }

  compact(): void {
    const parents = new Set([...this.owners.values()].filter((owner) => !ownershipIsTerminal(owner.record))
      .map((owner) => owner.record.parentOperationId));
    const terminal = [...this.owners.entries()].filter(([id, owner]) => ownershipIsTerminal(owner.record) && !parents.has(id));
    for (const [id] of terminal.slice(0, Math.max(0, terminal.length - 16))) this.owners.delete(id);
  }
}
