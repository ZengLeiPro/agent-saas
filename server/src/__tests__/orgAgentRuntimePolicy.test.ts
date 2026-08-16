import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  managedOrgAgentDefinitionSchema,
  projectManagedOrgAgentVersion,
} from '../data/agentResources/orgAgentProjection.js';
import { parseAgentRuntimeProfileConfig } from '../data/agentProfiles/types.js';
import { OrgAgentStore } from '../data/orgAgents/store.js';
import {
  DEFAULT_ORG_AGENT_RUNTIME_POLICY,
  mergeOrgAgentRuntimePolicy,
  mergeOrgAgentWorkerRuntimePolicy,
  orgAgentRuntimePolicySchema,
  resolveOrgAgentRuntimeSkillIds,
  type OrgAgentRuntimePolicy,
} from '../data/orgAgents/runtimePolicy.js';
import { buildOrgAgentSkillFilter } from '../runtime/rawRuntimeRunDispatch.js';
import { resolveOrgAgentSnapshotSkillRefs } from '../runtime/runPreflight.js';

const cleanup = new Set<string>();
afterEach(async () => {
  await Promise.all([...cleanup].map(path => rm(path, { recursive: true, force: true })));
  cleanup.clear();
});

function sharedProfile() {
  return parseAgentRuntimeProfileConfig({
    schemaVersion: 1,
    context: {
      systemInstructions: 'shared',
      modules: ['company_info', 'tenant_instructions', 'runtime_memory', 'personal_context'],
    },
    skills: { defaultSkillIds: ['dws'], allowlist: null, denylist: ['blocked-skill'] },
    mcp: {
      serverAllowlist: ['crm', 'docs'],
      toolAllowlist: ['find', 'read'],
      denyServers: ['legacy'],
      denyTools: ['delete'],
    },
    memory: { scope: 'full' },
    model: { strategy: 'inherit' },
    limits: { maxTurns: 20 },
    capabilities: {
      shell: true,
      backgroundTasks: false,
      interaction: true,
      subagents: true,
      scheduling: false,
    },
    tools: {
      allowlist: ['Read', 'Shell', 'WaitForWorkspaceReady', 'WebSearch'],
      denylist: ['DangerousTool'],
    },
    execution: { allowedTargets: ['server-container', 'server-remote'] },
  });
}

function policy(overrides: Partial<OrgAgentRuntimePolicy>): OrgAgentRuntimePolicy {
  return orgAgentRuntimePolicySchema.parse({
    ...structuredClone(DEFAULT_ORG_AGENT_RUNTIME_POLICY),
    ...overrides,
  });
}

