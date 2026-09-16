export type ExternalConversationStatus = 'active' | 'closed';

export interface ExternalConversationRecord {
  conversationId: string;
  clientId: string;
  tenantId: string;
  serviceAccountUserId: string;
  externalConversationId: string;
  sessionId?: string;
  databaseConnectionId?: string;
  metadata: Record<string, unknown>;
  status: ExternalConversationStatus;
  idempotencyKey: string;
  requestHash: string;
  createdAt: string;
  updatedAt: string;
}

export type ExternalExecutionSubmissionStatus = 'submitting' | 'accepted' | 'rejected';

export interface ExternalExecutionRecord {
  executionId: string;
  conversationId: string;
  clientId: string;
  tenantId: string;
  serviceAccountUserId: string;
  runId?: string;
  sessionId?: string;
  clientMessageId: string;
  idempotencyKey: string;
  requestHash: string;
  submissionStatus: ExternalExecutionSubmissionStatus;
  requestedModel?: string;
  requestedReasoningEffort?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export type IdempotentCreateResult<T> =
  | { outcome: 'created'; record: T }
  | { outcome: 'replay'; record: T }
  | { outcome: 'conflict'; record: T };

export interface ExternalConversationStore {
  createConversation(input: {
    clientId: string;
    tenantId: string;
    serviceAccountUserId: string;
    externalConversationId: string;
    databaseConnectionId?: string;
    metadata: Record<string, unknown>;
    idempotencyKey: string;
    requestHash: string;
  }): Promise<IdempotentCreateResult<ExternalConversationRecord>>;
  getConversation(conversationId: string): Promise<ExternalConversationRecord | undefined>;
  reserveExecution(input: {
    conversation: ExternalConversationRecord;
    idempotencyKey: string;
    requestHash: string;
    requestedModel?: string;
    requestedReasoningEffort?: string;
  }): Promise<IdempotentCreateResult<ExternalExecutionRecord>>;
  getExecution(executionId: string): Promise<ExternalExecutionRecord | undefined>;
  bindAcceptedExecution(input: {
    executionId: string;
    conversationId: string;
    runId: string;
    sessionId: string;
  }): Promise<ExternalExecutionRecord | undefined>;
  rejectExecution(input: {
    executionId: string;
    errorCode: string;
    errorMessage: string;
  }): Promise<ExternalExecutionRecord | undefined>;
}
