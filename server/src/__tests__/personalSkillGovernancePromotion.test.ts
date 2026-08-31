import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPersonalSkillGovernancePromotion } from '../services/personalSkillGovernancePromotion.js';
import { personalSkillResourceId } from '../services/tenantSkillGovernanceUpload.js';
import { computeSkillPackageFingerprint } from '../workspace/materialization/fingerprint.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function rig(
  resource: Record<string, unknown> | null = {
    tenantId: 'tenant-a',
    scope: 'personal',
    ownerUserId: 'user-1',
    status: 'published',
    currentVersionId: 'skillv-personal-1',
  },
) {
  const root = mkdtempSync(join(tmpdir(), 'personal-skill-promotion-'));
  roots.push(root);
  const skillDir = join(root, 'tenant-a', 'user-1', '.ky-agent', 'skills', 'personal-skill');
  mkdirSync(join(skillDir, 'assets'), { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    '---\nname: personal-skill\ndescription: personal\n---\nbody',
  );
  writeFileSync(join(skillDir, 'assets', 'note.txt'), 'nested asset');
  const contentDigest = await computeSkillPackageFingerprint(skillDir);
  const importTenantSkill = vi.fn().mockResolvedValue({
    ok: true,
    status: 'succeeded',
    skill: { id: 'personal-skill' },
    resource: { scope: 'tenant' },
    version: { versionNumber: 1 },
  });
  const promote = createPersonalSkillGovernancePromotion({
    skills: {
      getResource: vi.fn().mockResolvedValue(resource),
      getVersion: vi.fn().mockResolvedValue(
        resource
          ? {
              skillId: personalSkillResourceId('user-1', 'personal-skill'),
              definition: { legacySkillId: 'personal-skill', contentDigest },
            }
          : null,
      ),
    } as never,
    userStore: {
      findByUsername: (username: string) =>
        username === 'alice'
          ? { id: 'user-1', username: 'alice', tenantId: 'tenant-a', role: 'user' }
          : undefined,
    } as never,
    agentCwd: root,
    importTenantSkill,
  });
  return { promote, importTenantSkill };
}

describe('个人 Skill 治理提升服务', () => {
  it('校验个人治理版本后递归复制完整技能包到组织治理上传服务', async () => {
    const test = await rig();
    await expect(
      test.promote({
        tenantId: 'tenant-a',
        actorUserId: 'admin-1',
        sourceUsername: 'alice',
        skillId: 'personal-skill',
      }),
    ).resolves.toMatchObject({ status: 'succeeded', resource: { scope: 'tenant' } });

    expect(test.importTenantSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        actorUserId: 'admin-1',
        promotionSource: {
          ownerUserId: 'user-1',
          resourceId: personalSkillResourceId('user-1', 'personal-skill'),
          versionId: 'skillv-personal-1',
          expectedSkillId: 'personal-skill',
          expectedContentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        files: expect.arrayContaining([
          expect.objectContaining({ originalname: 'SKILL.md' }),
          expect.objectContaining({ originalname: 'assets/note.txt' }),
        ]),
      }),
    );
  });

  it('个人治理版本缺失时 fail closed，不复制个人目录', async () => {
    const test = await rig(null);
    await expect(
      test.promote({
        tenantId: 'tenant-a',
        actorUserId: 'admin-1',
        sourceUsername: 'alice',
        skillId: 'personal-skill',
      }),
    ).rejects.toMatchObject({ code: 'PERSONAL_SKILL_GOVERNANCE_REQUIRED', status: 409 });
    expect(test.importTenantSkill).not.toHaveBeenCalled();
  });

  it('拒绝提升其他组织用户的个人技能', async () => {
    const test = await rig();
    await expect(
      test.promote({
        tenantId: 'tenant-b',
        actorUserId: 'admin-1',
        sourceUsername: 'alice',
        skillId: 'personal-skill',
      }),
    ).rejects.toMatchObject({ code: 'SKILL_SOURCE_USER_NOT_FOUND', status: 404 });
    expect(test.importTenantSkill).not.toHaveBeenCalled();
  });
});
