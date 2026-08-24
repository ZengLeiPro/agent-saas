export const RELATION_TYPES = [
  'same_as', 'project_of', 'task_of', 'meeting_of', 'mentions', 'event_of',
] as const;
export type RelationType = typeof RELATION_TYPES[number];

export type RelationClass = 'explicit' | 'cooccurrence' | 'inferred';
export type RelationAuthority = 'informational' | 'advisory' | 'authoritative';
export type RelationReviewStatus = 'proposed' | 'confirmed' | 'rejected';
export type RelationLifecycle = 'active' | 'superseded' | 'revoked' | 'deleted';

export interface RelationEvidenceLocator {
  sourceId: string;
  collectionId: string;
  recordId: string;
  recordRevision: number;
  evidenceId: string;
}

export interface RelationNodeCandidate {
  entityId: string;
  entityType?: 'Customer' | 'Project' | 'Person' | 'Meeting' | 'Task';
  sourceId: string;
  collectionId: string;
  recordId: string;
  recordRevision: number;
}

/** Raw relation candidate. Authorization has intentionally not been evaluated. */
export interface RelationEdgeCandidate {
  relationId: string;
  relationType: RelationType;
  relationClass: RelationClass;
  authority: RelationAuthority;
  reviewStatus: RelationReviewStatus;
  lifecycle: RelationLifecycle;
  validFrom: string;
  validTo?: string;
  from: RelationNodeCandidate;
  to: RelationNodeCandidate;
  evidence: RelationEvidenceLocator;
  authorization: 'unchecked';
}

export interface RelationReadInput {
  tenantId: string;
  entityIds: string[];
  limit: number;
}

export interface RelationReadStore {
  listAdjacent(input: RelationReadInput): Promise<RelationEdgeCandidate[]>;
}

export interface RelationWalkInput {
  tenantId: string;
  startEntityId: string;
  maxDepth: 1 | 2;
  pageSize?: number;
  candidateLimit?: number;
  cursor?: string;
}

export interface RelationWalkCandidate {
  depth: 1 | 2;
  fromEntityId: string;
  nextEntityId: string;
  edge: RelationEdgeCandidate;
}

export interface RelationWalkPage {
  candidates: RelationWalkCandidate[];
  nextCursor?: string;
  truncated: boolean;
  authorization: 'unchecked';
}
