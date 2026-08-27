import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SkillConfigStore } from '../data/skills/store.js';
import { deletePersonalSkillWithGovernance } from '../services/skillGovernanceDeletion.js';
import {
  createPersonalSkillGovernanceUpload,
  personalSkillResourceId,
} from '../services/tenantSkillGovernanceUpload.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'skill-selection-atomicity-'));
  roots.push(root);
  return root;
}

function failNextPersist(store: SkillConfigStore): void {
  const internal = store as unknown as { persist: () => Promise<void> };
  const original = internal.persist.bind(store);
  let fail = true;
  internal.persist = async () => {
    if (fail) {
      fail = false;
      throw new Error('persist failed');
    }
    await original();
  };
}

function skillFile(skillId: string): Express.Multer.File {
  const buffer = Buffer.from(`---\nname: ${skillId}\ndescription: atomic selection\n---\nbody`);
  return {
    fieldname: 'files', originalname: 'SKILL.md', encoding: '7bit', mimetype: 'text/markdown',
    size: buffer.length, buffer, destination: '', filename: '', path: '', stream: undefined as never,
  };
}

function createUpload(input: {
  root: string;
  skillConfigStore: SkillConfigStore;
  getResource: ReturnType<typeof vi.fn>;
  createResource?: ReturnType<typeof vi.fn>;
  restoreResource?: ReturnType<typeof vi.fn>;
}) {
  const actor = { id: 'user-1', username: 'alice', tenantId: 'tenant-a', role: 'user' };
  return createPersonalSkillGovernanceUpload({
    skills: {
      getResource: input.getResource,
      createAndPublishResource: input.createResource ?? vi.fn(),
      restoreAndPublishResource: input.restoreResource ?? vi.fn(),
    } as never,
    skillConfigStore: input.skillConfigStore,
    userStore: { findById: (id: string) => id === actor.id ? actor : undefined } as never,
    agentCwd: join(input.root, 'agents'),
    sharedDir: join(input.root, 'shared'),
    tenantSkillsRootDir: join(input.root, 'tenants'),
  });
}

function installedDir(root: string, skillId: string): string {
  return join(root, 'agents', 'tenant-a', 'user-1', '.ky-agent', 'skills', skillId);
}

