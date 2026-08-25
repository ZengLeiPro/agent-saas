import { randomUUID } from 'node:crypto';

import type { PgAssignmentStore } from '../../data/assignments/store.js';
import type { PgMembershipStore } from '../../data/memberships/store.js';
import type { UserStore } from '../../data/users/store.js';
import { listAzerothTokenBindings } from '../../integrations/azeroth/tokens.js';
import type { PgTaskboardStore } from '../../taskboard/store.js';
import type { ContextStore } from '../store/index.js';
import { DerivedStoreError, type DerivedContextStore } from '../derived/index.js';
import { AZEROTH_ENTITIES, ConfigAzerothContextPorts, AzerothInventoryWorker, identityFor } from './azeroth/index.js';
import { DIRECTORY_COLLECTION_ID, DirectoryContextSyncWorker, GovernanceDirectoryContextReader } from './directory/index.js';
import { PgTaskboardContextReader, TASKBOARD_COLLECTIONS, TaskboardContextSyncWorker } from './taskboard/index.js';

const FAST_INTERVAL_MS = 60_000;
const AZEROTH_INTERVAL_MS = 60 * 60_000;
const DERIVED_OUTBOX_PAGE_SIZE = 100;
const DERIVED_OUTBOX_PAGE_CAP = 100;
const RELATION_RESOLVE_PAGE_SIZE = 100;
const RELATION_RESOLVE_PAGE_CAP = 100;

export interface ContextPlanePhase2RuntimeOptions {
  contextStore: ContextStore;
  taskboardStore?: PgTaskboardStore;
  membershipStore: PgMembershipStore;
  assignmentStore: PgAssignmentStore;
  userStore: UserStore;
  derivedStore?: DerivedContextStore;
  fetchImpl?: typeof fetch;
  logger?: { info(message: string): void; warn(message: string): void };
  fastIntervalMs?: number;
  azerothIntervalMs?: number;
}

export class ContextPlanePhase2Runtime {
  private readonly taskboard?: TaskboardContextSyncWorker;
  private readonly directory: DirectoryContextSyncWorker;
  private readonly azeroth: AzerothInventoryWorker;
  private readonly logger;
  private readonly derivedLeaseOwner = `context-derived-${randomUUID()}`;
  private fastTimer?: NodeJS.Timeout;
  private azerothTimer?: NodeJS.Timeout;
  private fastRun?: Promise<void>;
  private azerothRun?: Promise<void>;

  constructor(private readonly options: ContextPlanePhase2RuntimeOptions) {
    this.logger = options.logger ?? { info: () => undefined, warn: () => undefined };
    this.taskboard = options.taskboardStore
      ? new TaskboardContextSyncWorker({
          store: options.contextStore,
          reader: new PgTaskboardContextReader(options.taskboardStore),
          onTenantError: (tenantId, error) =>
            this.logger.warn(`Context Taskboard sync failed for tenant ${tenantId}: ${safeError(error)}`),
        })
      : undefined;
    this.directory = new DirectoryContextSyncWorker(
      options.contextStore,
      new GovernanceDirectoryContextReader(options.userStore, options.membershipStore),
      {
        onTenantError: (tenantId, error) =>
          this.logger.warn(`Context Directory sync failed for tenant ${tenantId}: ${safeError(error)}`),
      },
    );
    const azerothPorts = new ConfigAzerothContextPorts({ fetchImpl: options.fetchImpl });
    this.azeroth = new AzerothInventoryWorker({
      store: options.contextStore,
      bindings: azerothPorts,
      http: azerothPorts,
    });
  }

