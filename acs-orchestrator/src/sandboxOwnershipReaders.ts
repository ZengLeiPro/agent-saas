import type { AcsOrchestratorConfig } from './config.js';
import type { Kubectl } from './kubectl.js';
import type { KubeApi } from './kubeApi.js';
import type { OwnedOperations } from './ownedOperations.js';
import type { OwnershipJournal } from './ownershipJournal.js';
import { readManagedSandboxes } from './sandboxInventoryReader.js';
import type { ManagedSandbox } from './sandboxState.js';
import type { SandboxRef } from './sandboxManagerTypes.js';
import {
  OwnershipBlockedError, OwnershipUnavailableError, ownershipIsTerminal, scopesOverlap, writableScope,
  type OwnershipRecord, type WritableScope,
} from './ownershipState.js';
import { waitForOwned, OWNED_WAIT_BUDGETS } from './ownedWait.js';

/** Shared reader for admission, destructive mutation gates, inventory and archive. */
export class SandboxOwnershipReaders {
  constructor(
    private readonly config: AcsOrchestratorConfig,
    private readonly kubectl: Kubectl,
    private readonly operations: OwnedOperations,
    private readonly journal: OwnershipJournal,
    private readonly kubeApi?: KubeApi | null,
  ) {}

  async assertWritable(ref: SandboxRef): Promise<void> {
    const scope = writableScope(this.config, ref);
    const current = this.operations.current();
    const blocked = (await this.records()).find((record) => this.operations.blocksAdmission(
      record, scope, current?.record.invocationId, current?.record.operationId,
    ));
    if (blocked) throw new OwnershipBlockedError(blocked.operationId);
    for (const sandbox of await this.inventory()) {
      if (!sandbox.activeInvocationLeases?.length) continue;
      const existing = this.scopeForSandbox(sandbox);
      if (!existing) throw new OwnershipUnavailableError('Persisted lease has no usable writable scope');
      if (!scopesOverlap(scope, existing)) continue;
      for (const lease of sandbox.activeInvocationLeases) {
        if (!lease.malformed && lease.state === 'completion_pending') continue;
        if (lease.invocationKey && this.operations.isKnownLease(lease.invocationKey)) continue;
        // Expired timestamps and empty background inventory are not foreground-stop proof.
        throw new OwnershipBlockedError(lease.invocationKey);
      }
    }
  }

  async assertMutation(name: string): Promise<void> {
    const records = await this.records();
    const sandboxes = await this.inventory();
    const target = sandboxes.find((sandbox) => sandbox.name === name);
    const scope = target ? this.scopeForSandbox(target) : undefined;
    const current = this.operations.current();
    const blocked = records.find((record) => {
      if (ownershipIsTerminal(record)) return false;
      // A reserved ensure owner may exclude itself before dispatch, never afterwards.
      if (current?.record.operationId === record.operationId && !current.dispatched
        && record.resource === 'reserved') return false;
      return record.scope.sandboxName === name || Boolean(scope && scopesOverlap(record.scope, scope));
    });
    if (blocked) throw new OwnershipBlockedError(blocked.operationId);
    if (!target) return; // The original UID/resourceVersion gate independently rereads it.
    if (!scope) throw new OwnershipUnavailableError('Mutation target has no usable writable scope');
    for (const sandbox of sandboxes) {
      if (!sandbox.activeInvocationLeases?.length) continue;
      const other = this.scopeForSandbox(sandbox);
      if (!other) throw new OwnershipUnavailableError();
      if (scopesOverlap(scope, other)) throw new OwnershipBlockedError(sandbox.activeInvocationLeases[0]?.invocationKey);
    }
  }

  async assertArchive(workspaceId: string): Promise<void> {
    const scope = writableScope(this.config, {
      name: 'archive', workspaceId, sessionId: 'archive', sandboxScopeId: workspaceId, mountSubPath: workspaceId,
    });
    const blocked = (await this.records()).find((record) => !ownershipIsTerminal(record) && scopesOverlap(record.scope, scope));
    if (blocked) throw new OwnershipBlockedError(blocked.operationId);
    for (const sandbox of await this.inventory()) {
      const other = this.scopeForSandbox(sandbox);
      if ((sandbox.activeInvocationLeases?.length || sandbox.backgroundShellProtectedUntil)
        && (!other || scopesOverlap(scope, other))) throw new OwnershipBlockedError();
    }
  }

  async project(sandboxes: ManagedSandbox[]): Promise<ManagedSandbox[]> {
    const records = (await this.records()).filter((record) => !ownershipIsTerminal(record));
    return sandboxes.map((sandbox) => {
      const scope = this.scopeForSandbox(sandbox);
      const protectedOwner = records.some((record) => record.scope.sandboxName === sandbox.name
        || Boolean(scope && scopesOverlap(record.scope, scope)));
      return protectedOwner ? { ...sandbox, activeInvocationLeaseRecoveryPending: true } : sandbox;
    });
  }

  private async records(): Promise<OwnershipRecord[]> {
    const persisted = await waitForOwned(this.journal.read(), { phase: 'ownership_read', timeoutMs: OWNED_WAIT_BUDGETS.persistenceMs });
    const merged = new Map(persisted.map((record) => [record.operationId, record]));
    for (const local of this.operations.records()) {
      // An unpersisted local uncertainty must not be hidden by an older healthy value.
      if (!ownershipIsTerminal(local) || !merged.has(local.operationId)) merged.set(local.operationId, local);
    }
    return [...merged.values()];
  }

  private async inventory(): Promise<ManagedSandbox[]> {
    return await waitForOwned(readManagedSandboxes(this.config, this.kubectl, this.kubeApi), {
      phase: 'ownership_sandbox_inventory', timeoutMs: OWNED_WAIT_BUDGETS.persistenceMs,
    });
  }

  private scopeForSandbox(sandbox: ManagedSandbox): WritableScope | undefined {
    if (!sandbox.workspaceId || !sandbox.sessionId) return undefined;
    return writableScope(this.config, {
      name: sandbox.name, workspaceId: sandbox.workspaceId, sessionId: sandbox.sessionId,
      sandboxScopeId: sandbox.sandboxScopeId ?? sandbox.workspaceId,
      mountSubPath: sandbox.mountSubPath ?? sandbox.workspaceId,
    });
  }
}
