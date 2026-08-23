import type {
  ContextIngestRecordInput,
  ContextJson,
  ContextObject,
  ContextSyncPartition,
} from '../../store/index.js';

export const AZEROTH_ENTITIES = [
  'customers',
  'contacts',
  'employees',
  'opportunities',
  'keep-records',
  'projects',
  'project-tickets',
  'effort-records',
  'dingtalk-logs',
  'dingtalk-calendar-events',
  'sales-action-items',
  'web-events',
] as const;

export type AzerothEntity = typeof AZEROTH_ENTITIES[number];

/** A server-owned handle. Secrets remain behind the injected HTTP client. */
export interface AzerothServerBinding {
  bindingId: string;
  serverSide: true;
  roles: readonly string[];
  baseUrl: string;
  credentialHandle: string;
}

export interface AzerothBindingPort {
  /** The implementation resolves bindings inside tenant scope. */
  listServerBindings(tenantId: string): Promise<readonly AzerothServerBinding[]>;
}

export interface AzerothHttpClient {
  get(input: {
    binding: AzerothServerBinding;
    path: string;
    query: Readonly<Record<string, string | number>>;
    signal?: AbortSignal;
  }): Promise<unknown>;
}

export interface AzerothSourceResource {
  revision: number;
  status: 'active' | 'disabled' | 'revoked' | 'deleted';
}

export interface AzerothCollectionResource extends AzerothSourceResource {}

/** Narrow ContextStore-compatible surface used by the worker. */
export interface AzerothContextStorePort {
  getSource(tenantId: string, sourceId: string): Promise<AzerothSourceResource | null>;
  createSource(input: {
    tenantId: string;
    sourceId: string;
    kind: string;
    displayName: string;
    config?: ContextObject;
  }): Promise<AzerothSourceResource>;
  getCollection(
    tenantId: string,
    sourceId: string,
    collectionId: string,
  ): Promise<AzerothCollectionResource | null>;
  createCollection(input: {
    tenantId: string;
    sourceId: string;
    collectionId: string;
    externalKey: string;
    displayName: string;
    metadata?: ContextObject;
  }): Promise<AzerothCollectionResource>;
  ensurePartition(input: {
    tenantId: string;
    sourceId: string;
    collectionId: string;
    partitionKey: string;
  }): Promise<ContextSyncPartition>;
  acquirePartitionLease(input: {
    tenantId: string;
    sourceId: string;
    collectionId: string;
    partitionKey: string;
    leaseOwner: string;
    leaseMs: number;
  }): Promise<ContextSyncPartition | null>;
  renewPartitionLease(input: {
    tenantId: string;
    sourceId: string;
    collectionId: string;
    partitionKey: string;
    leaseOwner: string;
    leaseFence: number;
    leaseMs: number;
  }): Promise<boolean>;
  ingestPage(input: {
    tenantId: string;
    sourceId: string;
    collectionId: string;
    partitionKey: string;
    leaseOwner: string;
    leaseFence: number;
    records: readonly ContextIngestRecordInput[];
    checkpoint: {
      watermark?: ContextJson;
      pageCursor?: string;
      complete?: boolean;
      releaseLease?: boolean;
    };
  }): Promise<unknown>;
  failPartition(input: {
    tenantId: string;
    sourceId: string;
    collectionId: string;
    partitionKey: string;
    leaseOwner: string;
    leaseFence: number;
    errorCode: string;
    retryAt?: string;
    refused?: boolean;
  }): Promise<ContextSyncPartition>;
  listCurrentExternalRecordIds(
    tenantId: string,
    sourceId: string,
    collectionId: string,
  ): Promise<string[]>;
}

export interface AzerothInventoryResult {
  tenantId: string;
  entity: AzerothEntity;
  sourceId: string;
  collectionId: string;
  pages: number;
  records: number;
  revoked: number;
  completedAt: string;
}

export interface AzerothTenantSyncResult {
  tenantId: string;
  bindingId: string;
  inventories: AzerothInventoryResult[];
}

export class AzerothAuthorizationError extends Error {
  readonly code = 'AZEROTH_ADMIN_BINDING_REQUIRED';

  constructor(message = 'Azeroth sync requires exactly one server-side binding with the ADMIN role') {
    super(message);
    this.name = 'AzerothAuthorizationError';
  }
}

export class AzerothLeaseUnavailableError extends Error {
  readonly code = 'AZEROTH_LEASE_UNAVAILABLE';

  constructor(readonly entity: AzerothEntity) {
    super(`Azeroth ${entity} inventory lease is unavailable`);
    this.name = 'AzerothLeaseUnavailableError';
  }
}