  start(): void {
    if (this.fastTimer || this.azerothTimer) return;
    void this.triggerFast();
    void this.triggerAzeroth();
    this.fastTimer = setInterval(() => void this.triggerFast(), this.options.fastIntervalMs ?? FAST_INTERVAL_MS);
    this.azerothTimer = setInterval(
      () => void this.triggerAzeroth(),
      this.options.azerothIntervalMs ?? AZEROTH_INTERVAL_MS,
    );
    this.fastTimer.unref?.();
    this.azerothTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.fastTimer) clearInterval(this.fastTimer);
    if (this.azerothTimer) clearInterval(this.azerothTimer);
    this.fastTimer = undefined;
    this.azerothTimer = undefined;
    await Promise.allSettled([this.fastRun, this.azerothRun].filter(Boolean) as Promise<void>[]);
  }

  async runFastOnce(): Promise<void> {
    const [taskboardRun, directoryRun] = await Promise.allSettled([
      this.taskboard?.runOnce() ?? Promise.resolve([]),
      this.directory.runOnce(),
    ]);
    if (taskboardRun.status === 'rejected') {
      this.logger.warn(`Context Taskboard coordinator failed: ${safeError(taskboardRun.reason)}`);
    }
    if (directoryRun.status === 'rejected') {
      this.logger.warn(`Context Directory coordinator failed: ${safeError(directoryRun.reason)}`);
    }
    const taskboardResults = taskboardRun.status === 'fulfilled' ? taskboardRun.value : [];
    const directoryResults = directoryRun.status === 'fulfilled' ? directoryRun.value : [];
    const tenantIds = new Set([
      ...taskboardResults.map(result => result.tenantId),
      ...directoryResults.map(result => result.tenantId),
    ]);
    let projectedTenants = 0;
    for (const tenantId of tenantIds) {
      try {
        await this.ensurePhase2Assignments(tenantId, false);
        await this.projectDerived(tenantId);
        projectedTenants += 1;
      } catch (error) {
        this.logger.warn(`Context fast projection failed for tenant ${tenantId}: ${safeError(error)}`);
      }
    }
    this.logger.info(`Context Phase2/3 fast sync completed: tenants=${tenantIds.size}, projected=${projectedTenants}`);
  }

  async runAzerothOnce(): Promise<void> {
    const tenantIds = [...new Set(listAzerothTokenBindings()
      .filter(binding => binding.roles?.includes('ADMIN'))
      .map(binding => binding.tenantId))].sort();
    for (const tenantId of tenantIds) {
      try {
        await this.azeroth.syncTenant(tenantId);
        await this.ensurePhase2Assignments(tenantId, true);
        await this.projectDerived(tenantId);
      } catch (error) {
        this.logger.warn(`Context Azeroth sync failed for tenant ${tenantId}: ${safeError(error)}`);
      }
    }
    this.logger.info(`Context Azeroth sync completed: tenants=${tenantIds.length}`);
  }

  private triggerFast(): Promise<void> {
    if (this.fastRun) return this.fastRun;
    this.fastRun = this.runFastOnce()
      .catch(error => this.logger.warn(`Context Phase2 fast sync failed: ${safeError(error)}`))
      .finally(() => { this.fastRun = undefined; });
    return this.fastRun;
  }

  private triggerAzeroth(): Promise<void> {
    if (this.azerothRun) return this.azerothRun;
    this.azerothRun = this.runAzerothOnce()
      .catch(error => this.logger.warn(`Context Azeroth coordinator failed: ${safeError(error)}`))
      .finally(() => { this.azerothRun = undefined; });
    return this.azerothRun;
  }

  private async projectDerived(tenantId: string): Promise<void> {
    const store = this.options.derivedStore;
    if (!store) return;
    let outboxCapped = true;
    for (let page = 0; page < DERIVED_OUTBOX_PAGE_CAP; page += 1) {
      const lease = await store.claimContextOutbox({
        tenantId,
        consumerId: 'context-deterministic-projector-v1',
        leaseOwner: this.derivedLeaseOwner,
        leaseMs: 60_000,
        limit: DERIVED_OUTBOX_PAGE_SIZE,
      });
      if (!lease) { outboxCapped = false; break; }
      if (lease.events.length === 0) {
        await store.releaseConsumerLease(lease);
        outboxCapped = false;
        break;
      }
      try {
        await store.projectClaimed(lease);
      } catch (error) {
        await store.failConsumerLease(lease, derivedProjectionFailureCode(error)).catch(() => false);
        throw error;
      }
      if (lease.events.length < DERIVED_OUTBOX_PAGE_SIZE) { outboxCapped = false; break; }
    }
    if (outboxCapped) this.logger.warn(`Context derived projector page cap reached for tenant ${tenantId}`);
    await this.drainPendingRelations(tenantId, store);
  }

  private async drainPendingRelations(tenantId: string, store: DerivedContextStore): Promise<void> {
    for (let page = 0; page < RELATION_RESOLVE_PAGE_CAP; page += 1) {
      const result = await store.resolvePendingRelationCandidates({
        tenantId,
        limit: RELATION_RESOLVE_PAGE_SIZE,
      });
      if (!result.pending || result.materialized < RELATION_RESOLVE_PAGE_SIZE) return;
    }
    this.logger.warn(`Context relation resolver page cap reached with pending candidates for tenant ${tenantId}`);
  }

  private async ensurePhase2Assignments(tenantId: string, includeAzeroth: boolean): Promise<void> {
    const resources = [
      ...(this.taskboard
        ? Object.values(TASKBOARD_COLLECTIONS).map(item => ({ id: item.collectionId, name: item.displayName }))
        : []),
      { id: DIRECTORY_COLLECTION_ID, name: '组织成员' },
      ...(includeAzeroth ? AZEROTH_ENTITIES.map(entity => ({ id: identityFor(entity).collectionId, name: `Azeroth ${entity}` })) : []),
    ];
    for (const resource of resources) {
      if (await this.options.assignmentStore.getAssignmentSet(tenantId, 'org_knowledge', resource.id)) continue;
      try {
        await this.options.assignmentStore.replaceAssignments(
          tenantId,
          'org_knowledge',
          resource.id,
          [],
          0,
          'system:context-phase2-sync',
          { resourceName: resource.name, status: 'enabled' },
        );
      } catch (error) {
        if (!await this.options.assignmentStore.getAssignmentSet(tenantId, 'org_knowledge', resource.id)) throw error;
      }
    }
  }
}

export function derivedProjectionFailureCode(error: unknown): string {
  if (error instanceof DerivedStoreError) return error.code;
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? '') : '';
  switch (code) {
    case '23503': return 'DERIVED_REFERENCE_MISSING';
    case '23505': return 'DERIVED_UNIQUE_CONFLICT';
    case '23514': return 'DERIVED_CONSTRAINT_VIOLATION';
    case '22007':
    case '22008': return 'DERIVED_TIMESTAMP_INVALID';
    case '22P02': return 'DERIVED_VALUE_INVALID';
    case '42P01':
    case '42703': return 'DERIVED_SCHEMA_MISMATCH';
    default: return 'DERIVED_PROJECTION_FAILED';
  }
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/((?:pat|token|authorization)\s*[=:]\s*)\S+/gi, '$1[REDACTED]')
    .replace(/\s+/g, ' ')
    .slice(0, 300);
}
