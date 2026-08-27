import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectSkillPruneInventory } from '../app/skillPruneInventory.js';
import { SkillConfigStore } from '../data/skills/store.js';
import { resolveTenantSkillsDirFromRoot } from '../data/tenants/tenantSkillsPath.js';
import { resolveAgentPath } from '../workspace/namespace.js';
import { resolveUserCwd } from '../workspace/resolver.js';

const USERS = [
  { id: 'user-alice', username: 'alice', role: 'user', tenantId: 'acme' },
  { id: 'user-bob', username: 'bob', role: 'user', tenantId: 'acme' },
] as const;

function writeSkill(parent: string, id: string): void {
  const dir = join(parent, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${id}\ndescription: ${id}\n---\nbody`,
    'utf-8',
  );
}

describe('collectSkillPruneInventory', () => {
  let root: string;
  let agentCwd: string;
  let tenantSkillsRootDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'skill-prune-inventory-'));
    agentCwd = join(root, 'workspaces');
    tenantSkillsRootDir = join(root, 'tenant-skills');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('从真实目录按用户保留个人 Skill，并排除 pool、组织与其他用户同名 Skill', async () => {
    const aliceSkills = resolveAgentPath(resolveUserCwd(agentCwd, USERS[0]), 'skills');
    const bobSkills = resolveAgentPath(resolveUserCwd(agentCwd, USERS[1]), 'skills');
    const tenantSkills = resolveTenantSkillsDirFromRoot(tenantSkillsRootDir, 'acme');
    for (const dir of [aliceSkills, bobSkills]) {
      writeSkill(dir, 'browser');
      writeSkill(dir, 'org-skill');
    }
    writeSkill(aliceSkills, 'shared-personal');
    writeSkill(bobSkills, 'bob-only');
    writeSkill(tenantSkills, 'org-skill');

    const inventory = await collectSkillPruneInventory({
      users: USERS,
      agentCwd,
      tenantSkillsRootDir,
      currentPoolIds: new Set(['browser']),
    });

    expect([...inventory.tenantOwnIdsByTenant.acme]).toEqual(['org-skill']);
    expect([...inventory.personalSkillIdsByUsername.alice]).toEqual(['shared-personal']);
    expect([...inventory.personalSkillIdsByUsername.bob]).toEqual(['bob-only']);

    const store = new SkillConfigStore(join(root, 'skills-config.json'));
    await store.setUserSelectedSkills('alice', ['browser', 'org-skill', 'shared-personal', 'deleted']);
    await store.setUserSelectedSkills('bob', ['shared-personal', 'bob-only']);
    store.pruneStaleSkills(
      new Set(['browser']),
      inventory.tenantOwnIdsByTenant,
      inventory.personalSkillIdsByUsername,
    );

    expect(store.getUserSelectedSkills('alice')).toEqual(['browser', 'org-skill', 'shared-personal']);
    expect(store.getUserSelectedSkills('bob')).toEqual(['bob-only']);
  });
});
