import type {
  ContextCollection,
  ContextIngestRecordInput,
  ContextSource,
  ContextSyncPartition,
  CreateContextCollectionInput,
  CreateContextSourceInput,
  EnsureContextPartitionInput,
  FailContextPartitionInput,
  IngestContextPageInput,
  IngestContextPageResult,
  ContextPartitionLeaseInput,
} from '../../store/types.js';

export interface DirectoryPerson {
  tenantId: string;
  userId: string;
  username: string;
  displayName?: string;
  position?: string;
  role?: string;
  status: 'active' | 'disabled' | 'offboarded';
  updatedAt: string;
}

export interface DirectoryContextReader {
  listTenantIds(): Promise<string[]>;
  listPeople(tenantId: string): Promise<DirectoryPerson[]>;
}

export interface DirectoryContextStore {
  getSource(tenantId: string, sourceId: string): Promise<ContextSource | null>;
  createSource(input: CreateContextSourceInput): Promise<ContextSource>;
  getCollection(tenantId: string, sourceId: string, collectionId: string): Promise<ContextCollection | null>;
  createCollection(input: CreateContextCollectionInput): Promise<ContextCollection>;
  ensurePartition(input: EnsureContextPartitionInput): Promise<ContextSyncPartition>;
  acquirePartitionLease(input: ContextPartitionLeaseInput): Promise<ContextSyncPartition | null>;
  listCurrentExternalRecordIds(tenantId: string, sourceId: string, collectionId: string): Promise<string[]>;
  ingestPage(input: IngestContextPageInput): Promise<IngestContextPageResult>;
  failPartition(input: FailContextPartitionInput): Promise<ContextSyncPartition>;
}

export interface DirectoryContextSyncOptions {
  leaseOwner?: string;
  leaseMs?: number;
  now?: () => Date;
  onTenantError?: (tenantId: string, error: unknown) => void;
}

export interface DirectoryContextSyncResult {
  tenantId: string;
  people: number;
  revoked: number;
  skipped: boolean;
}

export type DirectoryContextRecord = ContextIngestRecordInput;
