import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PgSkillGovernanceStore } from '../data/skillGovernance/index.js';
import { SkillConfigStore } from '../data/skills/store.js';
import { createSkillDispatchState } from '../app/skillDispatchState.js';
import { resolveUserCwd, type WorkspaceUser } from '../workspace/resolver.js';
import { SkillWorkspaceMaterializer } from '../workspace/materialization/materializer.js';

function createSkill(root: string, id: string, body: string): void {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${id}\n---\n${body}\n`);
}

describe('技能 ownership 生产链路', () => {
  it('PgSkillGovernanceStore 的目标查询同时保护 materializer 与 runtime dispatch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skill-ownership-production-'));
    try {
      const sharedDir = join(root, 'shared');
      const agentCwd = join(root, 'workspaces');
      const user: WorkspaceUser = { id: 'u-1', username: 'alice', role: 'user', tenantId: 'tenant-a' };
      const userCwd = resolveUserCwd(agentCwd, user);
      const sourceDir = join(sharedDir, 'tenants', 'tenant-b', 'skills');
      mkdirSync(join(sharedDir, '.ky-agent', 'skills-pool'), { recursive: true });
      mkdirSync(join(sharedDir, '.ky-agent', 'scripts'), { recursive: true });
      createSkill(join(sharedDir, '.ky-agent', 'skills-pool'), 'alpha', 'alpha');
      createSkill(sourceDir, 'same-name', 'foreign-v1');
      createSkill(join(userCwd, '.ky-agent', 'skills'), 'same-name', 'personal');
      writeFileSync(join(sourceDir, 'same-name', 'SKILL.md'), '---\nname: same-name\n---\nforeign-v2\n');
      writeFileSync(join(userCwd, '.ky-agent', '.skills-version'), '1');

      const pool = {
        query: async (sql: string, params: unknown[] = []) => {
          if (sql.includes('LEFT JOIN test_governed_skill_versions')) {
            return params[0] === 'tenant-b'
              ? {
                  rows: [{
                    skill_id: 'tenant-foreign',
                    definition_json: { legacySkillId: 'same-name', contentDigest: 'foreign-v1' },
                  }],
                  rowCount: 1,
                }
              : { rows: [], rowCount: 0 };
          }
          if (!sql.includes("version.definition_json->>'legacySkillId'=$3")) {
            throw new Error(`unexpected governance query: ${sql}`);
          }
          return { rows: [{ personal: false, non_personal: true }], rowCount: 1 };
        },
      };
      const governanceStore = new PgSkillGovernanceStore({ pool: pool as never, tablePrefix: 'test' });
      const resolveOwnership = (tenantId: string, userId: string, skillId: string) =>
        governanceStore.resolveUserPersonalSkillOwnership(tenantId, userId, skillId);
      const resolveHistoricalProvenance = async (tenantId: string) => new Map(
        tenantId === 'tenant-b' ? [['same-name', { digests: [], legacyDigests: ['foreign-v1'] }] as const] : [],
      );
      const dispatch = createSkillDispatchState({
        findUser: (username) => username === user.username
          ? { id: user.id, username: user.username, role: user.role, tenantId: user.tenantId! }
          : undefined,
        agentCwd,
        tenantsRootDir: join(sharedDir, 'tenants'),
        getConfigVersion: () => 1,
        scanPoolSkills: () => [],
        resolveTenantSkillHistoricalProvenance: resolveHistoricalProvenance,
        resolveUserPersonalSkillIds: async () => undefined,
        resolveUserPersonalSkillOwnership: resolveOwnership,
      });

      await dispatch.refresh(user.username);
      expect(dispatch.getManagedTenantIds(user.username)).toContain('same-name');

      expect((await governanceStore.listTenantSkillHistoricalProvenance('tenant-b')).has('same-name')).toBe(true);
      await expect(governanceStore.resolveUserPersonalSkillOwnership('tenant-a', 'u-1', 'same-name'))
        .resolves.toBe('not_personal');

      const materializer = new SkillWorkspaceMaterializer({
        sharedDir,
        sourceRevision: 'test-release',
        skillConfigStore: new SkillConfigStore(join(root, 'skills-config.json')),
        resolveTenantSkillHistoricalProvenance: resolveHistoricalProvenance,
        resolveUserPersonalSkillOwnership: resolveOwnership,
      });
      const result = await materializer.materialize({ taskId: 'task-production-ownership', user, userCwd });

      expect(result.removedSkills).toBe(1);
      expect(existsSync(join(userCwd, '.ky-agent', 'skills', 'same-name'))).toBe(false);
      expect(readFileSync(join(sourceDir, 'same-name', 'SKILL.md'), 'utf-8')).toContain('foreign-v2');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
