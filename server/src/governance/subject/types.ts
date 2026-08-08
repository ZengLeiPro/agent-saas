export type HumanPersona = 'platform_admin' | 'org_admin' | 'member';

export interface HumanSubjectContext {
  subjectType: 'human';
  subjectId: string;
  tenantId: string;
  persona: HumanPersona;
  isOwner: boolean;
  accountStatus: 'active' | 'disabled';
  membershipVersion: number;
}

export type ServiceSubjectId =
  | 'runtime_worker'
  | 'credential_broker'
  | 'memory_consolidator'
  | 'retention_worker'
  | 'migration_worker';

export interface ServiceSubjectContext {
  subjectType: 'service';
  serviceId: ServiceSubjectId;
  tenantId?: string;
  delegatedUserId?: string;
  purpose: string;
}

export type SubjectContext = HumanSubjectContext | ServiceSubjectContext;

export class SubjectResolutionError extends Error {
  constructor(readonly code: 'SUBJECT_NOT_FOUND' | 'SUBJECT_IDENTITY_MISSING') {
    super(code);
    this.name = 'SubjectResolutionError';
  }
}
