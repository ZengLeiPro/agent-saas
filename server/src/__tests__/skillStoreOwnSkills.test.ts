/**
 * SkillConfigStore 租户自有 skill（ownSkills）规则与 prune 行为测试。
 *
 * 关键回归点：
 *   1. ownSkills 默认规则 = enabled + 全员开放（不受旧 enabledSkills pool 语义影响）
 *   2. pruneStaleSkills 不误删：selectedSkills 中的租户自有 skill 必须保留；
 *      ownSkills 幽灵条目（目录已删）按 tenantOwnIdsByTenant 清理
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SkillConfigStore } from '../data/skills/store.js';

describe('SkillConfigStore ownSkills', () => {
  let tmpRoot: string;
  let store: SkillConfigStore;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'skill-store-own-'));
    store = new SkillConfigStore(join(tmpRoot, 'skills-config.json'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('未配置的自有 skill 默认 enabled + 全员开放', () => {
    const rule = store.getTenantOwnSkillRule('wain', 'anything');
    expect(rule).toEqual({ enabled: true, exposure: 'all', usernames: [] });
    expect(store.isTenantOwnSkillAvailableToUser('wain', 'anything', 'bob')).toBe(true);
  });

  it('旧 enabledSkills（pool 语义）不影响自有 skill 默认启用', async () => {
    await store.setTenantEnabledSkills('wain', ['some_pool_skill']);
    // 自有 skill 不在 enabledSkills 里，但默认仍应 enabled
    expect(store.getTenantOwnSkillRule('wain', 'own-tool').enabled).toBe(true);
  });

  it('setTenantOwnSkillRules 生效且与 pool 规则（skills 字段）互不干扰', async () => {
    await store.setTenantSkillRules('wain', { pool_a: { enabled: false, exposure: 'all', usernames: [] } });
    await store.setTenantOwnSkillRules('wain', { own_a: { enabled: true, exposure: 'allow_users', usernames: ['alice'] } });

    expect(store.getTenantSkillRule('wain', 'pool_a').enabled).toBe(false);
    const own = store.getTenantOwnSkillRule('wain', 'own_a');
    expect(own.exposure).toBe('allow_users');
    expect(store.isTenantOwnSkillAvailableToUser('wain', 'own_a', 'alice')).toBe(true);
    expect(store.isTenantOwnSkillAvailableToUser('wain', 'own_a', 'bob')).toBe(false);
  });

  it('getUserEffectiveTenantOwnSkills = 目录现存 ∩ 规则允许 ∩ selectedSkills', async () => {
    await store.setUserSelectedSkills('bob', ['own_a', 'own_b', 'own_gone']);
    await store.setTenantOwnSkillRules('wain', { own_b: { enabled: false, exposure: 'all', usernames: [] } });

    const effective = store.getUserEffectiveTenantOwnSkills('bob', 'wain', new Set(['own_a', 'own_b']));
    expect(effective).toEqual(['own_a']); // own_b 被禁用，own_gone 目录不存在
    expect(store.getUserEffectiveTenantOwnSkills('bob', undefined, new Set(['own_a']))).toEqual([]);
  });

  it('pruneStaleSkills 保留 selectedSkills 中的租户自有 skill，清理 ownSkills 幽灵条目', async () => {
    await store.setPoolVisibility({ pool_x: true, pool_stale: true });
    await store.setUserSelectedSkills('bob', ['pool_x', 'pool_stale', 'own_alive', 'own_dead']);
    await store.setTenantOwnSkillRules('wain', {
      own_alive: { enabled: true, exposure: 'all', usernames: [] },
      own_dead: { enabled: true, exposure: 'all', usernames: [] },
    });

    const pruned = store.pruneStaleSkills(new Set(['pool_x']), { wain: new Set(['own_alive']) });
    expect(pruned).toBeGreaterThan(0);

    // pool 幽灵与目录已删的 own skill 被清；活着的都保留
    expect(store.getUserSelectedSkills('bob')).toEqual(['pool_x', 'own_alive']);
    expect(store.getPoolVisibility()).not.toHaveProperty('pool_stale');
    expect(Object.keys(store.getTenantOwnSkillRules('wain'))).toEqual(['own_alive']);
  });

  it('pruneStaleSkills 不传租户目录信息时不清 ownSkills 但也不误保留 selectedSkills 之外的 pool 幽灵', async () => {
    await store.setPoolVisibility({ pool_x: true });
    await store.setUserSelectedSkills('bob', ['pool_x', 'own_a']);

    // 未传 tenantOwnIdsByTenant：own_a 不在任何保留集合 → 会被从 selectedSkills 清掉。
    // 这是调用方契约：启动/sync 必须传入租户目录现状（runtime.ts 与 /sync 路由均已传）。
    store.pruneStaleSkills(new Set(['pool_x']));
    expect(store.getUserSelectedSkills('bob')).toEqual(['pool_x']);
  });
});
