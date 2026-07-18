import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  parseSkillFrontmatter,
  scanPoolSkills,
  scanTenantOwnSkillIds,
  scanUserCustomSkills,
} from '../data/skills/scanner.js';
import { migrateFromManifest } from '../data/skills/migrate.js';
import { SkillConfigStore } from '../data/skills/store.js';

/**
 * skills data 层未覆盖行为补测：
 * - scanner：frontmatter 解析 + pool/租户自有/用户自建目录扫描（shadow / strict 语义）
 * - migrate：从旧 _manifest.json 迁移（角色展开 / 缺省 core / 无 manifest / 解析失败回退）
 * - store：平台级 exposure、租户成员 exposure、removeUser/removeTenant、
 *   setPoolContentHashSync、load 失败保护
 */

const tmpRoots: string[] = [];
function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'skills-data-'));
  tmpRoots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ── scanner: parseSkillFrontmatter ─────────────────────────────
describe('parseSkillFrontmatter', () => {
  it('解析 name 与 description（去除包裹引号）', () => {
    const parsed = parseSkillFrontmatter('---\nname: "my-skill"\ndescription: 做某事\n---\n正文');
    expect(parsed).toEqual({ name: 'my-skill', description: '做某事' });
  });

  it('无 frontmatter 返回 null', () => {
    expect(parseSkillFrontmatter('# 只有标题没有 frontmatter')).toBeNull();
  });

  it('有 frontmatter 但缺 name 返回 null', () => {
    expect(parseSkillFrontmatter('---\ndescription: 只有描述\n---')).toBeNull();
  });

  it('缺 description 时 description 为空字符串', () => {
    expect(parseSkillFrontmatter('---\nname: solo\n---')).toEqual({ name: 'solo', description: '' });
  });
});

// ── scanner: scanPoolSkills ────────────────────────────────────
describe('scanPoolSkills', () => {
  function seedPool(): string {
    const pool = join(makeTmp(), 'pool');
    mkdirSync(join(pool, 'bravo'), { recursive: true });
    writeFileSync(join(pool, 'bravo', 'SKILL.md'), '---\nname: Bravo\ndescription: b\n---');
    mkdirSync(join(pool, 'alpha'), { recursive: true });
    // alpha 无有效 frontmatter → 非严格模式 fallback 到目录名
    writeFileSync(join(pool, 'alpha', 'SKILL.md'), 'no frontmatter here');
    // _ 与 . 开头目录、普通文件都跳过
    mkdirSync(join(pool, '_hidden'), { recursive: true });
    writeFileSync(join(pool, 'loose.txt'), 'x');
    return pool;
  }

  it('不存在的目录返回空数组', () => {
    expect(scanPoolSkills(join(makeTmp(), 'nope'))).toEqual([]);
  });

  it('按 id 排序，跳过 _/. 前缀与非目录，缺 frontmatter 时 fallback 目录名', () => {
    const metas = scanPoolSkills(seedPool());
    expect(metas.map((m) => m.id)).toEqual(['alpha', 'bravo']);
    expect(metas.find((m) => m.id === 'bravo')).toEqual({ id: 'bravo', name: 'Bravo', description: 'b' });
    // alpha fallback：name=目录名, description 空
    expect(metas.find((m) => m.id === 'alpha')).toEqual({ id: 'alpha', name: 'alpha', description: '' });
  });

  it('优先 SKILL.md，其次 {dirName}.md，最后唯一 .md 文件', () => {
    const pool = join(makeTmp(), 'pool');
    // 只有 {dirName}.md
    mkdirSync(join(pool, 'named'), { recursive: true });
    writeFileSync(join(pool, 'named', 'named.md'), '---\nname: FromNamed\ndescription: n\n---');
    // 只有唯一其它 .md
    mkdirSync(join(pool, 'onlyone'), { recursive: true });
    writeFileSync(join(pool, 'onlyone', 'guide.md'), '---\nname: FromUnique\ndescription: u\n---');

    const metas = scanPoolSkills(pool);
    expect(metas.find((m) => m.id === 'named')!.name).toBe('FromNamed');
    expect(metas.find((m) => m.id === 'onlyone')!.name).toBe('FromUnique');
  });
});

