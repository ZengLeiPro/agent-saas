export type DatabaseConnectionEngine = 'postgresql' | 'gateway';
export type DatabaseConnectionStatus =
  'pending' | 'ready' | 'disabled' | 'validation_failed' | 'revoked' | 'deleted';

export interface DatabaseConnectionRecord {
  connectionId: string;
  tenantId: string;
  name: string;
  engine: DatabaseConnectionEngine;
  host?: string;
  port?: number;
  databaseName?: string;
  username?: string;
  gatewayUrl?: string;
  sslMode: 'disable' | 'require' | 'verify-full';
  secretRef: string;
  allowedSchemas: string[];
  allowedTables: string[];
  sensitiveColumns: string[];
  status: DatabaseConnectionStatus;
  lastTestedAt?: string;
  lastErrorCode?: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  revokedAt?: string;
  revokedBy?: string;
}

export type DatabaseConnectionView = Omit<
  DatabaseConnectionRecord,
  'secretRef' | 'lastErrorCode'
> & {
  credentialConfigured: true;
  lastError?: { code: string };
};

export interface CreateDatabaseConnectionInput {
  tenantId: string;
  name: string;
  engine: DatabaseConnectionEngine;
  host?: string;
  port?: number;
  databaseName?: string;
  username?: string;
  gatewayUrl?: string;
  sslMode: DatabaseConnectionRecord['sslMode'];
  secretRef: string;
  allowedSchemas: string[];
  allowedTables: string[];
  sensitiveColumns?: string[];
  actorUserId: string;
}

export interface DatabaseQueryAuditInput {
  connectionId: string;
  tenantId: string;
  apiClientId: string;
  conversationId: string;
  sessionId: string;
  runId: string;
  sqlHash: string;
  status: 'completed' | 'rejected' | 'failed';
  durationMs: number;
  rowCount: number;
  resultBytes: number;
  truncated: boolean;
  errorCode?: string;
}

export interface DatabaseConnectionStore {
  create(input: CreateDatabaseConnectionInput): Promise<DatabaseConnectionRecord>;
  get(connectionId: string): Promise<DatabaseConnectionRecord | undefined>;
  list(tenantId: string): Promise<DatabaseConnectionRecord[]>;
  updateValidation(input: {
    connectionId: string;
    tenantId: string;
    ok: boolean;
    errorCode?: string;
    actorUserId: string;
  }): Promise<DatabaseConnectionRecord | undefined>;
  replaceSecretRef(input: {
    connectionId: string;
    tenantId: string;
    secretRef: string;
    actorUserId: string;
  }): Promise<DatabaseConnectionRecord | undefined>;
  setStatus(input: {
    connectionId: string;
    tenantId: string;
    status: Extract<DatabaseConnectionStatus, 'disabled' | 'revoked' | 'deleted'>;
    actorUserId: string;
  }): Promise<DatabaseConnectionRecord | undefined>;
  recordQueryAudit(input: DatabaseQueryAuditInput): Promise<void>;
}

export function toDatabaseConnectionView(record: DatabaseConnectionRecord): DatabaseConnectionView {
  const { secretRef: _secretRef, lastErrorCode, ...safe } = record;
  return {
    ...safe,
    credentialConfigured: true,
    ...(lastErrorCode ? { lastError: { code: lastErrorCode } } : {}),
  };
}
