import type {
  DerivedEvidenceRef,
  DerivedItemType,
  DerivedReviewAuthorizationSnapshot,
  DerivedScope,
} from '../derived/types.js';
import type { RelationEdgeCandidate } from '../relations/types.js';
import type { ContextJson, ContextObject } from '../store/types.js';

export interface ContextProductSubject {
  tenantId: string;
  actorId: string;
}

export interface ProductRecordLocator {
  sourceKind: string;
  sourceId: string;
  collectionId: string;
  recordId: string;
  recordRevision: number;
  currentRevision: number;
  recordType: 'snapshot' | 'event';
  currentDeleted: boolean;
  currentRevoked: boolean;
  refused: boolean;
  metadata: ContextObject;
  ownerPrincipal?: string;
  aclPrincipals?: string[];
  sourceEventId?: string;
  eventType?: string;
}

export interface ProductEvidenceCandidate {
  ref: DerivedEvidenceRef;
  locator: ProductRecordLocator;
  kind: string;
  source: string | null;
  author: string | null;
  excerpt: string | null;
  url: string | null;
  occurredAt: string | null;
  createdAt: string;
  label: string;
  summary: string | null;
}

export interface ProductTimelineCandidate {
  timelineId: string;
  type: string;
  label: string;
  summary: string | null;
  occurredAt: string;
  updatedAt: string;
  entityId: string | null;
  entityLabel: string | null;
  locator: ProductRecordLocator;
  evidence: DerivedEvidenceRef[];
}

export interface ProductEntityCandidate {
  entityId: string;
  entityType: string;
  label: string;
  summary: string | null;
  revision: number;
  correctionRevisions: { personal: number; organization: number };
  updatedAt: string;
  locator: ProductRecordLocator;
}

export interface ProductItemCandidate {
  itemId: string;
  entityId: string;
  itemType: DerivedItemType;
  semanticKey: string;
  value: ContextJson;
  valueFingerprint: string;
  authority: 'source' | 'user' | 'steward';
  state: 'proposed' | 'confirmed' | 'conflicted';
  scope: DerivedScope;
  revision: number;
  occurredAt: string;
  updatedAt: string;
  evidence: DerivedEvidenceRef[];
}

export interface ProductCorrectionCandidate {
  reviewId: string;
  entityId: string;
  itemId: string;
  action: 'assert' | 'reject';
  actorId: string;
  scope: DerivedScope;
  authority: 'user' | 'steward';
  revision: number;
  summary: string | null;
  createdAt: string;
  evidence: DerivedEvidenceRef[];
}

export interface ProductReviewCandidate extends ProductItemCandidate {
  entityLabel: string;
  originalSummary: string | null;
  conflict: string | null;
}

export interface ProductStoreListInput {
  tenantId: string;
  collectionIds: string[];
  limit: number;
  filter?: string;
  type?: string;
  entityId?: string;
  from?: string;
  through?: string;
}

export interface ProductRelationCandidate {
  edge: RelationEdgeCandidate;
  locator: ProductRecordLocator;
}

export interface ProductReviewAuthorizationItemSnapshot {
  readonly generation: string;
  readonly itemId: string;
  readonly revision: number;
  readonly status: string;
  readonly conflict: string;
  readonly valueFingerprint: string;
  readonly evidence: readonly Readonly<DerivedEvidenceRef>[];
}

export interface ProductReviewAuthorizationSnapshot {
  readonly tenantId: string;
  readonly targetItemId: string;
  readonly entityId: string;
  readonly itemType: DerivedItemType;
  readonly semanticKey: string;
  readonly count: number;
  readonly fingerprint: string;
  readonly items: readonly ProductReviewAuthorizationItemSnapshot[];
}

export type ProductReviewAuthorizer = (snapshot: ProductReviewAuthorizationSnapshot) => Promise<boolean>;

export interface ContextProductStore {
  listTimeline(input: ProductStoreListInput): Promise<ProductTimelineCandidate[]>;
  listEntities(input: ProductStoreListInput): Promise<ProductEntityCandidate[]>;
  getEntity(tenantId: string, entityId: string, collectionIds: string[], actorId: string): Promise<ProductEntityCandidate | null>;
  listItems(tenantId: string, entityId: string): Promise<ProductItemCandidate[]>;
  getItem(tenantId: string, entityId: string, itemId: string): Promise<ProductItemCandidate | null>;
  listCorrections(tenantId: string, entityId: string, actorId: string): Promise<ProductCorrectionCandidate[]>;
  listReviews(input: ProductStoreListInput): Promise<ProductReviewCandidate[]>;
  getReviewGroup(tenantId: string, itemId: string, limit: number): Promise<ProductReviewCandidate[]>;
  getCorrectionAuthorizationSnapshot(input: {
    tenantId: string;
    entityId: string;
    generation: string;
    itemId: string;
    scope: DerivedScope;
  }): Promise<DerivedReviewAuthorizationSnapshot | null>;
  getReviewAuthorizationSnapshot(
    tenantId: string,
    itemId: string,
    limit: number,
  ): Promise<ProductReviewAuthorizationSnapshot | null>;
  getEvidence(tenantId: string, ref: DerivedEvidenceRef): Promise<ProductEvidenceCandidate | null>;
  getCurrentRecordLocator(tenantId: string, ref: {
    sourceId: string;
    collectionId: string;
    recordId: string;
    recordRevision: number;
  }): Promise<ProductRecordLocator | null>;
  listAdjacent(tenantId: string, entityIds: string[], limit: number): Promise<{
    items: ProductRelationCandidate[];
    degraded: boolean;
  }>;
  decideReview(input: {
    tenantId: string;
    actorId: string;
    itemId: string;
    expectedRevision: number;
    decision: 'confirmed' | 'rejected';
    authorize: ProductReviewAuthorizer;
  }): Promise<{ status: 'confirmed' | 'rejected' }>;
}

export interface ProductPage<T> {
  items: T[];
  nextCursor: string | null;
  degraded: boolean;
}

export class ContextProductError extends Error {
  constructor(readonly code:
    | 'CONTEXT_PRODUCT_INVALID'
    | 'CONTEXT_PRODUCT_FORBIDDEN'
    | 'CONTEXT_PRODUCT_NOT_FOUND'
    | 'CONTEXT_PRODUCT_CONFLICT'
    | 'CONTEXT_PRODUCT_PRECONDITION_REQUIRED'
    | 'CONTEXT_PRODUCT_UNAVAILABLE'
    | 'CONTEXT_PRODUCT_CURSOR_INVALID'
    | 'CONTEXT_PRODUCT_EVIDENCE_INVALID') {
    super(code);
    this.name = 'ContextProductError';
  }
}
