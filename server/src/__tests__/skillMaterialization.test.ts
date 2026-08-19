import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SkillConfigStore } from '../data/skills/store.js';
import { resolveUserCwd, type WorkspaceUser } from '../workspace/resolver.js';
import { SkillWorkspaceMaterializer } from '../workspace/materialization/materializer.js';
import { readSkillManifest } from '../workspace/materialization/manifest.js';
import { SkillMaterializationService } from '../workspace/materialization/service.js';
import { InMemorySkillMaterializationStore } from '../workspace/materialization/store.js';

function createSkill(root: string, id: string, body: string): void {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${id}\ndescription: ${id}\n---\n${body}\n`,
  );
}

/** 复现旧 skillPackageUpload：故意不排除 node_modules 等目录。 */
function legacyPackageFingerprint(root: string): string {
  const files: string[] = [];
  const visit = (current: string, prefix = ''): void => {
    for (const name of readdirSync(current).sort((a, b) => a.localeCompare(b))) {
      const relativePath = prefix ? `${prefix}/${name}` : name;
      const path = join(current, name);
      if (statSync(path).isDirectory()) visit(path, relativePath);
      else files.push(relativePath);
    }
  };
  visit(root);
  const hash = createHash('sha256');
  for (const relativePath of files) {
    const path = join(root, relativePath);
    const size = statSync(path).size;
    hash.update(relativePath).update('\\0').update(String(size)).update('\\0').update(readFileSync(path));
  }
  return hash.digest('hex');
}

function fakeStore(selected: string[]) {
  let configVersion = 1;
  const tenantRules: Record<string, unknown> = {};
  const store = {
    getConfigVersion: () => configVersion,
    getPoolVisibility: () => Object.fromEntries(selected.map((id) => [id, true])),
    getTenantOwnSkillRules: () => tenantRules,
    getUserEffectivePoolSkills: () => [...selected],
    getUserEffectiveTenantOwnSkills: () => [],
    getOrgAgentEffectivePoolSkills: (_tenantId: string | undefined, ids: readonly string[]) => [...ids],
    getOrgAgentEffectiveTenantOwnSkills: () => [],
  } as unknown as SkillConfigStore;
  return {
    store,
    bump: () => { configVersion++; },
    setSelected: (ids: string[]) => {
      selected.splice(0, selected.length, ...ids);
      configVersion++;
    },
  };
}

describe('技能异步增量物化', () => {
  let root: string;
  let sharedDir: string;
  let agentCwd: string;
  let poolDir: string;
  let user: WorkspaceUser;
  let userCwd: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'skill-materialization-'));
    sharedDir = join(root, 'shared');
    agentCwd = join(root, 'workspaces');
    poolDir = join(sharedDir, '.ky-agent', 'skills-pool');
    mkdirSync(poolDir, { recursive: true });
    mkdirSync(join(sharedDir, '.ky-agent', 'scripts'), { recursive: true });
    writeFileSync(join(sharedDir, '.ky-agent', 'scripts', 'helper.sh'), '#!/bin/sh\n');
    user = { id: 'u-1', username: 'alice', role: 'user', tenantId: 'tenant-a' };
    userCwd = resolveUserCwd(agentCwd, user);
    mkdirSync(join(userCwd, '.ky-agent', 'skills'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('首次纳管后只复制内容变化的技能，并保留用户自建技能', async () => {
    createSkill(poolDir, 'alpha', 'alpha-v1');
    createSkill(poolDir, 'beta', 'beta-v1');
    createSkill(join(userCwd, '.ky-agent', 'skills'), 'custom', 'custom-v1');
    const config = fakeStore(['alpha', 'beta']);
    const materializer = new SkillWorkspaceMaterializer({
      sharedDir,
      sourceRevision: 'test-release',
      skillConfigStore: config.store,
    });

    const first = await materializer.materialize({ taskId: 'task-1', user, userCwd });
    expect(first).toMatchObject({ changedSkills: 2, skippedSkills: 0, removedSkills: 0 });
    expect(readFileSync(join(userCwd, '.ky-agent', 'skills', 'custom', 'SKILL.md'), 'utf-8'))
      .toContain('custom-v1');

    const second = await materializer.materialize({ taskId: 'task-2', user, userCwd });
    expect(second).toMatchObject({ changedSkills: 0, skippedSkills: 2, removedSkills: 0 });

    writeFileSync(
      join(poolDir, 'alpha', 'SKILL.md'),
      '---\nname: alpha\ndescription: alpha\n---\nalpha-v2\n',
    );
    config.bump();
    const third = await materializer.materialize({ taskId: 'task-3', user, userCwd });
    expect(third).toMatchObject({ changedSkills: 1, skippedSkills: 1, removedSkills: 0 });
    expect(readFileSync(join(userCwd, '.ky-agent', 'skills', 'alpha', 'SKILL.md'), 'utf-8'))
      .toContain('alpha-v2');
    expect(await readSkillManifest(userCwd)).toMatchObject({
      configVersion: 2,
      skills: {
        alpha: { source: 'pool' },
        beta: { source: 'pool' },
      },
    });
  });

  it('按 manifest provenance 将跨组织组织技能残留移入可恢复备份', async () => {
    createSkill(poolDir, 'alpha', 'alpha');
    createSkill(join(sharedDir, 'tenants', 'tenant-b', 'skills'), 'foreign-org-skill', 'foreign');
    createSkill(join(userCwd, '.ky-agent', 'skills'), 'foreign-org-skill', 'stale-copy');
    writeFileSync(
      join(userCwd, '.ky-agent', 'skills-state.json'),
      JSON.stringify({
        version: 1,
        desiredHash: 'previous',
        configVersion: 1,
        generatedAt: '2026-08-19T00:00:00.000Z',
        skills: { 'foreign-org-skill': { digest: 'foreign', source: 'tenant', tenantId: 'tenant-b' } },
      }),
    );
    const config = fakeStore(['alpha']);
    const materializer = new SkillWorkspaceMaterializer({
      sharedDir,
      sourceRevision: 'test-release',
      skillConfigStore: config.store,
    });

    const result = await materializer.materialize({ taskId: 'task-cross-tenant', user, userCwd });

    expect(result.removedSkills).toBe(1);
    expect(() => readFileSync(join(userCwd, '.ky-agent', 'skills', 'foreign-org-skill', 'SKILL.md'), 'utf-8'))
      .toThrow();
    expect(readFileSync(join(sharedDir, 'tenants', 'tenant-b', 'skills', 'foreign-org-skill', 'SKILL.md'), 'utf-8'))
      .toContain('foreign');
  });

  it('旧 .skills-version 状态按内容指纹清理外租户组织残留', async () => {
    createSkill(poolDir, 'alpha', 'alpha');
    createSkill(join(sharedDir, 'tenants', 'tenant-b', 'skills'), 'legacy-foreign', 'foreign');
    createSkill(join(userCwd, '.ky-agent', 'skills'), 'legacy-foreign', 'foreign');
    writeFileSync(join(userCwd, '.ky-agent', '.skills-version'), '1');
    const config = fakeStore(['alpha']);
    const materializer = new SkillWorkspaceMaterializer({
      sharedDir,
      sourceRevision: 'test-release',
      skillConfigStore: config.store,
    });

    const result = await materializer.materialize({ taskId: 'task-legacy-tenant', user, userCwd });

    expect(result.removedSkills).toBe(1);
    expect(() => readFileSync(join(userCwd, '.ky-agent', 'skills', 'legacy-foreign', 'SKILL.md'), 'utf-8'))
      .toThrow();
    expect(await readSkillManifest(userCwd)).toMatchObject({
      skills: { alpha: { source: 'pool' } },
    });
  });

  it('旧副本是外租户 Skill 的 v1、当前源已更新为 v2 时仍按治理历史清理', async () => {
    createSkill(poolDir, 'alpha', 'alpha');
    const sourceDir = join(sharedDir, 'tenants', 'tenant-b', 'skills');
    const userSkillDir = join(userCwd, '.ky-agent', 'skills');
    createSkill(sourceDir, 'legacy-foreign', 'foreign-v1');
    mkdirSync(join(sourceDir, 'legacy-foreign', 'node_modules'), { recursive: true });
    writeFileSync(join(sourceDir, 'legacy-foreign', 'node_modules', 'ignored.js'), 'ignored-v1');
    createSkill(userSkillDir, 'legacy-foreign', 'foreign-v1');
    // 历史 DB 中持久化的是旧上传算法对完整 v1 包的摘要；用户副本只含可物化文件。
    const legacyDigest = legacyPackageFingerprint(join(sourceDir, 'legacy-foreign'));
    writeFileSync(
      join(sourceDir, 'legacy-foreign', 'SKILL.md'),
      '---\nname: legacy-foreign\ndescription: legacy-foreign\n---\nforeign-v2\n',
    );
    writeFileSync(join(userCwd, '.ky-agent', '.skills-version'), '1');
    const config = fakeStore(['alpha']);
    const materializer = new SkillWorkspaceMaterializer({
      sharedDir,
      sourceRevision: 'test-release',
      skillConfigStore: config.store,
      resolveTenantSkillHistoricalProvenance: async (tenantId) => new Map([
        ...(tenantId === 'tenant-b' ? [['legacy-foreign', [legacyDigest]] as const] : []),
      ]),
    });

    const result = await materializer.materialize({ taskId: 'task-legacy-updated-source', user, userCwd });

    expect(result.removedSkills).toBe(1);
    expect(() => readFileSync(join(userSkillDir, 'legacy-foreign', 'SKILL.md'), 'utf-8'))
      .toThrow();
  });

  it('旧 .skills-version 状态不按同名误伤既有个人 Skill', async () => {
    createSkill(poolDir, 'alpha', 'alpha');
    const foreignDir = join(sharedDir, 'tenants', 'tenant-b', 'skills', 'same-name');
    createSkill(join(sharedDir, 'tenants', 'tenant-b', 'skills'), 'same-name', 'foreign');
    mkdirSync(join(foreignDir, 'node_modules'), { recursive: true });
    writeFileSync(join(foreignDir, 'node_modules', 'ignored.js'), 'ignored');
    createSkill(join(userCwd, '.ky-agent', 'skills'), 'same-name', 'personal');
    writeFileSync(join(userCwd, '.ky-agent', '.skills-version'), '1');
    const legacyDigest = legacyPackageFingerprint(foreignDir);
    const config = fakeStore(['alpha']);
    const materializer = new SkillWorkspaceMaterializer({
      sharedDir,
      sourceRevision: 'test-release',
      skillConfigStore: config.store,
      resolveTenantSkillHistoricalProvenance: async (tenantId) => new Map([
        ...(tenantId === 'tenant-b' ? [['same-name', [legacyDigest]] as const] : []),
      ]),
      resolveUserPersonalSkillIds: async () => new Set(['same-name']),
    });

    const result = await materializer.materialize({ taskId: 'task-same-name', user, userCwd });

    expect(result.removedSkills).toBe(0);
    expect(readFileSync(join(userCwd, '.ky-agent', 'skills', 'same-name', 'SKILL.md'), 'utf-8'))
      .toContain('personal');
  });

  it('撤销系统技能时移入可恢复备份，不碰同目录下的自建技能', async () => {
    createSkill(poolDir, 'alpha', 'alpha');
    createSkill(poolDir, 'beta', 'beta');
    createSkill(join(userCwd, '.ky-agent', 'skills'), 'custom', 'custom');
    const config = fakeStore(['alpha', 'beta']);
    const materializer = new SkillWorkspaceMaterializer({
      sharedDir,
      sourceRevision: 'test-release',
      skillConfigStore: config.store,
    });
    await materializer.materialize({ taskId: 'task-a', user, userCwd });

    config.setSelected(['alpha']);
    const result = await materializer.materialize({ taskId: 'task-b', user, userCwd });
    expect(result.removedSkills).toBe(1);
    expect(() => readFileSync(join(userCwd, '.ky-agent', 'skills', 'beta', 'SKILL.md'), 'utf-8'))
      .toThrow();
    expect(readFileSync(join(userCwd, '.ky-agent', 'skills', 'custom', 'SKILL.md'), 'utf-8'))
      .toContain('custom');
  });

  it('把历史 skills/scripts 软链接移入备份后换成真实目录，不沿链接写共享源', async () => {
    createSkill(poolDir, 'alpha', 'shared-alpha');
    const sharedScripts = join(sharedDir, '.ky-agent', 'scripts');
    const userAgentDir = join(userCwd, '.ky-agent');
    rmSync(join(userAgentDir, 'skills'), { recursive: true });
    symlinkSync(poolDir, join(userAgentDir, 'skills'));
    symlinkSync(sharedScripts, join(userAgentDir, 'scripts'));
    const config = fakeStore(['alpha']);
    const materializer = new SkillWorkspaceMaterializer({
      sharedDir,
      sourceRevision: 'test-release',
      skillConfigStore: config.store,
    });

    await materializer.materialize({ taskId: 'task-symlink', user, userCwd });

    expect(lstatSync(join(userAgentDir, 'skills')).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(userAgentDir, 'scripts')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(userAgentDir, 'skills', 'alpha', 'SKILL.md'), 'utf-8'))
      .toContain('shared-alpha');
    expect(readFileSync(join(poolDir, 'alpha', 'SKILL.md'), 'utf-8'))
      .toContain('shared-alpha');
  });

  it('ensureReady 通过串行队列完成物化，后续同版本直接命中 manifest', async () => {
    createSkill(poolDir, 'alpha', 'alpha');
    const config = fakeStore(['alpha']);
    const materializer = new SkillWorkspaceMaterializer({
      sharedDir,
      sourceRevision: 'test-release',
      skillConfigStore: config.store,
    });
    const store = new InMemorySkillMaterializationStore();
    await store.init();
    const service = new SkillMaterializationService({
      store,
      materializer,
      skillConfigStore: config.store,
      sourceRevision: 'test-release',
      pollIntervalMs: 10,
      resolveTargetByUsername: (username) => username === user.username ? { user, userCwd } : undefined,
    });
    service.start();
    await service.ensureReady('alice');
    expect(readFileSync(join(userCwd, '.ky-agent', 'skills', 'alpha', 'SKILL.md'), 'utf-8'))
      .toContain('alpha');

    const noOpBatch = await service.enqueue([{ user, userCwd, reason: 'dispatch' }]);
    expect(noOpBatch).toMatchObject({ status: 'succeeded', total: 0 });

    // 模拟“其他用户改了配置”造成全局 configVersion bump：alice 的目标摘要未变，
    // 不应被全局版本号放大成无意义 workspace 任务。
    config.bump();
    const unrelatedConfigBatch = await service.enqueue([{
      user,
      userCwd,
      reason: 'startup',
    }]);
    expect(unrelatedConfigBatch).toMatchObject({ status: 'succeeded', total: 0 });
    await service.stop();
  });

  it('共享 scripts 内容变化会使 workspace 精确失效并重新物化脚本', async () => {
    createSkill(poolDir, 'alpha', 'alpha');
    const config = fakeStore(['alpha']);
    const materializer = new SkillWorkspaceMaterializer({
      sharedDir,
      sourceRevision: 'test-release',
      skillConfigStore: config.store,
    });
    const store = new InMemorySkillMaterializationStore();
    await store.init();
    const service = new SkillMaterializationService({
      store,
      materializer,
      skillConfigStore: config.store,
      sourceRevision: 'test-release',
      pollIntervalMs: 5,
      resolveTargetByUsername: () => ({ user, userCwd }),
    });
    service.start();
    await service.ensureReady('alice');

    writeFileSync(
      join(sharedDir, '.ky-agent', 'scripts', 'helper.sh'),
      '#!/bin/sh\necho v2\n',
    );
    config.bump();
    const batch = await service.enqueue([{ user, userCwd, reason: 'startup' }]);
    expect(batch.total).toBe(1);
    await expect(service.waitForBatch(batch.id)).resolves.toMatchObject({
      status: 'succeeded',
    });
    expect(readFileSync(
      join(userCwd, '.ky-agent', 'scripts', 'helper.sh'),
      'utf-8',
    )).toContain('echo v2');
    await service.stop();
  });

  it('蓝绿并存时各 release 只领取自己的任务，workspace 锁保证最终不会倒灌旧源', async () => {
    createSkill(poolDir, 'alpha', 'old-release');
    const newSharedDir = join(root, 'new-shared');
    const newPoolDir = join(newSharedDir, '.ky-agent', 'skills-pool');
    createSkill(newPoolDir, 'alpha', 'new-release');
    mkdirSync(join(newSharedDir, '.ky-agent', 'scripts'), { recursive: true });

    const oldConfig = fakeStore(['alpha']);
    const newConfig = fakeStore(['alpha']);
    newConfig.bump();
    const store = new InMemorySkillMaterializationStore();
    await store.init();
    const oldMaterializer = new SkillWorkspaceMaterializer({
      sharedDir,
      sourceRevision: 'release-old',
      skillConfigStore: oldConfig.store,
    });
    const newMaterializer = new SkillWorkspaceMaterializer({
      sharedDir: newSharedDir,
      sourceRevision: 'release-new',
      skillConfigStore: newConfig.store,
    });
    const oldService = new SkillMaterializationService({
      store,
      materializer: oldMaterializer,
      skillConfigStore: oldConfig.store,
      sourceRevision: 'release-old',
      pollIntervalMs: 5,
      resolveTargetByUsername: () => ({ user, userCwd }),
    });
    const newService = new SkillMaterializationService({
      store,
      materializer: newMaterializer,
      skillConfigStore: newConfig.store,
      sourceRevision: 'release-new',
      pollIntervalMs: 5,
      resolveTargetByUsername: () => ({ user, userCwd }),
    });
    oldService.start();
    newService.start();
    try {
      const [oldBatch, newBatch] = await Promise.all([
        oldService.enqueue([{ user, userCwd, reason: 'admin', force: true }]),
        newService.enqueue([{ user, userCwd, reason: 'admin', force: true }]),
      ]);
      await Promise.all([
        oldService.waitForBatch(oldBatch.id),
        newService.waitForBatch(newBatch.id),
      ]);

      expect(readFileSync(join(userCwd, '.ky-agent', 'skills', 'alpha', 'SKILL.md'), 'utf-8'))
        .toContain('new-release');
      expect(await readSkillManifest(userCwd)).toMatchObject({
        configVersion: 2,
        sourceRevision: 'release-new',
      });
      await expect(oldMaterializer.isReady(userCwd)).resolves.toBe(true);
    } finally {
      await Promise.all([oldService.stop(), newService.stop()]);
    }
  });

  it('技能内容和配置未变化时，新 release 直接复用现有 manifest，不创建任务', async () => {
    createSkill(poolDir, 'alpha', 'same-content');
    const config = fakeStore(['alpha']);
    const store = new InMemorySkillMaterializationStore();
    await store.init();
    const oldMaterializer = new SkillWorkspaceMaterializer({
      sharedDir,
      sourceRevision: 'release-old',
      skillConfigStore: config.store,
    });
    await oldMaterializer.materialize({
      taskId: 'old-release-task',
      user,
      userCwd,
    });

    const newMaterializer = new SkillWorkspaceMaterializer({
      sharedDir,
      sourceRevision: 'release-new',
      skillConfigStore: config.store,
    });
    const newService = new SkillMaterializationService({
      store,
      materializer: newMaterializer,
      skillConfigStore: config.store,
      sourceRevision: 'release-new',
      pollIntervalMs: 5,
      resolveTargetByUsername: () => ({ user, userCwd }),
    });

    await expect(newMaterializer.isReady(userCwd)).resolves.toBe(true);
    const batch = await newService.enqueue([{ user, userCwd, reason: 'startup' }]);
    expect(batch).toMatchObject({ status: 'succeeded', total: 0 });
    expect(await readSkillManifest(userCwd)).toMatchObject({
      sourceRevision: 'release-old',
    });
  });
});