// ── scanner: scanTenantOwnSkillIds ─────────────────────────────
describe('scanTenantOwnSkillIds', () => {
  it('不存在目录返回空集', () => {
    expect(scanTenantOwnSkillIds(join(makeTmp(), 'nope'), new Set()).size).toBe(0);
  });

  it('返回现存目录 ID，shadow 掉与 pool 同名，跳过 _/. 前缀与文件', () => {
    const dir = join(makeTmp(), 'tenant-skills');
    mkdirSync(join(dir, 'own-a'), { recursive: true });
    mkdirSync(join(dir, 'shadowed'), { recursive: true }); // 与 pool 同名 → 排除
    mkdirSync(join(dir, '_tmp'), { recursive: true });      // _ 前缀跳过
    writeFileSync(join(dir, 'note.md'), 'x');               // 非目录跳过

    const ids = scanTenantOwnSkillIds(dir, new Set(['shadowed']));
    expect([...ids]).toEqual(['own-a']);
  });
});

// ── scanner: scanUserCustomSkills（strict 模式）──────────────────
describe('scanUserCustomSkills', () => {
  it('不存在目录返回空', () => {
    expect(scanUserCustomSkills(join(makeTmp(), 'nope'), new Set())).toEqual([]);
  });

  it('严格模式：无有效 frontmatter 的目录被跳过，pool 同名被 shadow', () => {
    const dir = join(makeTmp(), 'user-skills');
    // 有效 custom skill
    mkdirSync(join(dir, 'valid'), { recursive: true });
    writeFileSync(join(dir, 'valid', 'SKILL.md'), '---\nname: Valid\ndescription: v\n---');
    // 评测/临时目录：无 frontmatter → strict 下丢弃
    mkdirSync(join(dir, 'evaldir'), { recursive: true });
    writeFileSync(join(dir, 'evaldir', 'result.md'), 'no frontmatter');
    // 与 pool 同名 → shadow
    mkdirSync(join(dir, 'poolskill'), { recursive: true });
    writeFileSync(join(dir, 'poolskill', 'SKILL.md'), '---\nname: X\ndescription: x\n---');

    const metas = scanUserCustomSkills(dir, new Set(['poolskill']));
    expect(metas.map((m) => m.id)).toEqual(['valid']);
    expect(metas[0]).toEqual({ id: 'valid', name: 'Valid', description: 'v' });
  });
});

// ── migrate: migrateFromManifest ───────────────────────────────
describe('migrateFromManifest', () => {
  function poolWith(ids: string[]): string {
    const pool = join(makeTmp(), 'pool');
    for (const id of ids) mkdirSync(join(pool, id), { recursive: true });
    return pool;
  }
  function storeAt(): SkillConfigStore {
    return new SkillConfigStore(join(makeTmp(), 'skills-config.json'));
  }

  it('展开 manifest 用户的 roles→skills，缺省用户按 core 角色初始化', () => {
    const pool = poolWith(['s1', 's2', 's3']);
    writeFileSync(join(pool, '_manifest.json'), JSON.stringify({
      roles: { core: ['s1'], power: ['s1', 's2'] },
      users: { alice: { roles: ['power'] } },
    }));
    const store = storeAt();

    migrateFromManifest(store, pool, ['alice', 'bob']);

    // alice 展开 power → s1,s2（排序）
    expect(store.getUserSelectedSkills('alice')).toEqual(['s1', 's2']);
    // bob 不在 manifest → 按 core 角色 = s1
    expect(store.getUserSelectedSkills('bob')).toEqual(['s1']);
    // 所有 pool skill 默认平台可见
    expect(store.isPoolSkillVisible('s3')).toBe(true);
  });

  it('无 manifest 时所有用户选中全部 pool skill', () => {
    const pool = poolWith(['a', 'b']);
    const store = storeAt();
    migrateFromManifest(store, pool, ['u1']);
    expect(store.getUserSelectedSkills('u1')).toEqual(['a', 'b']);
  });

  it('manifest 解析失败时回退为所有用户选中全部 skill', () => {
    const pool = poolWith(['a', 'b']);
    writeFileSync(join(pool, '_manifest.json'), '{ 坏 json');
    const store = storeAt();
    migrateFromManifest(store, pool, ['u1']);
    expect(store.getUserSelectedSkills('u1')).toEqual(['a', 'b']);
  });

  it('忽略 manifest 中已不存在于 pool 的 skill id', () => {
    const pool = poolWith(['exists']);
    writeFileSync(join(pool, '_manifest.json'), JSON.stringify({
      roles: { core: ['exists', 'ghost'] },
      users: {},
    }));
    const store = storeAt();
    migrateFromManifest(store, pool, ['u1']);
    expect(store.getUserSelectedSkills('u1')).toEqual(['exists']);
  });
});

