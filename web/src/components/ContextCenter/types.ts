export type SourceSyncStatus = "healthy" | "syncing" | "attention" | "paused";

export type BackfillCoverage =
  | { kind: "items"; coveredItems: number; totalItems: number }
  | { kind: "time"; coveredFrom: string | null; coveredThrough: string | null };

export interface ContextScope {
  enabled: boolean;
  summary: string;
  from?: string | null;
  through?: string | null;
  includes?: string[];
}

export interface ContextSource {
  sourceId: string;
  name: string;
  system: string;
  collectionId: string;
  collection: string;
  status: SourceSyncStatus;
  lastSyncedAt: string | null;
  backfillCoverage: BackfillCoverage;
  watermarkLagSeconds: number | null;
  ingestOutcomes: {
    truncated: number;
    refused: number;
    unreadable: number;
    retrying: number;
    lastErrorCodes: string[];
    nextRetryAt: string | null;
  };
  historicalLearningScope: ContextScope;
  realtimeListeningScope: ContextScope;
}

export type ConsumerStatus = "current" | "lagging" | "blocked" | "offline";
export interface ContextConsumer {
  id: string;
  name: string;
  kind: string;
  status: ConsumerStatus;
  watermarkAt: string | null;
  lagSeconds: number | null;
  detail?: string;
}

export interface ContextCenterSnapshot {
  generatedAt: string;
  sources: ContextSource[];
  consumers: ContextConsumer[];
}

export type EvidenceFreshness = "fresh" | "aging" | "stale" | "unknown";
export interface ContextEvidence {
  id: string;
  sourceName: string;
  collection: string;
  author: string | null;
  occurredAt: string;
  quote: string;
  derived: boolean;
  freshness: EvidenceFreshness;
  freshnessAsOf: string | null;
  originalUrl: string | null;
}
export type ContextScopeKind = "personal" | "organization";
export interface ContextAuthority { scope: ContextScopeKind; label: string }
export interface ContextEvidenceRef {
  id: string;
  type: string;
  label: string;
  summary: string | null;
  occurredAt: string;
}
export interface ContextRecord {
  id: string;
  type: string;
  label: string;
  summary: string | null;
  revision: number;
  updatedAt: string;
  degraded: boolean;
}
export interface ContextTimelineItem extends ContextRecord {
  occurredAt: string;
  entityId: string | null;
  entityLabel: string | null;
  authority: ContextAuthority;
  evidence: ContextEvidenceRef[];
}
export interface ContextCorrectionRecord extends ContextRecord {
  action: "assert" | "reject";
  authority: ContextAuthority;
  evidence: ContextEvidenceRef[];
}
export type ContextEntity = ContextRecord;
export type ContextDerivedItemType = "Decision" | "Status" | "Task" | "Risk" | "Commitment";
export type ContextProfileFacetType = "role" | "tasks" | "workflow" | "artifacts" | "knowhow";
export interface ContextDerivedItem extends ContextRecord {
  type: ContextDerivedItemType;
  authority: ContextAuthority;
  evidence: ContextEvidenceRef[];
  review: "proposed" | "conflicted" | "confirmed";
  correctable: boolean;
  correctionDisabledReason: "pending_review" | "conflicted" | null;
}
export interface ContextProfileAttribute extends ContextRecord {
  type: ContextProfileFacetType;
  authority: ContextAuthority;
  evidence: ContextEvidenceRef[];
  conflict: string | null;
  review: "proposed" | "conflicted" | "confirmed" | "rejected" | null;
}
export interface ContextEntityDetail extends ContextRecord {
  correctionRevisions: { personal: number; organization: number };
  evidence: ContextEvidenceRef[];
  items: ContextDerivedItem[];
  corrections: ContextCorrectionRecord[];
}
export interface ContextEntityProfile {
  entityId: string;
  label: string;
  summary: string | null;
  revision: number;
  updatedAt: string;
  attributes: ContextProfileAttribute[];
  degraded: boolean;
}
export type RelationLevel = "explicit" | "cooccurrence" | "inferred";
export type RelationReviewStatus = "proposed" | "confirmed" | "rejected";
export interface ContextRelation extends ContextRecord {
  depth: 1 | 2;
  level: RelationLevel;
  reviewStatus: RelationReviewStatus;
  fromEntity: Pick<ContextEntity, "id" | "type" | "label" | "summary">;
  targetEntity: Pick<ContextEntity, "id" | "type" | "label" | "summary">;
  authority: ContextAuthority;
  evidence: ContextEvidenceRef[];
}
export interface ContextReviewItem extends ContextRecord {
  entityId: string;
  entityLabel: string;
  status: "proposed" | "conflicted" | "confirmed" | "rejected";
  originalSummary: string | null;
  proposedSummary: string;
  conflict: string | null;
  authority: ContextAuthority;
  evidence: ContextEvidenceRef[];
}
export interface ContextPage<T> { items: T[]; nextCursor: string | null; degraded: boolean }
export interface ContextListQuery { cursor?: string; filter?: string; type?: string }
export interface ContextTimelineQuery extends ContextListQuery { entityId?: string; from?: string; through?: string }
export interface ContextRelationQuery extends ContextListQuery { depth?: 1 | 2 }
export interface ContextRequestOptions { signal?: AbortSignal }
export type ContextCorrectionCommand = {
  action: "assert";
  scope: ContextScopeKind;
  expectedRevision: number;
  targetItemId: string;
  summary: string;
  evidenceIds: string[];
} | {
  action: "reject";
  scope: ContextScopeKind;
  expectedRevision: number;
  targetItemId: string;
  summary?: string;
  evidenceIds: string[];
};
export interface ContextReviewDecisionCommand { decision: "confirm" | "reject"; expectedRevision: number }

export interface ContextCenterApiPort {
  getSnapshot(options?: ContextRequestOptions): Promise<ContextCenterSnapshot>;
  getEvidence(id: string, options?: ContextRequestOptions): Promise<ContextEvidence[]>;
  listTimeline(query?: ContextTimelineQuery, options?: ContextRequestOptions): Promise<ContextPage<ContextTimelineItem>>;
  listEntities(query?: ContextListQuery, options?: ContextRequestOptions): Promise<ContextPage<ContextEntity>>;
  getEntity(entityId: string, options?: ContextRequestOptions): Promise<ContextEntityDetail>;
  listEntityItems(entityId: string, query?: ContextListQuery, options?: ContextRequestOptions): Promise<ContextPage<ContextDerivedItem>>;
  listEntityCorrections(entityId: string, query?: ContextListQuery, options?: ContextRequestOptions): Promise<ContextPage<ContextCorrectionRecord>>;
  getEntityProfile(entityId: string, options?: ContextRequestOptions): Promise<ContextEntityProfile>;
  listEntityRelations(entityId: string, query?: ContextRelationQuery, options?: ContextRequestOptions): Promise<ContextPage<ContextRelation>>;
  listReviews(query?: ContextListQuery, options?: ContextRequestOptions): Promise<ContextPage<ContextReviewItem>>;
  createCorrection(entityId: string, command: ContextCorrectionCommand, options?: ContextRequestOptions): Promise<ContextCorrectionRecord>;
  decideReview(itemId: string, command: ContextReviewDecisionCommand, options?: ContextRequestOptions): Promise<{ status: "confirmed" | "rejected" }>;
}
