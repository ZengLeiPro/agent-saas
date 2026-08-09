import { describe, expect, it } from 'vitest';

import { CredentialUseAuthorizer } from '../governance/access/credentialUseAuthorizer.js';
import type { GovernanceCredential } from '../data/credentials/types.js';
import type { AccessDecision, AccessEvaluationRequest } from '../governance/access/types.js';

const NOW = '2026-08-08T00:00:00.000Z';

function credential(overrides: Partial<GovernanceCredential> = {}): GovernanceCredential {
  return {
    credentialId: 'cred-1', tenantId: 'acme', connectorId: 'github', kind: 'org_shared',
    custodianUserId: 'custodian-1', purpose: 'GitHub API', scopeSummary: { repository: 'read' },
    secretRef: 'ref-1', generation: 1, status: 'active', source: 'governance', version: 1,
    createdAt: NOW, createdBy: 'admin', updatedAt: NOW, updatedBy: 'admin', ...overrides,
  };
}

function decision(request: AccessEvaluationRequest, verdict: 'allow' | 'deny'): AccessDecision {
  return {
    id: 'decision-1', verdict, action: request.action, resourceType: request.resource.type,
    resourceId: request.resource.id, tenantId: request.resource.tenantId,
    subjectType: request.subject.subjectType, subjectId: 'credential_broker',
    accessState: verdict === 'allow' ? 'allowed' : 'denied', reasonCode: verdict === 'allow' ? 'RESOURCE_ASSIGNED' : 'EXPLICIT_ASSIGNMENT_DENY',
    decisiveLayer: 'assignment', chain: [], policySnapshot: {}, nextActions: [], evaluatedAt: NOW,
  };
}

const request = {
  tenantId: 'acme', connectorId: 'github', delegatedUserId: 'user-1',
  agentId: 'agent-1', purpose: 'tool_call',
};

describe('CredentialUseAuthorizer', () => {
  it('org_shared 强制通过 credential Assignment，并携带 immutable Agent ID', async () => {
    let evaluated: AccessEvaluationRequest | undefined;
    const authorizer = new CredentialUseAuthorizer({
      subjectResolver: {
        resolveService: input => ({ subjectType: 'service', ...input }),
      },
      accessEvaluator: {
        evaluate: async input => {
          evaluated = input;
          return decision(input, 'allow');
        },
      },
      tenantStore: { findById: () => ({ disabled: false }) },
    });
    await expect(authorizer.authorize(request, credential())).resolves.toMatchObject({ allowed: true });
    expect(evaluated?.subject).toMatchObject({
      subjectType: 'service', serviceId: 'credential_broker', delegatedUserId: 'user-1', tenantId: 'acme',
    });
    expect(evaluated?.context).toMatchObject({
      entitlement: { resourceType: 'connector', resourceId: 'github' },
      tenantPolicyKey: 'credential.org_shared.allowed',
      assignment: { required: true, resourceType: 'credential', resourceId: 'cred-1', agentIds: ['agent-1'] },
    });
  });

  it('personal_grant 绑定 immutable owner，不要求组织 Assignment', async () => {
    let evaluated: AccessEvaluationRequest | undefined;
    const authorizer = new CredentialUseAuthorizer({
      subjectResolver: { resolveService: input => ({ subjectType: 'service', ...input }) },
      accessEvaluator: { evaluate: async input => { evaluated = input; return decision(input, 'allow'); } },
      tenantStore: { findById: () => ({ disabled: false }) },
    });
    await authorizer.authorize(request, credential({
      kind: 'personal_grant', custodianUserId: undefined, ownerUserId: 'user-1',
    }));
    expect(evaluated?.resource.ownerUserId).toBe('user-1');
    expect(evaluated?.context?.assignment).toBeUndefined();
    expect(evaluated?.context?.tenantPolicyKey).toBeUndefined();
  });

  it('AccessDecision deny 原样转为 denied', async () => {
    const authorizer = new CredentialUseAuthorizer({
      subjectResolver: { resolveService: input => ({ subjectType: 'service', ...input }) },
      accessEvaluator: { evaluate: async input => decision(input, 'deny') },
      tenantStore: { findById: () => ({ disabled: false }) },
    });
    await expect(authorizer.authorize(request, credential())).resolves.toMatchObject({
      allowed: false,
      decision: { reasonCode: 'EXPLICIT_ASSIGNMENT_DENY' },
    });
  });
});
