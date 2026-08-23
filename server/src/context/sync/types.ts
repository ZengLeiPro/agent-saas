export type ContextSyncSource = 'chat' | 'wiki' | 'minutes';

export interface ContextSyncScope {
  tenantId: string;
  accountId: string;
  profileId: string;
}

export interface ContextSyncWindow {
  /** Inclusive lower bound. */
  from: string;
  /** Exclusive upper bound. Fixed for every page in one run. */
  to: string;
}

export interface ContextSyncTarget {
  source: ContextSyncSource;
  /** One addressed conversation, primarily for event wakes and compatibility. */
  conversationId?: string;
  /** A selected chat scope pulled in one upstream scan; values must be canonical and unique. */
  conversationIds?: readonly string[];
}

export interface ContextSyncKey extends ContextSyncScope, ContextSyncTarget {}

export interface ContextContentTruncation {
  truncated: boolean;
  reason?: 'content_limit' | 'upstream';
  limitCharacters?: number;
  originalCharacters?: number;
}

export interface ContextIngestItem {
  /** Stable key on which the store must enforce idempotency. */
  idempotencyKey: string;
  source: ContextSyncSource;
  sourceId: string;
  kind: 'chat_message' | 'wiki_document' | 'minutes';
  title?: string;
  content: string;
  conversationId?: string;
  occurredAt: string;
  updatedAt?: string;
  url?: string;
  metadata: Record<string, string | number | boolean | null>;
  revoked?: boolean;
  /** Always present so clipping can never silently look complete. */
  truncation: ContextContentTruncation;
}

export interface ContextIngestPage {
  key: ContextSyncKey;
  window: ContextSyncWindow;
  cursor?: string;
  nextCursor?: string;
  items: ContextIngestItem[];
  /** True if either the upstream page or any normalized item was truncated. */
  truncated: boolean;
}

export interface ContextSyncRetryState {
  key: ContextSyncKey;
  window: ContextSyncWindow;
  attempt: number;
  status: 'waiting';
  nextAttemptAt: string;
  lastError: string;
}

export interface ContextSyncResult {
  key: ContextSyncKey;
  window: ContextSyncWindow;
  pages: number;
  items: number;
  truncated: boolean;
  watermarkAdvanced: boolean;
}

export interface DwsContextWakeEvent {
  type: string;
  eventId: string;
  conversationId?: string;
  /** Notification content is intentionally not part of the sync input. */
  content?: string;
  raw?: Record<string, unknown>;
}

export interface DwsContextWakeResult {
  woken: boolean;
  reason?: 'unsupported_event' | 'missing_conversation';
  sync?: ContextSyncResult;
}