// ── store: 平台级 exposure ─────────────────────────────────────
describe('SkillConfigStore platform & tenant exposure', () => {
  function store(): SkillConfigStore {
    return new SkillConfigStore(join(makeTmp(), 'skills-config.json'));
  }

  it('platform allow_tenants：仅列出的租户可用', async () => {
    const s = store();
    await s.setPlatformSkillConfigs({
      geo: { enabled: true, exposure: 'allow_tenants', tenantIds: ['wain'] },
    });
    expect(s.isPoolSkillAvailableToTenant('geo', 'wain')).toBe(true);
    expect(s.isPoolSkillAvailableToTenant('geo', 'other')).toBe(false);
    // 无租户上下文（平台自身）总可用
    expect(s.isPoolSkillAvailableToTenant('geo', undefined)).toBe(true);
  });

  it('platform deny_tenants：列出的租户被禁用', async () => {
    const s = store();
    await s.setPlatformSkillConfigs({
      geo: { enabled: true, exposure: 'deny_tenants', tenantIds: ['blocked'] },
    });
    expect(s.isPoolSkillAvailableToTenant('geo', 'blocked')).toBe(false);
    expect(s.isPoolSkillAvailableToTenant('geo', 'allowed')).toBe(true);
  });

  it('platform enabled=false：任何租户都不可用', async () => {
    const s = store();
    await s.setPlatformSkillConfigs({
      off: { enabled: false, exposure: 'all', tenantIds: [] },
    });
    expect(s.isPoolSkillAvailableToTenant('off', 'wain')).toBe(false);
    expect(s.isPoolSkillVisible('off')).toBe(false);
  });

  it('setPlatformSkillConfigs 归一化 tenantIds（去重、去空、排序）并回写 poolVisibility', async () => {
    const s = store();
    await s.setPlatformSkillConfigs({
      x: { enabled: true, exposure: 'allow_tenants', tenantIds: ['b', 'a', 'a', ''] as string[] },
    });
    expect(s.getPlatformSkillConfig('x').tenantIds).toEqual(['a', 'b']);
    expect(s.getPoolVisibility().x).toBe(true);
  });

  it('租户成员 exposure allow_users / deny_users 精确到用户', async () => {
    const s = store();
    await s.setPlatformSkillConfigs({ tool: { enabled: true, exposure: 'all', tenantIds: [] } });
    await s.setTenantSkillRules('wain', {
      tool: { enabled: true, exposure: 'allow_users', usernames: ['alice'] },
    });
    expect(s.isTenantSkillAvailableToUser('tool', 'wain', 'alice')).toBe(true);
    expect(s.isTenantSkillAvailableToUser('tool', 'wain', 'bob')).toBe(false);

    await s.setTenantSkillRules('wain', {
      tool: { enabled: true, exposure: 'deny_users', usernames: ['bob'] },
    });
    expect(s.isTenantSkillAvailableToUser('tool', 'wain', 'bob')).toBe(false);
    expect(s.isTenantSkillAvailableToUser('tool', 'wain', 'alice')).toBe(true);
  });

  it('getUserEffectivePoolSkills 剔除平台关闭的 skill（未配置默认可见）', async () => {
    const s = store();
    await s.setPlatformSkillConfigs({
      a: { enabled: true, exposure: 'all', tenantIds: [] },
      b: { enabled: false, exposure: 'all', tenantIds: [] }, // 平台显式关 → 剔除
    });
    await s.setUserSelectedSkills('alice', ['a', 'b']);
    // b 被平台关闭剔除，a 保留
    expect(s.getUserEffectivePoolSkills('alice', 'wain')).toEqual(['a']);
    expect(s.getUserEffectivePoolSkills('alice', 'wain')).not.toContain('b');
  });

  it('getTenantEnabledSkills = 平台开放 ∩ 租户启用', async () => {
    const s = store();
    await s.setPlatformSkillConfigs({
      a: { enabled: true, exposure: 'all', tenantIds: [] },
      b: { enabled: true, exposure: 'all', tenantIds: [] },
    });
    await s.setTenantSkillRules('wain', { b: { enabled: false, exposure: 'all', usernames: [] } });
    expect(s.getTenantEnabledSkills('wain').sort()).toEqual(['a']);
  });
});

