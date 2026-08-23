import type { ContextJson, ContextObject } from '../store/types.js';
import type { ContextRecallResolvedScope, ContextRecallSubject } from '../retrieval/types.js';

export interface ContextTimelineRequest {
  /** Server-authenticated subject; there is intentionally no top-level tenant input. */
  subject: ContextRecallSubject;
  /** Fresh governance assignment scope. */
  scope: ContextRecallResolvedScope;
  limit: number;
  cursor?: string;
  signal?: AbortSignal;
}

export interface ContextTimelineItem {
  sourceId: string;
  collectionId: string;
  recordId: string;
  revision: number;
  sourceKind: string;
  recordType: 'snapshot' | 'event';
  sourceEventId?: string;
  eventType?: string;
  occurredAt: string;
  content: ContextJson;
  metadata: ContextObject;
}

export interface ContextTimelineResult {
  items: readonly ContextTimelineItem[];
  nextCursor?: string;
  degraded: boolean;
  degradationReasons?: readonly string[];
}

export class ContextTimelineCursorError extends Error {
  readonly code = 'CONTEXT_TIMELINE_CURSOR_INVALID';

  constructor() {
    super('CONTEXT_TIMELINE_CURSOR_INVALID');
    this.name = 'ContextTimelineCursorError';
  }
}
