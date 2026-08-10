export type GovernanceAuditResult = 'intent' | 'succeeded' | 'failed';

export type GovernanceAuditMetadata = Record<string, string | number | boolean | null>;

export interface GovernanceAuditEvent {
  auditId: string;
  correlationId: string;
  changeId?: string;
  actorType: 'user' | 'service';
  actorUserId: string;
  actorPersona: 'platform_admin' | 'org_admin' | 'member' | 'service';
  actorTenantId?: string;
  action: string;
  targetType: string;
  targetId: string;
  targetTenantId?: string;
  purpose: string;
  reason?: string;
  beforeDigest?: string;
  afterDigest?: string;
  result: GovernanceAuditResult;
  occurredAt: string;
  metadata: GovernanceAuditMetadata;
}

export type GovernanceAuditAppendInput = Omit<GovernanceAuditEvent, 'auditId' | 'occurredAt'> & {
  auditId?: string;
  occurredAt?: string;
};

export interface GovernanceAuditQuery {
  targetTenantId?: string;
  before?: string;
  limit: number;
}

export interface GovernanceAuditStore {
  append(input: GovernanceAuditAppendInput): Promise<GovernanceAuditEvent>;
  list?(query: GovernanceAuditQuery): Promise<GovernanceAuditEvent[]>;
}
