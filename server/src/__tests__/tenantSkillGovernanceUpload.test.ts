import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SkillGovernanceInvariantError } from '../data/skillGovernance/index.js';
import { createTenantSkillGovernanceUpload, tenantSkillResourceId } from '../services/tenantSkillGovernanceUpload.js';
import { computeSkillPackageFingerprint } from '../workspace/materialization/fingerprint.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function uploadBuffer(buffer: Buffer, originalname: string): Express.Multer.File {
  return {
    fieldname: 'files', originalname, encoding: '7bit', mimetype: 'application/octet-stream',
    size: buffer.length, buffer, destination: '', filename: '', path: '', stream: undefined as never,
  };
}

function uploadFile(content: string, originalname = 'SKILL.md'): Express.Multer.File {
  return uploadBuffer(Buffer.from(content), originalname);
}

function singleFileZip(entryName: string, content: string): Buffer {
  const name = Buffer.from(entryName);
  const data = Buffer.from(content);
  const checksum = crc32(data);
  const local = Buffer.alloc(30 + name.length + data.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  data.copy(local, 30 + name.length);

  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x0314, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  name.copy(central, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, eocd]);
}

function deflatedZipWithDeclaredSize(entryName: string, content: Buffer, declaredSize: number): Buffer {
  const name = Buffer.from(entryName);
  const compressed = deflateRawSync(content);
  const checksum = crc32(content);
  const local = Buffer.alloc(30 + name.length + compressed.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(declaredSize, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  compressed.copy(local, 30 + name.length);

  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x0314, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(declaredSize, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  name.copy(central, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, eocd]);
}

function oversizedZipMetadata(uncompressedSize = 101 * 1024 * 1024): Buffer {
  const name = Buffer.from('SKILL.md');
  const local = Buffer.alloc(30 + name.length + 1);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(1, 18);
  local.writeUInt32LE(uncompressedSize, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);

  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x0314, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(1, 20);
  central.writeUInt32LE(uncompressedSize, 24);
  central.writeUInt16LE(name.length, 28);
  name.copy(central, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, eocd]);
}

function rig(input: {
  getResource?: ReturnType<typeof vi.fn>;
  createAndPublish?: ReturnType<typeof vi.fn>;
  restore?: ReturnType<typeof vi.fn>;
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
  const restoreAndPublishResource = input.restore ?? vi.fn().mockImplementation(async value => ({
    resource: {
      skillId: value.skillId, tenantId: value.tenantId, scope: 'tenant', status: 'published',
      currentVersionId: 'skillv-2', revision: value.expectedRevision + 1, createdAt: '2026-08-14T00:00:00.000Z',
      createdBy: value.publishedBy, updatedAt: '2026-08-14T00:00:00.000Z', updatedBy: value.publishedBy,
    },
    version: {
      versionId: 'skillv-2', skillId: value.skillId, versionNumber: 2, definition: value.definition,
      digest: 'digest-2', publishedAt: '2026-08-14T00:00:00.000Z', publishedBy: value.publishedBy,
    },
    created: true,
  }));
  const upload = createTenantSkillGovernanceUpload({
    skills: { getResource, createAndPublishResource, restoreAndPublishResource } as never,
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
    restoreAndPublishResource,
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
      skillId: tenantSkillResourceId('tenant-a', 'governed-skill'),
      tenantId: 'tenant-a', scope: 'tenant', createdBy: 'platform-1',
      definition: expect.objectContaining({
        resourceType: 'skill', legacySkillId: 'governed-skill', source: 'governance_upload',
        packageFormat: 'skill-package-v1', contentDigestAlgorithm: 'materialized-v2',
        contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    }));
  });

  it('治理 contentDigest 与物化副本统一排除 node_modules 等非物化目录', async () => {
    const test = rig();
    const result = await test.upload({
      tenantId: 'tenant-a',
      actorUserId: 'platform-1',
      files: [
        uploadFile(validSkill('normalized-digest')),
        uploadFile('ignored', 'node_modules/ignored.js'),
        uploadFile('ignored', '__pycache__/ignored.pyc'),
      ],
    });
    const expected = await computeSkillPackageFingerprint(test.installedDir('normalized-digest'));
    expect(result.version.definition.contentDigest).toBe(expected);
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

  it('合法 zip 通过中央目录预检后正常发布', async () => {
    const test = rig();
    const result = await test.upload({
      tenantId: 'tenant-a', actorUserId: 'admin-1',
      files: [uploadBuffer(singleFileZip('SKILL.md', validSkill('zipped-skill')), 'zipped-skill.zip')],
    });
    expect(result).toMatchObject({ status: 'succeeded', skill: { id: 'zipped-skill' } });
    expect(await readFile(join(test.installedDir('zipped-skill'), 'SKILL.md'), 'utf-8'))
      .toContain('governed upload');
  });

  it.each(['/SKILL.md', 'C:\\SKILL.md'])('zip 绝对路径 %s 在解压前拒绝', async (entryName) => {
    const test = rig();
    await expect(test.upload({
      tenantId: 'tenant-a', actorUserId: 'admin-1',
      files: [uploadBuffer(singleFileZip(entryName, validSkill('unsafe-path')), 'unsafe.zip')],
    })).rejects.toMatchObject({ code: 'SKILL_PACKAGE_UNSAFE', status: 400 });
    expect(test.createAndPublishResource).not.toHaveBeenCalled();
  });

  it('zip 中央目录声明单个文件解压后超过 25MB 时在解压前拒绝', async () => {
    const test = rig();
    await expect(test.upload({
      tenantId: 'tenant-a', actorUserId: 'admin-1',
      files: [uploadBuffer(oversizedZipMetadata(26 * 1024 * 1024), 'oversized-entry.zip')],
    })).rejects.toMatchObject({ code: 'SKILL_PACKAGE_LIMIT_EXCEEDED', status: 413 });
    expect(test.createAndPublishResource).not.toHaveBeenCalled();
  });

  it('zip 伪造中央目录大小时按实际解压流量执行 25MB 硬上限', async () => {
    const test = rig();
    const forged = deflatedZipWithDeclaredSize('SKILL.md', Buffer.alloc(26 * 1024 * 1024, 0x61), 1);
    await expect(test.upload({
      tenantId: 'tenant-a', actorUserId: 'admin-1',
      files: [uploadBuffer(forged, 'forged-size.zip')],
    })).rejects.toMatchObject({ code: 'SKILL_PACKAGE_LIMIT_EXCEEDED', status: 413 });
    expect(test.createAndPublishResource).not.toHaveBeenCalled();
    expect(existsSync(join(test.root, 'tenant-skills', 'tenant-a', 'skills'))).toBe(false);
  });

  it('zip 中央目录声明解压后超过 100MB 时在解压前拒绝', async () => {
    const test = rig();
    await expect(test.upload({
      tenantId: 'tenant-a', actorUserId: 'admin-1',
      files: [uploadBuffer(oversizedZipMetadata(), 'oversized.zip')],
    })).rejects.toMatchObject({ code: 'SKILL_PACKAGE_LIMIT_EXCEEDED', status: 413 });
    expect(test.createAndPublishResource).not.toHaveBeenCalled();
    expect(existsSync(join(test.root, 'tenant-skills', 'tenant-a', 'skills'))).toBe(false);
  });

  it('不同组织上传同名 Skill 时使用隔离治理主键，并保留相同 legacySkillId', async () => {
    const test = rig();
    await test.upload({
      tenantId: 'tenant-a', actorUserId: 'admin-a', files: [uploadFile(validSkill('same-name'))],
    });
    await test.upload({
      tenantId: 'tenant-b', actorUserId: 'admin-b', files: [uploadFile(validSkill('same-name'))],
    });

    const first = test.createAndPublishResource.mock.calls[0]?.[0];
    const second = test.createAndPublishResource.mock.calls[1]?.[0];
    expect(first.skillId).toBe(tenantSkillResourceId('tenant-a', 'same-name'));
    expect(second.skillId).toBe(tenantSkillResourceId('tenant-b', 'same-name'));
    expect(first.skillId).not.toBe(second.skillId);
    expect(first.definition.legacySkillId).toBe('same-name');
    expect(second.definition.legacySkillId).toBe('same-name');
    expect(existsSync(join(test.root, 'tenant-skills', 'tenant-a', 'skills', 'same-name', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(test.root, 'tenant-skills', 'tenant-b', 'skills', 'same-name', 'SKILL.md'))).toBe(true);
  });

  it('删除遗留治理资源后同名重导会恢复原组织资源并发布下一版本', async () => {
    const resourceId = tenantSkillResourceId('tenant-a', 'restored-skill');
    const test = rig({ getResource: vi.fn().mockResolvedValue({
      skillId: resourceId, tenantId: 'tenant-a', scope: 'tenant', status: 'retired',
      currentVersionId: 'skillv-1', revision: 3, createdAt: 'x', createdBy: 'admin-1', updatedAt: 'x', updatedBy: 'admin-1',
    }) });
    const result = await test.upload({
      tenantId: 'tenant-a', actorUserId: 'admin-1', files: [uploadFile(validSkill('restored-skill'))],
    });
    expect(result).toMatchObject({ resource: { skillId: resourceId, status: 'published' }, version: { versionNumber: 2 } });
    expect(test.restoreAndPublishResource).toHaveBeenCalledWith(expect.objectContaining({
      skillId: resourceId, scope: 'tenant', expectedRevision: 3,
    }));
    expect(test.createAndPublishResource).not.toHaveBeenCalled();
    expect(existsSync(join(test.installedDir('restored-skill'), 'SKILL.md'))).toBe(true);
  });

  it('同组织并发上传同名 Skill 时仅一个成功，且不覆盖胜出文件', async () => {
    const test = rig();
    const outcomes = await Promise.allSettled([
      test.upload({
        tenantId: 'tenant-a', actorUserId: 'admin-a',
        files: [uploadFile(validSkill('concurrent-skill'))],
      }),
      test.upload({
        tenantId: 'tenant-a', actorUserId: 'admin-b',
        files: [uploadFile(validSkill('concurrent-skill'))],
      }),
    ]);

    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(result => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: 'SKILL_VERSION_CONFLICT', status: 409 }) }),
    ]);
    expect(test.createAndPublishResource).toHaveBeenCalledTimes(1);
    expect(await readFile(join(test.installedDir('concurrent-skill'), 'SKILL.md'), 'utf-8'))
      .toContain('governed upload');
  });

  it('个人技能提升仅忽略来源所有者的同名目录，并记录来源治理版本', async () => {
    const test = rig({ users: [
      { id: 'user-1', username: 'alice', tenantId: 'tenant-a', role: 'user' },
    ] });
    const sourceDir = join(test.root, 'agents', 'tenant-a', 'user-1', '.ky-agent', 'skills', 'promoted-skill');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'SKILL.md'), validSkill('promoted-skill'));
    const expectedContentDigest = await computeSkillPackageFingerprint(sourceDir);

    await expect(test.upload({
      tenantId: 'tenant-a', actorUserId: 'admin-1',
      files: [uploadFile(validSkill('promoted-skill'))],
      promotionSource: {
        ownerUserId: 'user-1', resourceId: 'personal-resource-1', versionId: 'personal-version-1',
        expectedSkillId: 'promoted-skill', expectedContentDigest,
      },
    })).resolves.toMatchObject({ status: 'succeeded' });
    expect(test.createAndPublishResource).toHaveBeenCalledWith(expect.objectContaining({
      definition: expect.objectContaining({
        source: 'personal_skill_promotion',
        sourceResourceId: 'personal-resource-1',
        sourceVersionId: 'personal-version-1',
      }),
    }));
  });

  it('个人技能内容与已发布治理版本不一致时拒绝提升', async () => {
    const test = rig();
    await expect(test.upload({
      tenantId: 'tenant-a', actorUserId: 'admin-1',
      files: [uploadFile(validSkill('drifted-skill'))],
      promotionSource: {
        ownerUserId: 'user-1', resourceId: 'personal-resource-1', versionId: 'personal-version-1',
        expectedSkillId: 'drifted-skill', expectedContentDigest: '0'.repeat(64),
      },
    })).rejects.toMatchObject({ code: 'SKILL_SOURCE_VERSION_DRIFT', status: 409 });
    expect(test.createAndPublishResource).not.toHaveBeenCalled();
    expect(existsSync(test.installedDir('drifted-skill'))).toBe(false);
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
