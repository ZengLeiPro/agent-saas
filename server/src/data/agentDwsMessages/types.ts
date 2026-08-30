export type AgentDwsInboxState =
  | 'pending'
  | 'processing'
  | 'retry_wait'
  | 'reply_pending'
  | 'completed'
  | 'dead_letter';

export type AgentDwsPayload = Record<string, unknown>;

export const DWS_INBOX_V1_IDENTITY_UNPROVABLE = 'DWS_INBOX_V1_IDENTITY_UNPROVABLE';

export interface AgentDwsLegacyAccountIdentityCandidate {
  revision: number;
  profileId: string;
  corpId: string;
  dingtalkUserId: string;
}

export interface AgentDwsNormalizedEvent {
  tenantId: string;
  accountId: string;
  eventId: string;
  eventType: string;
  conversationId: string;
  messageId?: string;
  senderOpenDingtalkId?: string;
  content: string;
  eventTimestamp?: Date | string;
  maxAttempts?: number;
}

/** Alias used by DWS runtime adapters. */
export type AgentDwsInboundEvent = AgentDwsNormalizedEvent;

export interface AgentDwsInboxRecord {
  inboxId: string;
  tenantId: string;
  accountId: string;
  eventId: string;
  eventType: string;
  conversationId: string;
  messageId?: string;
  senderOpenDingtalkId?: string;
  content: string;
  eventTimestamp?: string;
  payload: AgentDwsPayload;
  state: AgentDwsInboxState;
  sessionId?: string;
  runId?: string;
  responseText?: string;
  replyStartedAt?: string;
  attempt: number;
  maxAttempts: number;
  leaseOwner?: string;
  leaseFence: number;
  leaseExpiresAt?: string;
  nextAttemptAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

/** Alias retained for callers that refer to durable inbox rows as messages. */
export type AgentDwsMessageRecord = AgentDwsInboxRecord;

export interface AgentDwsConversationBindingRecord {
  bindingId: string;
  tenantId: string;
  accountId: string;
  conversationId: string;
  requesterUserId: string;
  sessionId: string;
  peerOpenDingtalkId?: string;
  createdAt: string;
  updatedAt: string;
}

export type AgentDwsConversationBinding = AgentDwsConversationBindingRecord;

export interface AgentDwsIngestResult {
  record: AgentDwsInboxRecord;
  created: boolean;
}

export interface AgentDwsMessageStore {
  init(): Promise<void>;
  ingest(event: AgentDwsNormalizedEvent, rawPayload: unknown): Promise<AgentDwsIngestResult>;
  listForAccount(tenantId: string, accountId: string, limit?: number): Promise<AgentDwsInboxRecord[]>;
  claimNext(owner: string, ttlMs: number): Promise<AgentDwsInboxRecord | null>;
  releaseClaim(inboxId: string, owner: string, fence: number): Promise<AgentDwsInboxRecord>;
  renewLease(inboxId: string, owner: string, fence: number, ttlMs: number): Promise<boolean>;
  pinLegacyIdentityOrTerminate(
    inboxId: string,
    owner: string,
    fence: number,
    candidate?: AgentDwsLegacyAccountIdentityCandidate,
  ): Promise<AgentDwsInboxRecord>;
  getOrCreateBinding(
    tenantId: string,
    accountId: string,
    conversationId: string,
    requesterUserId: string,
    candidateSessionId: string,
    peerOpenDingtalkId?: string,
  ): Promise<AgentDwsConversationBindingRecord>;
  markDispatchStarted(
    inboxId: string,
    owner: string,
    fence: number,
    sessionId: string,
    runId?: string,
  ): Promise<AgentDwsInboxRecord>;
  saveDispatchResult(
    inboxId: string,
    owner: string,
    fence: number,
    responseText: string,
  ): Promise<AgentDwsInboxRecord>;
  markReplyAttemptStarted(
    inboxId: string,
    owner: string,
    fence: number,
  ): Promise<AgentDwsInboxRecord>;
  defer(
    inboxId: string,
    owner: string,
    fence: number,
    delayMs: number,
    reason: string,
  ): Promise<AgentDwsInboxRecord>;
  complete(inboxId: string, owner: string, fence: number): Promise<AgentDwsInboxRecord>;
  fail(
    inboxId: string,
    owner: string,
    fence: number,
    error: unknown,
    retryDelayMs?: number,
  ): Promise<AgentDwsInboxRecord>;
  deleteForTenant(tenantId: string): Promise<number>;
}

export type AgentDwsMessageInvariantCode =
  | 'AGENT_DWS_MESSAGE_INVALID'
  | 'AGENT_DWS_MESSAGE_LEASE_LOST';

export class AgentDwsMessageInvariantError extends Error {
  constructor(readonly code: AgentDwsMessageInvariantCode) {
    super(code);
    this.name = 'AgentDwsMessageInvariantError';
  }
}