// ── store: 删除与内容指纹 ──────────────────────────────────────
describe('SkillConfigStore removal & content hash & load', () => {
  function storePath(): string {
    return join(makeTmp(), 'skills-config.json');
  }

  it('removeUser 幂等：存在则删并 bump 版本，不存在则不 bump', async () => {
    const s = new SkillConfigStore(storePath());
    await s.setUserSelectedSkills('alice', ['a']);
    const v0 = s.getConfigVersion();
    await s.removeUser('alice');
    expect(s.getUserSelectedSkills('alice')).toEqual([]);
    expect(s.getConfigVersion()).toBe(v0 + 1);
    const v1 = s.getConfigVersion();
    await s.removeUser('ghost');
    expect(s.getConfigVersion()).toBe(v1); // 无变化不 bump
  });

  it('removeTenant 清理成员、租户配置与平台 tenantId 引用并返回计数', async () => {
    const s = new SkillConfigStore(storePath());
    await s.setPlatformSkillConfigs({
      geo: { enabled: true, exposure: 'allow_tenants', tenantIds: ['wain', 'keep'] },
    });
    await s.setTenantSkillRules('wain', { geo: { enabled: true, exposure: 'all', usernames: [] } });
    await s.setUserSelectedSkills('alice', ['geo']);
    await s.setUserSelectedSkills('bob', ['geo']);

    const result = await s.removeTenant('wain', ['alice', 'bob']);
    expect(result).toEqual({ usersRemoved: 2, tenantConfigRemoved: true, platformRefsRemoved: 1 });
    expect(s.getUserSelectedSkills('alice')).toEqual([]);
    expect(s.getAllTenantConfigs().wain).toBeUndefined();
    // 平台 tenantIds 仅保留 keep
    expect(s.getPlatformSkillConfig('geo').tenantIds).toEqual(['keep']);
  });

  it('setPoolContentHashSync：变化时落盘并 bump，未变化时 no-op', () => {
    const path = storePath();
    const s = new SkillConfigStore(path);
    const v0 = s.getConfigVersion();
    s.setPoolContentHashSync('hash-1');
    expect(s.getPoolContentHash()).toBe('hash-1');
    expect(s.getConfigVersion()).toBe(v0 + 1);
    // 落盘可被新实例读回
    expect(new SkillConfigStore(path).getPoolContentHash()).toBe('hash-1');

    const v1 = s.getConfigVersion();
    s.setPoolContentHashSync('hash-1'); // 相同 → no-op
    expect(s.getConfigVersion()).toBe(v1);
  });

  it('load 解析失败时置 loadFailed 并跳过持久化，避免以空数据破坏磁盘', async () => {
    const path = storePath();
    writeFileSync(path, '{ 非法 json ');
    const s = new SkillConfigStore(path);
    expect(s.loadFailed).toBe(true);

    const before = readFileSync(path, 'utf-8');
    await s.setUserSelectedSkills('alice', ['a']); // persist 应被 loadFailed 短路
    expect(readFileSync(path, 'utf-8')).toBe(before);
  });

  it('syncWithPool 补全缺失条目（默认 visible）不覆盖已存在，返回新增数', async () => {
    const s = new SkillConfigStore(storePath());
    await s.setPlatformSkillConfigs({ existing: { enabled: false, exposure: 'all', tenantIds: [] } });
    const added = s.syncWithPool(new Set(['existing', 'new1', 'new2']));
    expect(added).toBe(2);
    expect(s.isPoolSkillVisible('existing')).toBe(false); // 不被重置为 true
    expect(s.isPoolSkillVisible('new1')).toBe(true);
  });
});
