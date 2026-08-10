import type { GovernanceCredential } from '../credentials/types.js';
import type { ResourceRetirementImpact } from '../resourceReferences/types.js';
import type { GovernanceChangeJob } from './types.js';

interface ReferenceImpactReader {
  previewRetirement(tenantId: string, targetType: string, targetId: string): Promise<ResourceRetirementImpact>;
}

interface CredentialReader {
  get(credentialId: string): Promise<GovernanceCredential | null>;
}

interface ChangeJobCreator {
  create(input: {
    tenantId: string;
    jobType: 'tenant_delete';
    targetType: 'tenant';
    targetId: string;
    idempotencyKey: string;
    request: Record<string, unknown>;
    domains: string[];
    createdBy: string;
  }): Promise<{ job: GovernanceChangeJob; created: boolean }>;
}

export const TENANT_DELETE_DOMAINS = [
  'sessions_runs', 'memory', 'assignments', 'agents_skills', 'credentials',
  'memberships', 'tenant_configuration', 'audit_retention',
] as const;

export class GovernanceChangePlanner {
  constructor(private readonly options: {
    references: ReferenceImpactReader;
    credentials: CredentialReader;
    jobs: ChangeJobCreator;
  }) {}

  previewResourceRetirement(tenantId: string, targetType: string, targetId: string): Promise<ResourceRetirementImpact> {
    return this.options.references.previewRetirement(tenantId, targetType, targetId);
  }

  async previewCredentialChange(
    tenantId: string,
    credentialId: string,
    action: 'suspend' | 'revoke',
  ): Promise<{
    credentialId: string;
    currentStatus: GovernanceCredential['status'];
    currentGeneration: number;
    resultingGeneration: number;
    referenceImpact: ResourceRetirementImpact;
  }> {
    const credential = await this.options.credentials.get(credentialId);
    if (!credential || credential.tenantId !== tenantId) throw new Error('CREDENTIAL_NOT_FOUND');
    const referenceImpact = await this.options.references.previewRetirement(tenantId, 'credential', credentialId);
    return {
      credentialId,
      currentStatus: credential.status,
      currentGeneration: credential.generation,
      resultingGeneration: action === 'revoke' ? credential.generation + 1 : credential.generation,
      referenceImpact,
    };
  }

  async createTenantDeletion(input: {
    tenantId: string;
    idempotencyKey: string;
    requestedBy: string;
    reasonCode: string;
  }): Promise<{ job: GovernanceChangeJob; created: boolean }> {
    return this.options.jobs.create({
      tenantId: input.tenantId,
      jobType: 'tenant_delete',
      targetType: 'tenant',
      targetId: input.tenantId,
      idempotencyKey: input.idempotencyKey,
      request: { reasonCode: input.reasonCode },
      domains: [...TENANT_DELETE_DOMAINS],
      createdBy: input.requestedBy,
    });
  }
}
