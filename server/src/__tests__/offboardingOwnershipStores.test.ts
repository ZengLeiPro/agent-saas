import { describe, expect, it, vi } from 'vitest';

import { PgAgentResourceStore } from '../data/agentResources/index.js';
import { PgCredentialStore } from '../data/credentials/index.js';
import { PgSkillGovernanceStore } from '../data/skillGovernance/index.js';

const NOW = '2026-08-10T00:00:00.000Z';

describe('offboarding ownership stores', () => {
  it('组织与个人 Agent 均以 revision CAS 转移 owner，不再归档', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      agent_id: 'oa-1', tenant_id: 'tenant-a', kind: 'org_agent', owner_user_id: 'user-owner',
      template_id: null, status: 'enabled', current_version_id: null, revision: 3,
      created_at: NOW, created_by: 'user-leaving', updated_at: NOW, updated_by: 'admin-1',
      archived_at: null, archived_by: null,
    }], rowCount: 1 });
    const store = new PgAgentResourceStore({ pool: { query } as never, tablePrefix: 'test' });
    await expect(store.transferOwnership('tenant-a', 'oa-1', 2, 'user-owner', 'admin-1'))
      .resolves.toMatchObject({ ownerUserId: 'user-owner', revision: 3 });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('SET owner_user_id=$4,revision=revision+1'), [
      'tenant-a', 'oa-1', 2, 'user-owner', 'admin-1',
    ]);
  });

  it('个人 Skill 与共享 Credential custodian 分别按版本转移', async () => {
    const skillQuery = vi.fn().mockResolvedValue({ rows: [{
      skill_id: 'skill-1', tenant_id: 'tenant-a', scope: 'personal', owner_user_id: 'user-owner',
      status: 'published', current_version_id: null, revision: 2,
      created_at: NOW, created_by: 'user-leaving', updated_at: NOW, updated_by: 'admin-1',
    }], rowCount: 1 });
    const skillStore = new PgSkillGovernanceStore({ pool: { query: skillQuery } as never, tablePrefix: 'test' });
    await expect(skillStore.transferPersonalOwnership('tenant-a', 'skill-1', 1, 'user-owner', 'admin-1'))
      .resolves.toMatchObject({ ownerUserId: 'user-owner', revision: 2 });

    const credentialQuery = vi.fn().mockResolvedValue({ rows: [{
      credential_id: 'cred-1', tenant_id: 'tenant-a', connector_id: 'github', kind: 'org_shared',
      owner_user_id: null, custodian_user_id: 'user-owner', alias: null, purpose: 'shared',
      scope_summary_json: {}, secret_ref: 'vault://secret', status: 'active', generation: 1,
      expires_at: null, last_validated_at: null, last_validation_error_code: null, version: 2,
      created_at: NOW, created_by: 'admin-1', updated_at: NOW, updated_by: 'admin-1',
    }], rowCount: 1 });
    const credentialStore = new PgCredentialStore({ pool: { query: credentialQuery } as never, tablePrefix: 'test' });
    await expect(credentialStore.transferCustodian('tenant-a', 'cred-1', 1, 'user-owner', 'admin-1'))
      .resolves.toMatchObject({ custodianUserId: 'user-owner', version: 2 });
    expect(credentialQuery).toHaveBeenCalledWith(expect.stringContaining('SET custodian_user_id=$4'), [
      'tenant-a', 'cred-1', 1, 'user-owner', 'admin-1',
    ]);
  });
});