describe('Skill selection 持久化失败原子性', () => {
  it.each([
    ['setUserSkillSelected', (store: SkillConfigStore) => store.setUserSkillSelected('alice', 'skill-a', false)],
    ['updateUserSkillSelection', (store: SkillConfigStore) => store.updateUserSkillSelection(
      'alice', 'skill-a', false, store.getUserSelectionRevision('alice'),
    )],
    ['setUserSelectedSkills', (store: SkillConfigStore) => store.setUserSelectedSkills('alice', [])],
  ])('%s 失败后恢复 selection、revision 与 configVersion', async (_name, mutate) => {
    const root = makeRoot();
    const configPath = join(root, 'skills-config.json');
    const store = new SkillConfigStore(configPath);
    await store.setUserSelectedSkills('alice', ['skill-a']);
    const originalRevision = store.getUserSelectionRevision('alice');
    const originalVersion = store.getConfigVersion();
    failNextPersist(store);

    await expect(mutate(store)).rejects.toThrow('persist failed');

    expect(store.getUserSelectedSkills('alice')).toEqual(['skill-a']);
    expect(store.getUserSelectionRevision('alice')).toBe(originalRevision);
    expect(store.getConfigVersion()).toBe(originalVersion);
    const reloaded = new SkillConfigStore(configPath);
    expect(reloaded.getUserSelectedSkills('alice')).toEqual(['skill-a']);
    expect(reloaded.getUserSelectionRevision('alice')).toBe(originalRevision);
    expect(reloaded.getConfigVersion()).toBe(originalVersion);
  });

  it('个人删除 selection persist 失败后恢复目录、内存与磁盘选择', async () => {
    const root = makeRoot();
    const configPath = join(root, 'skills-config.json');
    const store = new SkillConfigStore(configPath);
    await store.setUserSelectedSkills('alice', ['delete-me']);
    const originalVersion = store.getConfigVersion();
    const skillDir = installedDir(root, 'delete-me');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: delete-me\ndescription: delete\n---\nbody');
    failNextPersist(store);
    const retire = vi.fn();

    await expect(deletePersonalSkillWithGovernance({
      skillDir,
      skillId: 'delete-me',
      tenantId: 'tenant-a',
      userId: 'user-1',
      username: 'alice',
      skillConfigStore: store,
      skillGovernanceStore: {
        getResource: vi.fn().mockResolvedValue({
          skillId: personalSkillResourceId('user-1', 'delete-me'),
          tenantId: 'tenant-a', scope: 'personal', ownerUserId: 'user-1', status: 'published', revision: 2,
        }),
        retire,
      } as never,
    })).rejects.toThrow('persist failed');

    expect(existsSync(skillDir)).toBe(true);
    expect(retire).not.toHaveBeenCalled();
    expect(store.getUserSelectedSkills('alice')).toEqual(['delete-me']);
    expect(store.getConfigVersion()).toBe(originalVersion);
    const reloaded = new SkillConfigStore(configPath);
    expect(reloaded.getUserSelectedSkills('alice')).toEqual(['delete-me']);
    expect(reloaded.getConfigVersion()).toBe(originalVersion);
  });

  it('个人首次导入默认启用 persist 失败后不留下目录、治理资源或选择', async () => {
    const root = makeRoot();
    const configPath = join(root, 'skills-config.json');
    const store = new SkillConfigStore(configPath);
    const originalVersion = store.getConfigVersion();
    failNextPersist(store);
    const createResource = vi.fn();
    const upload = createUpload({
      root, skillConfigStore: store, getResource: vi.fn().mockResolvedValue(null), createResource,
    });

    await expect(upload({
      tenantId: 'tenant-a', actorUserId: 'user-1', files: [skillFile('first-import')],
    })).rejects.toThrow('persist failed');

    expect(createResource).not.toHaveBeenCalled();
    expect(existsSync(installedDir(root, 'first-import'))).toBe(false);
    expect(store.getUserSelectedSkills('alice')).toEqual([]);
    expect(store.getConfigVersion()).toBe(originalVersion);
    const reloaded = new SkillConfigStore(configPath);
    expect(reloaded.getUserSelectedSkills('alice')).toEqual([]);
    expect(reloaded.getConfigVersion()).toBe(originalVersion);
  });

  it('个人同名恢复默认启用 persist 失败后不留下目录、治理变更或选择', async () => {
    const root = makeRoot();
    const configPath = join(root, 'skills-config.json');
    const store = new SkillConfigStore(configPath);
    await store.setUserSelectedSkills('alice', []);
    const originalVersion = store.getConfigVersion();
    failNextPersist(store);
    const resource = {
      skillId: personalSkillResourceId('user-1', 'restore-import'),
      tenantId: 'tenant-a', scope: 'personal', ownerUserId: 'user-1', status: 'retired', revision: 3,
    };
    const restoreResource = vi.fn();
    const upload = createUpload({
      root, skillConfigStore: store, getResource: vi.fn().mockResolvedValue(resource), restoreResource,
    });

    await expect(upload({
      tenantId: 'tenant-a', actorUserId: 'user-1', files: [skillFile('restore-import')],
    })).rejects.toThrow('persist failed');

    expect(restoreResource).not.toHaveBeenCalled();
    expect(resource.status).toBe('retired');
    expect(existsSync(installedDir(root, 'restore-import'))).toBe(false);
    expect(store.getUserSelectedSkills('alice')).toEqual([]);
    expect(store.getConfigVersion()).toBe(originalVersion);
    const reloaded = new SkillConfigStore(configPath);
    expect(reloaded.getUserSelectedSkills('alice')).toEqual([]);
    expect(reloaded.getConfigVersion()).toBe(originalVersion);
  });
});
