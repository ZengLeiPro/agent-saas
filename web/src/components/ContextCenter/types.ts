export type SourceSyncStatus = "healthy" | "syncing" | "attention" | "paused";

export type BackfillCoverage =
  | {
      kind: "items";
      coveredItems: number;
      totalItems: number;
    }
  | {
      kind: "time";
      coveredFrom: string | null;
      coveredThrough: string | null;
    };

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

export interface ContextEvidenceQuery {
  sourceId: string;
  collectionId: string;
  recordId?: string;
}

export interface ContextCenterApiPort {
  getSnapshot(options?: { signal?: AbortSignal }): Promise<ContextCenterSnapshot>;
  listEvidence(query: ContextEvidenceQuery, options?: { signal?: AbortSignal }): Promise<ContextEvidence[]>;
}
