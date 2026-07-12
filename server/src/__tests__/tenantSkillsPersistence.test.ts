import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SkillConfigStore } from '../data/skills/store.js';
import { resolveTenantSkillsDirFromRoot } from '../data/tenants/tenantSkillsPath.js';
import { resolveUserCwd, syncSkills } from '../workspace/resolver.js';

describe('tenant-owned skills persistence root', () => {
  let tmpRoot: string;
  let sharedDir: string;
  let tenantSkillsRootDir: string;
  let agentCwd: string;
  let store: SkillConfigStore;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'tenant-skills-persist-'));
    sharedDir = join(tmpRoot, 'release', 'workspace-shared');
    tenantSkillsRootDir = join(tmpRoot, 'server-data', 'tenant-skills');
    agentCwd = join(tmpRoot, 'workspaces');
    mkdirSync(join(sharedDir, '.ky-agent', 'skills-pool', 'browser'), { recursive: true });
    writeFileSync(
      join(sharedDir, '.ky-agent', 'skills-pool', 'browser', 'SKILL.md'),
      '---\nname: browser\ndescription: browser\n---\nbody',
      'utf-8',
    );
    store = new SkillConfigStore(join(tmpRoot, 'skills-config.json'));
    store.syncWithPool(new Set(['browser']));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('copies selected tenant-owned skills from the persistent root, not release workspace-shared', async () => {
    const user = { id: 'u-demo', username: 'demo', role: 'user' as const, tenantId: 'acme' };
    const userCwd = resolveUserCwd(agentCwd, user);
    const tenantSkillDir = join(resolveTenantSkillsDirFromRoot(tenantSkillsRootDir, 'acme'), 'daily-follow-up-plan');
    mkdirSync(tenantSkillDir, { recursive: true });
    writeFileSync(
      join(tenantSkillDir, 'SKILL.md'),
      '---\nname: daily-follow-up-plan\ndescription: follow up\n---\nbody',
      'utf-8',
    );

    await store.setUserSelectedSkills('demo', ['daily-follow-up-plan']);
    syncSkills(userCwd, sharedDir, user, store, tenantSkillsRootDir);

    const copied = join(userCwd, '.ky-agent', 'skills', 'daily-follow-up-plan', 'SKILL.md');
    expect(existsSync(copied)).toBe(true);
    expect(readFileSync(copied, 'utf-8')).toContain('follow up');
  });

  it('does not treat release workspace-shared tenants dir as the source when a persistent root is provided', async () => {
    const user = { id: 'u-demo', username: 'demo', role: 'user' as const, tenantId: 'acme' };
    const userCwd = resolveUserCwd(agentCwd, user);
    const releaseTenantSkillDir = join(sharedDir, 'tenants', 'acme', 'skills', 'release-only');
    mkdirSync(releaseTenantSkillDir, { recursive: true });
    writeFileSync(
      join(releaseTenantSkillDir, 'SKILL.md'),
      '---\nname: release-only\ndescription: should not copy\n---\nbody',
      'utf-8',
    );

    await store.setUserSelectedSkills('demo', ['release-only']);
    syncSkills(userCwd, sharedDir, user, store, tenantSkillsRootDir);

    expect(existsSync(join(userCwd, '.ky-agent', 'skills', 'release-only'))).toBe(false);
  });

  it('materializes org Agent skills without writing them into the member personal selection', async () => {
    const user = { id: 'u-demo', username: 'demo', role: 'user' as const, tenantId: 'acme' };
    const userCwd = resolveUserCwd(agentCwd, user);
    const tenantSkillDir = join(resolveTenantSkillsDirFromRoot(tenantSkillsRootDir, 'acme'), 'wain-kb');
    mkdirSync(tenantSkillDir, { recursive: true });
    writeFileSync(
      join(tenantSkillDir, 'SKILL.md'),
      '---\nname: wain-kb\ndescription: tenant knowledge base\n---\nbody',
      'utf-8',
    );
    await store.setTenantSkillRules('acme', {
      browser: { enabled: true, exposure: 'allow_users', usernames: ['someone-else'] },
    });
    await store.setTenantOwnSkillRules('acme', {
      'wain-kb': { enabled: true, exposure: 'allow_users', usernames: ['someone-else'] },
    });
    await store.setUserSelectedSkills('demo', []);

    syncSkills(userCwd, sharedDir, user, store, tenantSkillsRootDir, ['browser', 'wain-kb']);

    expect(existsSync(join(userCwd, '.ky-agent', 'skills', 'browser', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(userCwd, '.ky-agent', 'skills', 'wain-kb', 'SKILL.md'))).toBe(true);
    expect(store.getUserSelectedSkills('demo')).toEqual([]);
  });
});
