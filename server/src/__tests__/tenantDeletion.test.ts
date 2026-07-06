import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentStore } from '../data/agents/store.js';
import { GroupStore } from '../data/groups/store.js';
import { McpConfigStore } from '../data/mcpConfig.js';
import { SkillConfigStore } from '../data/skills/store.js';
import { deleteTenantResources } from '../data/tenants/cleanup.js';
import { TenantStore } from '../data/tenants/store.js';
import { UserStore } from '../data/users/store.js';
import { CronService } from '../cron/service.js';
import { resolveTenantCwd } from '../workspace/resolver.js';

describe('deleteTenantResources', () => {
  const tenantId = 'tdcleanup';
  let root: string;
  let agentCwd: string;
  let sharedDir: string;
  let tenantSkillsRootDir: string;
  let avatarsDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tenant-delete-'));
    agentCwd = join(root, 'agent-cwd');
    sharedDir = join(root, 'shared');
    tenantSkillsRootDir = join(root, 'tenant-skills');
    avatarsDir = join(root, 'data', 'avatars');
    mkdirSync(agentCwd, { recursive: true });
    mkdirSync(sharedDir, { recursive: true });
    mkdirSync(tenantSkillsRootDir, { recursive: true });
    mkdirSync(avatarsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('删除组织时清理组织用户和租户级资源', async () => {
    const tenantStore = new TenantStore(join(root, 'tenants.json'));
    await tenantStore.ensureDefaultTenant();
    await tenantStore.create({ id: tenantId, name: '待删组织', createdBy: 'admin' });
    await tenantStore.create({ id: 'keeporg', name: '保留组织', createdBy: 'admin' });

    const userStore = new UserStore(join(root, 'users.json'));
    const deletedUser = await userStore.create({
      username: 'delete_me',
      password: '123456',
      role: 'admin',
      tenantId,
      createdBy: 'admin',
    });
    const keptUser = await userStore.create({
      username: 'keep_me',
      password: '123456',
      role: 'admin',
      tenantId: 'keeporg',
      createdBy: 'admin',
    });

    const deletedWorkspace = join(resolveTenantCwd(agentCwd, tenantId), deletedUser.id);
    mkdirSync(deletedWorkspace, { recursive: true });
    writeFileSync(join(deletedWorkspace, 'MEMORY.md'), 'tenant data');
    writeFileSync(join(avatarsDir, `${deletedUser.id}.png`), 'avatar');
    mkdirSync(join(sharedDir, 'tenants', tenantId), { recursive: true });
    writeFileSync(join(sharedDir, 'tenants', tenantId, 'company.md'), 'company');
    mkdirSync(join(tenantSkillsRootDir, tenantId, 'skills', 'tenant-skill'), { recursive: true });
    writeFileSync(join(tenantSkillsRootDir, tenantId, 'skills', 'tenant-skill', 'SKILL.md'), '# Skill');

    const agentStore = new AgentStore(join(root, 'agents.json'));
    await agentStore.set(deletedUser.username, { name: '删除用户 Agent' }, 'admin');
    await agentStore.set(keptUser.username, { name: '保留用户 Agent' }, 'admin');

    const skillConfigStore = new SkillConfigStore(join(root, 'skills-config.json'));
    await skillConfigStore.setUserSelectedSkills(deletedUser.username, ['tenant-skill']);
    await skillConfigStore.setUserSelectedSkills(keptUser.username, ['keep-skill']);
    await skillConfigStore.setTenantOwnSkillRules(tenantId, {
      'tenant-skill': { enabled: true, exposure: 'all', usernames: [] },
    });

    const mcpConfigStore = new McpConfigStore(join(root, 'mcp-config.json'));
    await mcpConfigStore.upsertServer({
      id: 'tenant_mcp',
      name: 'Tenant MCP',
      tenantId,
      config: { type: 'stdio', command: 'echo' },
    });
    await mcpConfigStore.setUserEnabledServers(deletedUser.username, ['tenant_mcp'], tenantId);

    const groupStore = new GroupStore(join(root, 'groups.json'));
    await groupStore.create({ userId: deletedUser.id, name: '删除分组' });
    await groupStore.create({ userId: keptUser.id, name: '保留分组' });

    let jobs = [] as Awaited<ReturnType<CronService['list']>>;
    const cronService = new CronService({
      nowMs: () => 1_700_000_000_000,
      loadJobs: async () => jobs,
      saveJobs: async (next) => { jobs = next; },
      executeJob: async () => ({ status: 'skipped' }),
      appendRunLog: async () => undefined,
    });
    await cronService.add({
      name: '删除任务',
      enabled: true,
      schedule: { kind: 'every', everyMs: 60_000 },
      payload: { kind: 'systemEvent', text: 'tick' },
    }, { owner: deletedUser.id, ownerName: deletedUser.username });

    const report = await deleteTenantResources({
      tenantId,
      tenantStore,
      userStore,
      agentStore,
      skillConfigStore,
      mcpConfigStore,
      groupStore,
      cronService,
      agentCwd,
      sharedDir,
      tenantSkillsRootDir,
      avatarsDir,
    });

    expect(report.usersDeleted).toBe(1);
    expect(report.agentProfilesDeleted).toBe(1);
    expect(report.groupsDeleted).toBe(1);
    expect(report.cronJobsDeleted).toBe(1);
    expect(report.mcp.serversRemoved).toBe(1);
    expect(report.skills.tenantConfigRemoved).toBe(true);
    expect(tenantStore.findById(tenantId)).toBeUndefined();
    expect(userStore.findById(deletedUser.id)).toBeUndefined();
    expect(userStore.findById(keptUser.id)).toBeTruthy();
    expect(agentStore.get(deletedUser.username)).toBeUndefined();
    expect(agentStore.get(keptUser.username)).toBeTruthy();
    expect(groupStore.listByUserId(deletedUser.id)).toHaveLength(0);
    expect(groupStore.listByUserId(keptUser.id)).toHaveLength(1);
    await expect(cronService.list({ includeDisabled: true })).resolves.toHaveLength(0);
    expect(mcpConfigStore.getServer('tenant_mcp')).toBeUndefined();
    expect(skillConfigStore.getUserSelectedSkills(deletedUser.username)).toEqual([]);
    expect(existsSync(resolveTenantCwd(agentCwd, tenantId))).toBe(false);
    expect(existsSync(join(sharedDir, 'tenants', tenantId))).toBe(false);
    expect(existsSync(join(tenantSkillsRootDir, tenantId))).toBe(false);
    expect(existsSync(join(avatarsDir, `${deletedUser.id}.png`))).toBe(false);
  });
});
