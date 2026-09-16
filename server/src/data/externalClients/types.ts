export const EXTERNAL_CLIENT_SCOPES = ['conversations:write', 'executions:read'] as const;

export type ExternalClientScope = (typeof EXTERNAL_CLIENT_SCOPES)[number];
export type ExternalClientStatus = 'active' | 'revoked';

export interface ExternalClientRecord {
  clientId: string;
  tenantId: string;
  serviceAccountUserId: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  scopes: ExternalClientScope[];
  allowedConnectionIds: string[];
  allowedAgentIds: string[];
  status: ExternalClientStatus;
  expiresAt?: string;
  lastUsedAt?: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  revokedAt?: string;
  revokedBy?: string;
}

export interface ExternalClientView extends Omit<ExternalClientRecord, 'keyHash'> {
  effectiveStatus: ExternalClientStatus | 'expired';
}

export interface CreateExternalClientInput {
  tenantId: string;
  serviceAccountUserId: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  scopes: ExternalClientScope[];
  allowedConnectionIds?: string[];
  allowedAgentIds?: string[];
  expiresAt?: string;
  actorUserId: string;
}

export interface ExternalClientStore {
  create(input: CreateExternalClientInput): Promise<ExternalClientRecord>;
  get(clientId: string): Promise<ExternalClientRecord | undefined>;
  list(tenantId?: string): Promise<ExternalClientRecord[]>;
  findByKeyHash(keyHash: string): Promise<ExternalClientRecord | undefined>;
  rotateKey(input: {
    clientId: string;
    keyHash: string;
    keyPrefix: string;
    actorUserId: string;
  }): Promise<ExternalClientRecord | undefined>;
  revoke(input: {
    clientId: string;
    actorUserId: string;
  }): Promise<ExternalClientRecord | undefined>;
  setAllowedConnectionIds(input: {
    clientId: string;
    tenantId: string;
    allowedConnectionIds: string[];
    actorUserId: string;
  }): Promise<ExternalClientRecord | undefined>;
  setAllowedAgentIds(input: {
    clientId: string;
    tenantId: string;
    allowedAgentIds: string[];
    actorUserId: string;
  }): Promise<ExternalClientRecord | undefined>;
  touchLastUsed(clientId: string, usedAt: string): Promise<void>;
}

export function toExternalClientView(
  record: ExternalClientRecord,
  now = new Date(),
): ExternalClientView {
  const { keyHash: _keyHash, ...safe } = record;
  const expired =
    record.expiresAt !== undefined && new Date(record.expiresAt).getTime() <= now.getTime();
  return {
    ...safe,
    effectiveStatus: record.status === 'active' && expired ? 'expired' : record.status,
  };
}
