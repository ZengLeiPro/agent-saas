import type {
  ContextIngestPage,
  ContextSyncKey,
  ContextSyncRetryState,
  ContextSyncScope,
  ContextSyncWindow,
} from './types.js';

export interface ContextSyncStore {
  getWatermark(key: ContextSyncKey): Promise<string | null>;

  /** Returns the cursor persisted for this exact failed window, if any. */
  getResumeCursor(key: ContextSyncKey, window: ContextSyncWindow): Promise<string | undefined>;

  /**
   * Must upsert/deduplicate items by `item.idempotencyKey`. Pages already written
   * before a failed run are deliberately offered again on retry.
   */
  ingestPage(page: ContextIngestPage): Promise<void>;

  /** Marks records absent from a complete authoritative inventory as revoked. */
  reconcileInventory(input: {
    key: ContextSyncKey;
    window: ContextSyncWindow;
    externalRecordIds: readonly string[];
  }): Promise<number>;

  /** Called only after every page and every detail fetch in the fixed window succeeds. */
  advanceWatermark(input: {
    key: ContextSyncKey;
    expected: string | null;
    value: string;
  }): Promise<void>;

  getRetryState(key: ContextSyncKey): Promise<ContextSyncRetryState | null>;

  /** The store owns durable attempt counting and next-attempt calculation. */
  recordRetryFailure(input: {
    key: ContextSyncKey;
    window: ContextSyncWindow;
    error: string;
    failedAt: string;
  }): Promise<ContextSyncRetryState>;

  clearRetryState(key: ContextSyncKey): Promise<void>;
}

export interface DwsPage<T> {
  items: T[];
  nextCursor?: string;
  /** Upstream explicitly reported an incomplete response. */
  truncated?: boolean;
}

export interface DwsChatMessage {
  messageId: string;
  conversationId: string;
  text: string;
  createdAt: string;
  updatedAt?: string;
  senderId?: string;
  url?: string;
  truncated?: boolean;
}

export interface DwsWikiDocument {
  documentId: string;
  title: string;
  updatedAt: string;
  createdAt?: string;
  spaceId?: string;
  extension?: string;
  url?: string;
}

export interface DwsWikiDocumentBody {
  content: string;
  format?: string;
  updatedAt?: string;
  truncated?: boolean;
  unreadable?: boolean;
  unreadableReason?: string;
}

export interface DwsMinutesRecord {
  minutesId: string;
  title: string;
  startedAt: string;
  updatedAt?: string;
  durationSeconds?: number;
  url?: string;
}

export interface DwsMinutesContent {
  content: string;
  truncated?: boolean;
}

interface DwsWindowPageInput {
  scope: ContextSyncScope;
  window: ContextSyncWindow;
  cursor?: string;
  pageSize: number;
}

/**
 * Adapter boundary for the authenticated DWS capability. Implementations may
 * reuse the Agent DWS profile workspace/ACS transport, but must return parsed
 * API/CLI results rather than treating transient Shell output as durable state.
 */
export interface DwsContextClient {
  listChatMessages(input: DwsWindowPageInput & {
    conversationId?: string;
    conversationIds?: readonly string[];
  }): Promise<DwsPage<DwsChatMessage>>;

  listWikiDocuments(input: DwsWindowPageInput): Promise<DwsPage<DwsWikiDocument>>;
  getWikiDocumentBody(input: {
    scope: ContextSyncScope;
    documentId: string;
    extension?: string;
  }): Promise<DwsWikiDocumentBody>;

  listMinutes(input: DwsWindowPageInput): Promise<DwsPage<DwsMinutesRecord>>;
  getMinutesSummary(input: {
    scope: ContextSyncScope;
    minutesId: string;
  }): Promise<DwsMinutesContent>;
  getMinutesTranscript(input: {
    scope: ContextSyncScope;
    minutesId: string;
  }): Promise<DwsMinutesContent>;
}