describe('Org Agent Runtime Policy', () => {
  it('managed definition 缺 runtime 时补 inherit-only v1 默认值，默认合并保持 shared Profile 不变', () => {
    const definition = managedOrgAgentDefinitionSchema.parse({
      schemaVersion: 1,
      name: '销售助手',
    });
    expect(definition.runtime).toEqual(DEFAULT_ORG_AGENT_RUNTIME_POLICY);

    const shared = sharedProfile();
    expect(definition.runtime.executionMode).toBe('direct');
    expect(definition.runtime.workerModel).toEqual({ strategy: 'inherit' });
    expect(mergeOrgAgentRuntimePolicy(shared, definition.runtime)).toEqual(shared);
  });

  it('dispatcher 强制保留 Agent/BackgroundTask，Worker 模型可独立覆盖前台模型', () => {
    expect(() => policy({
      executionMode: 'dispatcher',
      capabilities: {
        ...DEFAULT_ORG_AGENT_RUNTIME_POLICY.capabilities,
        subagents: 'disabled',
      },
    })).toThrow(/子 Agent/);
    expect(() => policy({
      executionMode: 'dispatcher',
      tools: { allowlist: ['Agent'], denylist: [] },
    })).toThrow(/BackgroundTask/);

    const worker = mergeOrgAgentWorkerRuntimePolicy(sharedProfile(), policy({
      executionMode: 'dispatcher',
      model: { strategy: 'fixed', modelRef: 'tenant/front' },
      workerModel: { strategy: 'fixed', modelRef: 'tenant/worker' },
    }));
    expect(worker.model).toEqual({ strategy: 'fixed', modelRef: 'tenant/worker' });
  });

  it('governance projection 将已发布版本的 runtime policy 写入 legacy record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'org-agent-runtime-projection-'));
    cleanup.add(root);
    const legacyAgents = new OrgAgentStore(join(root, 'org-agents.json'));
    const runtime = policy({ model: { strategy: 'fixed', modelRef: 'tenant/model-a' } });
    const definition = managedOrgAgentDefinitionSchema.parse({
      schemaVersion: 1,
      name: '销售助手',
      skills: [{ id: 'dws' }],
      knowledge: ['kb-sales'],
      runtime,
    });
    const agents = {
      getForTenant: vi.fn().mockResolvedValue({
        agentId: 'oa-sales', tenantId: 'tenant-a', kind: 'org_agent', ownerUserId: 'admin',
        status: 'enabled', currentVersionId: 'oav-1', revision: 1,
      }),
      getVersion: vi.fn().mockResolvedValue({
        versionId: 'oav-1', agentId: 'oa-sales', versionNumber: 1, definition,
      }),
    };

    await projectManagedOrgAgentVersion({ agents: agents as never, legacyAgents }, {
      tenantId: 'tenant-a', agentId: 'oa-sales', versionId: 'oav-1', resourceRevision: 1,
    });
    expect(legacyAgents.get('oa-sales')).toMatchObject({
      runtime,
      allowedSkills: ['dws'],
      allowedKnowledge: ['kb-sales'],
    });
  });

  it('Agent 可固定模型、独立选择 context/memory，maxTurns 与 shared 取更小值', () => {
    const merged = mergeOrgAgentRuntimePolicy(sharedProfile(), policy({
      context: { modules: ['company_info', 'runtime_memory'] },
      model: { strategy: 'fixed', modelRef: 'tenant/model-a' },
      memory: { scope: 'search_only' },
      limits: { maxTurns: 8 },
    }));

    expect(merged.model).toEqual({ strategy: 'fixed', modelRef: 'tenant/model-a' });
    expect(merged.context.modules).toEqual(['company_info', 'runtime_memory']);
    expect(merged.memory.scope).toBe('search_only');
    expect(merged.limits.maxTurns).toBe(8);

    const sparseShared = {
      ...sharedProfile(),
      context: { systemInstructions: 'shared', modules: ['company_info' as const] },
      memory: { scope: 'none' as const },
    };
    const independentlyConfigured = mergeOrgAgentRuntimePolicy(sparseShared, policy({
      context: { modules: ['tenant_instructions', 'runtime_memory'] },
      memory: { scope: 'full' },
    }));
    expect(independentlyConfigured.context.modules).toEqual(['runtime_memory', 'tenant_instructions']);
    expect(independentlyConfigured.memory.scope).toBe('full');
  });

  it('capabilities 只能 inherit/disabled，不能把 shared 已关闭能力重新打开', () => {
    const merged = mergeOrgAgentRuntimePolicy(sharedProfile(), policy({
      capabilities: {
        shell: 'disabled',
        backgroundTasks: 'inherit',
        interaction: 'inherit',
        subagents: 'disabled',
        scheduling: 'inherit',
      },
    }));
    expect(merged.capabilities).toEqual({
      shell: false,
      backgroundTasks: false,
      interaction: true,
      subagents: false,
      scheduling: false,
    });
    expect(() => orgAgentRuntimePolicySchema.parse({
      ...structuredClone(DEFAULT_ORG_AGENT_RUNTIME_POLICY),
      capabilities: {
        ...DEFAULT_ORG_AGENT_RUNTIME_POLICY.capabilities,
        shell: 'enabled',
      },
    })).toThrow();
  });

  it('tools/MCP/execution allowlist 取交集，denylist 合并，且保留 WaitForWorkspaceReady 不变量', () => {
    const merged = mergeOrgAgentRuntimePolicy(sharedProfile(), policy({
      tools: {
        allowlist: ['Read', 'WaitForWorkspaceReady', 'WebFetch'],
        denylist: ['WebSearch'],
      },
      mcp: {
        serverAllowlist: ['crm', 'finance'],
        toolAllowlist: ['find', 'write'],
        denyServers: ['sandbox'],
        denyTools: ['export'],
      },
      execution: { allowedTargets: ['client', 'server-remote'] },
    }));

    expect(merged.tools).toEqual({
      allowlist: ['Read', 'WaitForWorkspaceReady'],
      denylist: ['DangerousTool', 'WebSearch'],
    });
    expect(merged.mcp).toEqual({
      serverAllowlist: ['crm'],
      toolAllowlist: ['find'],
      denyServers: ['legacy', 'sandbox'],
      denyTools: ['delete', 'export'],
    });
    expect(merged.execution.allowedTargets).toEqual(['server-remote']);

    expect(() => policy({
      tools: { allowlist: ['Read'], denylist: [] },
    })).toThrow(/WaitForWorkspaceReady/);
    expect(() => policy({
      tools: { allowlist: null, denylist: ['WaitForWorkspaceReady'] },
    })).toThrow(/WaitForWorkspaceReady/);
  });

  it('legacy Store 缺 runtime 时读为默认 policy，并在下一次写操作持久化', async () => {
    const root = await mkdtemp(join(tmpdir(), 'org-agent-runtime-policy-'));
    cleanup.add(root);
    const path = join(root, 'org-agents.json');
    await writeFile(path, JSON.stringify({
      version: 1,
      agents: [{
        id: 'oa-legacy', tenantId: 'tenant-a', name: '旧 Agent', description: '', starterPrompts: [],
        instructions: '', allowedSkills: ['dws'], audience: { exposure: 'all', usernames: [] },
        guardrail: { enabled: false, scopeDescription: '', rejectionMessage: '拒绝', strictness: 'strict' },
        enabled: true, createdAt: '', createdBy: '', updatedAt: '', updatedBy: '',
      }],
    }));

    const store = new OrgAgentStore(path);
    expect(store.get('oa-legacy')?.runtime).toEqual(DEFAULT_ORG_AGENT_RUNTIME_POLICY);
    await store.update('oa-legacy', { name: '旧 Agent v2' }, 'admin');
    const persisted = JSON.parse(await readFile(path, 'utf8')) as { agents: Array<{ runtime?: unknown }> };
    expect(persisted.agents[0]?.runtime).toEqual(DEFAULT_ORG_AGENT_RUNTIME_POLICY);
  });

  it('knowledge IDs 按 MVP 作为 skill 与 allowedSkills 合并进入运行时过滤和 preflight snapshot', () => {
    const agent = {
      allowedSkills: ['dws', 'shared'],
      allowedKnowledge: ['kb-sales', 'shared'],
    };
    expect(resolveOrgAgentRuntimeSkillIds(agent)).toEqual(['dws', 'shared', 'kb-sales']);

    const filter = buildOrgAgentSkillFilter(agent);
    expect(filter({ id: 'kb-sales', name: '任意同名', description: '' })).toBe(true);
    expect(filter({ id: 'other', name: 'kb-sales', description: '' })).toBe(false);

    expect(resolveOrgAgentSnapshotSkillRefs({
      typedSkills: [{ id: 'typed', revision: 2 }],
      versionedSkills: [{ id: 'dws', versionId: 'sv-1' }],
      versionedKnowledge: ['kb-sales'],
      legacyAgent: agent,
    })).toEqual([
      { id: 'typed', revision: 2 },
      { id: 'kb-sales' },
      { id: 'shared' },
    ]);
  });
});
