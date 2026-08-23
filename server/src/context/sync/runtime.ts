import { randomUUID } from 'node:crypto';

import type { PgAssignmentStore } from '../../data/assignments/store.js';
import type { PgMembershipStore } from '../../data/memberships/store.js';
import type { UserStore } from '../../data/users/store.js';
import { listAzerothTokenBindings } from '../../integrations/azeroth/tokens.js';
import type { PgTaskboardStore } from '../../taskboard/store.js';
import type { ContextStore } from '../store/index.js';
import type { DerivedContextStore } from '../derived/index.js';
import { AZEROTH_ENTITIES, ConfigAzerothContextPorts, AzerothInventoryWorker, identityFor } from './azeroth/index.js';
import { DIRECTORY_COLLECTION_ID, DirectoryContextSyncWorker, GovernanceDirectoryContextReader } from './directory/index.js';
import { PgTaskboardContextReader, TASKBOARD_COLLECTIONS, TaskboardContextSyncWorker } from './taskboard/index.js';

const FAST_INTERVAL_MS = 60_000;
const AZEROTH_INTERVAL_MS = 60 * 60_000;

export interface ContextPlanePhase2RuntimeOptions {
  contextStore: ContextStore;
  taskboardStore: PgTaskboardStore;
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
  private readonly taskboard: TaskboardContextSyncWorker;
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
    this.taskboard = new TaskboardContextSyncWorker({
      store: options.contextStore,
      reader: new PgTaskboardContextReader(options.taskboardStore),
    });
    this.directory = new DirectoryContextSyncWorker(
      options.contextStore,
      new GovernanceDirectoryContextReader(options.userStore, options.membershipStore),
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
    const [taskboardResults, directoryResults] = await Promise.all([
      this.taskboard.runOnce(),
      this.directory.runOnce(),
    ]);
    const tenantIds = new Set([
      ...taskboardResults.map(result => result.tenantId),
      ...directoryResults.map(result => result.tenantId),
    ]);
    for (const tenantId of tenantIds) {
      await this.ensurePhase2Assignments(tenantId, false);
      await this.projectDerived(tenantId);
    }
    this.logger.info(`Context Phase2/3 fast sync completed: tenants=${tenantIds.size}`);
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
    for (let page = 0; page < 100; page += 1) {
      const lease = await store.claimContextOutbox({
        tenantId,
        consumerId: 'context-deterministic-projector-v1',
        leaseOwner: this.derivedLeaseOwner,
        leaseMs: 60_000,
        limit: 100,
      });
      if (!lease) return;
      if (lease.events.length === 0) {
        await store.releaseConsumerLease(lease);
        return;
      }
      await store.projectClaimed(lease);
      if (lease.events.length < 100) return;
    }
    this.logger.warn(`Context derived projector page cap reached for tenant ${tenantId}`);
  }

  private async ensurePhase2Assignments(tenantId: string, includeAzeroth: boolean): Promise<void> {
    const resources = [
      ...Object.values(TASKBOARD_COLLECTIONS).map(item => ({ id: item.collectionId, name: item.displayName })),
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

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/((?:pat|token|authorization)\s*[=:]\s*)\S+/gi, '$1[REDACTED]')
    .replace(/\s+/g, ' ')
    .slice(0, 300);
}
