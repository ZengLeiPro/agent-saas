import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { OrgAgentStore } from '../data/orgAgents/store.js';
import { SkillConfigStore } from '../data/skills/store.js';
import { TenantStore } from '../data/tenants/store.js';
import { UserStore } from '../data/users/store.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'governance-observer-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('legacy store 治理影子投影观察器', () => {
  it('User/Tenant/OrgAgent/Skill 仅在成功持久化后通知', async () => {
    const root = tempRoot();
    const counts = { user: 0, tenant: 0, agent: 0, skill: 0 };
    const userStore = new UserStore(join(root, 'users.json'));
    const tenantStore = new TenantStore(join(root, 'tenants.json'));
    const orgAgentStore = new OrgAgentStore(join(root, 'org-agents.json'));
    const skillStore = new SkillConfigStore(join(root, 'skills-config.json'));
    userStore.setPostPersistObserver(() => { counts.user += 1; });
    tenantStore.setPostPersistObserver(() => { counts.tenant += 1; });
    orgAgentStore.setPostPersistObserver(() => { counts.agent += 1; });
    skillStore.setPostPersistObserver(() => { counts.skill += 1; });

    await tenantStore.create({ id: 'acme', name: 'Acme', createdBy: 'system' });
    await userStore.create({
      username: 'member-1',
      password: 'password-123',
      role: 'user',
      tenantId: 'acme',
      createdBy: 'system',
    });
    await orgAgentStore.create({
      tenantId: 'acme',
      name: '销售专家',
      instructions: 'test',
      allowedSkills: [],
      audience: { exposure: 'all', usernames: [] },
      guardrail: {
        enabled: false,
        scopeDescription: '',
        rejectionMessage: '',
        strictness: 'strict',
      },
      enabled: true,
    }, 'system');
    await skillStore.setUserSelectedSkills('member-1', ['skill-1']);

    expect(counts).toEqual({ user: 1, tenant: 1, agent: 1, skill: 1 });
  });
});
