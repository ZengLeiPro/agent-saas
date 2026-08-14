import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SkillGovernanceInvariantError } from '../data/skillGovernance/index.js';
import { createTenantSkillGovernanceUpload } from '../services/tenantSkillGovernanceUpload.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function uploadFile(content: string, originalname = 'SKILL.md'): Express.Multer.File {
  const buffer = Buffer.from(content);
  return {
    fieldname: 'files', originalname, encoding: '7bit', mimetype: 'text/markdown',
    size: buffer.length, buffer, destination: '', filename: '', path: '', stream: undefined as never,
  };
}

function rig(input: {
  getResource?: ReturnType<typeof vi.fn>;
  createAndPublish?: ReturnType<typeof vi.fn>;
  poolVisibility?: Record<string, boolean>;
  users?: Array<{ id: string; username: string; tenantId: string; role: string }>;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tenant-skill-governance-upload-'));
  roots.push(root);
  const getResource = input.getResource ?? vi.fn().mockResolvedValue(null);
  const createAndPublishResource = input.createAndPublish ?? vi.fn().mockImplementation(async value => ({
    resource: {
      skillId: value.skillId, tenantId: value.tenantId, scope: 'tenant', status: 'published',
      currentVersionId: 'skillv-1', revision: 2, createdAt: '2026-08-14T00:00:00.000Z',
      createdBy: value.createdBy, updatedAt: '2026-08-14T00:00:00.000Z', updatedBy: value.createdBy,
    },
    version: {
      versionId: 'skillv-1', skillId: value.skillId, versionNumber: 1, definition: value.definition,
      digest: 'digest-1', publishedAt: '2026-08-14T00:00:00.000Z', publishedBy: value.createdBy,
    },
    created: true,
  }));
  const upload = createTenantSkillGovernanceUpload({
    skills: { getResource, createAndPublishResource } as never,
    skillConfigStore: { getPoolVisibility: () => input.poolVisibility ?? {} } as never,
    userStore: { listAll: () => input.users ?? [] } as never,
    agentCwd: join(root, 'agents'),
    sharedDir: join(root, 'shared'),
    tenantSkillsRootDir: join(root, 'tenant-skills'),
  });
  return {
    root,
    getResource,
    createAndPublishResource,
    upload,
    installedDir: (skillId: string) => join(root, 'tenant-skills', 'tenant-a', 'skills', skillId),
  };
}

const validSkill = (name: string) => `---\nname: ${name}\ndescription: governed upload\n---\nbody`;

describe('组织 Skill 治理上传服务', () => {
  it('合法包先安全落盘，再原子创建并发布 tenant Skill v1', async () => {
    const test = rig();
    const result = await test.upload({
      tenantId: 'tenant-a', actorUserId: 'platform-1', files: [uploadFile(validSkill('governed-skill'))],
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'succeeded',
      skill: { id: 'governed-skill' },
      resource: { tenantId: 'tenant-a', scope: 'tenant', status: 'published', createdBy: 'platform-1' },
      version: { versionNumber: 1 },
    });
    expect(await readFile(join(test.installedDir('governed-skill'), 'SKILL.md'), 'utf-8')).toContain('governed upload');
    expect(test.createAndPublishResource).toHaveBeenCalledWith(expect.objectContaining({
      skillId: 'governed-skill', tenantId: 'tenant-a', scope: 'tenant', createdBy: 'platform-1',
      definition: expect.objectContaining({
        resourceType: 'skill', source: 'governance_upload', packageFormat: 'skill-package-v1',
        contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    }));
  });

  it.each([
    ['缺少 frontmatter', uploadFile('plain text'), 'SKILL_DOCUMENT_INVALID'],
    ['路径穿越', uploadFile(validSkill('unsafe-skill'), '../SKILL.md'), 'SKILL_PACKAGE_UNSAFE'],
  ])('%s 时明确拒绝且不产生文件或治理资源', async (_label, file, code) => {
    const test = rig();
    await expect(test.upload({ tenantId: 'tenant-a', actorUserId: 'admin-1', files: [file] }))
      .rejects.toMatchObject({ code, status: 400 });
    expect(test.createAndPublishResource).not.toHaveBeenCalled();
    expect(existsSync(join(test.root, 'tenant-skills', 'tenant-a', 'skills'))).toBe(false);
  });

  it('平台同名、治理资源重复时返回可理解冲突且不覆盖现有数据', async () => {
    const platformConflict = rig({ poolVisibility: { duplicated: true } });
    await expect(platformConflict.upload({
      tenantId: 'tenant-a', actorUserId: 'admin-1', files: [uploadFile(validSkill('duplicated'))],
    })).rejects.toMatchObject({ code: 'SKILL_SCOPE_CONFLICT', status: 409 });
    expect(platformConflict.createAndPublishResource).not.toHaveBeenCalled();

    const governedConflict = rig({ getResource: vi.fn().mockResolvedValue({ skillId: 'duplicated' }) });
    await expect(governedConflict.upload({
      tenantId: 'tenant-a', actorUserId: 'admin-1', files: [uploadFile(validSkill('duplicated'))],
    })).rejects.toMatchObject({ code: 'SKILL_VERSION_CONFLICT', status: 409 });
    expect(governedConflict.createAndPublishResource).not.toHaveBeenCalled();
  });

  it('治理 Store 提交失败时回滚已落盘目录，不留下半成品', async () => {
    const test = rig({
      createAndPublish: vi.fn().mockRejectedValue(
        new SkillGovernanceInvariantError('SKILL_RESOURCE_VERSION_CONFLICT'),
      ),
    });
    await expect(test.upload({
      tenantId: 'tenant-a', actorUserId: 'admin-1', files: [uploadFile(validSkill('rollback-skill'))],
    })).rejects.toMatchObject({ code: 'SKILL_VERSION_CONFLICT', status: 409 });
    expect(existsSync(test.installedDir('rollback-skill'))).toBe(false);
  });
});
