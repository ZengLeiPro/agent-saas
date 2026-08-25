/** Authenticated retrieval subject. It is assembled server-side and is never model input. */
export interface ContextRecallSubject {
  tenantId: string;
  userId: string;
  workspaceId?: string;
  sessionId?: string;
  orgAgentId?: string;
}

export interface ContextRecallCollectionScope {
  collectionId: string;
  assignmentVersion: number;
  resourceType?: 'org_knowledge' | 'org_memory';
}

/** A fresh authorization snapshot. Empty collections always means deny. */
export interface ContextRecallResolvedScope {
  collections: readonly ContextRecallCollectionScope[];
  resolvedAt: string;
  degraded?: boolean;
  degradationReasons?: readonly string[];
}

export interface ContextRecallTimeRange {
  from?: string;
  to?: string;
}

export interface ContextRecallSource {
  sourceId: string;
  kind: string;
  displayName?: string;
  url?: string;
}

export interface ContextRecallTime {
  occurredAt?: string;
  sourceUpdatedAt?: string;
  observedAt?: string;
}

export interface ContextRecallFreshness {
  status: 'fresh' | 'stale' | 'unknown';
  asOf?: string;
  reason?: string;
}

export interface ContextRecallRoute {
  strategy: string;
  stages?: readonly string[];
}

export interface ContextRecallEvidence {
  evidenceId: string;
  sourceId: string;
  collectionId: string;
  recordId: string;
  revision: number;
  kind: string;
  excerpt?: string;
  author?: string;
  url?: string;
  occurredAt?: string;
}

export interface ContextRecallHit {
  id: string;
  collectionId: string;
  /** Version used by the backend; the provider checks it against the fresh scope. */
  assignmentVersion: number;
  /** Canonical business kind. Prefer entity type (for example Task/Project). */
  kind: string;
  /** Storage envelope kind remains available for advanced filtering and diagnostics. */
  recordKind: string;
  entityType?: string;
  content: string;
  score?: number;
  source: ContextRecallSource;
  time: ContextRecallTime;
  freshness: ContextRecallFreshness;
  route: ContextRecallRoute;
  /** True for inferred/summarized facts rather than verbatim source records. */
  derived: boolean;
  evidence: readonly ContextRecallEvidence[];
}

export interface ContextRecallSearchFilters {
  timeRange?: ContextRecallTimeRange;
  kinds?: readonly string[];
  sources?: readonly string[];
}

export interface ContextRecallSearchRequest {
  subject: ContextRecallSubject;
  scope: ContextRecallResolvedScope;
  query: string;
  limit: number;
  filters: ContextRecallSearchFilters;
  signal?: AbortSignal;
}

export interface ContextRecallGetRequest {
  subject: ContextRecallSubject;
  /** Opaque recall hit id. It carries no authority. */
  id: string;
  /** Must be freshly resolved for every ContextGet invocation. */
  scope: ContextRecallResolvedScope;
  signal?: AbortSignal;
}

export interface ContextRecallSearchDiagnostics {
  normalizedFilters: {
    kinds: readonly string[];
    sources: readonly string[];
  };
}

export interface ContextRecallSearchResult {
  hits: readonly ContextRecallHit[];
  degraded: boolean;
  degradationReasons?: readonly string[];
  diagnostics?: ContextRecallSearchDiagnostics;
}

export interface ContextRecallGetResult {
  hit: ContextRecallHit | null;
  degraded: boolean;
  degradationReasons?: readonly string[];
}
