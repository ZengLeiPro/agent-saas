import type { RelationAuthority, RelationClass, RelationReviewStatus, RelationType } from '../relations/types.js';
import type { ContextJson, ContextObject } from '../store/types.js';

export const DERIVED_ENTITY_TYPES = ['Project', 'Task', 'Person', 'Meeting', 'Customer'] as const;
export type DerivedEntityType = typeof DERIVED_ENTITY_TYPES[number];

export const DERIVED_ITEM_TYPES = [
  'Decision', 'Status', 'Task', 'Risk', 'Commitment',
] as const;
export type DerivedItemType = typeof DERIVED_ITEM_TYPES[number];
export type DerivedAuthority = 'source' | 'user' | 'steward';
export type DerivedItemState = 'proposed' | 'confirmed' | 'superseded' | 'conflicted' | 'rejected' | 'revoked';
export type DerivedScope = { type: 'org' } | { type: 'person'; personId: string };

export interface DerivedEvidenceRef {
  sourceId: string;
  collectionId: string;
  recordId: string;
  recordRevision: number;
  evidenceId: string;
}

export interface ClaimedContextRecord {
  tenantId: string;
  seq: string;
  eventType: 'context.record.upserted' | 'context.record.deleted' | 'context.record.revoked';
  sourceId: string;
  collectionId: string;
  recordId: string;
  recordRevision: number;
  content: ContextJson;
  metadata: ContextObject;
  entityType?: 'customer' | 'project' | 'person' | 'meeting' | 'task';
  recordKind?: 'snapshot' | 'event';
  nativeId?: string;
  occurredAt?: string;
  sourceEventId?: string;
  ownerPrincipal?: string;
  aclPrincipals?: string[];
  deleted: boolean;
  revoked: boolean;
  sourceUpdatedAt?: string;
  observedAt: string;
  evidence: Array<{ evidenceId: string; kind: string; data: ContextObject }>;
}

export interface DerivedEntityCandidate {
  entityId: string;
  entityType: DerivedEntityType;
  stableKey: string;
  label?: string;
  metadata: ContextObject;
  sourceId: string;
  collectionId: string;
  recordId: string;
  recordRevision: number;
  ownerPrincipal?: string;
  aclPrincipals?: string[];
}

export interface DerivedRelationCandidate {
  relationId: string;
  fromEntityId: string;
  toEntityId: string;
  relationType: RelationType;
  relationClass: RelationClass;
  authority: RelationAuthority;
  reviewStatus: RelationReviewStatus;
  sourceId: string;
  collectionId: string;
  recordId: string;
  recordRevision: number;
  validFrom: string;
  validTo?: string;
  evidence: DerivedEvidenceRef[];
}

export interface DerivedItemCandidate {
  itemId: string;
  entityId: string;
  itemType: DerivedItemType;
  semanticKey: string;
  value: ContextJson;
  valueFingerprint: string;
  derivation: 'source' | 'review' | 'distill';
  authority: DerivedAuthority;
  state: 'confirmed' | 'proposed';
  scope: DerivedScope;
  sourceId?: string;
  collectionId?: string;
  recordId?: string;
  recordRevision?: number;
  ownerPrincipal?: string;
  aclPrincipals?: string[];
  validFrom?: string;
  validTo?: string;
  occurredAt?: string;
  observedAt: string;
  evidence: DerivedEvidenceRef[];
}

export interface DerivedProjection {
  entities: DerivedEntityCandidate[];
  relations: DerivedRelationCandidate[];
  items: DerivedItemCandidate[];
}

export interface ConsumerLease {
  tenantId: string;
  consumerId: string;
  leaseOwner: string;
  leaseFence: string;
  cursorSeq: string;
  events: ClaimedContextRecord[];
  leaseExpiresAt: string;
}

export interface ReviewRoleGate {
  /** Must verify trusted platform authorization; actor-supplied role strings are not accepted. */
  mayCorrectOrganization(input: { tenantId: string; actorId: string }): Promise<boolean>;
}

export interface DerivedReviewAuthorizationSnapshot {
  readonly tenantId: string;
  readonly entityId: string;
  readonly generation: string;
  readonly itemId: string;
  readonly itemType: DerivedItemType;
  readonly semanticKey: string;
  readonly valueFingerprint: string;
  readonly ownerPrincipal: string | null;
  readonly evidence: readonly Readonly<DerivedEvidenceRef>[];
  readonly scope: Readonly<DerivedScope>;
}

export type DerivedReviewAuthorizer = (snapshot: DerivedReviewAuthorizationSnapshot) => Promise<boolean>;

export interface AppendReviewInput {
  tenantId: string;
  actorId: string;
  entityId: string;
  expectedRevision: number;
  scope: DerivedScope;
  action: 'assert' | 'reject';
  /** Mandatory live authorization performed against the locked target snapshot. */
  authorize: DerivedReviewAuthorizer;
  /** Exact active item being corrected; never infer a reject target from its fingerprint. */
  targetItemId: string;
  itemType?: DerivedItemType;
  semanticKey?: string;
  value?: ContextJson;
  rejectFingerprint?: string;
  evidence: DerivedEvidenceRef[];
  validFrom?: string;
  validTo?: string;
  occurredAt?: string;
  observedAt?: string;
}

export interface DerivedReview {
  reviewId: string;
  tenantId: string;
  entityId: string;
  entityRevision: number;
  actorId: string;
  scope: DerivedScope;
  authority: Exclude<DerivedAuthority, 'source'>;
  action: 'assert' | 'reject';
  itemId?: string;
  rejectFingerprint?: string;
  createdAt: string;
}

export interface ProposedDistillItem {
  entityId: string;
  itemType: string;
  semanticKey: string;
  value: ContextJson;
  quote: string;
  evidence: DerivedEvidenceRef[];
  validFrom?: string;
  validTo?: string;
  occurredAt?: string;
}

export interface ProfileFacetEntry {
  itemId: string;
  semanticKey: string;
  value: ContextJson;
  authority: DerivedAuthority;
  evidence: DerivedEvidenceRef[];
}

export interface DerivedProfile {
  tenantId: string;
  entityId: string;
  viewerId?: string;
  status: 'active' | 'revoked';
  facets: {
    role: ProfileFacetEntry[];
    tasks: ProfileFacetEntry[];
    workflow: ProfileFacetEntry[];
    artifacts: ProfileFacetEntry[];
    knowhow: ProfileFacetEntry[];
  };
}

export class DerivedStoreError extends Error {
  constructor(readonly code:
    | 'DERIVED_INVALID'
    | 'DERIVED_NOT_FOUND'
    | 'DERIVED_VERSION_CONFLICT'
    | 'DERIVED_LEASE_LOST'
    | 'DERIVED_FORBIDDEN'
    | 'DERIVED_EVIDENCE_INVALID') {
    super(code);
    this.name = 'DerivedStoreError';
  }
}
