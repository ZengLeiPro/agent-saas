export type ContextJson = null | boolean | number | string | ContextJson[] | { [key: string]: ContextJson };
export type ContextObject = Record<string, ContextJson>;

export type ContextResourceStatus = 'active' | 'disabled' | 'revoked' | 'deleted';
export type ContextPartitionStatus = 'idle' | 'syncing' | 'retry_wait' | 'complete' | 'refused';

export interface ContextSource {
  tenantId: string;
  sourceId: string;
  kind: string;
  displayName: string;
  status: ContextResourceStatus;
  config: ContextObject;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateContextSourceInput {
  tenantId: string;
  sourceId: string;
  kind: string;
  displayName: string;
  config?: ContextObject;
}

export interface UpdateContextSourceInput {
  tenantId: string;
  sourceId: string;
  expectedRevision: number;
  displayName?: string;
  status?: ContextResourceStatus;
  config?: ContextObject;
}

export interface ContextCollection {
  tenantId: string;
  sourceId: string;
  collectionId: string;
  externalKey: string;
  displayName: string;
  status: ContextResourceStatus;
  metadata: ContextObject;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateContextCollectionInput {
  tenantId: string;
  sourceId: string;
  collectionId: string;
  externalKey: string;
  displayName: string;
  metadata?: ContextObject;
}

export interface UpdateContextCollectionInput {
  tenantId: string;
  sourceId: string;
  collectionId: string;
  expectedRevision: number;
  displayName?: string;
  status?: ContextResourceStatus;
  metadata?: ContextObject;
}

export interface ContextSyncPartition {
  tenantId: string;
  sourceId: string;
  collectionId: string;
  partitionKey: string;
  status: ContextPartitionStatus;
  watermark?: ContextJson;
  windowStart?: string;
  windowEnd?: string;
  pageCursor?: string;
  leaseOwner?: string;
  leaseFence: number;
  leaseExpiresAt?: string;
  retryCount: number;
  nextRetryAt?: string;
  lastErrorCode?: string;
  coverageStart?: string;
  coverageEnd?: string;
  truncated: boolean;
  refused: boolean;
  updatedAt: string;
}

export interface EnsureContextPartitionInput {
  tenantId: string;
  sourceId: string;
  collectionId: string;
  partitionKey: string;
  windowStart?: string;
  windowEnd?: string;
}

export interface ContextPartitionLeaseInput {
  tenantId: string;
  sourceId: string;
  collectionId: string;
  partitionKey: string;
  leaseOwner: string;
  leaseMs: number;
}

export interface ContextPartitionFenceInput {
  tenantId: string;
  sourceId: string;
  collectionId: string;
  partitionKey: string;
  leaseOwner: string;
  leaseFence: number;
}

export interface FailContextPartitionInput extends ContextPartitionFenceInput {
  errorCode: string;
  retryAt?: string;
  refused?: boolean;
}

export interface ContextSourceRecord {
  tenantId: string;
  sourceId: string;
  collectionId: string;
  recordId: string;
  externalRecordId: string;
  currentRevision: number;
  contentHash: string;
  content: ContextJson;
  metadata: ContextObject;
  deleted: boolean;
  revoked: boolean;
  sourceUpdatedAt?: string;
  observedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContextRecordRevision {
  tenantId: string;
  sourceId: string;
  collectionId: string;
  recordId: string;
  revision: number;
  contentHash: string;
  content: ContextJson;
  metadata: ContextObject;
  deleted: boolean;
  revoked: boolean;
  sourceUpdatedAt?: string;
  observedAt: string;
  createdAt: string;
}

export interface ContextEvidence {
  tenantId: string;
  sourceId: string;
  collectionId: string;
  recordId: string;
  revision: number;
  evidenceId: string;
  kind: string;
  data: ContextObject;
  createdAt: string;
}

export interface ContextEvidenceInput {
  evidenceId: string;
  kind: string;
  data: ContextObject;
}

export interface ContextIngestRecordInput {
  recordId: string;
  externalRecordId: string;
  content: ContextJson;
  contentHash?: string;
  metadata?: ContextObject;
  deleted?: boolean;
  revoked?: boolean;
  sourceUpdatedAt?: string;
  observedAt?: string;
  evidence?: readonly ContextEvidenceInput[];
}

export interface ContextPartitionCheckpoint {
  watermark?: ContextJson;
  windowStart?: string;
  windowEnd?: string;
  pageCursor?: string;
  coverageStart?: string;
  coverageEnd?: string;
  truncated?: boolean;
  refused?: boolean;
  complete?: boolean;
  releaseLease?: boolean;
}

export interface IngestContextPageInput extends ContextPartitionFenceInput {
  records: readonly ContextIngestRecordInput[];
  checkpoint: ContextPartitionCheckpoint;
}

export interface IngestContextPageResult {
  partition: ContextSyncPartition;
  created: number;
  revised: number;
  unchanged: number;
  outbox: ContextOutboxEvent[];
}

export interface ContextRecordWithRevision {
  record: ContextSourceRecord;
  revision: ContextRecordRevision;
}

export interface ContextOutboxEvent {
  tenantId: string;
  seq: string;
  eventType: 'context.record.upserted' | 'context.record.deleted' | 'context.record.revoked';
  sourceId: string;
  collectionId: string;
  recordId: string;
  recordRevision: number;
  payload: ContextObject;
  createdAt: string;
}

export interface ContextOutboxCursor {
  tenantId: string;
  seq: string;
}

export type ContextStoreErrorCode =
  | 'CONTEXT_INVALID'
  | 'CONTEXT_NOT_FOUND'
  | 'CONTEXT_VERSION_CONFLICT'
  | 'CONTEXT_IDENTITY_CONFLICT'
  | 'CONTEXT_LEASE_LOST';

export class ContextStoreError extends Error {
  constructor(readonly code: ContextStoreErrorCode) {
    super(code);
    this.name = 'ContextStoreError';
  }
}
