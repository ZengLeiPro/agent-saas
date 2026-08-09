import type { GovernanceCredential } from '../../data/credentials/types.js';
import type { SubjectResolver } from '../subject/resolver.js';
import type { AccessEvaluator } from './evaluator.js';
import type { AccessDecision } from './types.js';

export interface CredentialUseAuthorizationRequest {
  tenantId: string;
  connectorId: string;
  delegatedUserId: string;
  agentId: string;
  purpose: string;
}

export interface CredentialUseAuthorizerOptions {
  subjectResolver: Pick<SubjectResolver, 'resolveService'>;
  accessEvaluator: Pick<AccessEvaluator, 'evaluate'>;
  tenantStore: { findById(tenantId: string): { disabled?: boolean } | undefined };
}

export class CredentialUseAuthorizer {
  constructor(private readonly options: CredentialUseAuthorizerOptions) {}

  async authorize(
    request: CredentialUseAuthorizationRequest,
    credential: GovernanceCredential,
  ): Promise<{ allowed: boolean; decision: AccessDecision }> {
    const subject = this.options.subjectResolver.resolveService({
      serviceId: 'credential_broker',
      tenantId: request.tenantId,
      delegatedUserId: request.delegatedUserId,
      purpose: request.purpose,
    });
    const tenant = this.options.tenantStore.findById(request.tenantId);
    const decision = await this.options.accessEvaluator.evaluate({
      subject,
      action: 'credential.use',
      resource: {
        type: 'credential',
        id: credential.credentialId,
        tenantId: credential.tenantId,
        ...(credential.kind === 'personal_grant' && credential.ownerUserId
          ? { ownerUserId: credential.ownerUserId }
          : {}),
        tenantStatus: tenant?.disabled === true ? 'disabled' : 'active',
      },
      context: {
        entitlement: {
          resourceType: 'connector',
          resourceId: request.connectorId,
        },
        ...(credential.kind === 'org_shared'
          ? { tenantPolicyKey: 'credential.org_shared.allowed' as const }
          : {}),
        assignment: {
          required: true,
          resourceType: 'credential' as const,
          resourceId: credential.credentialId,
          agentIds: [request.agentId],
        },
      },
    });
    return { allowed: decision.verdict === 'allow', decision };
  }
}
