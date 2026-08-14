import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { projectManagedOrgAgentVersion } from '../data/agentResources/orgAgentProjection.js';
import { OrgAgentStore } from '../data/orgAgents/store.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const definition = {
  schemaVersion: 1 as const,
  name: '开开',
  description: 'AI 实习生',
  starterPrompts: ['帮我整理一下'],
  instructions: '直接协助处理工作，不猜测。',
  skills: [{ id: 'dws' }],
  knowledge: ['company'],
  guardrail: {
    mode: 'off' as const,
    enabled: false,
    scopeDescription: '',
    rejectionMessage: '这个问题超出了我的职责范围，暂时无法回答。',
    strictness: 'strict' as const,
  },
  source: 'governance' as const,
};

describe('Org Agent governance compatibility projection', () => {
  it('使用 governance agentId 创建 legacy Runtime 记录，并让另一 Store 实例立即可见', async () => {
    const root = await mkdtemp(join(tmpdir(), 'org-agent-governance-projection-'));
    roots.push(root);
    const path = join(root, 'org-agents.json');
    const writer = new OrgAgentStore(path);
    const reader = new OrgAgentStore(path);
    const resource = {
      agentId: 'org-kaikai', tenantId: 'tenant-a', kind: 'org_agent' as const,
      ownerUserId: 'admin-1', status: 'enabled' as const, currentVersionId: 'agentv-1',
      revision: 2, createdAt: '2026-08-14T00:00:00.000Z', createdBy: 'admin-1',
      updatedAt: '2026-08-14T00:00:00.000Z', updatedBy: 'admin-1',
    };
    const version = {
      versionId: 'agentv-1', agentId: 'org-kaikai', versionNumber: 1,
      definition, digest: 'digest-1', publishedAt: '2026-08-14T00:00:00.000Z', publishedBy: 'admin-1',
    };
    const agents = {
      getForTenant: vi.fn().mockResolvedValue(resource),
      getVersion: vi.fn().mockResolvedValue(version),
    };

    await projectManagedOrgAgentVersion({ agents: agents as never, legacyAgents: writer }, {
      tenantId: 'tenant-a', agentId: 'org-kaikai', versionId: 'agentv-1', resourceRevision: 2,
    });

    expect(reader.get('org-kaikai')).toMatchObject({
      id: 'org-kaikai', tenantId: 'tenant-a', name: '开开', enabled: true,
      starterPrompts: ['帮我整理一下'], instructions: '直接协助处理工作，不猜测。',
      allowedSkills: ['dws'], allowedKnowledge: ['company'],
      audience: { exposure: 'allow_users', usernames: [] },
      createdBy: 'system:governance-projection',
    });
  });

  it('拒绝 payload revision 与治理资源当前基线不一致', async () => {
    const root = await mkdtemp(join(tmpdir(), 'org-agent-governance-projection-'));
    roots.push(root);
    const legacyAgents = new OrgAgentStore(join(root, 'org-agents.json'));
    const agents = {
      getForTenant: vi.fn().mockResolvedValue({
        agentId: 'org-kaikai', tenantId: 'tenant-a', kind: 'org_agent', ownerUserId: 'admin-1',
        status: 'enabled', currentVersionId: 'agentv-1', revision: 3,
      }),
      getVersion: vi.fn().mockResolvedValue({ agentId: 'org-kaikai', versionId: 'agentv-1', definition }),
    };
    await expect(projectManagedOrgAgentVersion({ agents: agents as never, legacyAgents }, {
      tenantId: 'tenant-a', agentId: 'org-kaikai', versionId: 'agentv-1', resourceRevision: 2,
    })).rejects.toThrow('GOVERNANCE_PROJECTION_INVALID');
    expect(legacyAgents.listAll()).toEqual([]);
  });
});
