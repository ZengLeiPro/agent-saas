import { describe, expect, it } from 'vitest';

import { GovernanceChangePlanner, TENANT_DELETE_DOMAINS } from '../data/changeJobs/index.js';
import type { GovernanceCredential } from '../data/credentials/types.js';

const credential: GovernanceCredential = {
  credentialId: 'cred-1', tenantId: 'acme', connectorId: 'github', kind: 'org_shared',
  custodianUserId: 'custodian-1', purpose: 'GitHub API', scopeSummary: {}, secretRef: 'ref-1',
  status: 'active', generation: 3, source: 'governance', version: 1,
  createdAt: '2026-08-08T00:00:00.000Z', createdBy: 'admin', updatedAt: '2026-08-08T00:00:00.000Z', updatedBy: 'admin',
};

function buildPlanner() {
  const calls: unknown[][] = [];
  const planner = new GovernanceChangePlanner({
    references: {
      previewRetirement: async (...args) => {
        calls.push(args);
        return {
          tenantId: args[0], targetType: args[1], targetId: args[2], hardDeleteAllowed: false,
          referenceCount: 2, references: [],
        };
      },
    },
    credentials: { get: async id => id === 'cred-1' ? credential : null },
    jobs: {
      create: async input => ({
        created: true,
        job: {
          jobId: 'chg-1', tenantId: input.tenantId, jobType: input.jobType,
          targetType: input.targetType, targetId: input.targetId, idempotencyKey: input.idempotencyKey,
          request: input.request, status: 'pending', revision: 1, attempt: 0,
          createdAt: credential.createdAt, createdBy: input.createdBy,
          updatedAt: credential.updatedAt, updatedBy: input.createdBy,
        },
      }),
    },
  });
  return { planner, calls };
}

describe('GovernanceChangePlanner', () => {
  it('Credential suspend/revoke 预览携带引用影响与 generation 变化', async () => {
    const { planner, calls } = buildPlanner();
    await expect(planner.previewCredentialChange('acme', 'cred-1', 'suspend')).resolves.toMatchObject({
      currentGeneration: 3, resultingGeneration: 3, referenceImpact: { referenceCount: 2 },
    });
    await expect(planner.previewCredentialChange('acme', 'cred-1', 'revoke')).resolves.toMatchObject({
      currentGeneration: 3, resultingGeneration: 4,
    });
    expect(calls).toEqual([
      ['acme', 'credential', 'cred-1'], ['acme', 'credential', 'cred-1'],
    ]);
  });

  it('跨租户 Credential 不可预览，避免泄漏存在性', async () => {
    const { planner } = buildPlanner();
    await expect(planner.previewCredentialChange('beta', 'cred-1', 'revoke'))
      .rejects.toThrow('CREDENTIAL_NOT_FOUND');
  });

  it('Tenant 删除固定为 8 个分域的可重试 Change Job', async () => {
    const { planner } = buildPlanner();
    expect(TENANT_DELETE_DOMAINS).toHaveLength(8);
    await expect(planner.createTenantDeletion({
      tenantId: 'acme', idempotencyKey: 'delete-acme-v1', requestedBy: 'platform-admin', reasonCode: 'customer_request',
    })).resolves.toMatchObject({ created: true, job: { jobType: 'tenant_delete', targetId: 'acme' } });
  });
});
